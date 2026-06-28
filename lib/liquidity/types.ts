// LIQUIDITY_MODEL — shared types for the read-only Polymarket liquidity/price
// microstructure monitoring contour.
//
// Pure type declarations only. Row shapes mirror the operator-applied migration
// supabase/migrations/20260626_liquidity_pool_mvp_foundation.sql. Code must
// degrade gracefully (DB_ENV_MISSING / SCHEMA_MISSING) when the tables/env are
// absent. No I/O, no Supabase, no trading auth.

// ---------------------------------------------------------------------------
// Sport / market family taxonomy
// ---------------------------------------------------------------------------

/** First-class normalized sport. UNKNOWN is reported separately, never mixed. */
export type NormalizedSport =
  | "soccer"
  | "basketball"
  | "baseball"
  | "tennis"
  | "hockey"
  | "american_football"
  | "mma"
  | "boxing"
  | "cricket"
  | "rugby"
  | "golf"
  | "racing"
  | "esports"
  | "UNKNOWN";

/** Supported P0 market families plus the UNKNOWN sentinel. */
export type MarketFamily = "moneyline" | "spread" | "total" | "UNKNOWN";

/** Internal market-family gate enum (mapped to DB 'passed'/'rejected'/...). */
export type MarketFamilyGateStatus =
  | "SUPPORTED"
  | "EXCLUDED_OUTRIGHT_FUTURE"
  | "EXCLUDED_PROP"
  | "EXCLUDED_EXACT_SCORE"
  | "EXCLUDED_NOVELTY_POLITICS"
  | "EXCLUDED_UNKNOWN_FAMILY"
  // Row carried no nested/explicit market type/subtype to gate on. The broad
  // `market_family` source column ('Sports'/'Esports') is NOT used for gating.
  | "EXCLUDED_MISSING_MARKET_TYPE";

/**
 * Internal volume gate enum. Only PASS (concrete market-level volume >=
 * threshold) counts as a real pass. EVENT_VOLUME_ONLY means the only volume
 * figure available is event-level, which is NOT proof of concrete market/
 * condition liquidity and therefore does NOT pass the market-level gate.
 */
export type VolumeGateStatus =
  | "PASS"
  | "EVENT_VOLUME_ONLY"
  | "FAIL_BELOW_THRESHOLD"
  | "FAIL_MISSING_VOLUME"
  | "FAIL_STALE_VOLUME"
  | "FAIL_UNKNOWN";

/** Scope of the volume figure used for the gate. */
export type VolumeScope = "market_level" | "event_level_not_market_level";

/**
 * DB-facing gate status string stored on rows. `deferred` = the gate could not
 * be decided from source data and is intentionally validated later (e.g. source
 * has no volume column, so the market-level volume check is deferred to live
 * orderbook capture). Stored in a free-text column (no CHECK constraint).
 */
export type GateStatusDb = "passed" | "rejected" | "unknown" | "deferred";

/** DB-facing snapshot status string. */
export type SnapshotStatus = "ok" | "partial" | "failed";

/** Phase relative to game start, derived from minutes-to-start. */
export type PhaseBucket =
  | "T_12H_PLUS"
  | "T_12H"
  | "T_6H"
  | "T_3H"
  | "T_2H"
  | "T_1H"
  | "T_30M"
  | "T_15M"
  | "T_10M"
  | "T_5M"
  | "LIVE_0_5M"
  | "LIVE_5_15M"
  | "LIVE_15M_PLUS"
  | "UNKNOWN_START"
  | "POST_OR_STALE";

// ---------------------------------------------------------------------------
// Orderbook structures
// ---------------------------------------------------------------------------

/** A single normalized orderbook price level. Prices/sizes are numbers. */
export interface OrderBookLevel {
  /** Probability price in (0,1) for a Polymarket YES/NO token. */
  price: number;
  /** Share size at this level. */
  size: number;
}

/** Normalized orderbook. bids descending by price, asks ascending by price. */
export interface ParsedOrderBook {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /** Optional raw payload for diagnostics; never required downstream. */
  raw?: unknown;
}

