/**
 * MODEL_RESEARCH_ENGINE_FREEZE_V1 — input contract.
 *
 * This module freezes MODEL SEMANTICS AS CODE for the already-frozen
 * C0 / C1 / C4 / C5 model family. It does NOT solve canonical dataset
 * portability. The authoritative normalized physical-event identity field
 * is deferred to CANONICAL_MODELING_DATASET_V1; until then the caller
 * supplies `physicalEventKey` through this explicit input contract and the
 * engine treats it as opaque. The engine never invents an identity
 * algorithm.
 */

/** Normalized, lowercase sport-family token, e.g. `"soccer"`, `"table-tennis"`. */
export type SportFamily = string;

/** Realized settlement outcome for a single candidate economic bet. */
export type Outcome = "WIN" | "LOSS";

/**
 * One row of compatible normalized input. One physical economic event may
 * appear on multiple rows (multiple candidate bets); the engine collapses
 * them to at most one selected bet per `physicalEventKey`.
 */
export interface ResearchEngineInputEvent {
  /**
   * Caller-supplied physical-event identity key. All candidate rows for the
   * same physical economic event MUST share this value. REQUIRED. Opaque to
   * the engine. CANONICAL_MODELING_DATASET_V1 will later provide the
   * authoritative normalized field that populates this.
   */
  physicalEventKey: string;

  /** Decision timestamp — when the bet decision is made. ISO 8601 (UTC). */
  decisionTimestamp: string;

  /** Physical event start. ISO 8601 (UTC). */
  eventStart: string;

  /** Entry price in probability units. Must satisfy 0 < entryPrice < 1. */
  entryPrice: number;

  /** Normalized sport-family token. */
  sportFamily: SportFamily;

  /** Realized outcome of this candidate bet. */
  outcome: Outcome;

  /** Optional opaque passthrough retained on selected membership rows. */
  ref?: string;
}

/** Input row augmented with the derived time semantic. */
export interface EvaluatedEvent extends ResearchEngineInputEvent {
  /**
   * lead_time_hours = eventStart - decisionTimestamp, expressed in hours.
   * May be negative if the decision is made after the event start.
   */
  leadTimeHours: number;
}

/** A single bet that a model selected, with its flat-1u settlement. */
export interface SelectedBet {
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  leadTimeHours: number;
  entryPrice: number;
  sportFamily: SportFamily;
  outcome: Outcome;
  /** Settlement in units for a flat 1u stake. */
  pnlU: number;
  ref?: string;
}

/** Deterministic per-model result. */
export interface ModelResult {
  MODEL_ID: string;
  MODEL_VERSION: string;
  ROLE: string;
  /** Count of raw input rows fed to the model. */
  INPUT_EVENT_N: number;
  /** Count of distinct physical events the model selected (= WINS + LOSSES). */
  SELECTED_PHYSICAL_EVENT_N: number;
  WINS: number;
  LOSSES: number;
  /** Total settlement in units, rounded to 2 dp. */
  PNL_U: number;
  /** Return on flat-1u stake per selected event, percent, rounded to 4 dp. */
  ROI_PCT: number;
  /** Chronological maximum drawdown in units (<= 0), rounded to 2 dp. */
  MAX_DRAWDOWN_U: number;
  /** Raw (unrounded) aggregates for downstream precision-sensitive analysis. */
  raw: {
    pnlU: number;
    roiPct: number;
    maxDrawdownU: number;
  };
  /**
   * Selected physical-event keys, in stable chronological order. Exposed for
   * future weekly / sport / feature membership analysis.
   */
  selectedMembership: string[];
  /** Full selected bets, in stable chronological order. */
  selectedBets: SelectedBet[];
}
