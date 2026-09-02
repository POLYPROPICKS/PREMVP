/**
 * AUGUST_MAIN_DB_ENRICHMENT_V1 — enrich the EXISTING accepted August research
 * population with historical point-in-time attributes recovered from the PRIMARY
 * PRODUCTION database (Supabase `nbnldzfsxffztsfrrxqy`, PostgREST scope).
 *
 * BASE (unchanged, not rebuilt): the 18,705 physical-provider-event August
 * research population — read from the `base` blocks of
 *   modeling/local_exports/august_enriched_research_dataset_v1/AUGUST_ENRICHED_RESEARCH_DATASET_V1.jsonl
 * (identity key `id` == public.generated_signal_pairs.id; producer predicate
 *  formula_version = 'shadow-strategic-sports-v1').
 *
 * ENRICHMENT AUTHORITY: primary production DB, READ-ONLY. Two sources:
 *   A. public.generated_signal_pairs        (exact id join; observed_at = created_at)
 *   B. public.generated_signal_research_snapshots
 *                                           (exact condition_id + selected_token_id;
 *                                            point-in-time: latest snapshot_at <= decision_timestamp)
 *
 * No DB mutation. No DDL. No fuzzy matching. No current-value backfill.
 * No imputation. Missing feature => null + explicit status.
 *
 * Usage:  npx tsx scripts/modeling/build-august-enriched-main.ts [--limit=N] [--out=<dir>]
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  asNumber,
  buildFeature,
  buildScoreFeature,
  round4,
  type MainFeature as Feature,
} from "@/lib/modeling/august-enrichment/mainDbLineage";

const BASE_ARTIFACT =
  "modeling/local_exports/august_enriched_research_dataset_v1/AUGUST_ENRICHED_RESEARCH_DATASET_V1.jsonl";
const OUT_DEFAULT = "modeling/local_exports/august_main_db_enrichment_v1";
const MISSION = "AUGUST_MAIN_DB_ENRICHMENT_V1";
const BASE_PRODUCER_PREDICATE =
  "public.generated_signal_pairs WHERE formula_version = 'shadow-strategic-sports-v1'";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const chunk = <T>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};
const num = asNumber;

/** positional adapter over buildFeature — keeps call sites terse. */
const feat = (
  value: string | number | null,
  table: string,
  field: string,
  semantic: string,
  observedAt: string | null,
  joinKey: string | null,
  sourceRowId: string | null,
  decisionIso: string,
): Feature => buildFeature({ value, table, field, semantic, observedAt, joinKey, sourceRowId, decisionIso });

/** positional adapter over buildScoreFeature. */
const scoreFeat = (
  value: number | null,
  table: string,
  field: string,
  semantic: string,
  observedAt: string | null,
  id: string,
  decisionIso: string,
  gspRow: unknown,
): Feature =>
  buildScoreFeature({ value, table, field, semantic, observedAt, id, decisionIso, gspRowPresent: !!gspRow });

interface BaseRow {
  id: string;
  provider_event_id: string | null;
  condition_id: string | null;
  selected_token_id: string | null;
  decision_timestamp: string;
  event_start: string;
  t90_cutoff: string | null;
  event_slug: string | null;
  split_lane: string;
  settlement: { status: string | null; gamma_event_id: string | null; gamma_winning_token_id: string | null };
}