/** Structured result of a read-only orderbook fetch. */
export interface FetchOrderBookResult {
  ok: boolean;
  tokenId: string;
  latencyMs: number;
  book?: ParsedOrderBook;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
}

// ---------------------------------------------------------------------------
// Watchlist candidate / rows
// ---------------------------------------------------------------------------

/**
 * Candidate produced from a source research snapshot/pair row before
 * dedupe/ranking/caps. Carries gate diagnostics so downstream reports can
 * explain every drop.
 */
export interface WatchlistCandidate {
  conditionId: string;
  tokenId: string;
  opposingTokenId: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
  selectedOutcome: string | null;

  rawSport: string | null;
  normalizedSport: NormalizedSport;
  sportSource: string | null;

  /** Broad source category from the `market_family` column (e.g. 'Esports'). */
  rawSourceCategory: string | null;
  /** Resolved fine market type used for gating (nested marketType/subtype). */
  marketType: string | null;
  marketTypeSource: string | null;
  /** Kept for backward-compat: the string actually fed to the family gate. */
  rawMarketFamily: string | null;
  normalizedMarketFamily: MarketFamily;
  marketFamilyGate: MarketFamilyGateStatus;
  marketFamilyGateReason: string | null;
  isOutrightOrFuture: boolean;
  isProp: boolean;

  league: string | null;
  matchFamilyKey: string | null;
  gameStartIso: string | null;
  selectedPrice: number | null;

  volumeUsd: number | null;
  volumeSource: string | null;
  volumeScope: VolumeScope | null;
  volumeGate: VolumeGateStatus;
  volumeGateReason: string | null;
  /** DB-facing volume disposition: passed | rejected | deferred (missing source). */
  volumeGateDb: GateStatusDb;

  /** Higher = preferred when deduping/ranking. */
  priorityScore: number;
  sourceTable: string | null;
  sourceRowId: string | null;
  sourceFormulaVersion: string | null;
  sourceScope: string | null;
}

/** Row destined for public.market_tracking_watchlist. */
export interface WatchlistRow {
  source_table: string | null;
  source_row_id: string | null;
  source_formula_version: string | null;
  source_scope: string | null;

  condition_id: string;
  token_id: string;
  opposing_token_id: string | null;
  event_slug: string | null;
  market_slug: string | null;
  selected_outcome: string | null;

  source_sport: string | null;
  normalized_sport: NormalizedSport;
  sport_source: string | null;

  source_market_family: string | null;
  normalized_market_family: MarketFamily;
  market_family_source: string | null;
  market_family_gate_status: GateStatusDb;
  market_family_gate_reason: string | null;
  is_supported_p0_market_family: boolean;
  is_outright_or_future: boolean;
  is_prop_market: boolean;

  league: string | null;
  match_family_key: string | null;
  game_start_iso: string | null;

  market_volume_usd: number | null;
  market_volume_source: string | null;
  volume_gate_status: GateStatusDb;
  volume_gate_threshold_usd: number;
  volume_gate_reason: string | null;
  minutes_to_start_at_insert: number | null;

  tracking_priority: number;
  tracking_status: string;
  reason: string | null;
  diagnostics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Snapshot rows
// ---------------------------------------------------------------------------

/** Row destined for public.market_price_liquidity_snapshots. */
export interface SnapshotRow {
  captured_at: string;
  source: string;
  snapshot_reason: string;
  snapshot_status: SnapshotStatus;

  condition_id: string;
  token_id: string;
  opposing_token_id: string | null;
  event_slug: string | null;
  market_slug: string | null;
  selected_outcome: string | null;

  normalized_sport: NormalizedSport;
  league: string | null;
  normalized_market_family: MarketFamily;
  match_family_key: string | null;
  game_start_iso: string | null;
  minutes_to_start: number | null;
  phase_bucket: PhaseBucket;

