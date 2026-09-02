/**
 * AUGUST_C4_SCORECARD_REPRODUCIBILITY_V1
 *
 * Thin, permanent, deterministic reproduction of the four accepted frozen
 * August cohorts (C4_BASELINE / C4_SOCCER_FIRST_TO_SCORE / C4_SOCCER_EXACT_SCORE
 * / C4_UWCL) from the recovered immutable AUGUST_MAIN_DB_ENRICHMENT_V1 artifact.
 *
 * Reuses, unchanged:
 *  - the C4 predicate, chronological ordering, settlement (flat 1u) and
 *    PNL/ROI/MaxDD math from lib/modeling/research-engine/** (models.ts /
 *    engine.ts / metrics.ts / settlement.ts) -- NOT reimplemented here;
 *  - field semantics defined by lib/modeling/august-enrichment/types.ts
 *    (EnrichedRow / TaxonomyRow) for how sport_family / market_type_raw /
 *    provider_sport_code / settlement map onto that engine's input contract.
 *
 * No DB call, no Gamma call, no rebuild of the August artifacts. This script
 * only READS already-produced, already-accepted JSONL files and joins them
 * by `id` -- the same join key the recovered artifact's own manifest already
 * declares (`base.id`, `UPSTREAM` in SHA256_MANIFEST.txt).
 *
 * Cohort selectors (unchanged from the frozen tracked context,
 * lib/modeling/forward-rich/augustFrozenResearchContext.ts):
 *   C4_BASELINE                  -> model=C4, no extra filter
 *   C4_SOCCER_FIRST_TO_SCORE     -> model=C4, market_type_raw=soccer_first_to_score
 *   C4_SOCCER_EXACT_SCORE        -> model=C4, market_type_raw=soccer_exact_score
 *   C4_UWCL                      -> model=C4, provider_sport_code=uwcl
 *
 * Usage:
 *   npx tsx scripts/modeling/august-c4-scorecard.ts [--json-out FILE] [--md-out FILE]
 *
 * Deterministic: same input bytes -> byte-identical stdout on every run.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { runModel } from "@/lib/modeling/research-engine/engine";
import type { ResearchEngineInputEvent } from "@/lib/modeling/research-engine/types";

// ---------------------------------------------------------------------------
// Expected accepted artifact identity (do not change without a new mission).
// ---------------------------------------------------------------------------
const EXPECTED_MAIN_SHA256 =
  "3e3472839dab244ee0b18b7435fd882a21a440042928a10ed5f6111c93697e93";
const EXPECTED_MAIN_BASE_EVENT_N = 18705;

const MAIN_JSONL_CANDIDATES = [
  "modeling/local_exports/august_main_db_enrichment_v1/AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl",
];
const MAIN_JSONL_GZ_FALLBACK =
  "modeling/evidence/august-cloud-artifact-recovery/AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl.gz";

const UPSTREAM_JSONL =
  "modeling/local_exports/august_enriched_research_dataset_v1/AUGUST_ENRICHED_RESEARCH_DATASET_V1.jsonl";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Load the main artifact bytes, verifying identity, preferring the raw file. */
function loadMainArtifactText(): string {
  for (const path of MAIN_JSONL_CANDIDATES) {
    if (existsSync(path)) {
      const buf = readFileSync(path);
      const hash = sha256(buf);
      if (hash !== EXPECTED_MAIN_SHA256) {
        throw new Error(
          `august-c4-scorecard: ${path} SHA256 mismatch. expected=${EXPECTED_MAIN_SHA256} actual=${hash}`,
        );
      }
      return buf.toString("utf8");
    }
  }
  if (existsSync(MAIN_JSONL_GZ_FALLBACK)) {
    const gz = readFileSync(MAIN_JSONL_GZ_FALLBACK);
    const buf = gunzipSync(gz);
    const hash = sha256(buf);
    if (hash !== EXPECTED_MAIN_SHA256) {
      throw new Error(
        `august-c4-scorecard: decompressed ${MAIN_JSONL_GZ_FALLBACK} SHA256 mismatch. expected=${EXPECTED_MAIN_SHA256} actual=${hash}`,
      );
    }
    return buf.toString("utf8");
  }
  throw new Error(
    "august-c4-scorecard: AUGUST_MAIN_DB_ENRICHMENT_V1 not found at any known location " +
      "(raw local_exports path or recovered evidence gzip). Refusing to rebuild.",
  );
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
    market_type_raw: { value: string | null };
    provider_sport_code: { value: string | null };
  };
}

