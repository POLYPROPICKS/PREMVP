/**
 * FOOTBALL_EXECUTION_MATRIX_S1S2S3_MATERIALIZER_V1
 *
 * Wires the football S1/S2/S3 evidence contract
 * (lib/executionMatrix/footballS1S2S3.ts) to REAL prospective evidence
 * already replicated into the research clone (project ref nppznoujvnyjargjkmnv):
 *
 *   candidate identity  <- public.generated_signal_pairs
 *   contemporaneous odds <- generated_signal_pairs.entry_price_num (same row,
 *                            decision-time by construction)
 *   post-decision orderbook trajectory <- public.market_price_liquidity_snapshots
 *   authoritative fill evidence <- public.executor_order_events /
 *                                   public.bet_execution_ledger
 *
 * Writes durable evidence via the public.record_football_execution_matrix_s1s2s3_evidence
 * RPC bridge (see supabase/migrations/20260924133000_*.sql) because the
 * destination table lives in the `research` schema, which this clone does
 * not expose over PostgREST directly — only `public` and `graphql_public`
 * are exposed (confirmed via `Accept-Profile: research` -> PGRST106).
 *
 * Scope: football/soccer only, per HOLD semantics — Exact Score markets are
 * explicitly excluded (see isExcludedFromOrdinaryHold below), no other
 * sport is read or written.
 *
 * Run:
 *   npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts [--dry-run]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

import {
  S2_INITIAL_TARGET_DECIMAL_ODDS,
  S3_INITIAL_LADDER_DECIMAL_ODDS,
  S3_MIN_ACCEPTABLE_DECIMAL_ODDS,
  assertSameCandidateIdentity,
  evaluateS1TakerHold,
  evaluateS2FixedMakerHold,
  evaluateS3MakerValueBandHold,
  sharePriceToDecimalOdds,
  type CandidateIdentity,
  type S2Observation,
} from "../../lib/executionMatrix/footballS1S2S3";

const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const S1_MIN_ACCEPTABLE_DECIMAL_ODDS = 1.85;

export function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

export function resolveCloneClient(): { client: SupabaseClient; url: string } {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("REQUIRED_CLONE_WRITE_AUTHORIZATION_UNAVAILABLE");
  }
  if (projectRef(url) !== EXPECTED_CLONE_REF) {
    throw new Error(
      `RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH: got ${projectRef(url)} expected ${EXPECTED_CLONE_REF}`,
    );
  }
  return {
    client: createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
    url,
  };
}

/**
 * Ordinary football HOLD materialization must not include Exact Score
 * markets (mission §10). No structured market-family field is populated on
 * these real rows yet, so this checks the only text fields available
 * (event/market slug + title) for the current authoritative naming, rather
 * than inventing a new heuristic.
 */
export function isExcludedFromOrdinaryHold(text: string | null | undefined): boolean {
  if (!text) return false;
  return /exact[\s_-]?score|correct[\s_-]?score/i.test(text);
}

export interface RawCandidateRow {
  condition_id: string;
  selected_token_id: string;
  event_slug: string | null;
  market_slug: string | null;
  formula_version: string | null;
  metric_formula_version: string | null;
  created_at: string;
  entry_price_num: number | null;
}

export interface RawSnapshotRow {
  captured_at: string;
  condition_id: string;
  token_id: string;
  implied_decimal_odds_mid: number | null;
  implied_decimal_odds_bid: number | null;
  spread_bps: number | null;
  bid_depth_total: number | null;
  event_slug: string | null;
  market_slug: string | null;
  event_title: string | null;
  market_title: string | null;
}

export interface RawFillRow {
  filledDecimalOdds: number;
  filledAtIso: string;
  source: "executor_order_events" | "bet_execution_ledger";
}

