// lib/executor/nightWindow.ts
//
// Single source of truth for the Contur3 canonical night window.
//
// Founder canonical rule (LOCKED): operational window is 17:00 Minsk → 08:00 Minsk,
// planning horizon ~18h from the run. The legacy 6h hoursToStart cutoff is NOT the
// canonical eligibility rule and must never be used to exclude reserved night events.
//
// Europe/Minsk is a fixed UTC+3 offset (no DST since 2011).

export const PLAN_TIMEZONE = "Europe/Minsk";
const MINSK_UTC_OFFSET_HOURS = 3;

export const NIGHT_PLAN_ANCHOR_HOUR_MINSK = 17; // plan is built ~17:00 Minsk
export const NIGHT_OPERATION_END_HOUR_MINSK = 8; // operational window ends 08:00 Minsk
export const NIGHT_PLAN_HORIZON_HOURS = 18; // planning horizon from the run instant

// Per-event entry timing (preserves existing planner policy).
export const REBALANCE_MINUTES_BEFORE_START = 60; // open rebalance at T-60m
export const REBALANCE_LATE_MINUTES_BEFORE_START = 30; // still rebalance until T-30m
export const PREFERRED_ENTRY_MINUTES_BEFORE = 45; // preferred entry at T-45m
export const LATEST_ENTRY_MINUTES_BEFORE = 5; // last safe entry at T-5m

function minskParts(ms: number): { y: number; mo: number; d: number; h: number } {
  const shifted = new Date(ms + MINSK_UTC_OFFSET_HOURS * 3_600_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
  };
}

function minskWallToUtcMs(y: number, mo: number, d: number, h: number): number {
  return Date.UTC(y, mo, d, h, 0, 0) - MINSK_UTC_OFFSET_HOURS * 3_600_000;
}

/** Minsk calendar date (YYYY-MM-DD) the plan run belongs to. */
export function planDateMinsk(nowMs: number): string {
  const { y, mo, d } = minskParts(nowMs);
  return `${y.toString().padStart(4, "0")}-${(mo + 1).toString().padStart(2, "0")}-${d
    .toString()
    .padStart(2, "0")}`;
}

export interface NightWindow {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  horizonEndMs: number;
  horizonEndIso: string;
  planDateMinsk: string;
}

/**
 * Resolve the active 17:00 Minsk → 08:00 Minsk (next day) operational window for an instant.
 *   - hour < 08         → window started yesterday 17:00, ends today 08:00.
 *   - 08 <= hour < 17   → upcoming window today 17:00 → tomorrow 08:00.
 *   - hour >= 17        → window today 17:00 → tomorrow 08:00.
 * horizonEnd = max(window end, now + NIGHT_PLAN_HORIZON_HOURS) so the planning horizon
 * never falls short of ~18h regardless of when the run fires.
 */
export function resolveNightWindow(nowMs: number): NightWindow {
  const { y, mo, d, h } = minskParts(nowMs);
  let startMs: number;
  let endMs: number;
  if (h < NIGHT_OPERATION_END_HOUR_MINSK) {
    startMs = minskWallToUtcMs(y, mo, d - 1, NIGHT_PLAN_ANCHOR_HOUR_MINSK);
    endMs = minskWallToUtcMs(y, mo, d, NIGHT_OPERATION_END_HOUR_MINSK);
  } else {
    startMs = minskWallToUtcMs(y, mo, d, NIGHT_PLAN_ANCHOR_HOUR_MINSK);
    endMs = minskWallToUtcMs(y, mo, d + 1, NIGHT_OPERATION_END_HOUR_MINSK);
  }
  const horizonEndMs = Math.max(endMs, nowMs + NIGHT_PLAN_HORIZON_HOURS * 3_600_000);
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    horizonEndMs,
    horizonEndIso: new Date(horizonEndMs).toISOString(),
    planDateMinsk: planDateMinsk(nowMs),
  };
}

/** Deterministic plan_run_id for a Minsk plan date + anchor window. */
export function buildPlanRunId(nowMs: number): string {
  const w = resolveNightWindow(nowMs);
  return `night-plan:${w.planDateMinsk}:${NIGHT_PLAN_ANCHOR_HOUR_MINSK}00-minsk`;
}

export function buildRebalanceRunId(nowMs: number): string {
  return `rebalance:${new Date(nowMs).toISOString()}`;
}

/** True when an event start falls inside the planning horizon (and still future). */
export function isWithinHorizon(gameStartMs: number, win: NightWindow, nowMs: number): boolean {
  return gameStartMs > nowMs && gameStartMs <= win.horizonEndMs;
}

/**
 * True when an event is due for rebalance: now is within [T-60, T-30] before start,
 * i.e. event starts in (REBALANCE_LATE, REBALANCE] minutes. We keep rebalancing
 * until T-LATEST_ENTRY so a late run still queues a market before kickoff.
 */
export function isDueForRebalance(gameStartMs: number, nowMs: number): boolean {
  const minutesToStart = (gameStartMs - nowMs) / 60_000;
  return minutesToStart > LATEST_ENTRY_MINUTES_BEFORE && minutesToStart <= REBALANCE_MINUTES_BEFORE_START;
}

export function preferredEntryIso(gameStartMs: number): string {
  return new Date(gameStartMs - PREFERRED_ENTRY_MINUTES_BEFORE * 60_000).toISOString();
}

export function latestEntryIso(gameStartMs: number): string {
  return new Date(gameStartMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString();
}

/** Minsk decimal hour (e.g. 16.5 = 16:30) for an instant. */
export function minskHourOf(nowMs: number): number {
  const shifted = new Date(nowMs + MINSK_UTC_OFFSET_HOURS * 3_600_000);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

// Reservation creation is blocked 08:00–16:30 Minsk (daytime guard).
// Allowed: 16:30–24:00 and 00:00–08:00 Minsk (evening/night operational window).
export const RESERVATION_CREATION_ALLOWED_FROM_MINSK = 16.5;  // 16:30
export const RESERVATION_CREATION_BLOCKED_UNTIL_MINSK = 8.0;  // 08:00

/**
 * Returns true when it is safe to create tonight's reservation plan.
 * Creation is blocked during daytime (08:00–16:30 Minsk) to prevent
 * accidental stale-plan generation with matches that expire before the
 * operational window opens.
 */
export function isInReservationCreationWindow(nowMs: number): boolean {
  const h = minskHourOf(nowMs);
  return h >= RESERVATION_CREATION_ALLOWED_FROM_MINSK || h < RESERVATION_CREATION_BLOCKED_UNTIL_MINSK;
}

/** Human label "DD MMM HH:mm Minsk / HH:mm UTC" for emails. */
export function formatMinskUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const m = new Date(ms + MINSK_UTC_OFFSET_HOURS * 3_600_000);
  const u = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(m.getUTCDate())}.${pad(m.getUTCMonth() + 1)} ${pad(m.getUTCHours())}:${pad(
    m.getUTCMinutes()
  )} Minsk / ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())} UTC`;
}
