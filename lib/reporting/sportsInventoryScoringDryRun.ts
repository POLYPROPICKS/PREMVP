// Read-only production scoring dry run.
//
// Pipeline: read-only inventory rows (already loaded by the caller, reusing
// loadSportsInventoryFunnelRows from sportsInventoryFunnelReport.ts) ->
// computeSportsInventoryEligibleGroups (the reporter's real, reused rules)
// -> a deterministic bounded sample -> sportsInventoryScoringAdapter ->
// the existing live enrichMarket/generateLandingCardPair scoring boundary
// (injected as a ScoreMarketPort so this module and its tests never import
// buildLandingCards.ts's network client directly) -> one JSON evidence
// document.
//
// This module never selects a side, computes a score, or invents any field
// itself -- every selected_outcome/selected_token_id/entry_price/score/
// confidence/data_coverage value comes verbatim from the injected scorer.
// It never writes: no Supabase mutation, no generated_signal_pairs row, no
// Reservation/Queue access, no FireModelCandidate. Score is not
// executability proof and this dry run does not claim planning or
// Reservation readiness.

import type { PolymarketRawEvent, PolymarketRawMarket } from "@/lib/feed/types";
import { resolveMarketAnchorDecision } from "@/lib/contur3/taxonomy";
import {
  adaptSportsInventoryRowToScoringInput,
  type SportsInventoryScoringAdapterRow,
  type SportsInventoryScoringAdapterReasonCode,
} from "@/lib/feed/sportsInventoryScoringAdapter";
import {
  computeSportsInventoryEligibleGroups,
  type SportsInventoryFunnelRow,
  type EligibleStrictGroup,
} from "@/lib/reporting/sportsInventoryFunnelReport";

export const DRY_RUN_REPORT_VERSION = "sports-inventory-scoring-dry-run/1";

// ---------------------------------------------------------------------------
// Configured limits + validation
// ---------------------------------------------------------------------------

export const HARD_MAX_GROUPS = 25;
export const HARD_MAX_MARKETS_PER_GROUP = 2;
export const HARD_MAX_CONCURRENCY = 2;

export interface ScoringDryRunLimits {
  maxGroups: number;
  maxMarketsPerGroup: number;
  concurrency: number;
}

export interface ScoringDryRunOptions extends ScoringDryRunLimits {
  fixedNow: string;
  horizonHours: number;
}

export type ScoringDryRunInvalidReason =
  | "FIXED_NOW_INVALID"
  | "HORIZON_HOURS_INVALID"
  | "MAX_GROUPS_INVALID"
  | "MAX_MARKETS_PER_GROUP_INVALID"
  | "CONCURRENCY_INVALID";

