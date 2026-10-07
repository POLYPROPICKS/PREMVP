// TODAY_REAL_MONEY_PAUSE_KEEP_TELEMETRY_V1 -- PREMVP_QUEUE_PUBLICATION_KILL_SWITCH
//
// ONE narrow authority: T10_REAL_MONEY_EXECUTION_ENABLED.
//   unset                 => TRUE  (released behaviour, unchanged)
//   true | 1 | yes        => TRUE
//   false | 0 | no        => FALSE
//   anything else (incl. an empty explicit value) => FALSE  (fail closed on a malformed explicit value)
//
// When FALSE the normal write=true orchestration keeps running (capture, telemetry, selection, lifecycle,
// settlement). ONLY the creation of NEW executable event_execution_queue authority is blocked: the planned
// economic action is computed as usual, then recorded as a bounded shadow marker on the Reservation
// diagnostics (no new table, no migration) instead of becoming a READY Queue row.
//
// The marker is deliberately inert for the live path: it never changes Reservation status, never counts as
// Queue exposure and never blocks live execution once the switch is TRUE again (one-action rollback).
import { T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY, t10FrozenExecutionMode, type EventExecutionQueueRow } from "./executorQueueTypes";

export const T10_REAL_MONEY_EXECUTION_ENV = "T10_REAL_MONEY_EXECUTION_ENABLED" as const;
export const REAL_MONEY_PAUSED_SHADOW_ONLY = "REAL_MONEY_PAUSED_SHADOW_ONLY" as const;
export const SHADOW_ECONOMIC_ACTION_KEY = "shadow_economic_action_v1" as const;

export type RealMoneyExecutionSwitch = { enabled: boolean; malformed: boolean };

const TRUE_VALUES = new Set(["true", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "no"]);

export function readRealMoneyExecutionSwitch(env: Record<string, string | undefined> = process.env): RealMoneyExecutionSwitch {
  const raw = env[T10_REAL_MONEY_EXECUTION_ENV];
  if (raw === undefined) return { enabled: true, malformed: false };
  const v = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return { enabled: true, malformed: false };
  if (FALSE_VALUES.has(v)) return { enabled: false, malformed: false };
  return { enabled: false, malformed: true };
}

export function isRealMoneyExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return readRealMoneyExecutionSwitch(env).enabled;
}

/** Thrown by the Queue money boundary when a new executable row is attempted while paused. */
export class RealMoneyPausedError extends Error {
  readonly code = REAL_MONEY_PAUSED_SHADOW_ONLY;
  constructor(surface: string) {
    super(`${REAL_MONEY_PAUSED_SHADOW_ONLY}: ${surface}`);
    this.name = "RealMoneyPausedError";
  }
}

export type ShadowExecutionMode = "TAKER_FIRST" | "MAKER_FIRST" | "SKIP";

/** Scalars only. Never the order book, never the ask ladder. */
export type ShadowEconomicActionMarker = {
  marker_version: typeof SHADOW_ECONOMIC_ACTION_KEY;
  physical_event_id: string | null;
  decision_timestamp: string;
  capture_run_id: string | null;
  condition_id: string | null;
  token_id: string | null;
  side: string | null;
  market_family: string | null;
  shadow_execution_mode: ShadowExecutionMode | null;
  raw_vwap: number | null;
  effective_cost: number | null;
  maker_limit: number | null;
  ranking_inputs: Record<string, unknown> | null;
  selection_reason: string | null;
  reject_reason: string | null;
  policy_version: string;
  live_authority: false;
  real_money_paused: true;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Marker for a would-be QUEUE action: every value is copied from the row the normal decision already built.
 * Nothing here is recomputed or invented; a field the decision did not produce stays null.
 */
export function buildShadowMarkerFromPlannedRow(input: {
  row: EventExecutionQueueRow;
  reason: string;
  captureRunId: string | null;
  nowMs: number;
  policyVersion: string;
}): ShadowEconomicActionMarker {
  const d = input.row.diagnostics ?? {};
  const contract = obj(d[T10_ECONOMIC_ACTION_DIAGNOSTICS_KEY]);
  const mode = t10FrozenExecutionMode(d);
  const taker = obj(contract?.taker);
  const maker = obj(contract?.maker);
  return {
    marker_version: SHADOW_ECONOMIC_ACTION_KEY,
    physical_event_id: str(d.physical_event_id),
    decision_timestamp: new Date(input.nowMs).toISOString(),
    capture_run_id: input.captureRunId,
    condition_id: input.row.condition_id ?? null,
    token_id: input.row.token_id ?? null,
    side: input.row.side ?? null,
    market_family: input.row.market_family ?? null,
    shadow_execution_mode: mode === "TAKER_FIRST" || mode === "MAKER_FIRST" ? mode : null,
    raw_vwap: num(taker?.authorized_raw_vwap),
    effective_cost: num(taker?.authorized_effective_cost),
    maker_limit: num(maker?.maker_limit_price),
    ranking_inputs: contract
      ? {
          p_buy_max: num(contract.p_buy_max),
          reference_status: str(contract.reference_status),
          stake_usd: num(contract.stake_usd),
          taker_price_limit: num(taker?.price_limit),
          support_audit: obj(d.t10_support_audit_v1),
          b_comparison: obj(d.current_b_comparison),
        }
      : null,
    selection_reason: input.row.selection_reason ?? input.reason,
    reject_reason: null,
    policy_version: input.policyVersion,
    live_authority: false,
    real_money_paused: true,
  };
}

/** Marker for a natural economic SKIP: the normal reason is preserved verbatim. */
export function buildShadowSkipMarker(input: {
  physicalEventId: string | null;
  reason: string;
  nowMs: number;
  policyVersion: string;
}): ShadowEconomicActionMarker {
  return {
    marker_version: SHADOW_ECONOMIC_ACTION_KEY,
    physical_event_id: input.physicalEventId,
    decision_timestamp: new Date(input.nowMs).toISOString(),
    capture_run_id: null,
    condition_id: null, token_id: null, side: null, market_family: null,
    shadow_execution_mode: "SKIP",
    raw_vwap: null, effective_cost: null, maker_limit: null, ranking_inputs: null,
    selection_reason: null,
    reject_reason: input.reason,
    policy_version: input.policyVersion,
    live_authority: false,
    real_money_paused: true,
  };
}

/**
 * The existing marker, if it is valid for exactly this completed capture and policy version. A QUEUE-derived marker
 * only (a SKIP is terminal on its own). Anything else (absent, other capture, other policy, malformed) is null and
 * the decision is evaluated again once.
 */
export function readValidShadowMarker(
  diagnostics: Record<string, unknown> | null | undefined,
  captureRunId: string | null,
  policyVersion: string,
): ShadowEconomicActionMarker | null {
  const m = obj(diagnostics?.[SHADOW_ECONOMIC_ACTION_KEY]);
  if (!m || !captureRunId) return null;
  if (m.marker_version !== SHADOW_ECONOMIC_ACTION_KEY) return null;
  if (m.live_authority !== false || m.real_money_paused !== true) return null;
  if (m.shadow_execution_mode === "SKIP") return null;
  if (m.capture_run_id !== captureRunId || m.policy_version !== policyVersion) return null;
  return m as unknown as ShadowEconomicActionMarker;
}