  market_volume_usd: number | null;
  volume_gate_status: GateStatusDb;
  volume_gate_threshold_usd: number;
  market_family_gate_status: GateStatusDb;

  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  implied_decimal_odds_mid: number | null;
  implied_decimal_odds_bid: number | null;
  implied_decimal_odds_ask: number | null;

  spread_abs: number | null;
  spread_bps: number | null;

  bid_depth_total: number | null;
  ask_depth_total: number | null;
  bid_depth_1pct: number | null;
  bid_depth_2pct: number | null;
  bid_depth_5pct: number | null;
  ask_depth_1pct: number | null;
  ask_depth_2pct: number | null;
  ask_depth_5pct: number | null;

  exit_sellable_usd_1pct: number | null;
  exit_sellable_usd_2pct: number | null;
  exit_sellable_usd_5pct: number | null;
  entry_buyable_usd_1pct: number | null;
  entry_buyable_usd_2pct: number | null;
  entry_buyable_usd_5pct: number | null;

  book_levels_json: { bids: OrderBookLevel[]; asks: OrderBookLevel[] };
  api_latency_ms: number | null;
  failure_reason: string | null;
  diagnostics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Simulation rows
// ---------------------------------------------------------------------------

/** Row destined for public.market_entry_exit_simulations. */
export interface SimulationRow {
  simulation_run_id: string;
  condition_id: string;
  token_id: string;
  opposing_token_id: string | null;
  event_slug: string | null;
  market_slug: string | null;

  normalized_sport: NormalizedSport;
  league: string | null;
  normalized_market_family: MarketFamily;
  match_family_key: string | null;
  selected_outcome: string | null;
  game_start_iso: string | null;

  entry_captured_at: string;
  exit_captured_at: string;
  entry_phase_bucket: PhaseBucket | null;
  exit_phase_bucket: PhaseBucket | null;

  entry_best_ask: number | null;
  entry_best_bid: number | null;
  entry_mid_price: number | null;
  exit_best_bid: number | null;
  exit_best_ask: number | null;
  exit_mid_price: number | null;

  stake_usd: number;
  gross_return_pct: number | null;
  estimated_slippage_pct: number | null;
  estimated_fee_pct: number;
  net_return_pct: number | null;
  exit_liquidity_usd: number | null;
  exit_possible_boolean: boolean;
  executable_5pct_boolean: boolean;
  executable_10pct_boolean: boolean;
  executable_15pct_boolean: boolean;

  entry_market_volume_usd: number | null;
  exit_market_volume_usd: number | null;
  volume_gate_threshold_usd: number;
  market_family_gate_status: GateStatusDb | null;

  exit_reason: string | null;
  model_version: string;
  diagnostics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Funnel summary + machine verdict
// ---------------------------------------------------------------------------

export type DbStatus = "OK" | "DB_ENV_MISSING" | "SCHEMA_MISSING";

/** Machine-readable contour health verdict. */
export type MachineVerdict =
  | "OK_CAPTURING"
  // Live capture + snapshots + baseline (single-snapshot) simulations succeeded,
  // but no real entry->exit history exists yet and source volume is deferred to
  // live capture. A healthy foundation state, not a failure.
  | "OK_BASELINE_CAPTURE"
  | "DB_ENV_MISSING"
  | "SCHEMA_MISSING"
  | "DEGRADED_NO_WATCHLIST"
  | "DEGRADED_NO_SNAPSHOTS"
  | "DEGRADED_LOW_SNAPSHOT_SUCCESS"
  | "DEGRADED_NO_LIQUIDITY"
  | "DEGRADED_NO_SIMULATIONS"
  | "DEGRADED_NO_VOLUME_ELIGIBLE"
  | "DEGRADED_VOLUME_SOURCE_MISSING"
  | "DEGRADED_UNKNOWN_SPORT_DOMINANT"
  | "DEGRADED_SPORT_CONCENTRATION";

export type CountMap = Partial<Record<string, number>>;

export interface VolumeGateBreakdown {
  checked: number;
  pass: number;
  eventVolumeOnly: number;
  failBelowThreshold: number;
  failMissing: number;
  failStale: number;
  failUnknown: number;
}

/**
 * Honest market-level volume disposition for the funnel summary line.
 * - marketVolumeChecked: family-supported candidates whose volume was evaluated.
 * - marketVolumePass: concrete market-level volume >= threshold (the ONLY pass).
 * - eventVolumeOnly: only event-level volume present (not market-level proof).
 * - volumeDeferred: no market-level volume in source -> deferred to live capture.
 * - volumeMissing: same source rows as deferred (no volume figure at all).
 * - volumeRejected: proven insufficient/invalid (below threshold / stale / bad).
 */
export interface VolumeDisposition {
  marketVolumeChecked: number;
  marketVolumePass: number;
  eventVolumeOnly: number;
  volumeDeferred: number;
  volumeMissing: number;
  volumeRejected: number;
}

export interface MarketFamilyGateBreakdown {
  supported: number;
  excludedOutrightFuture: number;
  excludedProp: number;
  excludedExactScore: number;
  excludedNoveltyPolitics: number;
  excludedUnknownFamily: number;
}

export interface SimulationSummaryBreakdown {
  simulations: number;
  executable5pct: number;
  executable10pct: number;
  executable15pct: number;
}

/** Aggregated 24h funnel summary; the report renderers consume this shape. */
export interface LiquidityFunnelSummary {
  windowStartIso: string;
  windowEndIso: string;
  dbStatus: DbStatus;