interface UpstreamRow {
  base: { id: string };
  enrichment: { sport_family: { value: string | null } };
}

function parseJsonlLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

interface JoinedRow {
  id: string;
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number | null;
  sportFamily: string | null;
  outcome: "WIN" | "LOSS";
  marketTypeRaw: string | null;
  providerSportCode: string | null;
}

function buildJoinedRows(): { rows: JoinedRow[]; baseEventN: number } {
  const mainText = loadMainArtifactText();
  const mainRows = parseJsonlLines<MainRow>(mainText);

  const upstreamText = readFileSync(UPSTREAM_JSONL, "utf8");
  const upstreamRows = parseJsonlLines<UpstreamRow>(upstreamText);
  const sportFamilyById = new Map<string, string | null>();
  for (const r of upstreamRows) {
    sportFamilyById.set(r.base.id, r.enrichment.sport_family?.value ?? null);
  }

  const rows: JoinedRow[] = mainRows.map((r) => ({
    id: r.base.id,
    physicalEventKey: r.base.provider_event_id || r.base.condition_id,
    decisionTimestamp: r.base.decision_timestamp,
    eventStart: r.base.event_start,
    entryPrice: r.enrichment.entry_price?.value ?? null,
    sportFamily: sportFamilyById.get(r.base.id) ?? null,
    outcome: r.base.settlement.status,
    marketTypeRaw: r.enrichment.market_type_raw?.value ?? null,
    providerSportCode: r.enrichment.provider_sport_code?.value ?? null,
  }));

  return { rows, baseEventN: mainRows.length };
}

interface EngineEventWithSource {
  event: ResearchEngineInputEvent;
  marketTypeRaw: string | null;
  providerSportCode: string | null;
}