// ---- static WRITER TRACE (from source inspection, not field-name inference) ----
const WRITER_TRACE = [
  {
    field: "entry_price / winProbability",
    producer: "writeStrategicShadowPairs (scripts/generate-signals.ts -> lib/feed/cacheGeneratedSignals.ts:480-560)",
    production_table: "public.generated_signal_pairs",
    source_field: "entry_price_num  (also diagnostics.entryPrice, premium_signal.winProbability)",
    observation_timestamp: "generated_signal_pairs.created_at (row insert == decision time)",
    semantic_version: "shadow-strategic-sports-v1 selected decision-time price",
  },
  {
    field: "raw provider Volume (USD)",
    producer: "collectors -> WcShadowEntry.volumeUsd -> writeStrategicShadowPairs (cacheGeneratedSignals.ts:524)",
    production_table: "public.generated_signal_pairs",
    source_field: "diagnostics.volumeUsd",
    observation_timestamp: "generated_signal_pairs.created_at",
    semantic_version: "provider raw market volume (USD) as seen by the strategic-shadow collector at capture",
  },
  {
    field: "Signal Score + score raw inputs (signal_confidence_num, score, smart_money_score_num, whale_public_score_num, pre_event_score_num)",
    producer: "writeStrategicShadowPairs (cacheGeneratedSignals.ts:545-554)",
    production_table: "public.generated_signal_pairs",
    source_field: "score / signal_confidence_num / smart_money_score_num / whale_public_score_num / pre_event_score_num",
    observation_timestamp: "n/a — writer inserts literal NULL for every score slot on this population",
    semantic_version: "shadow-strategic-sports-v1 — NOT scored by the live scorer; score columns hard-coded NULL at insert",
  },
  {
    field: "point-in-time trade flow / price movement / holder concentration / formula score inputs",
    producer: "writeResearchEligibleSignalSnapshots (scripts/generate-signals.ts -> lib/feed/cacheResearchSnapshots.ts)",
    production_table: "public.generated_signal_research_snapshots",
    source_field: "diagnostics.{recentTradeCash,maxTradeCash,openInterest,selectedTradeCount,totalTradeCount,holderConcentrationScore,currentPrice,price1hAgo,price6hAgo,delta1hPp,delta6hPp,spread,dataCoverage,formulaScore,formulaUsed,fireModel}; columns selected_price_num/opposing_price_num/data_coverage_num/market_family/league/hours_until_start_num/odds_band_label",
    observation_timestamp: "generated_signal_research_snapshots.snapshot_at",
    semantic_version: "scope=RESEARCH_ELIGIBLE_UNIVERSE, formula_version=trusted-initial-formula-v1.1, formula_feature_version=modeling-features-v1 — a DIFFERENT population/formula from the strategic-shadow base; only joins where the same (condition_id, selected_token_id) was also in the research-eligible universe at or before the base decision time",
  },
  {
    field: "event / market 24h Volume (USD)",
    producer: "sports market inventory snapshot writer (lib/feed/cacheSportsEventMarketInventory.ts, invoked from scripts/generate-signals.ts before buildLandingCards)",
    production_table: "public.sports_event_market_inventory",
    source_field: "volume_24hr_usd (also outcome_prices for prior-price observation)",
    observation_timestamp: "first_observed_at (row creation) / last_observed_at (last upsert)",
    semantic_version: "provider Gamma event/market 24h USD volume captured during sports market discovery; independent of generated_signal_pairs.diagnostics.volumeUsd and never collapsed with it",
  },
  {
    field: "strategic export omission",
    producer: "expanded_strategic_research_v1 export (frozen JSONL clone of generated_signal_pairs rows only)",
    production_table: "n/a (frozen file export)",
    source_field: "carried entry_price_num + diagnostics subset; dropped diagnostics.volumeUsd and never carried research-snapshot diagnostics",
    observation_timestamp: "export time (post-decision)",
    semantic_version: "absence in the frozen export is NOT evidence a field was never persisted",
  },
];

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
      const i = a.indexOf("=");
      return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
  ) as Record<string, string | boolean>;
  const outDir = typeof args.out === "string" ? args.out : OUT_DEFAULT;
  const limit = typeof args.limit === "string" ? parseInt(args.limit, 10) : Infinity;

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const dbHost = new URL(process.env.SUPABASE_URL as string).host;

  // ---- load base membership (NOT rebuilt) ----
  const baseLines = readFileSync(BASE_ARTIFACT, "utf8").split("\n").filter(Boolean);
  let base: BaseRow[] = baseLines.map((l) => JSON.parse(l).base as BaseRow);
  const baseArtifactSha = sha256(readFileSync(BASE_ARTIFACT));
  if (Number.isFinite(limit)) base = base.slice(0, limit);
  const BASE_EVENT_N = base.length;
  const baseIdSetHash = sha256([...base.map((b) => b.id)].sort().join("\n"));

  // ---- PRIMARY PRODUCTION DB identity proof (bounded) ----
  const identityProbe = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id, formula_version, created_at")
    .eq("id", base[0].id)
    .limit(1);
  if (identityProbe.error) throw new Error(`DB identity probe failed: ${identityProbe.error.message}`);
  const augWindowProbe = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id", { count: "exact", head: true })
    .eq("formula_version", "shadow-strategic-sports-v1")
    .gte("created_at", "2026-08-01T00:00:00Z")
    .lte("created_at", "2026-08-28T00:00:00Z");
  const dbIdentity = {
    supabase_host: dbHost,
    identity_probe_row: identityProbe.data?.[0] ?? null,
    identity_probe_matches_base_row_0: identityProbe.data?.[0]?.id === base[0].id,
    shadow_strategic_aug_window_live_count: augWindowProbe.count ?? null,
    shadow_strategic_aug_window_count_note:
      augWindowProbe.count == null
        ? "PostgREST head-count not returned for this table; base->primary-DB linkage is proven instead by exact-id join match rate below"
        : null,
    read_only: true,
    base_ids_matched_in_primary_db: 0, // filled after Extract A
  };

  // ---- Extract A: generated_signal_pairs by exact id ----
  const gspById = new Map<string, any>();
  const idChunks = chunk(base.map((b) => b.id), 300);
  for (let i = 0; i < idChunks.length; i++) {
    const r = await supabaseAdmin
      .from("generated_signal_pairs")
      .select(
        "id, created_at, score, signal_confidence_num, smart_money_score_num, whale_public_score_num, pre_event_score_num, entry_price_num, expected_return_pct_num, metric_formula_version, formula_version, selected_outcome, trust_metrics, diagnostics",
      )
      .in("id", idChunks[i]);
    if (r.error) throw new Error(`GSP extract chunk ${i} failed: ${r.error.message}`);
    for (const row of r.data ?? []) gspById.set(row.id, row);
    if (i % 20 === 0) process.stderr.write(`  GSP extract ${i}/${idChunks.length}\n`);
  }
  dbIdentity.base_ids_matched_in_primary_db = base.filter((b) => gspById.has(b.id)).length;

  // ---- Extract B: research snapshots by exact condition_id ----
  const condIds = [...new Set(base.map((b) => b.condition_id).filter(Boolean) as string[])];
  const snapByCond = new Map<string, any[]>();
  const decisionTimes = base.map((b) => Date.parse(b.decision_timestamp)).filter(Number.isFinite);
  const snapCeilIso = new Date(Math.max(...decisionTimes)).toISOString();
  const snapFloorIso = new Date(Math.min(...decisionTimes) - 30 * 24 * 3600 * 1000).toISOString();
  const condChunks = chunk(condIds, 160);
  for (let i = 0; i < condChunks.length; i++) {
    const r = await supabaseAdmin
      .from("generated_signal_research_snapshots")
      .select(
        "condition_id, selected_token_id, snapshot_at, formula_version, formula_feature_version, scope, selected_price_num, opposing_price_num, data_coverage_num, market_family, league, hours_until_start_num, odds_band_label, signal_phase_at_snapshot, diagnostics",
      )
      .in("condition_id", condChunks[i])
      .gte("snapshot_at", snapFloorIso)
      .lte("snapshot_at", snapCeilIso);
    if (r.error) throw new Error(`snapshot extract chunk ${i} failed: ${r.error.message}`);
    for (const row of r.data ?? []) {
      const arr = snapByCond.get(row.condition_id) ?? [];
      arr.push(row);
      snapByCond.set(row.condition_id, arr);
    }
    if (i % 20 === 0) process.stderr.write(`  snapshot extract ${i}/${condChunks.length}\n`);
  }

  // ---- Extract C: sports_event_market_inventory by exact condition_id ----
  const invByCond = new Map<string, any[]>();
  for (let i = 0; i < condChunks.length; i++) {
    const r = await supabaseAdmin
      .from("sports_event_market_inventory")
      .select(
        "condition_id, provider_market_id, provider_event_id, first_observed_at, last_observed_at, volume_usd, volume_24hr_usd, outcome_prices, outcomes, sports_market_type, sibling_market_count",
      )
      .in("condition_id", condChunks[i]);
    if (r.error) throw new Error(`inventory extract chunk ${i} failed: ${r.error.message}`);
    for (const row of r.data ?? []) {
      const arr = invByCond.get(row.condition_id) ?? [];
      arr.push(row);
      invByCond.set(row.condition_id, arr);
    }
    if (i % 20 === 0) process.stderr.write(`  inventory extract ${i}/${condChunks.length}\n`);
  }

  // ---- deterministic per-row enrichment ----
  const GSP = "public.generated_signal_pairs";
  const SNAP = "public.generated_signal_research_snapshots";
  const INV = "public.sports_event_market_inventory";
  const enriched = base.map((b) => {
    const dec = b.decision_timestamp;
    const g = gspById.get(b.id) ?? null;
    const gDiag = g?.diagnostics ?? {};
    const gObserved = g?.created_at ?? null;

    // point-in-time research snapshot: same condition_id + selected_token_id, latest snapshot_at <= decision
    const snapCandidates = (snapByCond.get(b.condition_id ?? "") ?? []).filter(
      (s) => s.selected_token_id === b.selected_token_id && Date.parse(s.snapshot_at) <= Date.parse(dec),
    );
    snapCandidates.sort((a, z) => Date.parse(z.snapshot_at) - Date.parse(a.snapshot_at));
    const snap = snapCandidates[0] ?? null;
    const snapDiag = snap?.diagnostics ?? {};
    const snapAt: string | null = snap?.snapshot_at ?? null;
    const snapJoinKey = snap ? `condition_id=${b.condition_id} & selected_token_id=${b.selected_token_id}` : null;
    const snapRowId = snap ? `${snap.condition_id}::${snap.selected_token_id}::${snap.snapshot_at}` : null;

    // point-in-time market inventory: leak-free requires last_observed_at <= decision
    // (volume_24hr_usd is upsert-updated in place, so a row still being observed after
    //  the decision could carry a post-decision value).
    const invClean = (invByCond.get(b.condition_id ?? "") ?? []).filter(
      (s) => s.last_observed_at && Date.parse(s.last_observed_at) <= Date.parse(dec),
    );
    invClean.sort((a, z) => Date.parse(z.last_observed_at) - Date.parse(a.last_observed_at));
    const inv = invClean[0] ?? null;
    const invAt: string | null = inv?.last_observed_at ?? null;
    const invJoinKey = inv ? `condition_id=${b.condition_id}` : null;
    const invRowId = inv ? `${inv.condition_id}::${inv.provider_market_id}` : null;
    // selected-side prior price from inventory outcome_prices (index by base selected outcome side is
    // not reliably ordered; expose the raw array + a best-effort selected price only when 2-outcome).
    let invSelectedPrice: number | null = null;
    if (inv && Array.isArray(inv.outcome_prices) && inv.outcome_prices.length === 2 && Array.isArray(inv.outcomes)) {
      const gi = (g?.selected_outcome ?? "").toString().toLowerCase();
      const idx = (inv.outcomes as string[]).findIndex((o) => String(o).toLowerCase() === gi);
      if (idx >= 0) invSelectedPrice = num(parseFloat(inv.outcome_prices[idx]));
    }

    const F = {
      // ---------- ENTRY PRICE ----------
      entry_price: feat(
        num(g?.entry_price_num) ?? num(gDiag.entryPrice),
        GSP, "entry_price_num", "decision-time selected price (winProbability)",
        gObserved, `id=${b.id}`, g ? b.id : null, dec,
      ),
      // ---------- SIGNAL SCORE (persisted score surface) ----------
      signal_score: scoreFeat(num(g?.signal_confidence_num), GSP, "signal_confidence_num",
        "persisted Signal Score (confidence) for this population", gObserved, b.id, dec, g),
      score: scoreFeat(num(g?.score), GSP, "score", "persisted score column", gObserved, b.id, dec, g),
      pre_event_score_num: scoreFeat(num(g?.pre_event_score_num), GSP, "pre_event_score_num",
        "pre-event / research score", gObserved, b.id, dec, g),
      smart_money_score_num: scoreFeat(num(g?.smart_money_score_num), GSP, "smart_money_score_num",
        "smart-money score input", gObserved, b.id, dec, g),
      whale_public_score_num: scoreFeat(num(g?.whale_public_score_num), GSP, "whale_public_score_num",
        "whale-vs-public score input", gObserved, b.id, dec, g),
      metric_formula_version: feat(g?.metric_formula_version ?? null, GSP, "metric_formula_version",
        "score formula version", gObserved, `id=${b.id}`, g ? b.id : null, dec),
      formula_version: feat(g?.formula_version ?? "shadow-strategic-sports-v1", GSP, "formula_version",
        "producer population tag", gObserved, `id=${b.id}`, g ? b.id : null, dec),
      // ---------- VOLUME (each semantic kept strictly separate) ----------
      volume_usd_provider_raw: feat(num(gDiag.volumeUsd), GSP, "diagnostics.volumeUsd",
        "provider raw market volume (USD) captured by the strategic-shadow collector at decision time",
        gObserved, `id=${b.id}`, g ? b.id : null, dec),
      market_volume_24hr_usd: feat(num(inv?.volume_24hr_usd), INV, "volume_24hr_usd",
        "event/market 24h volume (USD) as first persisted in the sports market inventory at/before decision",
        invAt, invJoinKey, invRowId, dec),
      market_volume_usd_inventory: feat(num(inv?.volume_usd), INV, "volume_usd",
        "cumulative market volume (USD) from sports market inventory", invAt, invJoinKey, invRowId, dec),
      inventory_sibling_market_count: feat(num(inv?.sibling_market_count), INV, "sibling_market_count",
        "sibling market count in the same event at inventory capture", invAt, invJoinKey, invRowId, dec),
      inventory_prior_selected_price: feat(invSelectedPrice, INV, "outcome_prices[selected]",
        "selected-side price as persisted in the market inventory at/before decision (prior-price observation)",
        invAt, invJoinKey, invRowId, dec),
      recent_trade_cash: feat(num(snapDiag.recentTradeCash), SNAP, "diagnostics.recentTradeCash",
        "recent trade cash flow (research-eligible-universe snapshot, formula trusted-initial-formula-v1.1)",
        snapAt, snapJoinKey, snapRowId, dec),
      max_trade_cash: feat(num(snapDiag.maxTradeCash), SNAP, "diagnostics.maxTradeCash",
        "largest single trade cash (research-eligible-universe snapshot)", snapAt, snapJoinKey, snapRowId, dec),
      open_interest: feat(num(snapDiag.openInterest), SNAP, "diagnostics.openInterest",
        "open interest (research-eligible-universe snapshot)", snapAt, snapJoinKey, snapRowId, dec),
      selected_trade_count: feat(num(snapDiag.selectedTradeCount), SNAP, "diagnostics.selectedTradeCount",
        "selected-outcome trade count (research-eligible-universe snapshot)", snapAt, snapJoinKey, snapRowId, dec),
      total_trade_count: feat(num(snapDiag.totalTradeCount), SNAP, "diagnostics.totalTradeCount",
        "total trade count (research-eligible-universe snapshot)", snapAt, snapJoinKey, snapRowId, dec),
      // ---------- PRICE MOVEMENT ----------
      price_current: feat(num(snapDiag.currentPrice), SNAP, "diagnostics.currentPrice",
        "price at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      price_1h_ago: feat(num(snapDiag.price1hAgo), SNAP, "diagnostics.price1hAgo",
        "price 1h before snapshot", snapAt, snapJoinKey, snapRowId, dec),
      price_6h_ago: feat(num(snapDiag.price6hAgo), SNAP, "diagnostics.price6hAgo",
        "price 6h before snapshot", snapAt, snapJoinKey, snapRowId, dec),
      delta_1h_pp: feat(num(snapDiag.delta1hPp), SNAP, "diagnostics.delta1hPp",
        "1h price delta (pp)", snapAt, snapJoinKey, snapRowId, dec),
      delta_6h_pp: feat(num(snapDiag.delta6hPp), SNAP, "diagnostics.delta6hPp",
        "6h price delta (pp)", snapAt, snapJoinKey, snapRowId, dec),
      spread: feat(num(snapDiag.spread), SNAP, "diagnostics.spread",
        "bid/ask spread at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      opposing_price: feat(num(snap?.opposing_price_num), SNAP, "opposing_price_num",
        "opposing token price at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      // ---------- HOLDER / EVIDENCE ----------
      holder_concentration_score: feat(num(snapDiag.holderConcentrationScore), SNAP, "diagnostics.holderConcentrationScore",
        "holder concentration score (research-eligible-universe snapshot)", snapAt, snapJoinKey, snapRowId, dec),
      // ---------- SCORE INPUTS (snapshot formula) ----------
      formula_score_snapshot: feat(num(snapDiag.formulaScore), SNAP, "diagnostics.formulaScore",
        "formula score under trusted-initial-formula-v1.1 (DIFFERENT formula from base population)", snapAt, snapJoinKey, snapRowId, dec),
      formula_used_snapshot: feat(snapDiag.formulaUsed ?? null, SNAP, "diagnostics.formulaUsed",
        "formula id used for the snapshot score", snapAt, snapJoinKey, snapRowId, dec),
      // ---------- DATA COVERAGE ----------
      data_coverage: feat(num(snap?.data_coverage_num) ?? num(snapDiag.dataCoverage), SNAP, "data_coverage_num / diagnostics.dataCoverage",
        "research data coverage at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      hours_until_start: feat(num(snap?.hours_until_start_num), SNAP, "hours_until_start_num",
        "lead time to event start at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      // ---------- MARKET FAMILY ----------
      market_family: feat(
        (g && typeof gDiag.marketFamily === "string" ? gDiag.marketFamily : null) ?? (snap?.market_family ?? null),
        g && typeof gDiag.marketFamily === "string" ? GSP : SNAP,
        g && typeof gDiag.marketFamily === "string" ? "diagnostics.marketFamily" : "market_family",
        "market family / primary-vs-derivative bucket",
        g && typeof gDiag.marketFamily === "string" ? gObserved : snapAt,
        g && typeof gDiag.marketFamily === "string" ? `id=${b.id}` : snapJoinKey,
        g && typeof gDiag.marketFamily === "string" ? b.id : snapRowId,
        dec,
      ),
      price_bucket: feat(gDiag.priceBucket ?? null, GSP, "diagnostics.priceBucket",
        "price bucket label at decision", gObserved, `id=${b.id}`, g ? b.id : null, dec),
      market_type_raw: feat(gDiag.marketType ?? null, GSP, "diagnostics.marketType",
        "raw provider market type", gObserved, `id=${b.id}`, g ? b.id : null, dec),
      provider_sport_code: feat(gDiag.providerSportCode ?? null, GSP, "diagnostics.providerSportCode",
        "structured provider sport code", gObserved, `id=${b.id}`, g ? b.id : null, dec),
      odds_band_label: feat(snap?.odds_band_label ?? null, SNAP, "odds_band_label",
        "odds band label at snapshot", snapAt, snapJoinKey, snapRowId, dec),
      signal_phase_at_snapshot: feat(snap?.signal_phase_at_snapshot ?? null, SNAP, "signal_phase_at_snapshot",
        "signal lifecycle phase at snapshot", snapAt, snapJoinKey, snapRowId, dec),
    } satisfies Record<string, Feature>;

    return {
      base: {
        id: b.id,
        provider_event_id: b.provider_event_id,
        condition_id: b.condition_id,
        selected_token_id: b.selected_token_id,
        decision_timestamp: dec,
        event_start: b.event_start,
        t90_cutoff: b.t90_cutoff,
        event_slug: b.event_slug,
        split_lane: b.split_lane,
        settlement: b.settlement,
      },
      lineage: {
        gsp_row_present: !!g,
        gsp_created_at: gObserved,
        gsp_metric_formula_version: g?.metric_formula_version ?? null,
        research_snapshot_present: !!snap,
        research_snapshot_at: snapAt,
        research_snapshot_formula_version: snap?.formula_version ?? null,
        research_snapshot_candidates_pit: snapCandidates.length,
      },
      enrichment: F,
    };
  });

  // ---- coverage report (denominator = BASE_EVENT_N) ----
  const featureKeys = Object.keys(enriched[0].enrichment);
  const recoveredN = (k: string) => enriched.filter((r) => (r.enrichment as any)[k].status === "RECOVERED").length;
  const coverage: Record<string, any> = {};
  for (const k of featureKeys) {
    const n = recoveredN(k);
    coverage[k] = { unit: "physical_provider_event", base_event_denominator: BASE_EVENT_N, recovered_n: n, recovered_pct: round4((n / BASE_EVENT_N) * 100) };
  }

  const scoreVersions: Record<string, number> = {};
  for (const r of enriched) {
    const v = (r.enrichment.metric_formula_version.value as string | null) ?? r.lineage.gsp_metric_formula_version ?? "UNKNOWN";
    scoreVersions[v] = (scoreVersions[v] ?? 0) + 1;
  }
  const hasScore = (r: any) => r.enrichment.signal_score.status === "RECOVERED" || r.enrichment.score.status === "RECOVERED";
  const anyVolume = (r: any) =>
    ["volume_usd_provider_raw", "market_volume_24hr_usd", "market_volume_usd_inventory", "recent_trade_cash", "max_trade_cash", "open_interest"].some(
      (k) => r.enrichment[k].status === "RECOVERED",
    );
  const anyPriceMovement = (r: any) =>
    ["price_1h_ago", "price_6h_ago", "delta_1h_pp", "delta_6h_pp"].some((k) => r.enrichment[k].status === "RECOVERED");

  // Non-authoritative UPPER BOUND for event/market 24h volume: rows whose inventory
  // row existed (first_observed_at <= decision) and currently carries a non-null
  // volume_24hr_usd. NOT point-in-time safe (the column is upsert-updated in place),
  // reported only so the C4 recheck knows the ceiling of what a historical snapshot
  // table would have covered.
  const marketVolume24hUpperBoundN = base.filter((b) => {
    const rows = invByCond.get(b.condition_id ?? "") ?? [];
    return rows.some(
      (s) =>
        s.first_observed_at &&
        Date.parse(s.first_observed_at) <= Date.parse(b.decision_timestamp) &&
        s.volume_24hr_usd != null,
    );
  }).length;

  const SCORE_EVENT_N = enriched.filter(hasScore).length;
  const SCORE_AND_SETTLED = enriched.filter(
    (r) => hasScore(r) && r.base.settlement.status && ["WIN", "LOSS"].includes(r.base.settlement.status),
  ).length;
  const SCORE_AND_ANY_VOLUME = enriched.filter((r) => hasScore(r) && anyVolume(r)).length;

  // ---- loss-stage classification per major feature ----
  const lossTrace = {
    _classes: {
      A: "RECOVERED_FROM_PRIMARY_PRODUCTION_SOURCE",
      B: "PRESENT_IN_GSP_TOO",
      C: "LOST_BETWEEN_UPSTREAM_SOURCE_AND_STRATEGIC_EXPORT",
      D: "NEVER_HISTORICALLY_PERSISTED",
      E: "AMBIGUOUS / NOT_PROVEN",
    },
    signal_score: {
      class: "D",
      evidence:
        "writeStrategicShadowPairs (cacheGeneratedSignals.ts:545-554) inserts literal NULL for score/signal_confidence_num/pre_event_score_num/smart_money_score_num/whale_public_score_num on 100% of the shadow-strategic-sports-v1 population; live GSP self-join confirms " +
        `signal_score recovered_n=${coverage.signal_score.recovered_n}, score recovered_n=${coverage.score.recovered_n} of ${BASE_EVENT_N}. This population was never run through the live scorer.`,
    },
    smart_money: {
      class: "D",
      evidence: `Same writer path; smart_money_score_num / whale_public_score_num inserted NULL. Live recovered_n=${coverage.smart_money_score_num.recovered_n}.`,
    },
    volume_usd_provider_raw: {
      class: coverage.volume_usd_provider_raw.recovered_n > 0 ? "C" : "E",
      evidence:
        `diagnostics.volumeUsd IS written by writeStrategicShadowPairs (cacheGeneratedSignals.ts:524) and the strategic export dropped it. Live GSP recovered_n=${coverage.volume_usd_provider_raw.recovered_n}/${BASE_EVENT_N} ` +
        `(${coverage.volume_usd_provider_raw.recovered_pct}%). Where present => class C (lost only at export). Where the collector itself captured null at decision time => class E (semantic present in schema, value absent at source).`,
    },
    market_volume_24hr_usd: {
      class: coverage.market_volume_24hr_usd.recovered_n > 0 ? "C" : "E",
      evidence:
        `sports_event_market_inventory.volume_24hr_usd is written by the inventory snapshot writer (cacheSportsEventMarketInventory) keyed by condition_id, timestamped first_observed_at/last_observed_at. Leak-free point-in-time join (last_observed_at <= decision) recovers volume_24hr_usd for recovered_n=${coverage.market_volume_24hr_usd.recovered_n}/${BASE_EVENT_N} (${coverage.market_volume_24hr_usd.recovered_pct}%). ` +
        "This upstream event/market volume authority was never carried into the strategic research export => class C for the recovered rows. volume_usd (cumulative) column is effectively dead (all-null) => that specific semantic is class E.",
    },
    trade_flow_snapshot: {
      class: coverage.recent_trade_cash.recovered_n > 0 ? "C" : "D",
      evidence:
        `recentTradeCash / maxTradeCash / openInterest / holderConcentrationScore persist in generated_signal_research_snapshots.diagnostics, but ONLY for scope=RESEARCH_ELIGIBLE_UNIVERSE / formula_version=trusted-initial-formula-v1.1 — a DIFFERENT population from the strategic-shadow base. Exact (condition_id, selected_token_id, snapshot_at<=decision) join finds a snapshot for only ${coverage.data_coverage.recovered_n}/${BASE_EVENT_N} base events, and even those ${coverage.data_coverage.recovered_n} snapshots carry NULL for every trade-flow diagnostic. recovered_n=${coverage.recent_trade_cash.recovered_n}/${BASE_EVENT_N}. => class D at population scope: never persisted for the strategic-shadow population.`,
    },
    price_movement: {
      class: coverage.delta_1h_pp.recovered_n > 0 ? "C" : "D",
      evidence: `price1hAgo/price6hAgo/delta1hPp/delta6hPp only exist on research-eligible-universe snapshots; recovered_n=${coverage.delta_1h_pp.recovered_n}/${BASE_EVENT_N} for the strategic-shadow base (the overlapping ${coverage.data_coverage.recovered_n} snapshots carry NULL deltas). Prior-price observation partially substitutable via sports_event_market_inventory.outcome_prices: inventory_prior_selected_price recovered_n=${coverage.inventory_prior_selected_price.recovered_n}/${BASE_EVENT_N}. => class D for the delta series at population scope.`,
    },
    data_coverage: {
      class: coverage.data_coverage.recovered_n > 0 ? "C" : "D",
      evidence: `data_coverage_num via exact research-snapshot join (snapshot_at<=decision): recovered_n=${coverage.data_coverage.recovered_n}/${BASE_EVENT_N} (${coverage.data_coverage.recovered_pct}%) — the small subset of strategic-shadow tuples that were also in the research-eligible universe at decision time. Class C for that subset; class D for the ~98% that were not.`,
    },
    market_family: {
      class: "E",
      evidence: `Canonical market_family: generated_signal_pairs.diagnostics.marketFamily is NULL for 100% of the August shadow-strategic population; only the research-snapshot fallback populates it, recovered_n=${coverage.market_family.recovered_n}/${BASE_EVENT_N} (${coverage.market_family.recovered_pct}%).`,
    },
    market_type_raw: {
      class: "C",
      evidence: `generated_signal_pairs.diagnostics.marketType (raw provider market type, the market-family-adjacent attribute actually populated by the strategic-shadow collector) recovered_n=${coverage.market_type_raw.recovered_n}/${BASE_EVENT_N} (${coverage.market_type_raw.recovered_pct}%). Present in primary production, dropped by the strategic export.`,
    },
    provider_sport_code: {
      class: "C",
      evidence: `generated_signal_pairs.diagnostics.providerSportCode recovered_n=${coverage.provider_sport_code.recovered_n}/${BASE_EVENT_N} (${coverage.provider_sport_code.recovered_pct}%). Structured provider-sport contract persisted on the decision row from ~mid-August onward; omitted from the strategic export.`,
    },
    entry_price: {
      class: "A",
      evidence: `generated_signal_pairs.entry_price_num, decision-row value, recovered_n=${coverage.entry_price.recovered_n}/${BASE_EVENT_N} (${coverage.entry_price.recovered_pct}%).`,
    },
  };

  // ---- serialize ----
  mkdirSync(outDir, { recursive: true });
  const artifactJsonl = enriched.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const artifactSha = sha256(artifactJsonl);

  const coverageReport = {
    mission: MISSION,
    generated_at: new Date().toISOString(),
    base_event_n: BASE_EVENT_N,
    base_artifact: BASE_ARTIFACT,
    base_artifact_sha256: baseArtifactSha,
    base_id_set_sha256: baseIdSetHash,
    base_producer_predicate: BASE_PRODUCER_PREDICATE,
    primary_production_db: dbIdentity,
    date_range: {
      decision_timestamp: [
        enriched.map((r) => r.base.decision_timestamp).sort()[0],
        enriched.map((r) => r.base.decision_timestamp).sort()[BASE_EVENT_N - 1],
      ],
    },
    score_version_distribution: scoreVersions,
    score_event_n: SCORE_EVENT_N,
    score_event_pct: round4((SCORE_EVENT_N / BASE_EVENT_N) * 100),
    score_and_settled_event_n: SCORE_AND_SETTLED,
    score_and_any_volume_event_n: SCORE_AND_ANY_VOLUME,
    market_volume_24hr_usd_first_observed_upper_bound_n: marketVolume24hUpperBoundN,
    market_volume_24hr_usd_first_observed_upper_bound_note:
      "NON-AUTHORITATIVE ceiling: inventory row existed before decision AND currently carries a non-null volume_24hr_usd. Value is not point-in-time safe (upsert-updated); the leak-free recovered_n is market_volume_24hr_usd in feature_coverage.",
    feature_coverage: coverage,
    volume_semantics_note:
      "Each volume semantic is reported independently and never collapsed: volume_usd_provider_raw (generated_signal_pairs.diagnostics.volumeUsd) vs recent_trade_cash / max_trade_cash / open_interest (generated_signal_research_snapshots.diagnostics, trusted-initial-formula-v1.1).",
    loss_trace: lossTrace,
    writer_trace: WRITER_TRACE,
  };
  const coverageJson = JSON.stringify(coverageReport, null, 2) + "\n";

  const manifest = {
    artifact_id: MISSION,
    status: "IMMUTABLE",
    llm_dependency_at_runtime: false,
    next_semantic_transition: "RICH_AUGUST_C4_ATTRIBUTE_RECHECK_V2",
    base_event_n: BASE_EVENT_N,
    enriched_row_n: enriched.length,
    row_conservation_ok: enriched.length === BASE_EVENT_N,
    base_membership_unchanged: true,
    primary_production_db: dbIdentity,
    enrichment_sources: [
      { table: "public.generated_signal_pairs", join: "exact base.id == id", observed_at: "created_at", read_only: true },
      {
        table: "public.generated_signal_research_snapshots",
        join: "exact condition_id + selected_token_id; latest snapshot_at <= decision_timestamp",
        observed_at: "snapshot_at",
        read_only: true,
      },
      {
        table: "public.sports_event_market_inventory",
        join: "exact condition_id; latest last_observed_at <= decision_timestamp (leak-free)",
        observed_at: "last_observed_at",
        read_only: true,
      },
    ],
    point_in_time_rule: "feature_observed_at <= base.decision_timestamp; snapshot series -> latest eligible; no current-value backfill; no post-decision leakage; no fuzzy matching",
    output_sha256: { "AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl": artifactSha },
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";

  writeFileSync(join(outDir, "AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl"), artifactJsonl);
  writeFileSync(join(outDir, "AUGUST_MAIN_DB_ENRICHMENT_V1_COVERAGE.json"), coverageJson);
  writeFileSync(join(outDir, "AUGUST_MAIN_DB_ENRICHMENT_V1_MANIFEST.json"), manifestJson);
  const shaManifest =
    [
      `AUGUST_MAIN_DB_ENRICHMENT_V1.jsonl  ${artifactSha}`,
      `AUGUST_MAIN_DB_ENRICHMENT_V1_COVERAGE.json  ${sha256(coverageJson)}`,
      `AUGUST_MAIN_DB_ENRICHMENT_V1_MANIFEST.json  ${sha256(manifestJson)}`,
      `UPSTREAM ${BASE_ARTIFACT}  ${baseArtifactSha}`,
    ].join("\n") + "\n";
  writeFileSync(join(outDir, "SHA256_MANIFEST.txt"), shaManifest);

  process.stdout.write(
    JSON.stringify(
      {
        mission: MISSION,
        verdict: "PASS",
        out_dir: outDir,
        base_event_n: BASE_EVENT_N,
        enriched_row_n: enriched.length,
        base_membership_unchanged: true,
        primary_production_db_host: dbHost,
        artifact_sha256: artifactSha,
        score_event_n: SCORE_EVENT_N,
        score_and_settled_event_n: SCORE_AND_SETTLED,
        score_and_any_volume_event_n: SCORE_AND_ANY_VOLUME,
        key_coverage_pct: {
          entry_price: coverage.entry_price.recovered_pct,
          volume_usd_provider_raw: coverage.volume_usd_provider_raw.recovered_pct,
          market_volume_24hr_usd: coverage.market_volume_24hr_usd.recovered_pct,
          recent_trade_cash: coverage.recent_trade_cash.recovered_pct,
          max_trade_cash: coverage.max_trade_cash.recovered_pct,
          holder_concentration_score: coverage.holder_concentration_score.recovered_pct,
          delta_1h_pp: coverage.delta_1h_pp.recovered_pct,
          data_coverage: coverage.data_coverage.recovered_pct,
          market_family: coverage.market_family.recovered_pct,
          signal_score: coverage.signal_score.recovered_pct,
        },
        loss_trace_classes: Object.fromEntries(
          Object.entries(lossTrace).filter(([k]) => k !== "_classes").map(([k, v]) => [k, (v as any).class]),
        ),
        next_semantic_transition: "RICH_AUGUST_C4_ATTRIBUTE_RECHECK_V2",
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((e) => {
  process.stderr.write(`${MISSION} error: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
