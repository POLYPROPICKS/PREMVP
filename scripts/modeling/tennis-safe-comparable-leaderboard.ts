/**
 * TENNIS_SAFE_COMPARABLE_LEADERBOARD_V1 — rebuilds the CURRENT comparable
 * model leaderboard over ONE shared safe-tennis universe.
 *
 * The old generic tennis population mixed a profitable
 * tennis_completed_match regime with ordinary/low-tier tennis that should
 * never have been eligible. This runner filters TENNIS rows to only those
 * that pass the shared live-money gate (lib/executor/tennisLiveEligibility.ts
 * resolveTennisMoneyEligibility — imported verbatim, never re-implemented
 * here) BEFORE any model predicate runs, so every _SAFE variant below shares
 * the exact same corrected tennis universe. Non-tennis rows are unaffected.
 *
 * Reuses the existing engine verbatim — no second sync/capacity engine:
 *   - C0/C4/C5 frozen predicates: lib/modeling/research-engine/models.ts
 *   - PORTFOLIO_BROAD tiers: scripts/modeling/daily-portfolio-frontier.ts
 *   - QUALITY_FILL_A/D tiers: scripts/modeling/quality-fill-portfolio-test.ts
 *   - runStandalone/runPortfolio/applyDailyCap/computeCapacity/metricsFor/
 *     computeDailyResults: scripts/modeling/daily-portfolio-frontier.ts
 *   - toAtlasInput normalizer: scripts/modeling/factor-atlas.ts
 *   - evaluateEvent/aggregateMetrics/settleBetU: lib/modeling/research-engine
 *
 * P50_52 (no _SAFE suffix) is the one unchanged generic raw benchmark
 * (RAW_LEGACY_BASELINE) — computed over the FULL, unfiltered universe,
 * exactly as it always has been, for comparison only.
 *
 * Where canonical_row lacks tournament identity (event title/slug, market
 * type text), it is enriched ONLY with identity metadata joined from
 * generated_signal_pairs on the exact (condition_id, selected_token_id) key,
 * decision-time-safe (only a GSP row with created_at <= decisionAt is ever
 * used) — never future outcome/settlement/price/volume fields.
 *
 * Source: research_model_ready_rows (RESEARCH CLONE, read-only). Writes a
 * NEW aggregate artifact under modeling/evidence/ — never touches the
 * dashboard, never mutates old artifacts, never edits frozen model
 * definitions.
 *
 *   npx tsx scripts/modeling/tennis-safe-comparable-leaderboard.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import "dotenv/config";

import { enumerateMinskDates, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { FROZEN_MODELS, SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import {
  resolveTennisMoneyEligibility,
  type TennisMoneyEligibilityDecision,
} from "@/lib/executor/tennisLiveEligibility";
import { toAtlasInput, type AtlasInputEvent } from "./factor-atlas";
import { PORTFOLIOS, runStandalone, runPortfolio, computeDailyResults, applyDailyCap, metricsFor, type TieredBet } from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const DISPLAY_CAPS = [30, 40, 50] as const;
const EVIDENCE_OUT_DIR = "modeling/evidence/tennis-safe-comparable-leaderboard-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";
const TENNIS_FAMILY = "tennis";
/** Chunk size for the .in("condition_id", ...) identity join, mirroring the established CID_CHUNK pattern. */
const CID_CHUNK = 200;

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

export const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

