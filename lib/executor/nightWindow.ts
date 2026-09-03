// Canonical Reservation-anchor clock. Railway wakes the route; this module owns anchor timing.
export const PLAN_TIMEZONE = "Europe/Minsk";
const MINSK_UTC_OFFSET_HOURS = 3;
export const MAX_RESERVATION_HORIZON_HOURS = 24;
export const RESERVATION_ANCHOR_DELAY_TOLERANCE_MINUTES = 5;

import { REBALANCE_MINUTES_BEFORE_START, LATEST_ENTRY_MINUTES_BEFORE, isDueForRebalance as isDueForRebalanceAtUtc } from "./reservationRebalanceContract.mjs";
export { REBALANCE_MINUTES_BEFORE_START, LATEST_ENTRY_MINUTES_BEFORE };
export const REBALANCE_LATE_MINUTES_BEFORE_START = 30;
export const PREFERRED_ENTRY_MINUTES_BEFORE = 45;

export interface ReservationAnchorTime { hour: number; minute: number; hhmm: string; }
export interface ReservationAnchor extends ReservationAnchorTime { anchorMs: number; anchorIso: string; planDateMinsk: string; times: readonly ReservationAnchorTime[]; }

function minskParts(ms: number) { const x = new Date(ms + MINSK_UTC_OFFSET_HOURS * 3_600_000); return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours(), minute: x.getUTCMinutes() }; }
function minskWallToUtcMs(y: number, mo: number, d: number, h: number, minute = 0) { return Date.UTC(y, mo, d, h, minute, 0) - MINSK_UTC_OFFSET_HOURS * 3_600_000; }
function minskDate(y: number, mo: number, d: number) { return `${y.toString().padStart(4, "0")}-${(mo + 1).toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`; }

/** The only Reservation schedule config. Absent retains the historical 17:00 anchor. */
export function parseReservationTimesMinsk(value: string | undefined = process.env.RESERVATION_TIMES_MINSK): ReservationAnchorTime[] {
  if (value === undefined) return [{ hour: 17, minute: 0, hhmm: "1700" }];
  if (!value.trim()) throw new Error("RESERVATION_TIMES_MINSK_INVALID: expected one or more HH:MM anchors");
  const seen = new Set<string>();
  const times = value.split(",").map((part) => {
    const match = /^(\d{2}):(\d{2})$/.exec(part.trim());
    if (!match) throw new Error(`RESERVATION_TIMES_MINSK_INVALID: invalid anchor ${JSON.stringify(part)}`);
    const hour = Number(match[1]), minute = Number(match[2]), hhmm = `${match[1]}${match[2]}`;
    if (hour > 23 || minute > 59 || seen.has(hhmm)) throw new Error(`RESERVATION_TIMES_MINSK_INVALID: invalid or duplicate anchor ${JSON.stringify(part)}`);
    seen.add(hhmm); return { hour, minute, hhmm };
  });
  return times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

export function planDateMinsk(nowMs: number): string { const p = minskParts(nowMs); return minskDate(p.y, p.mo, p.d); }
function makeAnchor(y: number, mo: number, d: number, time: ReservationAnchorTime, times: readonly ReservationAnchorTime[]): ReservationAnchor {
  const anchorMs = minskWallToUtcMs(y, mo, d, time.hour, time.minute);
  return { ...time, anchorMs, anchorIso: new Date(anchorMs).toISOString(), planDateMinsk: minskDate(y, mo, d), times };
}

/** Most recent configured anchor; explicit repair paths use this deterministic context. */
export function resolveReservationAnchor(nowMs: number, times = parseReservationTimesMinsk()): ReservationAnchor {
  const p = minskParts(nowMs);
  const candidates = [...times.map((t) => makeAnchor(p.y, p.mo, p.d, t, times)), ...times.map((t) => makeAnchor(p.y, p.mo, p.d - 1, t, times))].filter((a) => a.anchorMs <= nowMs);
  if (!candidates.length) throw new Error("RESERVATION_ANCHOR_RESOLUTION_FAILED");
  return candidates.sort((a, b) => b.anchorMs - a.anchorMs)[0];
}

/** A cron retry is due only within this bounded delay; it cannot claim an unrelated anchor. */
export function resolveDueReservationAnchor(nowMs: number, times = parseReservationTimesMinsk(), toleranceMinutes = RESERVATION_ANCHOR_DELAY_TOLERANCE_MINUTES): ReservationAnchor | null {
  const anchor = resolveReservationAnchor(nowMs, times);
  return nowMs - anchor.anchorMs <= toleranceMinutes * 60_000 ? anchor : null;
}

export interface NightWindow { startMs: number; endMs: number; startIso: string; endIso: string; horizonEndMs: number; horizonEndIso: string; planDateMinsk: string; }
/** [actual configured anchor, next configured anchor), bounded to 24 hours. */
export function resolveNightWindow(nowMs: number, anchor = resolveReservationAnchor(nowMs)): NightWindow {
  const next = anchor.times.find((t) => t.hour > anchor.hour || (t.hour === anchor.hour && t.minute > anchor.minute));
  const p = minskParts(anchor.anchorMs);
  const nextMs = next ? minskWallToUtcMs(p.y, p.mo, p.d, next.hour, next.minute) : minskWallToUtcMs(p.y, p.mo, p.d + 1, anchor.times[0].hour, anchor.times[0].minute);
  const horizonEndMs = Math.min(nextMs, anchor.anchorMs + MAX_RESERVATION_HORIZON_HOURS * 3_600_000);
  return { startMs: anchor.anchorMs, endMs: horizonEndMs, startIso: anchor.anchorIso, endIso: new Date(horizonEndMs).toISOString(), horizonEndMs, horizonEndIso: new Date(horizonEndMs).toISOString(), planDateMinsk: anchor.planDateMinsk };
}
export function buildPlanRunId(nowMs: number, anchor = resolveReservationAnchor(nowMs)): string { return `night-plan:${anchor.planDateMinsk}:${anchor.hhmm}-minsk`; }
export function buildRebalanceRunId(nowMs: number): string { return `rebalance:${new Date(nowMs).toISOString()}`; }
export function isWithinHorizon(gameStartMs: number, win: NightWindow, nowMs: number): boolean { return gameStartMs > nowMs && gameStartMs >= win.startMs && gameStartMs < win.horizonEndMs; }
export function isDueForRebalance(gameStartMs: number, nowMs: number): boolean { return isDueForRebalanceAtUtc(gameStartMs, nowMs); }
export function preferredEntryIso(gameStartMs: number): string { return new Date(gameStartMs - PREFERRED_ENTRY_MINUTES_BEFORE * 60_000).toISOString(); }
export function latestEntryIso(gameStartMs: number): string { return new Date(gameStartMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString(); }
export function minskHourOf(nowMs: number): number { const p = minskParts(nowMs); return p.h + p.minute / 60; }
export function formatMinskUtc(iso: string): string { const ms = Date.parse(iso); if (!Number.isFinite(ms)) return iso; const m = new Date(ms + MINSK_UTC_OFFSET_HOURS * 3_600_000), u = new Date(ms), pad = (n: number) => n.toString().padStart(2, "0"); return `${pad(m.getUTCDate())}.${pad(m.getUTCMonth()+1)} ${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())} Minsk / ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())} UTC`; }