export function validateScoringDryRunOptions(
  options: ScoringDryRunOptions,
): { ok: true } | { ok: false; reasonCode: ScoringDryRunInvalidReason } {
  if (!options.fixedNow || !Number.isFinite(Date.parse(options.fixedNow))) {
    return { ok: false, reasonCode: "FIXED_NOW_INVALID" };
  }
  if (!Number.isInteger(options.horizonHours) || options.horizonHours <= 0) {
    return { ok: false, reasonCode: "HORIZON_HOURS_INVALID" };
  }
  if (!Number.isInteger(options.maxGroups) || options.maxGroups <= 0 || options.maxGroups > HARD_MAX_GROUPS) {
    return { ok: false, reasonCode: "MAX_GROUPS_INVALID" };
  }
  if (
    !Number.isInteger(options.maxMarketsPerGroup) ||
    options.maxMarketsPerGroup <= 0 ||
    options.maxMarketsPerGroup > HARD_MAX_MARKETS_PER_GROUP
  ) {
    return { ok: false, reasonCode: "MAX_MARKETS_PER_GROUP_INVALID" };
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency <= 0 ||
    options.concurrency > HARD_MAX_CONCURRENCY
  ) {
    return { ok: false, reasonCode: "CONCURRENCY_INVALID" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Deterministic sample selection -- NOT a planning selection policy.
// ---------------------------------------------------------------------------

export interface SampleMarket {
  groupKey: string;
  provider: string;
  providerEventId: string;
  eventStartIso: string;
  row: SportsInventoryFunnelRow;
}

export interface SampleGroup {
  groupKey: string;
  provider: string;
  providerEventId: string;
  eventStartIso: string;
  markets: SampleMarket[];
}

export const DETERMINISTIC_SAMPLE_LABEL = "DETERMINISTIC_SAMPLE_ONLY_NOT_PLANNING_SELECTION";

/**
 * Pure, deterministic sample selector. Sorts groups by event_start_iso ASC,
 * provider ASC, provider_event_id ASC, and markets within a group by
 * provider_market_id ASC -- never by market class, favorite, or any scoring
 * signal. This is diagnostic sampling only, not a planning-stage selection.
 */
export function selectDeterministicSample(
  eligibleGroups: EligibleStrictGroup[],
  limits: { maxGroups: number; maxMarketsPerGroup: number },
): SampleGroup[] {
  const sortedGroups = [...eligibleGroups].sort((a, b) => {
    if (a.eventStartIso !== b.eventStartIso) return a.eventStartIso < b.eventStartIso ? -1 : 1;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return a.providerEventId < b.providerEventId ? -1 : 1;
  });

  return sortedGroups.slice(0, limits.maxGroups).map((group) => {
    const sortedRows = [...group.rows].sort((a, b) => {
      const am = a.provider_market_id ?? "";
      const bm = b.provider_market_id ?? "";
      return am < bm ? -1 : am > bm ? 1 : 0;
    });
    const markets: SampleMarket[] = sortedRows.slice(0, limits.maxMarketsPerGroup).map((row) => ({
      groupKey: group.groupKey,
      provider: group.provider,
      providerEventId: group.providerEventId,
      eventStartIso: group.eventStartIso,
      row,
    }));
    return {
      groupKey: group.groupKey,
      provider: group.provider,
      providerEventId: group.providerEventId,
      eventStartIso: group.eventStartIso,
      markets,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring boundary port -- injected so this module and its tests never
// import buildLandingCards.ts's network client directly. The real CLI wires
// this to enrichMarket() + generateLandingCardPair(), the exact production
// enrichment/scoring functions -- no formula is copied here.
// ---------------------------------------------------------------------------

export type ScoreMarketFailureReason =
  | "LIVE_ENRICHMENT_EMPTY"
  | "SCORE_NOT_PRODUCED"
  | "LIVE_ENRICHMENT_FAILED";

export type ScoreMarketPortResult =
  | {
      ok: true;
      selected_outcome: string;
      selected_token_id: string | null;
      opposing_token_id: string | null;
      entry_price: number;
      score: number;
      confidence: number;
      data_coverage: number;
    }
  | {
      ok: false;
      reasonCode: ScoreMarketFailureReason;
    };

export type ScoreMarketPort = (
  event: PolymarketRawEvent,
  market: PolymarketRawMarket,
) => Promise<ScoreMarketPortResult>;

// ---------------------------------------------------------------------------
// Per-market result + report contract
// ---------------------------------------------------------------------------

export type MarketFailureReason =
  | SportsInventoryScoringAdapterReasonCode
  | ScoreMarketFailureReason;

export interface ScoringDryRunMarketResult {
  provider: string;
  provider_event_id: string;
  provider_market_id: string;
  condition_id: string | null;
  event_start_iso: string;
  market_question: string | null;
  market_class: string;
  event_scope: string;

  adapter_status: "OK" | SportsInventoryScoringAdapterReasonCode;
  enrichment_status: "SCORED" | "NOT_SCORED";
  selected_outcome: string | null;
  selected_token_id: string | null;
  opposing_token_id: string | null;
  entry_price: number | null;
  score: number | null;
  confidence: number | null;
  data_coverage: number | null;

  failure_reason: MarketFailureReason | null;
  duration_ms: number;
}

export interface ScoringDryRunReport {
  report_version: string;
  fixed_now: string;
  horizon_hours: number;
  configured_limits: ScoringDryRunLimits;
  source_counts: {
    rows: number;
    distinct_provider_event_id: number;
    distinct_provider_market_id: number;
  };
  eligible_strict_groups: number;
  excluded_group_reasons: Record<string, number>;
  selected_sample_groups: number;
  attempted_markets: number;
  successfully_enriched_markets: number;
  successfully_scored_markets: number;
  failed_market_reasons: Record<string, number>;
  market_results: ScoringDryRunMarketResult[];
  limitations: string[];
}

function sortedRecord(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function toAdapterRow(row: SportsInventoryFunnelRow): SportsInventoryScoringAdapterRow {
  return {
    provider: row.provider,
    provider_event_id: row.provider_event_id,
    provider_event_slug: row.provider_event_slug,
    provider_market_id: row.provider_market_id,
    provider_market_slug: row.provider_market_slug,
    event_title: row.event_title,
    market_question: row.market_question,
    event_start_iso: row.event_start_iso,
    market_end_iso: row.market_end_iso,
    condition_id: row.condition_id,
    clob_token_ids: row.clob_token_ids,
    outcomes: row.outcomes,
    outcome_prices: row.outcome_prices,
    provider_tags: row.provider_tags,
    raw_category: row.raw_category,
    league_hint: row.league_hint,
    sports_market_type: row.sports_market_type,
    volume_usd: row.volume_usd,
    volume_24hr_usd: row.volume_24hr_usd,
  };
}

async function scoreSampleMarket(
  sample: SampleMarket,
  scorePort: ScoreMarketPort,
): Promise<ScoringDryRunMarketResult> {
  const startedAt = Date.now();
  const row = sample.row;

  const decision = resolveMarketAnchorDecision({
    providerMarketQuestion: row.market_question,
    marketTitle: row.market_question,
    eventTitle: row.event_title,
    marketSlug: row.provider_market_slug,
    eventSlug: row.provider_event_slug,
  });

  const base = {
    provider: sample.provider,
    provider_event_id: sample.providerEventId,
    provider_market_id: row.provider_market_id ?? "",
    condition_id: row.condition_id,
    event_start_iso: sample.eventStartIso,
    market_question: row.market_question,
    market_class: decision.market_class,
    event_scope: decision.event_scope,
  };

  const adapterResult = adaptSportsInventoryRowToScoringInput(toAdapterRow(row));
  if (!adapterResult.ok) {
    return {
      ...base,
      adapter_status: adapterResult.reasonCode,
      enrichment_status: "NOT_SCORED",
      selected_outcome: null,
      selected_token_id: null,
      opposing_token_id: null,
      entry_price: null,
      score: null,
      confidence: null,
      data_coverage: null,
      failure_reason: adapterResult.reasonCode,
      duration_ms: Date.now() - startedAt,
    };
  }

  let scoreResult: ScoreMarketPortResult;
  try {
    scoreResult = await scorePort(adapterResult.event, adapterResult.market);
  } catch {
    scoreResult = { ok: false, reasonCode: "LIVE_ENRICHMENT_FAILED" };
  }

  if (!scoreResult.ok) {
    return {
      ...base,
      adapter_status: "OK",
      enrichment_status: "NOT_SCORED",
      selected_outcome: null,
      selected_token_id: null,
      opposing_token_id: null,
      entry_price: null,
      score: null,
      confidence: null,
      data_coverage: null,
      failure_reason: scoreResult.reasonCode,
      duration_ms: Date.now() - startedAt,
    };
  }

  return {
    ...base,
    adapter_status: "OK",
    enrichment_status: "SCORED",
    selected_outcome: scoreResult.selected_outcome,
    selected_token_id: scoreResult.selected_token_id,
    opposing_token_id: scoreResult.opposing_token_id,
    entry_price: scoreResult.entry_price,
    score: scoreResult.score,
    confidence: scoreResult.confidence,
    data_coverage: scoreResult.data_coverage,
    failure_reason: null,
    duration_ms: Date.now() - startedAt,
  };
}

/** Bounded-concurrency worker pool -- never more than `concurrency` in-flight scorer calls. */
async function runWithBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * Bounded, read-only live-scoring dry run. Selects a deterministic sample of
 * reporter-proven strict, structurally-ready groups and scores each sampled
 * market through the injected production scoring port. One failed market
 * (adapter rejection, enrichment failure, or thrown exception) never
 * suppresses evidence from any other market.
 */
export async function runSportsInventoryScoringDryRun(
  rows: SportsInventoryFunnelRow[],
  options: ScoringDryRunOptions,
  scorePort: ScoreMarketPort,
): Promise<ScoringDryRunReport> {
  const validation = validateScoringDryRunOptions(options);
  if (!validation.ok) {
    throw new Error(`SCORING_DRY_RUN_INVALID_ARGUMENT: ${validation.reasonCode}`);
  }

  const distinctEventIds = new Set<string>();
  const distinctMarketIds = new Set<string>();
  for (const row of rows) {
    if (row.provider_event_id) distinctEventIds.add(row.provider_event_id);
    if (row.provider_market_id) distinctMarketIds.add(row.provider_market_id);
  }

  const eligible = computeSportsInventoryEligibleGroups(rows, {
    fixedNow: options.fixedNow,
    horizonHours: options.horizonHours,
  });

  const sample = selectDeterministicSample(eligible.eligibleGroups, {
    maxGroups: options.maxGroups,
    maxMarketsPerGroup: options.maxMarketsPerGroup,
  });
  const attemptList: SampleMarket[] = sample.flatMap((g) => g.markets);

  const marketResults: ScoringDryRunMarketResult[] = new Array(attemptList.length);
  await runWithBoundedConcurrency(attemptList, options.concurrency, async (sampleMarket, index) => {
    marketResults[index] = await scoreSampleMarket(sampleMarket, scorePort);
  });

  const failedMarketReasons: Record<string, number> = {};
  let successfullyScored = 0;
  for (const result of marketResults) {
    if (result.enrichment_status === "SCORED") {
      successfullyScored += 1;
    } else if (result.failure_reason) {
      bump(failedMarketReasons, result.failure_reason);
    }
  }

  const sortedResults = [...marketResults].sort((a, b) => {
    if (a.provider_event_id !== b.provider_event_id) return a.provider_event_id < b.provider_event_id ? -1 : 1;
    return a.provider_market_id < b.provider_market_id ? -1 : 1;
  });

  return {
    report_version: DRY_RUN_REPORT_VERSION,
    fixed_now: new Date(Date.parse(options.fixedNow)).toISOString(),
    horizon_hours: options.horizonHours,
    configured_limits: {
      maxGroups: options.maxGroups,
      maxMarketsPerGroup: options.maxMarketsPerGroup,
      concurrency: options.concurrency,
    },
    source_counts: {
      rows: rows.length,
      distinct_provider_event_id: distinctEventIds.size,
      distinct_provider_market_id: distinctMarketIds.size,
    },
    eligible_strict_groups: eligible.eligibleGroups.length,
    excluded_group_reasons: sortedRecord(eligible.excludedReasons),
    selected_sample_groups: sample.length,
    attempted_markets: attemptList.length,
    successfully_enriched_markets: successfullyScored,
    successfully_scored_markets: successfullyScored,
    failed_market_reasons: sortedRecord(failedMarketReasons),
    market_results: sortedResults,
    limitations: [
      "READ_ONLY_NO_WRITES",
      DETERMINISTIC_SAMPLE_LABEL,
      "LIVE_MARKET_DATA_TIME_SENSITIVE",
      "SCORE_IS_NOT_EXECUTABILITY_PROOF",
      "NO_RESERVATION_OR_QUEUE_VALIDATION",
    ],
  };
}
