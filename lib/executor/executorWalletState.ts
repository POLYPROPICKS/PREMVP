// lib/executor/executorWalletState.ts
//
// EXECUTOR_WALLET_STATE_V1 — the canonical PREMVP wallet-observation surface.
//
// Accepted Ireland/Polymarket order callbacks carry a point-in-time trading
// wallet observation: spendable / collateral / allowance balances, the moment
// the wallet was read (wallet_observed_at), and a lifecycle point
// (PRE_SUBMIT / POST_SUBMIT / CURRENT_SNAPSHOT). Historically that evidence
// only survived inside executor_order_events.raw_event_json as opaque JSON.
//
// This module is the ONE place PREMVP:
//   1. shapes a wallet observation out of a sanitized callback payload
//      (deriveWalletObservationFields) so the order-events route can persist
//      it as structured, queryable columns on executor_order_events; and
//   2. resolves the current authoritative spendable balance
//      (selectCurrentSpendableWalletState / getCurrentSpendableWalletState)
//      strictly by observation freshness, so a late or out-of-order callback
//      can never overwrite a newer wallet reading.
//
// Semantics (do not widen without a Founder decision):
//   CURRENT_SPENDABLE_BALANCE_USD — latest valid Ireland/Polymarket
//     spendable_balance_usd by wallet_observed_at. The authoritative
//     available trading cash for future stake / risk decisions.
//   collateral_balance_usd — retained for audit / reconciliation only.
//   allowance_usd — technical contract spend allowance / readiness evidence.
//     It is NOT bankroll and must never be used as stake capital.
//
// This is NOT portfolio NAV. Open-position valuation and settlement are out
// of scope.
//
// Pure module: no Supabase import, no network, no env. The Supabase-backed
// WalletStateDbPort implementation lives in ./executorWalletStateDbPort.

export const WALLET_STATE_VERSION = "EXECUTOR_WALLET_STATE_V1" as const;

export const WALLET_OBSERVATION_LIFECYCLE_POINTS = [
  "PRE_SUBMIT",
  "POST_SUBMIT",
  "CURRENT_SNAPSHOT",
  "UNKNOWN",
] as const;

export type WalletObservationLifecyclePoint = (typeof WALLET_OBSERVATION_LIFECYCLE_POINTS)[number];

/** Structured wallet-observation columns persisted on executor_order_events. */
export interface WalletObservationFields {
  spendable_balance_usd: number | null;
  collateral_balance_usd: number | null;
  allowance_usd: number | null;
  /** ISO 8601 UTC instant the wallet was read by the Ireland executor. */
  wallet_observed_at: string | null;
  wallet_observation_lifecycle_point: WalletObservationLifecyclePoint | null;
}

const WALLET_FIELD_KEYS: readonly (keyof WalletObservationFields)[] = [
  "spendable_balance_usd",
  "collateral_balance_usd",
  "allowance_usd",
  "wallet_observed_at",
  "wallet_observation_lifecycle_point",
];

/** The wallet-observation column names, for callers that must strip them (e.g. additive-migration fallback). */
export const WALLET_OBSERVATION_COLUMN_NAMES: readonly string[] = WALLET_FIELD_KEYS;