  // Totals
  sourceRows: number;
  candidateRows: number;
  familyGatePass: number;
  volumeChecked: number;
  volumePass: number;
  volumeRejected: number;
  /** Honest market-level volume disposition breakdown. */
  volumeDisposition: VolumeDisposition;
  activeWatchlistTokens: number;
  bookAttempts: number;
  snapshotsWritten: number;
  snapshotOk: number;
  snapshotPartial: number;
  snapshotFailed: number;
  snapshotSuccessRate: number | null;
  simulations: number;
  /** Simulations from real two-snapshot entry->exit pairs (entry != exit time). */
  entryExitSimulations: number;
  /** Simulations from single-snapshot baseline self-pairs (entry == exit). */
  baselineSimulations: number;
  /** True when family-supported markets had no source volume (deferred to capture). */
  sourceVolumeDeferred: boolean;
  executable5pct: number;
  executable10pct: number;
  executable15pct: number;
  failures: number;

  // Sport coverage
  sportsCovered: number;
  unknownSportShare: number | null;
  topSportShare: number | null;

  // By-sport breakdowns
  sourceRowsBySport: CountMap;
  candidateRowsBySport: CountMap;
  marketFamilyGateBySport: Partial<Record<string, MarketFamilyGateBreakdown>>;
  volumeGateBySport: Partial<Record<string, VolumeGateBreakdown>>;
  activeWatchlistBySport: CountMap;
  snapshotSuccessBySport: CountMap;
  simulationSummaryBySport: Partial<Record<string, SimulationSummaryBreakdown>>;
  executableOpportunitiesBySport: CountMap;

  // By sport+family breakdowns
  sourceRowsBySportFamily: CountMap;
  volumeGateBySportFamily: Partial<Record<string, VolumeGateBreakdown>>;
  activeWatchlistBySportFamily: CountMap;
  snapshotSuccessBySportFamily: CountMap;
  simulationSummaryBySportFamily: Partial<Record<string, SimulationSummaryBreakdown>>;
  executableOpportunitiesBySportFamily: CountMap;

  // Diagnostics
  rejectedMarketFamilies: CountMap;
  volumeRejectionReasons: CountMap;
  failureReasons: CountMap;
  phaseBucketCoverage: CountMap;
  topExamples: FunnelExample[];
}

/** A representative example row for the report's "Top 20" section. */
export interface FunnelExample {
  tokenId: string;
  conditionId: string;
  normalizedSport: NormalizedSport;
  normalizedMarketFamily: MarketFamily;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  exitPossible: boolean | null;
  netReturnPct: number | null;
  executable5pct: boolean | null;
}
