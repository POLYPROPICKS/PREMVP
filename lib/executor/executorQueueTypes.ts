// lib/executor/executorQueueTypes.ts
//
// Shared types for the Contur3 canonical night pipeline:
//   night_event_reservations  → event-level frozen plan (written ~17:00 Minsk)
//   event_execution_queue      → per-event single-market selection (written at rebalance)
//
// Pure types only — no DB client, no side effects.

export type ReservationStatus =
  | "RESERVED"
  | "REBALANCE_PENDING"
  | "QUEUED"
  | "SKIPPED"
  | "EXPIRED"
  | "CANCELLED";

export type QueueStatus =
  | "READY"
  | "CLAIMED"
  | "SENT"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

// Executable policy constants (LOCKED — Tier1 only, $7 stake, no halftime).
export const EXECUTABLE_TIER = "TIER1" as const;
export const EXECUTABLE_STAKE_USD = 7 as const;
export const QUEUE_SCHEMA_VERSION = "executor-queue-v1" as const;
export const QUEUE_EXECUTION_MODE = "NIGHT_LIVE_EXECUTION" as const;
export const QUEUE_SOURCE = "event_execution_queue" as const;

export interface NightEventReservationRow {
  id?: string;
  plan_run_id: string;
  plan_date_minsk: string; // YYYY-MM-DD (Minsk)
  reserved_at?: string;
  window_start_iso: string;
  window_end_iso: string;
  match_family_key: string;
  event_slug: string | null;
  event_title: string | null;
  sport: string | null;
  league: string | null;
  strategic_scope: string | null;
  game_start_iso: string;
  event_tier: string | null;
  event_score: number | null;
  best_snapshot_id: string | null;
  reservation_rank: number | null;
  status: ReservationStatus;
  selection_reason: string | null;
  diagnostics: Record<string, unknown>;
}

export interface EventExecutionQueueRow {
  id?: string;
  reservation_id: string | null;
  plan_run_id: string;
  rebalance_run_id: string;
  queued_at?: string;
  match_family_key: string;
  event_title: string | null;
  event_slug: string | null;
  sport: string | null;
  league: string | null;
  game_start_iso: string;
  condition_id: string;
  token_id: string;
  side: string;
  market_slug: string | null;
  market_title: string | null;
  market_family: string | null;
  score: number | null;
  coverage: number | null;
  tier: string;
  stake_usd: number;
  preferred_entry_iso: string;
  latest_entry_iso: string;
  selection_rank: number;
  selection_reason: string | null;
  status: QueueStatus;
  order_key: string | null;
  idempotency_key: string | null;
  diagnostics: Record<string, unknown>;
}

// Ireland-facing candidate projection (mirrors /api/executor/night-plan candidate shape).
export interface IrelandQueueCandidate {
  candidate_id: string;
  order_key: string;
  idempotency_key: string | null;
  plan_run_id: string;
  rebalance_run_id: string;
  reservation_id: string | null;
  match_family_key: string;
  event_slug: string | null;
  event_id: string | null;
  event_title: string | null;
  sport: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  market_slug: string | null;
  market_title: string | null;
  market_family: string | null;
  score: number | null;
  coverage: number | null;
  tier: string;
  stake_usd: number;
  max_stake_usd: number;
  preferred_entry_iso: string;
  latest_entry_iso: string;
  game_start_iso: string;
  // PENDING_WINDOW: preferred_entry_iso still in the future; IN_WINDOW: ready to enter now.
  entry_state: "IN_WINDOW" | "PENDING_WINDOW";
  selection_rank: number;
  is_executable: true;
}