function numLike(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function nestedObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isoInstant(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function lifecyclePoint(v: unknown): WalletObservationLifecyclePoint | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const upper = v.trim().toUpperCase();
  return (WALLET_OBSERVATION_LIFECYCLE_POINTS as readonly string[]).includes(upper)
    ? (upper as WalletObservationLifecyclePoint)
    : "UNKNOWN";
}

/**
 * Derives the wallet-observation fields from an already-sanitized callback
 * payload. Reads the proven live top-level snake_case shape first
 * (spendable_balance_usd, collateral_balance_usd, allowance_usd,
 * wallet_observed_at, wallet_observation_lifecycle_point), then falls back to
 * the ECONOMIC_TELEMETRY_V1 nested wallet block (top level or inside
 * raw_event_json) and to raw_event_json's own top level. Numeric strings are
 * accepted. Nothing is fabricated: an absent field stays null.
 */
export function deriveWalletObservationFields(sanitized: Record<string, unknown>): WalletObservationFields {
  const rawEventJson = nestedObj(sanitized.raw_event_json);
  const telemetryWallet =
    nestedObj(nestedObj(sanitized.economic_telemetry_v1)?.wallet) ??
    nestedObj(nestedObj(rawEventJson?.economic_telemetry_v1)?.wallet);

  const pick = (key: string): unknown =>
    sanitized[key] ?? telemetryWallet?.[key] ?? rawEventJson?.[key];

  const observedAtRaw =
    sanitized.wallet_observed_at ??
    telemetryWallet?.observed_at ??
    telemetryWallet?.wallet_observed_at ??
    rawEventJson?.wallet_observed_at;

  const lifecycleRaw =
    sanitized.wallet_observation_lifecycle_point ??
    telemetryWallet?.lifecycle_point ??
    telemetryWallet?.wallet_observation_lifecycle_point ??
    rawEventJson?.wallet_observation_lifecycle_point;

  return {
    spendable_balance_usd: numLike(pick("spendable_balance_usd")),
    collateral_balance_usd: numLike(pick("collateral_balance_usd")),
    allowance_usd: numLike(pick("allowance_usd")),
    wallet_observed_at: isoInstant(observedAtRaw),
    wallet_observation_lifecycle_point: lifecyclePoint(lifecycleRaw),
  };
}

/** True when at least one wallet fact is present — i.e. worth persisting. */
export function hasWalletObservation(fields: WalletObservationFields): boolean {
  return (
    fields.spendable_balance_usd !== null ||
    fields.collateral_balance_usd !== null ||
    fields.allowance_usd !== null ||
    fields.wallet_observed_at !== null
  );
}

// ── current spendable balance resolution ────────────────────────────────────

/** One executor_order_events row projected to its wallet-observation facts + lineage. */
export interface WalletObservationRow extends WalletObservationFields {
  id: string;
  idempotency_key: string | null;
  clob_order_id: string | null;
  /** Row insert time — used ONLY to break exact wallet_observed_at ties. */
  created_at: string | null;
}

export interface CurrentSpendableWalletState {
  version: typeof WALLET_STATE_VERSION;
  /** Authoritative available trading cash. */
  current_spendable_balance_usd: number;
  collateral_balance_usd: number | null;
  /** Contract spend readiness evidence only — never bankroll. */
  allowance_usd: number | null;
  wallet_observed_at: string;
  wallet_observation_lifecycle_point: WalletObservationLifecyclePoint | null;
  source_order_event: {
    id: string;
    idempotency_key: string | null;
    clob_order_id: string | null;
    created_at: string | null;
  };
}

/**
 * Picks the current spendable wallet state from a set of order-event wallet
 * observations. Freshness is strictly by wallet_observed_at (the venue read
 * time); created_at only breaks an exact observed-at tie. Rows without a
 * finite spendable_balance_usd or without a parseable wallet_observed_at are
 * ignored, so a later callback that omitted the wallet block — or that was
 * delivered out of order — can never become the newer wallet authority.
 */
export function selectCurrentSpendableWalletState(
  rows: readonly WalletObservationRow[],
): CurrentSpendableWalletState | null {
  let best: WalletObservationRow | null = null;
  let bestObservedMs = Number.NEGATIVE_INFINITY;
  let bestCreatedMs = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    if (typeof row.spendable_balance_usd !== "number" || !Number.isFinite(row.spendable_balance_usd)) continue;
    if (!row.wallet_observed_at) continue;
    const observedMs = Date.parse(row.wallet_observed_at);
    if (!Number.isFinite(observedMs)) continue;
    const createdMs = row.created_at ? Date.parse(row.created_at) : Number.NEGATIVE_INFINITY;
    const createdComparable = Number.isFinite(createdMs) ? createdMs : Number.NEGATIVE_INFINITY;

    if (observedMs > bestObservedMs || (observedMs === bestObservedMs && createdComparable > bestCreatedMs)) {
      best = row;
      bestObservedMs = observedMs;
      bestCreatedMs = createdComparable;
    }
  }

  if (!best) return null;

  return {
    version: WALLET_STATE_VERSION,
    current_spendable_balance_usd: best.spendable_balance_usd as number,
    collateral_balance_usd: best.collateral_balance_usd,
    allowance_usd: best.allowance_usd,
    wallet_observed_at: new Date(bestObservedMs).toISOString(),
    wallet_observation_lifecycle_point: best.wallet_observation_lifecycle_point,
    source_order_event: {
      id: best.id,
      idempotency_key: best.idempotency_key,
      clob_order_id: best.clob_order_id,
      created_at: best.created_at,
    },
  };
}

/** Read boundary for the current-spendable-balance helper. */
export interface WalletStateDbPort {
  /** Most recent order-event wallet observations, newest row first. */
  recentWalletObservations(limit: number): Promise<WalletObservationRow[]>;
}

export interface GetCurrentSpendableWalletStateOptions {
  /** How many recent order-event rows to consider (default 200). */
  lookback?: number;
}

/**
 * The one canonical internal read for CURRENT_SPENDABLE_BALANCE_USD. Returns
 * null when no accepted callback has yet carried a usable spendable-balance
 * observation. Does not change stake sizing — callers decide how to use it.
 */
export async function getCurrentSpendableWalletState(
  port: WalletStateDbPort,
  options: GetCurrentSpendableWalletStateOptions = {},
): Promise<CurrentSpendableWalletState | null> {
  const lookback = Number.isFinite(options.lookback) && (options.lookback as number) > 0
    ? Math.min(Math.trunc(options.lookback as number), 1000)
    : 200;
  const rows = await port.recentWalletObservations(lookback);
  return selectCurrentSpendableWalletState(rows);
}
