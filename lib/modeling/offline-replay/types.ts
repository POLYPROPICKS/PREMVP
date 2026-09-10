/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — shared types.
 *
 * A thin, local, deterministic research evaluator. No production runtime
 * dependency for repeat evaluation. Not a product; not an ML platform.
 */

/** Terminal settlement status of one market/outcome research identity. */
export type TerminalStatus = "WIN" | "LOSS" | "OPEN";

/**
 * One normalized analytical row = ONE market/outcome research identity.
 * A single physical event may carry many of these — they are NEVER collapsed
 * before policy evaluation.
 */
export interface ModelReadyRow {
  /** Canonical outcome identity: `lower(condition_id)|selected_token_id`. */
  research_identity: string;
  /** Canonical physical-event key (== provider_event_id where present). */
  physical_event_id: string;
  provider_event_id: string | null;
  condition_id: string | null;
  selected_token_id: string | null;
  selected_outcome: string | null;

  sport: string; // normalized lowercase family, or "unknown"
  market_family: string | null; // coarse family (compact corpus)
  market_type: string | null; // finer type token where present

  event_start: string | null; // ISO
  decision_at: string; // ISO — the decision / as-of instant for this identity
  observed_as_of: string | null; // ISO — evidence materialization instant
  lead_time_hours: number | null;

  entry_price: number | null; // probability units 0..1
  decimal_odds: number | null; // 1/entry_price when 0<p<1

  signal_score: number | null;
  signal_score_source: string | null;
  confidence: number | null;
  coverage: number | null;

  volume_usd: number | null;
  liquidity_usd: number | null;

  formula_version: string | null;

  terminal_status: TerminalStatus;
  winning_outcome: string | null;
  winning_token_id: string | null;

  /** Gross P&L inputs (before fees). */
  gross_pnl_u_if_win: number | null; // 1/entry_price - 1
  gross_pnl_u_if_loss: number; // -1

  settlement_provenance: string; // e.g. "settlement_label_sidecar" | "corpus_inline_gammaTerminal" | "unresolved"
  source_day: string; // YYYY-MM-DD (D-1 corpus partition)
}

export interface ModelReadyView {
  rows: ModelReadyRow[];
  meta: {
    from: string;
    to: string;
    as_of: string;
    evidence_dir: string;
    days_loaded: string[];
    days_missing: string[];
    label_sources: Record<string, string>; // day -> source
    counts: {
      IDENTITY_N: number;
      DISTINCT_PHYSICAL_EVENT_N: number;
      TERMINAL_LABELED_IDENTITY_N: number;
      UNRESOLVED_IDENTITY_N: number;
    };
    field_completeness?: {
      IDENTITY_N: number;
      MARKET_TYPE_PRESENT_N: number;
      MARKET_TYPE_PRESENT_PCT: number;
      EVENT_START_PRESENT_N: number;
      EVENT_START_PRESENT_PCT: number;
      BOTH_PRESENT_N: number;
      BOTH_PRESENT_PCT: number;
      UNKNOWN_BOTH_MISSING_N: number;
      CA_FIELDS_OVERLAY_ENRICHED_N: number;
    };
  };
}

/** One selected simulated bet (flat 1u stake). */
export interface SimulatedBet {
  physical_event_id: string;
  research_identity: string;
  decision_at: string;
  event_start: string | null;
  sport: string;
  market_family: string | null;
  entry_price: number;
  lead_time_hours: number | null;
  signal_score: number | null;
  terminal_status: TerminalStatus;
  /** null while UNRESOLVED (never enters ROI). */
  pnl_u: number | null;
}

export interface StandardResult {
  MODEL: string;
  AVAILABLE_PHYSICAL_EVENT_N: number;
  AVAILABLE_IDENTITY_N: number;
  FILTER_PASS_EVENT_N: number;
  FILTER_PASS_IDENTITY_N: number;
  SIMULATED_BET_N: number;
  TERMINAL_BET_N: number;
  UNRESOLVED_BET_N: number;
  WINS: number;
  LOSSES: number;
  GROSS_PNL_U: number; // GROSS_BEFORE_FEES
  GROSS_ROI_PCT: number | null; // per flat-1u stake on terminal bets
  MAX_DD_U: number;
  WIN_RATE_PCT: number | null;
  /** largest single-day share of |terminal PnL| — concentration diagnostic. */
  CONCENTRATION: number | null;
  /** why identities were rejected (top reasons, descending) — proves what the filter applied. */
  REJECT_REASONS: Record<string, number>;
}

export interface GroupedResult extends StandardResult {
  GROUP_KEY: string; // sport | market_family value
}

export interface ReplayRun {
  mission: "BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1";
  params: {
    models: string[];
    from: string;
    to: string;
    as_of: string;
    group_by: "sport" | "market_family" | "none";
    evidence_dir: string;
  };
  economics_basis: "GROSS_BEFORE_FEES";
  view_meta: ModelReadyView["meta"];
  overall: StandardResult[];
  grouped: Record<string, GroupedResult[]>; // model -> rows
  determinism_hash: string;
  wall_clock_ms: number;
}