function toEngineInputs(rows: JoinedRow[]): EngineEventWithSource[] {
  const out: EngineEventWithSource[] = [];
  for (const r of rows) {
    if (r.entryPrice == null || !(r.entryPrice > 0 && r.entryPrice < 1)) continue;
    if (!r.sportFamily) continue;
    out.push({
      event: {
        physicalEventKey: r.physicalEventKey,
        decisionTimestamp: r.decisionTimestamp,
        eventStart: r.eventStart,
        entryPrice: r.entryPrice,
        sportFamily: r.sportFamily,
        outcome: r.outcome,
        ref: r.id,
      },
      marketTypeRaw: r.marketTypeRaw,
      providerSportCode: r.providerSportCode,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selected-side (YES/NO) + entry-price distribution for the exact-score
// cohort. `outcomeName` is not carried by either recovered artifact (neither
// AUGUST_MAIN_DB_ENRICHMENT_V1 nor its upstream persist selected-outcome
// text) -- it is read from the already-existing, already-local strategic
// substrate checkpoint chunks (same August production lineage, keyed by the
// identical `id`), which is the only place this field survives locally.
// This is a lookup, not a rebuild: no filter, no threshold, no new row.
// ---------------------------------------------------------------------------
const SUBSTRATE_CHUNK_DIR =
  "modeling/local_exports/summer_canonical_substrate_v3/_checkpoints/stage3_main_chunks";

function loadOutcomeNameById(ids: Set<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!existsSync(SUBSTRATE_CHUNK_DIR) || ids.size === 0) return out;
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(SUBSTRATE_CHUNK_DIR).filter((f: string) => f.endsWith(".ndjson"));
  for (const f of files) {
    if (out.size >= ids.size) break;
    const data = readFileSync(join(SUBSTRATE_CHUNK_DIR, f), "utf8");
    let start = 0;
    while (start < data.length) {
      let end = data.indexOf("\n", start);
      if (end === -1) end = data.length;
      const line = data.slice(start, end);
      start = end + 1;
      if (!line) continue;
      // Cheap pre-filter before JSON.parse.
      let idMatch = false;
      for (const id of ids) {
        if (!out.has(id) && line.includes(id)) { idMatch = true; break; }
      }
      if (!idMatch) continue;
      const r = JSON.parse(line);
      if (r?.id && ids.has(r.id) && !out.has(r.id)) {
        out.set(r.id, r.diagnostics?.outcomeName ?? null);
      }
    }
  }
  return out;
}

function quantile(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.floor(f * (sorted.length - 1));
  return sorted[idx];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { rows, baseEventN } = buildJoinedRows();
  const allEnginePairs = toEngineInputs(rows);
  const allEvents = allEnginePairs.map((p) => p.event);

  const cohorts: Array<{ id: string; label: string; events: ResearchEngineInputEvent[] }> = [
    { id: "C4_BASELINE", label: "C4 baseline (no extra filter)", events: allEvents },
    {
      id: "C4_SOCCER_FIRST_TO_SCORE",
      label: "C4 + market_type_raw=soccer_first_to_score",
      events: allEnginePairs.filter((p) => p.marketTypeRaw === "soccer_first_to_score").map((p) => p.event),
    },
    {
      id: "C4_SOCCER_EXACT_SCORE",
      label: "C4 + market_type_raw=soccer_exact_score",
      events: allEnginePairs.filter((p) => p.marketTypeRaw === "soccer_exact_score").map((p) => p.event),
    },
    {
      id: "C4_UWCL",
      label: "C4 + provider_sport_code=uwcl",
      events: allEnginePairs.filter((p) => p.providerSportCode === "uwcl").map((p) => p.event),
    },
  ];

  const results: Record<string, ReturnType<typeof runModel>> = {};
  for (const c of cohorts) {
    results[c.id] = runModel("C4", c.events);
  }

  // Exact-score semantics check: selected side + entry-price distribution,
  // computed only over the rows the engine actually SELECTED for C4_SOCCER_EXACT_SCORE.
  const exactScoreSelected = results.C4_SOCCER_EXACT_SCORE.selectedBets;
  const exactScoreIds = new Set(exactScoreSelected.map((b) => b.ref).filter(Boolean) as string[]);
  const outcomeNameById = loadOutcomeNameById(exactScoreIds);
  let yesN = 0;
  let noN = 0;
  let otherN = 0;
  for (const id of exactScoreIds) {
    const name = outcomeNameById.get(id);
    if (name === "Yes") yesN++;
    else if (name === "No") noN++;
    else otherN++;
  }
  const prices = exactScoreSelected.map((b) => b.entryPrice).sort((a, b) => a - b);
  const priceDist = {
    MIN: prices.length ? round2(prices[0]) : null,
    P25: prices.length ? round2(quantile(prices, 0.25)) : null,
    MEDIAN: prices.length ? round2(quantile(prices, 0.5)) : null,
    P75: prices.length ? round2(quantile(prices, 0.75)) : null,
    MAX: prices.length ? round2(prices[prices.length - 1]) : null,
  };

  const anchors: Record<string, { N: number; PNL_U: number; ROI_PCT: number; MAX_DD_U: number }> = {
    C4_BASELINE: { N: 4117, PNL_U: 474.56, ROI_PCT: 11.5269, MAX_DD_U: -16.41 },
    C4_SOCCER_FIRST_TO_SCORE: { N: 621, PNL_U: 103.29, ROI_PCT: 16.63, MAX_DD_U: -13.31 },
    C4_SOCCER_EXACT_SCORE: { N: 196, PNL_U: 113.13, ROI_PCT: 57.72, MAX_DD_U: -6.0 },
    C4_UWCL: { N: 87, PNL_U: 22.35, ROI_PCT: 25.69, MAX_DD_U: -3.0 },
  };

  const scorecard: Record<string, unknown> = {
    mission: "AUGUST_C4_SCORECARD_REPRODUCIBILITY_V1",
    artifact: {
      id: "AUGUST_MAIN_DB_ENRICHMENT_V1",
      sha256: EXPECTED_MAIN_SHA256,
      base_event_n_expected: EXPECTED_MAIN_BASE_EVENT_N,
      base_event_n_observed: baseEventN,
      base_event_n_match: baseEventN === EXPECTED_MAIN_BASE_EVENT_N,
    },
    cohorts: {} as Record<string, unknown>,
    exact_score_semantics: {
      SELECTED_N: exactScoreSelected.length,
      OUTCOME_NAME_RESOLVED_N: yesN + noN,
      OUTCOME_NAME_COVERAGE_PCT: exactScoreSelected.length
        ? round2((100 * (yesN + noN)) / exactScoreSelected.length)
        : null,
      OUTCOME_NAME_COVERAGE_NOTE:
        "outcomeName is not carried by AUGUST_MAIN_DB_ENRICHMENT_V1 or its upstream; resolved " +
        "here by id-join against the local summer_canonical_substrate_v3 checkpoint chunks, " +
        `which only cover 2026-08-05..2026-08-12 of the full 2026-08-05..2026-08-25 cohort ` +
        "window. Unresolved rows are reported as UNKNOWN_N, not guessed.",
      YES_N: yesN,
      NO_N: noN,
      UNKNOWN_N: otherN,
      ENTRY_PRICE: priceDist,
    },
  };

  for (const c of cohorts) {
    const r = results[c.id];
    const a = anchors[c.id];
    (scorecard.cohorts as Record<string, unknown>)[c.id] = {
      label: c.label,
      N: r.SELECTED_PHYSICAL_EVENT_N,
      W: r.WINS,
      L: r.LOSSES,
      PNL_U: r.PNL_U,
      ROI_PCT: r.ROI_PCT,
      MAX_DRAWDOWN_U: r.MAX_DRAWDOWN_U,
      anchor: a,
      anchor_match: {
        N: r.SELECTED_PHYSICAL_EVENT_N === a.N,
        PNL_U: Math.abs(r.PNL_U - a.PNL_U) < 0.01,
        ROI_PCT: Math.abs(r.ROI_PCT - a.ROI_PCT) < 0.01,
        MAX_DRAWDOWN_U: Math.abs(r.MAX_DRAWDOWN_U - a.MAX_DD_U) < 0.01,
      },
    };
  }

  const json = JSON.stringify(scorecard, null, 2);

  const md: string[] = [];
  md.push("# AUGUST_C4_SCORECARD_REPRODUCIBILITY_V1\n");
  md.push(`artifact: AUGUST_MAIN_DB_ENRICHMENT_V1  sha256=${EXPECTED_MAIN_SHA256}`);
  md.push(`base_event_n: expected=${EXPECTED_MAIN_BASE_EVENT_N} observed=${baseEventN} match=${baseEventN === EXPECTED_MAIN_BASE_EVENT_N}\n`);
  md.push("| cohort | N | W | L | PNL_U | ROI_PCT | MAX_DD_U | anchor N/PNL/ROI/DD | match |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of cohorts) {
    const r = results[c.id];
    const a = anchors[c.id];
    const m = (scorecard.cohorts as any)[c.id].anchor_match;
    const allMatch = m.N && m.PNL_U && m.ROI_PCT && m.MAX_DRAWDOWN_U;
    md.push(
      `| ${c.id} | ${r.SELECTED_PHYSICAL_EVENT_N} | ${r.WINS} | ${r.LOSSES} | ${r.PNL_U.toFixed(2)} | ${r.ROI_PCT.toFixed(4)}% | ${r.MAX_DRAWDOWN_U.toFixed(2)} | ${a.N}/${a.PNL_U}/${a.ROI_PCT}%/${a.MAX_DD_U} | ${allMatch ? "MATCH" : "MISMATCH"} |`,
    );
  }
  md.push("");
  md.push(
    `exact-score selected side (N=${exactScoreSelected.length}, outcomeName resolved for ${yesN + noN} = ${
      exactScoreSelected.length ? round2((100 * (yesN + noN)) / exactScoreSelected.length) : 0
    }%): YES_N=${yesN} NO_N=${noN} UNKNOWN_N=${otherN}`,
  );
  md.push(
    `exact-score entry price: MIN=${priceDist.MIN} P25=${priceDist.P25} MEDIAN=${priceDist.MEDIAN} P75=${priceDist.P75} MAX=${priceDist.MAX}`,
  );
  const mdText = md.join("\n") + "\n";

  const args = process.argv.slice(2);
  const jsonOutIdx = args.indexOf("--json-out");
  const mdOutIdx = args.indexOf("--md-out");
  if (jsonOutIdx >= 0 && args[jsonOutIdx + 1]) writeFileSync(args[jsonOutIdx + 1], json);
  if (mdOutIdx >= 0 && args[mdOutIdx + 1]) writeFileSync(args[mdOutIdx + 1], mdText);

  process.stdout.write(json + "\n");
  process.stdout.write(mdText);
}

main();