/** Builds the frozen candidate identity shared by S1/S2/S3 for one source row. */
export function candidateFromRow(row: RawCandidateRow): CandidateIdentity {
  return {
    conditionId: row.condition_id,
    selectedTokenId: row.selected_token_id,
    // No explicit numeric provider-event-id field is populated on these
    // real rows; event_slug is the authoritative real identity value
    // available from the source and is used as-is (not fabricated).
    providerEventId: row.event_slug ?? row.condition_id,
    formulaVersion: row.metric_formula_version ?? row.formula_version ?? "unknown",
    decisionTimeIso: row.created_at,
  };
}

export interface MaterializedCandidate {
  candidate: CandidateIdentity;
  availableDecimalOdds: number | null;
  s2s3Observations: S2Observation[];
  fill: RawFillRow | null;
}

/** Pure mapping/assembly step: no DB or network I/O. */
export function assembleCandidate(
  row: RawCandidateRow,
  laterSnapshots: RawSnapshotRow[],
  fill: RawFillRow | null,
): MaterializedCandidate {
  const candidate = candidateFromRow(row);
  const decisionTimeMs = Date.parse(row.created_at);

  // Temporal causality: only snapshots strictly AFTER decision time feed
  // S2/S3 trajectory evaluation. Decision-time S1 uses only entry_price_num
  // from the same source row (contemporaneous by construction).
  const causalObservations = laterSnapshots
    .filter((s) => Date.parse(s.captured_at) > decisionTimeMs)
    .filter((s) => s.implied_decimal_odds_mid !== null)
    .filter((s) => !isExcludedFromOrdinaryHold(s.event_title ?? s.market_title ?? s.event_slug ?? s.market_slug))
    .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at))
    .map((s) => ({
      observedAtIso: s.captured_at,
      bestObservedDecimalOdds: s.implied_decimal_odds_mid as number,
    }));

  return {
    candidate,
    availableDecimalOdds: row.entry_price_num !== null ? sharePriceToDecimalOdds(row.entry_price_num) : null,
    s2s3Observations: causalObservations,
    fill,
  };
}

export interface MaterializedEvidenceRow {
  strategy: "S1_TAKER_HOLD" | "S2_FIXED_MAKER_HOLD" | "S3_MAKER_VALUE_BAND_HOLD";
  payload: Record<string, unknown>;
}

