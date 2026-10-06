// Canonical, side-effect-free reservation lifecycle contract shared by the
// production rebalance and node-based read-only diagnostics.

export const REBALANCE_MINUTES_BEFORE_START = 70;
// LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2 (Founder decision 2026-10-06): the final entry deadline is the physical
// event start + 3 minutes; at or after it there is no new entry. LATEST_ENTRY_MINUTES_AFTER_START is the canonical
// authority. The signed LATEST_ENTRY_MINUTES_BEFORE (negative = AFTER the start) keeps every existing
// `start - minutes * 60_000` and `minutesToStart <= minutes` expression correct without a second deadline definition.
export const LATEST_ENTRY_MINUTES_AFTER_START = 3;
export const LATEST_ENTRY_MINUTES_BEFORE = -LATEST_ENTRY_MINUTES_AFTER_START;
export const ACTIVE_REBALANCE_RESERVATION_STATUSES = Object.freeze([
  "RESERVED",
  "REBALANCE_PENDING",
]);

export function isActiveReservationForRebalance(status) {
  return ACTIVE_REBALANCE_RESERVATION_STATUSES.includes(status);
}

export function isDueForRebalance(gameStartMs, asOfMs) {
  const minutesToStart = (gameStartMs - asOfMs) / 60_000;
  return minutesToStart > LATEST_ENTRY_MINUTES_BEFORE && minutesToStart <= REBALANCE_MINUTES_BEFORE_START;
}

export function classifyActiveReservationDue(reservation, asOfMs) {
  const startMs = Date.parse(reservation.game_start_iso);
  if (!Number.isFinite(startMs)) {
    return { state: "INVALID_START", seconds_until_due: null, rebalance_starts_iso: null, rebalance_ends_iso: null };
  }
  const rebalanceStartsMs = startMs - REBALANCE_MINUTES_BEFORE_START * 60_000;
  const rebalanceEndsMs = startMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000;
  const minutesToStart = (startMs - asOfMs) / 60_000;
  const state = minutesToStart <= LATEST_ENTRY_MINUTES_BEFORE
    ? "EXPIRED"
    : minutesToStart <= REBALANCE_MINUTES_BEFORE_START
      ? "DUE_NOW"
      : "NOT_DUE_YET";
  return {
    state,
    seconds_until_due: state === "NOT_DUE_YET" ? Math.max(0, Math.ceil((rebalanceStartsMs - asOfMs) / 1000)) : 0,
    rebalance_starts_iso: new Date(rebalanceStartsMs).toISOString(),
    rebalance_ends_iso: new Date(rebalanceEndsMs).toISOString(),
  };
}
