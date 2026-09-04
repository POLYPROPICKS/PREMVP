/**
 * RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1 — deterministic scorecard.
 *
 * Evaluates the exact already-frozen model predicates C0 / C1 / C2 / C3 / C4 / C5
 * on ONE trusted historical summer basis: the recovered immutable
 * AUGUST_MAIN_DB_ENRICHMENT_V1 artifact (18,705 August physical events,
 * formula_version='shadow-strategic-sports-v1', SHA256 3e347283...93 verified
 * before use).
 *
 * Reuses, UNCHANGED, from lib/modeling/research-engine/**:
 *   - the shared price band + C4 lead-time threshold + soccer / table-tennis
 *     family constants (models.ts);
 *   - evaluateEvent (lead_time_hours derivation), sortChronologically,
 *     settleBetU (flat 1u: WIN=1/p-1, LOSS=-1), aggregateMetrics
 *     (PNL_U / ROI_PCT / chronological MAX_DRAWDOWN_U).
 *
 * C0/C1/C4/C5 are the frozen research-engine family. C2 and C3 are the
 * additional already-declared summer shortlist arms recovered from
 * modeling/local_exports/frozen_candidates_for_forward_v1 (C2_LEAD_GE_24H) and
 * reconciled from the C4 = C1 + C2 - C3 identity (C3 = the C1 INTERSECT C2 arm,
 * N=2001 in PNL_PORTFOLIO_OVERLAP_AND_PRIORITY_V1). No threshold is introduced
 * or changed. No new hypothesis. No dataset rebuilt.
 *
 * Usage:  npx tsx scripts/modeling/summer-model-ranking-scorecard.ts [--json-out F] [--md-out F]
 * Deterministic: same input bytes -> byte-identical output.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  ENTRY_PRICE_BAND,
  C4_LEAD_TIME_HOURS_THRESHOLD,
  SOCCER_FAMILY,
  TABLE_TENNIS_FAMILY,
} from "@/lib/modeling/research-engine/models";
import { evaluateEvent } from "@/lib/modeling/research-engine/engine";
import { sortChronologically, aggregateMetrics } from "@/lib/modeling/research-engine/metrics";
import { settleBetU } from "@/lib/modeling/research-engine/settlement";
import type {
  EvaluatedEvent,
  ResearchEngineInputEvent,
  SelectedBet,
} from "@/lib/modeling/research-engine/types";

const EXPECTED_MAIN_SHA256 =
  "3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93";
const EXPECTED_MAIN_BASE_EVENT_N = 18705;

const MAIN_RAW = "modeling/local_exports/august_main_db_enrichment_v1/AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl";
const MAIN_GZ = "modeling/evidence/august-cloud-artifact-recovery/AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl.gz";
const UPSTREAM_JSONL =
  "modeling/local_exports/august_enriched_research_dataset_v1/AUGUST_ENRICHED_RESEARCH_DATASET_V1.jsonl";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function loadMainText(): string {
  if (existsSync(MAIN_RAW)) {
    const buf = readFileSync(MAIN_RAW);
    if (sha256(buf) !== EXPECTED_MAIN_SHA256) throw new Error("main raw SHA mismatch");
    return buf.toString("utf8");
  }
  const buf = gunzipSync(readFileSync(MAIN_GZ));
  if (sha256(buf) !== EXPECTED_MAIN_SHA256) throw new Error("main gz SHA mismatch");
  return buf.toString("utf8");
}

interface MainRow {
  base: {
    id: string;
    provider_event_id: string;
    condition_id: string;
    decision_timestamp: string;
    event_start: string;
    settlement: { status: "WIN" | "LOSS" };
  };
  enrichment: {
    entry_price: { value: number | null };
    market_family?: { value: string | null };
    market_type_raw?: { value: string | null };
  };
}
interface UpstreamRow {
  base: { id: string };
  enrichment: { sport_family: { value: string | null } };
}

function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) if (line) out.push(JSON.parse(line) as T);
  return out;
}

interface Joined {
  id: string;
  ev: EvaluatedEvent;
  marketFamily: string | null;
}

function buildRows(): { joined: Joined[]; baseEventN: number; inputAfterFilter: number } {
  const mainRows = parseJsonl<MainRow>(loadMainText());
  const upstream = parseJsonl<UpstreamRow>(readFileSync(UPSTREAM_JSONL, "utf8"));
  const sportById = new Map<string, string | null>();
  for (const r of upstream) sportById.set(r.base.id, r.enrichment.sport_family?.value ?? null);

  const joined: Joined[] = [];
  for (const r of mainRows) {
    const entryPrice = r.enrichment.entry_price?.value ?? null;
    const sportFamily = sportById.get(r.base.id) ?? null;
    if (entryPrice == null || !(entryPrice > 0 && entryPrice < 1)) continue;
    if (!sportFamily) continue;
    const input: ResearchEngineInputEvent = {
      physicalEventKey: r.base.provider_event_id || r.base.condition_id,
      decisionTimestamp: r.base.decision_timestamp,
      eventStart: r.base.event_start,
      entryPrice,
      sportFamily,
      outcome: r.base.settlement.status,
      ref: r.base.id,
    };
    joined.push({
      id: r.base.id,
      ev: evaluateEvent(input),
      marketFamily: r.enrichment.market_family?.value ?? null,
    });
  }
  return { joined, baseEventN: mainRows.length, inputAfterFilter: joined.length };
}

function inBand(p: number): boolean {
  return p >= ENTRY_PRICE_BAND.minInclusive && p < ENTRY_PRICE_BAND.maxExclusive;
}

type Predicate = (e: EvaluatedEvent) => boolean;

const MODELS: Array<{ id: string; role: string; rule: string; predicate: Predicate }> = [
  { id: "C0", role: "PRICE_ANCHOR", rule: "0.50 <= entry_price < 0.60", predicate: (e) => inBand(e.entryPrice) },
  { id: "C1", role: "HIGH_ROI", rule: "0.50 <= entry_price < 0.60 AND sport_family = soccer", predicate: (e) => inBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY },
  { id: "C2", role: "LEAD_GE_24H", rule: "0.50 <= entry_price < 0.60 AND lead_time_hours >= 24", predicate: (e) => inBand(e.entryPrice) && e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD },
  { id: "C3", role: "SOCCER_AND_LEAD_GE_24H (C1 INTERSECT C2)", rule: "0.50 <= entry_price < 0.60 AND sport_family = soccer AND lead_time_hours >= 24", predicate: (e) => inBand(e.entryPrice) && e.sportFamily === SOCCER_FAMILY && e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD },
  { id: "C4", role: "BALANCED / CURRENT OPERATING MODEL", rule: "0.50 <= entry_price < 0.60 AND (sport_family = soccer OR lead_time_hours >= 24)", predicate: (e) => inBand(e.entryPrice) && (e.sportFamily === SOCCER_FAMILY || e.leadTimeHours >= C4_LEAD_TIME_HOURS_THRESHOLD) },
  { id: "C5", role: "PNL_SCALE", rule: "0.50 <= entry_price < 0.60 AND sport_family != table-tennis", predicate: (e) => inBand(e.entryPrice) && e.sportFamily !== TABLE_TENNIS_FAMILY },
];

function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round((n + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

interface ModelReport {
  MODEL_ID: string;
  ROLE: string;
  EXACT_PREDICATE: string;
  PHYSICAL_EVENT_PARENT_N: number;
  MODEL_ELIGIBLE_N: number;
  SETTLED_BET_N: number;
  W: number;
  L: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DRAWDOWN_U: number;
  BETS_PER_DAY: number;
  WEEKLY: Array<{ week: string; n: number; pnlU: number; roiPct: number }>;
  POSITIVE_BUCKET_N: number;
  NEGATIVE_BUCKET_N: number;
  LARGEST_DAY_PNL_SHARE_PCT: number | null;
  LARGEST_SINGLE_EVENT_PNL_SHARE_PCT: number | null;
  SPORT_COMPOSITION: Array<{ sport: string; n: number; sharePct: number }>;
  MARKET_FAMILY_COMPOSITION: Array<{ family: string; n: number; sharePct: number }>;
}

function evaluateModel(
  predicate: Predicate,
  rule: string,
  id: string,
  role: string,
  joined: Joined[],
  spanDays: number,
): ModelReport {
  const familyById = new Map<string, string | null>();
  for (const j of joined) familyById.set(j.id, j.marketFamily);

  const ordered = sortChronologically(joined.map((j) => j.ev));
  const claimed = new Set<string>();
  const bets: SelectedBet[] = [];
  for (const e of ordered) {
    if (claimed.has(e.physicalEventKey)) continue;
    if (!predicate(e)) continue;
    claimed.add(e.physicalEventKey);
    bets.push({
      physicalEventKey: e.physicalEventKey,
      decisionTimestamp: e.decisionTimestamp,
      eventStart: e.eventStart,
      leadTimeHours: e.leadTimeHours,
      entryPrice: e.entryPrice,
      sportFamily: e.sportFamily,
      outcome: e.outcome,
      pnlU: settleBetU(e.outcome, e.entryPrice),
      ...(e.ref === undefined ? {} : { ref: e.ref }),
    });
  }
  const m = aggregateMetrics(bets);

  // Weekly buckets (chronological).
  const weekMap = new Map<string, { n: number; pnlU: number }>();
  for (const b of bets) {
    const k = isoWeekKey(b.decisionTimestamp);
    const w = weekMap.get(k) ?? { n: 0, pnlU: 0 };
    w.n += 1;
    w.pnlU += b.pnlU;
    weekMap.set(k, w);
  }
  const WEEKLY = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, v]) => ({ week, n: v.n, pnlU: round(v.pnlU, 2), roiPct: round(v.n ? (v.pnlU / v.n) * 100 : 0, 4) }));
  const POSITIVE_BUCKET_N = WEEKLY.filter((w) => w.pnlU > 0).length;
  const NEGATIVE_BUCKET_N = WEEKLY.filter((w) => w.pnlU < 0).length;

  // Concentration.
  const dayPos = new Map<string, number>();
  let totalPos = 0;
  for (const b of bets) {
    if (b.pnlU > 0) {
      totalPos += b.pnlU;
      const k = dayKey(b.decisionTimestamp);
      dayPos.set(k, (dayPos.get(k) ?? 0) + b.pnlU);
    }
  }
  const largestDay = [...dayPos.values()].reduce((a, b) => Math.max(a, b), 0);
  const largestEvent = bets.reduce((a, b) => Math.max(a, b.pnlU > 0 ? b.pnlU : 0), 0);
  const LARGEST_DAY_PNL_SHARE_PCT = totalPos > 0 ? round((largestDay / totalPos) * 100, 2) : null;
  const LARGEST_SINGLE_EVENT_PNL_SHARE_PCT = totalPos > 0 ? round((largestEvent / totalPos) * 100, 2) : null;

  // Composition.
  const sportMap = new Map<string, number>();
  const famMap = new Map<string, number>();
  for (const b of bets) {
    sportMap.set(b.sportFamily, (sportMap.get(b.sportFamily) ?? 0) + 1);
    const fam = familyById.get(b.ref ?? "") ?? "unknown";
    famMap.set(fam, (famMap.get(fam) ?? 0) + 1);
  }
  const n = bets.length || 1;
  const SPORT_COMPOSITION = [...sportMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sport, c]) => ({ sport, n: c, sharePct: round((c / n) * 100, 2) }));
  const MARKET_FAMILY_COMPOSITION = [...famMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, c]) => ({ family: family ?? "unknown", n: c, sharePct: round((c / n) * 100, 2) }));

  return {
    MODEL_ID: id,
    ROLE: role,
    EXACT_PREDICATE: rule,
    PHYSICAL_EVENT_PARENT_N: joined.length,
    MODEL_ELIGIBLE_N: bets.length,
    SETTLED_BET_N: bets.length, // every recovered August row carries a terminal WIN/LOSS settlement
    W: m.WINS,
    L: m.LOSSES,
    PNL_U: m.PNL_U,
    ROI_PCT: m.ROI_PCT,
    MAX_DRAWDOWN_U: m.MAX_DRAWDOWN_U,
    BETS_PER_DAY: round(bets.length / spanDays, 2),
    WEEKLY,
    POSITIVE_BUCKET_N,
    NEGATIVE_BUCKET_N,
    LARGEST_DAY_PNL_SHARE_PCT,
    LARGEST_SINGLE_EVENT_PNL_SHARE_PCT,
    SPORT_COMPOSITION,
    MARKET_FAMILY_COMPOSITION,
  };
}

function main(): void {
  const { joined, baseEventN, inputAfterFilter } = buildRows();

  // Decision-time span of the basis.
  let minD = "9";
  let maxD = "0";
  for (const j of joined) {
    const d = j.ev.decisionTimestamp;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const spanDays = (Date.parse(maxD) - Date.parse(minD)) / 86_400_000;

  const reports = MODELS.map((mdl) =>
    evaluateModel(mdl.predicate, mdl.rule, mdl.id, mdl.role, joined, spanDays),
  );

  const scorecard = {
    mission: "RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1",
    basis: {
      dataset_id: "AUGUST_MAIN_DB_ENRICHMENT_V1",
      sha256: EXPECTED_MAIN_SHA256,
      formula_version: "shadow-strategic-sports-v1",
      base_event_n_expected: EXPECTED_MAIN_BASE_EVENT_N,
      base_event_n_observed: baseEventN,
      base_event_n_match: baseEventN === EXPECTED_MAIN_BASE_EVENT_N,
      physical_event_parent_n_after_price_and_sport_presence_filter: inputAfterFilter,
      decision_span_start: minD,
      decision_span_end: maxD,
      span_days: round(spanDays, 3),
      settlement: "flat 1u; WIN pnl_u = 1/entry_price - 1; LOSS pnl_u = -1; every recovered row carries a terminal WIN/LOSS",
      one_bet_per_physical_event: "chronologically first row per physicalEventKey satisfying the predicate (research-engine engine.ts semantics, unchanged)",
    },
    models: reports,
  };

  const json = JSON.stringify(scorecard, null, 2);

  const md: string[] = [];
  md.push("# RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1 — six-model summer scorecard\n");
  md.push(`basis: AUGUST_MAIN_DB_ENRICHMENT_V1  sha256=${EXPECTED_MAIN_SHA256}`);
  md.push(`formula_version=shadow-strategic-sports-v1  base_event_n=${baseEventN}  price+sport-present parent N=${inputAfterFilter}`);
  md.push(`decision span ${minD} -> ${maxD}  (${round(spanDays, 2)} days)\n`);
  md.push("| model | predicate | N | W | L | PnL_u | ROI% | MaxDD_u | bets/day | +wk | -wk |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    md.push(
      `| ${r.MODEL_ID} | ${r.EXACT_PREDICATE} | ${r.MODEL_ELIGIBLE_N} | ${r.W} | ${r.L} | ${r.PNL_U.toFixed(2)} | ${r.ROI_PCT.toFixed(2)} | ${r.MAX_DRAWDOWN_U.toFixed(2)} | ${r.BETS_PER_DAY} | ${r.POSITIVE_BUCKET_N} | ${r.NEGATIVE_BUCKET_N} |`,
    );
  }
  md.push("");
  for (const r of reports) {
    md.push(`## ${r.MODEL_ID} — ${r.ROLE}`);
    md.push(`weekly: ${r.WEEKLY.map((w) => `${w.week}:${w.pnlU.toFixed(1)}u/${w.roiPct.toFixed(1)}%(n${w.n})`).join("  ")}`);
    md.push(`largest single-day positive-PnL share: ${r.LARGEST_DAY_PNL_SHARE_PCT}%  largest single-event share: ${r.LARGEST_SINGLE_EVENT_PNL_SHARE_PCT}%`);
    md.push(`sport: ${r.SPORT_COMPOSITION.map((s) => `${s.sport} ${s.n} (${s.sharePct}%)`).join(", ")}`);
    md.push(`market family: ${r.MARKET_FAMILY_COMPOSITION.slice(0, 8).map((s) => `${s.family} ${s.n} (${s.sharePct}%)`).join(", ")}`);
    md.push("");
  }
  const mdText = md.join("\n") + "\n";

  const args = process.argv.slice(2);
  const j = args.indexOf("--json-out");
  const mo = args.indexOf("--md-out");
  if (j >= 0 && args[j + 1]) writeFileSync(args[j + 1], json);
  if (mo >= 0 && args[mo + 1]) writeFileSync(args[mo + 1], mdText);
  process.stdout.write(json + "\n");
  process.stdout.write(mdText);
}

main();