/** Runs the three shared-identity strategy evaluations for one candidate. */
export function evaluateCandidate(m: MaterializedCandidate): MaterializedEvidenceRow[] {
  if (m.availableDecimalOdds === null) {
    // No contemporaneous price at all: nothing provable for S1; S2/S3 can
    // still run on later observations if any exist, else UNKNOWN.
  }

  const fillEvidence = m.fill
    ? { filledDecimalOdds: m.fill.filledDecimalOdds, filledAtIso: m.fill.filledAtIso, source: m.fill.source }
    : undefined;

  const rows: MaterializedEvidenceRow[] = [];

  if (m.availableDecimalOdds !== null) {
    const s1 = evaluateS1TakerHold({
      candidate: m.candidate,
      availableDecimalOdds: m.availableDecimalOdds,
      minAcceptableDecimalOdds: S1_MIN_ACCEPTABLE_DECIMAL_ODDS,
      fill: fillEvidence,
    });
    rows.push({
      strategy: "S1_TAKER_HOLD",
      payload: {
        condition_id: s1.candidate.conditionId,
        selected_token_id: s1.candidate.selectedTokenId,
        provider_event_id: s1.candidate.providerEventId,
        formula_version: s1.candidate.formulaVersion,
        decision_time: s1.candidate.decisionTimeIso,
        strategy: s1.strategy,
        model_fair_decimal_odds: s1.modelFairDecimalOdds,
        available_decimal_odds: s1.availableDecimalOdds,
        min_acceptable_decimal_odds: s1.minAcceptableDecimalOdds,
        spread: s1.spread,
        depth: s1.depth,
        take_decision: s1.decision,
        actual_fill_decimal_odds: s1.actualFillDecimalOdds,
        fill_evidence_source: m.fill?.source ?? null,
        recorded_window_start: s1.candidate.decisionTimeIso,
        diagnostics: { source: "generated_signal_pairs" },
      },
    });
  }

  const s2 = evaluateS2FixedMakerHold({
    candidate: m.candidate,
    targetDecimalOdds: S2_INITIAL_TARGET_DECIMAL_ODDS,
    observations: m.s2s3Observations,
    fill: fillEvidence,
  });
  const s3 = evaluateS3MakerValueBandHold({
    candidate: m.candidate,
    ladderDecimalOdds: S3_INITIAL_LADDER_DECIMAL_ODDS,
    minAcceptableDecimalOdds: S3_MIN_ACCEPTABLE_DECIMAL_ODDS,
    observations: m.s2s3Observations,
    fill: fillEvidence,
  });

  assertSameCandidateIdentity(
    {
      strategy: "S1_TAKER_HOLD",
      candidate: m.candidate,
      modelFairDecimalOdds: null,
      availableDecimalOdds: m.availableDecimalOdds ?? 0,
      minAcceptableDecimalOdds: S1_MIN_ACCEPTABLE_DECIMAL_ODDS,
      spread: null,
      depth: null,
      decision: "NO_TAKE",
      actualFillDecimalOdds: null,
    },
    s2,
    s3,
  );

  const windowStart = m.s2s3Observations[0]?.observedAtIso ?? m.candidate.decisionTimeIso;

  rows.push({
    strategy: "S2_FIXED_MAKER_HOLD",
    payload: {
      condition_id: s2.candidate.conditionId,
      selected_token_id: s2.candidate.selectedTokenId,
      provider_event_id: s2.candidate.providerEventId,
      formula_version: s2.candidate.formulaVersion,
      decision_time: s2.candidate.decisionTimeIso,
      strategy: s2.strategy,
      target_decimal_odds: s2.targetDecimalOdds,
      target_reachable: s2.targetReachable,
      best_observed_acceptable_decimal_odds: s2.bestObservedAcceptableDecimalOdds,
      status: s2.status,
      actual_fill_decimal_odds: s2.actualFillDecimalOdds,
      fill_evidence_source: m.fill?.source ?? null,
      observation_times: s2.observationTimesIso,
      recorded_window_start: windowStart,
      diagnostics: { source: "market_price_liquidity_snapshots" },
    },
  });

  rows.push({
    strategy: "S3_MAKER_VALUE_BAND_HOLD",
    payload: {
      condition_id: s3.candidate.conditionId,
      selected_token_id: s3.candidate.selectedTokenId,
      provider_event_id: s3.candidate.providerEventId,
      formula_version: s3.candidate.formulaVersion,
      decision_time: s3.candidate.decisionTimeIso,
      strategy: s3.strategy,
      ladder_decimal_odds: s3.ladderDecimalOdds,
      min_acceptable_decimal_odds: s3.minAcceptableDecimalOdds,
      best_observed_acceptable_decimal_odds: s3.bestReachableAcceptableDecimalOdds,
      ladder_levels: s3.levels,
      status: s3.status,
      actual_fill_decimal_odds: s3.actualFillDecimalOdds,
      fill_evidence_source: m.fill?.source ?? null,
      observation_times: m.s2s3Observations.map((o) => o.observedAtIso),
      recorded_window_start: windowStart,
      diagnostics: { source: "market_price_liquidity_snapshots" },
    },
  });

  return rows;
}

async function fetchFootballCandidatePairs(client: SupabaseClient): Promise<Array<{ condition_id: string; token_id: string }>> {
  const { data, error } = await client
    .from("market_price_liquidity_snapshots")
    .select("condition_id, token_id, event_title, market_title")
    .eq("normalized_sport", "soccer")
    .limit(1000);
  if (error) throw new Error(`fetchFootballCandidatePairs: ${error.message}`);
  const seen = new Map<string, { condition_id: string; token_id: string }>();
  for (const row of data ?? []) {
    if (isExcludedFromOrdinaryHold(row.event_title ?? row.market_title)) continue;
    const key = `${row.condition_id}::${row.token_id}`;
    if (!seen.has(key)) seen.set(key, { condition_id: row.condition_id, token_id: row.token_id });
  }
  return [...seen.values()];
}