async function fetchRows(): Promise<ScorecardReadyRow[]> {
  const db = await resolveDb();
  const rows: ScorecardReadyRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select("canonical_row")
      .gte("model_date", START)
      .lte("model_date", END)
      .order("model_date")
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ── Decision-time-safe tournament-identity enrichment ───────────────────────
// canonical_row carries no event title/slug/tournament-level text. Only the
// exact (condition_id, selected_token_id) identity is used to join back to
// generated_signal_pairs, and only a candidate row whose created_at <=
// decisionAt is ever used (no future leak) — mirrors the point-in-time cut
// contract in lib/modeling/forward-rich/materializeForwardRichResearch.ts.
// No outcome/settlement/price/volume field is read from this join.

export interface IdentityCandidate {
  createdAt: string;
  structuredMarketType: string | null;
  marketText: string | null;
  eventIdentityText: string | null;
}

export type IdentityLookup = (conditionId: string, selectedTokenId: string, decisionAt: string) => IdentityCandidate | null;

/** Builds a decision-time-safe lookup from an unordered list of GSP candidate rows. */
export function buildIdentityLookup(rowsByPair: Map<string, IdentityCandidate[]>): IdentityLookup {
  const sorted = new Map<string, IdentityCandidate[]>();
  for (const [key, arr] of rowsByPair) sorted.set(key, [...arr].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  return (conditionId, selectedTokenId, decisionAt) => {
    const arr = sorted.get(`${conditionId}::${selectedTokenId}`);
    if (!arr) return null;
    let best: IdentityCandidate | null = null;
    for (const candidate of arr) {
      if (candidate.createdAt <= decisionAt) best = candidate;
      else break;
    }
    return best;
  };
}

async function fetchTennisIdentityLookup(db: any, conditionIds: string[]): Promise<IdentityLookup> {
  const rowsByPair = new Map<string, IdentityCandidate[]>();
  const unique = [...new Set(conditionIds)].filter(Boolean);
  for (let i = 0; i < unique.length; i += CID_CHUNK) {
    const slice = unique.slice(i, i + CID_CHUNK);
    const { data, error } = await db
      .from("generated_signal_pairs")
      .select("condition_id,selected_token_id,created_at,event_slug,market_slug,diagnostics")
      .in("condition_id", slice);
    if (error) throw new Error(`FETCH_TENNIS_IDENTITY:${error.code ?? error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const conditionId = String(r.condition_id ?? "");
      const selectedTokenId = String(r.selected_token_id ?? "");
      if (!conditionId || !selectedTokenId) continue;
      const diag = (r.diagnostics ?? {}) as Record<string, unknown>;
      // Tennis GSP rows nest their identity under diagnostics.providerEventContext
      // (eventTitle/marketQuestion/marketType); some other sources carry a flat
      // diagnostics.marketTitle/marketType instead. Check both, flat first.
      const ctx = (diag.providerEventContext ?? {}) as Record<string, unknown>;
      const structuredMarketType = (typeof diag.marketType === "string" ? diag.marketType : null) ?? (typeof ctx.marketType === "string" ? ctx.marketType : null);
      const marketSlug = typeof r.market_slug === "string" ? r.market_slug : null;
      const eventSlug = typeof r.event_slug === "string" ? r.event_slug : null;
      const marketText =
        (typeof diag.marketTitle === "string" ? diag.marketTitle : null) ?? (typeof ctx.marketQuestion === "string" ? ctx.marketQuestion : null) ?? marketSlug;
      const eventIdentityText =
        (typeof diag.eventTitle === "string" ? diag.eventTitle : null) ?? (typeof ctx.eventTitle === "string" ? ctx.eventTitle : null) ?? eventSlug ?? marketSlug;
      const key = `${conditionId}::${selectedTokenId}`;
      const list = rowsByPair.get(key);
      const candidate: IdentityCandidate = { createdAt: String(r.created_at ?? ""), structuredMarketType, marketText, eventIdentityText };
      if (list) list.push(candidate);
      else rowsByPair.set(key, [candidate]);
    }
  }
  return buildIdentityLookup(rowsByPair);
}

/**
 * Resolves the shared TENNIS live-money gate for one input row, reusing
 * resolveTennisMoneyEligibility() verbatim — never a re-derived rule.
 * marketTypeRaw already on canonical_row (when present) is preferred over
 * the joined identity's structuredMarketType; the join exists only to fill
 * in the identity/text fields canonical_row never carries.
 */
export function resolveSafeTennisDecision(
  e: Pick<AtlasInputEvent, "marketTypeRaw">,
  identity: IdentityCandidate | null,
): TennisMoneyEligibilityDecision {
  return resolveTennisMoneyEligibility({
    structuredMarketType: e.marketTypeRaw ?? identity?.structuredMarketType ?? null,
    marketText: identity?.marketText ?? null,
    eventIdentityText: identity?.eventIdentityText ?? null,
  });
}

export interface SafeUniverseResult {
  safeUniverse: AtlasInputEvent[];
  rawTennisN: number;
  approvedTennisN: number;
  excludedTennisInput: AtlasInputEvent[];
}

/**
 * ONE shared safe-tennis universe: non-tennis rows pass through unchanged;
 * a tennis row is retained only when resolveTennisMoneyEligibility says it
 * is eligible. Applied ONCE, upstream of every model predicate below — no
 * model-specific tennis logic exists anywhere else in this file.
 */
export function buildSafeUniverse(
  input: AtlasInputEvent[],
  selectedTokenIdOf: (e: AtlasInputEvent) => string | undefined,
  identityLookup: IdentityLookup,
): SafeUniverseResult {
  const safeUniverse: AtlasInputEvent[] = [];
  const excludedTennisInput: AtlasInputEvent[] = [];
  let rawTennisN = 0;
  let approvedTennisN = 0;
  for (const e of input) {
    if (e.sportFamily !== TENNIS_FAMILY) {
      safeUniverse.push(e);
      continue;
    }
    rawTennisN += 1;
    const selectedTokenId = selectedTokenIdOf(e);
    const identity = selectedTokenId ? identityLookup(e.ref ?? "", selectedTokenId, e.decisionTimestamp) : null;
    const decision = resolveSafeTennisDecision(e, identity);
    if (decision.eligible) {
      approvedTennisN += 1;
      safeUniverse.push(e);
    } else {
      excludedTennisInput.push(e);
    }
  }
  return { safeUniverse, rawTennisN, approvedTennisN, excludedTennisInput };
}

// ── Sport composition + fill rate reporting ─────────────────────────────────

export function sportSplit(bets: TieredBet[]) {
  const total = bets.length || 1;
  const footballN = bets.filter((b) => b.sportFamily === SOCCER_FAMILY).length;
  const tennisN = bets.filter((b) => b.sportFamily === TENNIS_FAMILY).length;
  const otherN = bets.length - footballN - tennisN;
  return {
    FOOTBALL_N: footballN,
    FOOTBALL_PCT: round((footballN / total) * 100, 1),
    TENNIS_N: tennisN,
    TENNIS_PCT: round((tennisN / total) * 100, 1),
    OTHER_N: otherN,
    OTHER_PCT: round((otherN / total) * 100, 1),
  };
}

/** Fraction of days in range whose UNCAPPED daily supply meets `cap`. */
export function fillRateAtCap(uncappedBets: TieredBet[], dates: string[], cap: number): number {
  if (dates.length === 0) return 0;
  const daily = computeDailyResults(uncappedBets, dates);
  return round(daily.filter((d) => d.event_n >= cap).length / dates.length, 4);
}

// ── QUALITY_FILL_A_SAFE cap30 already-approved live allocation ─────────────
// football >=20 supply that day: 20 football -> max 7 approved tennis -> other fills the rest.
// football <20 that day: all football -> approved tennis unrestricted -> other fills the rest.
// Reuses the same tier/decision/physicalEventKey ordering the generic capacity
// engine (applyDailyCap in daily-portfolio-frontier.ts) uses within a day —
// this function only changes WHICH sport buckets are prioritized and by how
// much, never the underlying selection/settlement.

function withinDayOrder(a: TieredBet, b: TieredBet): number {
  return a.tier - b.tier || a.decisionTimestamp.localeCompare(b.decisionTimestamp) || a.physicalEventKey.localeCompare(b.physicalEventKey);
}

export function applyQualityFillACap30(bets: TieredBet[], allDates: string[]): TieredBet[] {
  const byDay = new Map<string, TieredBet[]>();
  for (const bet of bets) {
    const list = byDay.get(bet.day);
    if (list) list.push(bet);
    else byDay.set(bet.day, [bet]);
  }
  const kept: TieredBet[] = [];
  for (const date of allDates) {
    const dayBets = (byDay.get(date) ?? []).slice().sort(withinDayOrder);
    const football = dayBets.filter((b) => b.sportFamily === SOCCER_FAMILY);
    const tennis = dayBets.filter((b) => b.sportFamily === TENNIS_FAMILY);
    const other = dayBets.filter((b) => b.sportFamily !== SOCCER_FAMILY && b.sportFamily !== TENNIS_FAMILY);
    const fb = football.length >= 20 ? football.slice(0, 20) : football;
    const tn = football.length >= 20 ? tennis.slice(0, 7) : tennis;
    const remaining = Math.max(0, 30 - fb.length - tn.length);
    const ot = other.slice(0, remaining);
    kept.push(...fb, ...tn, ...ot);
  }
  return kept;
}

// ── Model definitions: non-tennis semantics reused verbatim; tennis is
// governed ONLY by the shared safe universe built above — no per-model
// tennis predicate exists here. ───────────────────────────────────────────

interface CapRow {
  MODEL: string;
  CAP: number | "UNCAPPED";
  N: number;
  PNL_U: number;
  ROI_PCT: number;
  MAX_DD_U: number;
  FILL_RATE: number;
  FOOTBALL_N: number;
  FOOTBALL_PCT: number;
  TENNIS_N: number;
  TENNIS_PCT: number;
  OTHER_N: number;
  OTHER_PCT: number;
}

function rowFor(modelId: string, cap: number, uncapped: TieredBet[], dates: string[], cappedOverride?: TieredBet[]): CapRow {
  const capped = cappedOverride ?? applyDailyCap(uncapped, cap);
  const m = metricsFor(capped);
  return {
    MODEL: modelId,
    CAP: cap,
    N: m.events,
    PNL_U: m.pnl_u,
    ROI_PCT: m.roi_pct,
    MAX_DD_U: m.max_drawdown_u,
    FILL_RATE: fillRateAtCap(uncapped, dates, cap),
    ...sportSplit(capped),
  };
}

function uncappedRow(modelId: string, bets: TieredBet[]): CapRow {
  const m = metricsFor(bets);
  return {
    MODEL: modelId,
    CAP: "UNCAPPED",
    N: m.events,
    PNL_U: m.pnl_u,
    ROI_PCT: m.roi_pct,
    MAX_DD_U: m.max_drawdown_u,
    FILL_RATE: 1,
    ...sportSplit(bets),
  };
}

async function main() {
  const rawRows = await fetchRows();
  const input = toAtlasInput(rawRows);
  const dates = enumerateMinskDates(START, END);

  const rawBySelectedTokenId = new Map(rawRows.map((r) => [`${r.conditionId}|${r.decisionAt}`, r.selectedTokenId]));
  const selectedTokenIdOf = (e: AtlasInputEvent) => rawBySelectedTokenId.get(`${e.ref}|${e.decisionTimestamp}`);

  const tennisConditionIds = input.filter((e) => e.sportFamily === TENNIS_FAMILY).map((e) => e.ref).filter((v): v is string => !!v);
  const db = await resolveDb();
  const identityLookup = await fetchTennisIdentityLookup(db, tennisConditionIds);

  const { safeUniverse, rawTennisN, approvedTennisN, excludedTennisInput } = buildSafeUniverse(input, selectedTokenIdOf, identityLookup);
  const excludedTennisBets = runStandalone(excludedTennisInput, () => true);
  const excludedTennisPnlU = metricsFor(excludedTennisBets).pnl_u;

  // RAW_LEGACY_BASELINE — unchanged, computed over the FULL unfiltered universe.
  const p5052Raw = runStandalone(input, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52);

  const broadTiers = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")!.tiers;

  const modelBets: Record<string, TieredBet[]> = {
    P50_52_SAFE: runStandalone(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52),
    P50_54_SAFE: runStandalone(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54),
    PORTFOLIO_BROAD_SAFE: runPortfolio(safeUniverse, broadTiers),
    QUALITY_FILL_A_SAFE: runPortfolio(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_A as Array<(e: any) => boolean>),
    QUALITY_FILL_D_SAFE: runPortfolio(safeUniverse, QUALITY_PORTFOLIOS.QUALITY_FILL_D as Array<(e: any) => boolean>),
    C0_SAFE: runStandalone(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e)),
    C4_SAFE: runStandalone(safeUniverse, (e) => FROZEN_MODELS.C4.predicate(e)),
    C5_SAFE: runStandalone(safeUniverse, (e) => FROZEN_MODELS.C5.predicate(e)),
    C0_ONLY_NOT_C1_SAFE: runStandalone(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e) && e.sportFamily !== SOCCER_FAMILY),
    SCORE63_64_SAFE: runStandalone(safeUniverse, (e) => FROZEN_MODELS.C0.predicate(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65),
    TENNIS_P50_52_SAFE: runStandalone(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52 && e.sportFamily === TENNIS_FAMILY),
  };

  const table: CapRow[] = [uncappedRow("P50_52 (RAW_LEGACY_BASELINE)", p5052Raw)];
  for (const [modelId, bets] of Object.entries(modelBets)) {
    table.push(uncappedRow(modelId, bets));
    for (const cap of DISPLAY_CAPS) {
      const override = modelId === "QUALITY_FILL_A_SAFE" && cap === 30 ? applyQualityFillACap30(bets, dates) : undefined;
      table.push(rowFor(modelId, cap, bets, dates, override));
    }
  }

  const artifact = {
    MISSION: "TENNIS_SAFE_COMPARABLE_LEADERBOARD_V1",
    DATASET_RANGE: { start: START, end: END },
    SOURCE_ROW_N: rawRows.length,
    PROCESSED_N: input.length,
    TENNIS_SAFE_UNIVERSE: {
      RAW_TENNIS_N: rawTennisN,
      APPROVED_TENNIS_N: approvedTennisN,
      EXCLUDED_TENNIS_N: rawTennisN - approvedTennisN,
      EXCLUDED_TENNIS_PNL_U: round(excludedTennisPnlU, 4),
    },
    TABLE: table,
  };

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/LEADERBOARD_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
