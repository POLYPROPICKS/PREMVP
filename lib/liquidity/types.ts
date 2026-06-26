// LIQUIDITY_MODEL — shared types for the read-only Polymarket liquidity/price
// microstructure monitoring contour.
//
// This module is pure type declarations only. No runtime side effects, no I/O,
// no Supabase, no trading auth. It is safe to import from anywhere (lib, scripts,
// tests). Tables referenced here are created manually by the operator; code must
// degrade gracefully (DB_ENV_MISSING / SCHEMA_MISSING) when they are absent.

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

/** Outcome of the market-family gate (applied before the volume gate). */
export type MarketFamilyGateStatus =
  | "SUPPORTED"
  | "EXCLUDED_OUTRIGHT_FUTURE"
  | "EXCLUDED_PROP"
  | "EXCLUDED_EXACT_SCORE"
  | "EXCLUDED_NOVELTY_POLITICS"
  | "EXCLUDED_UNKNOWN_FAMILY";

/** Outcome of the hard market-level volume gate. */
export type VolumeGateStatus =
  | "PASS"
  | "PASS_EVENT_LEVEL"
  | "FAIL_BELOW_THRESHOLD"
  | "FAIL_MISSING_VOLUME"
  | "FAIL_STALE_VOLUME"
  | "FAIL_UNKNOWN";

/** Scope of the volume figure used for the gate. */
export type VolumeScope = "market_level" | "event_level_not_market_level";

/** Result of an orderbook snapshot capture attempt. */
export type SnapshotStatus =
  | "OK"
  | "PARTIAL"
  | "EMPTY_BOOK"
  | "FETCH_FAILED"
  | "PARSE_FAILED"
  | "TIMEOUT"
  | "HTTP_ERROR";

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
// Watchlist / snapshot / simulation rows
// ---------------------------------------------------------------------------

/**
 * Candidate produced from a source research snapshot/pair row before
 * dedupe/ranking/caps. Carries gate diagnostics so downstream reports can
 * explain every drop.
 */
export interface WatchlistCandidate {
  tokenId: string;
  marketId: string | null;
  eventId: string | null;
  question: string | null;
  normalizedSport: NormalizedSport;
  rawSport: string | null;
  normalizedMarketFamily: MarketFamily;
  rawMarketFamily: string | null;
  marketFamilyGate: MarketFamilyGateStatus;
  volumeUsd: number | null;
  volumeScope: VolumeScope | null;
  volumeGate: VolumeGateStatus;
  gameStartIso: string | null;
  /** Higher = preferred when deduping/ranking. */
  priorityScore: number;
  sourceTable: string | null;
  sourceRowId: string | null;
}

/** Row destined for market_tracking_watchlist (operator-managed table). */
export interface WatchlistRow {
  token_id: string;
  market_id: string | null;
  event_id: string | null;
  question: string | null;
  normalized_sport: NormalizedSport;
  normalized_market_family: MarketFamily;
  market_family_gate: MarketFamilyGateStatus;
  volume_usd: number | null;
  volume_scope: VolumeScope | null;
  volume_gate: VolumeGateStatus;
  game_start_iso: string | null;
  priority_score: number;
  source_table: string | null;
  source_row_id: string | null;
}

/** Row destined for market_price_liquidity_snapshots. */
export interface SnapshotRow {
  token_id: string;
  market_id: string | null;
  normalized_sport: NormalizedSport;
  normalized_market_family: MarketFamily;
  captured_at: string;
  game_start_iso: string | null;
  minutes_to_start: number | null;
  phase_bucket: PhaseBucket;
  status: SnapshotStatus;
  failure_code: string | null;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
  spread_bps: number | null;
  bid_depth_1pct_usd: number | null;
  ask_depth_1pct_usd: number | null;
  bid_depth_2pct_usd: number | null;
  ask_depth_2pct_usd: number | null;
  bid_depth_5pct_usd: number | null;
  ask_depth_5pct_usd: number | null;
  latency_ms: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/** Row destined for market_entry_exit_simulations. */
export interface SimulationRow {
  token_id: string;
  market_id: string | null;
  normalized_sport: NormalizedSport;
  normalized_market_family: MarketFamily;
  simulated_at: string;
  phase_bucket: PhaseBucket;
  stake_usd: number;
  entry_price: number | null;
  shares: number | null;
  exit_proceeds_5pct_usd: number | null;
  exit_proceeds_10pct_usd: number | null;
  exit_proceeds_15pct_usd: number | null;
  net_return_5pct_pct: number | null;
  net_return_10pct_pct: number | null;
  net_return_15pct_pct: number | null;
  executable_5pct: boolean;
  executable_10pct: boolean;
  executable_15pct: boolean;
}

// ---------------------------------------------------------------------------
// Funnel summary + machine verdict
// ---------------------------------------------------------------------------

export type DbStatus = "OK" | "DB_ENV_MISSING" | "SCHEMA_MISSING";

/** Machine-readable contour health verdict. */
export type MachineVerdict =
  | "OK_CAPTURING"
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

/** A keyed count map, e.g. { soccer: 12, basketball: 3 }. */
export type CountBySport = Partial<Record<string, number>>;

/** Per-(sport|family) keyed bucket, key format "sport::family". */
export type CountBySportFamily = Partial<Record<string, number>>;

export interface VolumeGateBreakdown {
  checked: number;
  pass: number;
  passEventLevel: number;
  failBelowThreshold: number;
  failMissing: number;
  failStale: number;
  failUnknown: number;
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
  activeWatchlistTokens: number;
  bookAttempts: number;
  snapshotsWritten: number;
  snapshotOk: number;
  snapshotPartial: number;
  snapshotFailed: number;
  snapshotSuccessRate: number | null;
  simulations: number;
  executable5pct: number;
  executable10pct: number;
  executable15pct: number;
  failures: number;

  // Sport coverage
  sportsCovered: number;
  unknownSportShare: number | null;
  topSportShare: number | null;

  // By-sport breakdowns
  sourceRowsBySport: CountBySport;
  candidateRowsBySport: CountBySport;
  marketFamilyGateBySport: Partial<Record<string, MarketFamilyGateBreakdown>>;
  volumeGateBySport: Partial<Record<string, VolumeGateBreakdown>>;
  activeWatchlistBySport: CountBySport;

  // By sport+family breakdowns
  sourceRowsBySportFamily: CountBySportFamily;
  volumeGateBySportFamily: Partial<Record<string, VolumeGateBreakdown>>;
  activeWatchlistBySportFamily: CountBySportFamily;
  snapshotSuccessBySportFamily: CountBySportFamily;
  simulationSummaryBySportFamily: Partial<Record<string, SimulationSummaryBreakdown>>;
  executableOpportunitiesBySportFamily: CountBySportFamily;

  // Diagnostics
  rejectedMarketFamilies: Partial<Record<string, number>>;
  failureReasons: Partial<Record<string, number>>;
  phaseBucketCoverage: Partial<Record<string, number>>;
  topExamples: FunnelExample[];
}

/** A representative example row for the report's "Top 20" section. */
export interface FunnelExample {
  tokenId: string;
  normalizedSport: NormalizedSport;
  normalizedMarketFamily: MarketFamily;
  question: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  executable5pct: boolean | null;
  netReturn5pctPct: number | null;
}