async function fetchAuthoritativeFill(
  client: SupabaseClient,
  conditionId: string,
  tokenId: string,
): Promise<RawFillRow | null> {
  const { data: ledgerRows, error: ledgerErr } = await client
    .from("bet_execution_ledger")
    .select("fill_price, filled_at, bet_status, condition_id, token_id")
    .eq("condition_id", conditionId)
    .eq("token_id", tokenId)
    .not("fill_price", "is", null)
    .not("filled_at", "is", null)
    .limit(5);
  if (ledgerErr) throw new Error(`fetchAuthoritativeFill(ledger): ${ledgerErr.message}`);
  const filled = (ledgerRows ?? []).find((r) => r.bet_status && /fill/i.test(r.bet_status));
  if (filled) {
    return {
      filledDecimalOdds: sharePriceToDecimalOdds(filled.fill_price as number),
      filledAtIso: filled.filled_at as string,
      source: "bet_execution_ledger",
    };
  }

  const { data: orderRows, error: orderErr } = await client
    .from("executor_order_events")
    .select("submitted_price, created_at, order_status, success, condition_id, token_id")
    .eq("condition_id", conditionId)
    .eq("token_id", tokenId)
    .eq("success", true)
    .not("submitted_price", "is", null)
    .limit(5);
  if (orderErr) throw new Error(`fetchAuthoritativeFill(orders): ${orderErr.message}`);
  const orderFilled = (orderRows ?? []).find((r) => r.order_status && /fill/i.test(r.order_status));
  if (orderFilled) {
    return {
      filledDecimalOdds: sharePriceToDecimalOdds(orderFilled.submitted_price as number),
      filledAtIso: orderFilled.created_at as string,
      source: "executor_order_events",
    };
  }

  return null;
}

export interface RunSummary {
  candidateIdentities: number;
  rowsByStrategy: Record<string, number>;
  s1TakeCounts: Record<string, number>;
  s2StatusCounts: Record<string, number>;
  s3StatusCounts: Record<string, number>;
  authoritativeActualFills: number;
  exactScoreContamination: number;
  decisionTimes: string[];
  recordedAtTimes: string[];
  /**
   * Row ids returned by the write RPC (research schema has no PostgREST
   * read path on this clone — see review package §7/§9 — so this is the
   * proof surface for idempotency: an unchanged set of ids across two runs
   * for the same source slice means the second run upserted the same
   * logical rows rather than duplicating them).
   */
  writtenRowIds: Array<{ strategy: string; id: string }>;
}

async function run(dryRun: boolean): Promise<RunSummary> {
  const { client } = resolveCloneClient();
  const pairs = await fetchFootballCandidatePairs(client);

  const summary: RunSummary = {
    candidateIdentities: 0,
    rowsByStrategy: { S1_TAKER_HOLD: 0, S2_FIXED_MAKER_HOLD: 0, S3_MAKER_VALUE_BAND_HOLD: 0 },
    s1TakeCounts: { TAKE: 0, NO_TAKE: 0 },
    s2StatusCounts: { ACTUAL_FILL: 0, FILL_OPPORTUNITY: 0, NO_FILL: 0, UNKNOWN: 0 },
    s3StatusCounts: { ACTUAL_FILL: 0, FILL_OPPORTUNITY: 0, NO_FILL: 0, UNKNOWN: 0 },
    authoritativeActualFills: 0,
    exactScoreContamination: 0,
    decisionTimes: [],
    recordedAtTimes: [],
    writtenRowIds: [],
  };

  for (const pair of pairs) {
    const { data: candidateRows, error: candErr } = await client
      .from("generated_signal_pairs")
      .select(
        "condition_id, selected_token_id, event_slug, market_slug, formula_version, metric_formula_version, created_at, entry_price_num",
      )
      .eq("condition_id", pair.condition_id)
      .eq("selected_token_id", pair.token_id)
      .order("created_at", { ascending: true })
      .limit(200);
    if (candErr) throw new Error(`generated_signal_pairs fetch: ${candErr.message}`);

    // Dedup: one decision instance per distinct created_at (the source
    // materializer that populates generated_signal_pairs may emit repeat
    // rows for the same serving cycle; each distinct created_at is treated
    // as its own decision-time identity, never invented or merged).
    const distinctByCreatedAt = new Map<string, RawCandidateRow>();
    for (const row of (candidateRows ?? []) as RawCandidateRow[]) {
      if (isExcludedFromOrdinaryHold(row.event_slug ?? row.market_slug)) {
        summary.exactScoreContamination += 1;
        continue;
      }
      if (!distinctByCreatedAt.has(row.created_at)) distinctByCreatedAt.set(row.created_at, row);
    }

    if (distinctByCreatedAt.size === 0) continue;

    const { data: snapshotRows, error: snapErr } = await client
      .from("market_price_liquidity_snapshots")
      .select(
        "captured_at, condition_id, token_id, implied_decimal_odds_mid, implied_decimal_odds_bid, spread_bps, bid_depth_total, event_slug, market_slug, event_title, market_title",
      )
      .eq("condition_id", pair.condition_id)
      .eq("token_id", pair.token_id)
      .order("captured_at", { ascending: true })
      .limit(500);
    if (snapErr) throw new Error(`market_price_liquidity_snapshots fetch: ${snapErr.message}`);

    const fill = await fetchAuthoritativeFill(client, pair.condition_id, pair.token_id);
    if (fill) summary.authoritativeActualFills += 1;

    for (const row of distinctByCreatedAt.values()) {
      const materialized = assembleCandidate(row, (snapshotRows ?? []) as RawSnapshotRow[], fill);
      const evidenceRows = evaluateCandidate(materialized);
      summary.candidateIdentities += 1;
      summary.decisionTimes.push(materialized.candidate.decisionTimeIso);

      for (const evidenceRow of evidenceRows) {
        summary.rowsByStrategy[evidenceRow.strategy] += 1;
        if (evidenceRow.strategy === "S1_TAKER_HOLD") {
          const decision = evidenceRow.payload.take_decision as string;
          summary.s1TakeCounts[decision] = (summary.s1TakeCounts[decision] ?? 0) + 1;
        } else if (evidenceRow.strategy === "S2_FIXED_MAKER_HOLD") {
          const status = evidenceRow.payload.status as string;
          summary.s2StatusCounts[status] = (summary.s2StatusCounts[status] ?? 0) + 1;
        } else {
          const status = evidenceRow.payload.status as string;
          summary.s3StatusCounts[status] = (summary.s3StatusCounts[status] ?? 0) + 1;
        }

        if (dryRun) continue;

        const { data: writtenId, error: rpcErr } = await client.rpc(
          "record_football_execution_matrix_s1s2s3_evidence",
          { payload: evidenceRow.payload },
        );
        if (rpcErr) {
          throw new Error(
            `record_football_execution_matrix_s1s2s3_evidence RPC failed for ${evidenceRow.strategy} ` +
              `(${materialized.candidate.conditionId}/${materialized.candidate.selectedTokenId} @ ${materialized.candidate.decisionTimeIso}): ${rpcErr.message}`,
          );
        }
        summary.recordedAtTimes.push(new Date().toISOString());
        summary.writtenRowIds.push({ strategy: evidenceRow.strategy, id: writtenId as string });
      }
    }
  }

  return summary;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const summary = await run(dryRun);
  console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
