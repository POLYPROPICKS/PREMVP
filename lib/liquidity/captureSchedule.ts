// LIQUIDITY_MODEL — pure capture-cadence scheduling for the auto-capture contour.
//
// Decides WHEN to capture liquidity snapshots for an event, relative to its
// start/end. All arithmetic is in UTC; Minsk-local strings are for display only
// (Europe/Minsk is a fixed UTC+3, no DST). No I/O, no Supabase, no fetch.
//
// Cadence rules (per founder spec):
//   before T-12h          -> not in window (no capture)
//   T-12h .. T-2h         -> every 120 minutes   (phase pre12_to_pre2)
//   T-2h  .. start        -> every 10 minutes    (phase final2h)
//   start .. end          -> every 10 minutes    (phase in_play)
//   after end             -> closed (no capture)
// Default in-play duration for football/soccer = 130 minutes unless an explicit
// end/close time is supplied.

import { pathToFileURL } from "node:url";

export type CapturePhase =
  | "not_started_window"
  | "pre12_to_pre2"
  | "final2h"
  | "in_play"
  | "closed";

export const SOCCER_DEFAULT_DURATION_MIN = 130;
export const DEFAULT_EVENT_DURATION_MIN = 130;

const MIN = 60_000;
const HOUR = 60 * MIN;
const PRE_WINDOW_START_MS = 12 * HOUR; // T-12h
const FINAL_WINDOW_START_MS = 2 * HOUR; // T-2h
const PRE12_CADENCE_MIN = 120;
const FINAL_CADENCE_MIN = 10;
const IN_PLAY_CADENCE_MIN = 10;

function toMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value).trim());
  return Number.isNaN(t) ? null : t;
}

function isSoccer(sport: string | null | undefined): boolean {
  if (!sport) return true; // default contour is football/soccer-first
  const s = sport.toLowerCase();
  return s.includes("soccer") || s.includes("football") || s === "fifwc" || s.includes("fifa");
}

/**
 * Resolve an event end timestamp (ms). Uses an explicit end if present and
 * after start; otherwise start + default duration (130 min for soccer/default).
 */
export function resolveEventEndMs(
  eventStart: string | number | Date | null | undefined,
  eventEnd?: string | number | Date | null,
  sport?: string | null,
  durationMin?: number,
): number | null {
  const startMs = toMs(eventStart);
  if (startMs === null) return null;
  const endMs = toMs(eventEnd ?? null);
  if (endMs !== null && endMs > startMs) return endMs;
  const dur =
    durationMin && durationMin > 0
      ? durationMin
      : isSoccer(sport)
        ? SOCCER_DEFAULT_DURATION_MIN
        : DEFAULT_EVENT_DURATION_MIN;
  return startMs + dur * MIN;
}

export interface CaptureCadence {
  phase: CapturePhase;
  /** Minutes between captures in the current phase, or null when not due. */
  cadenceMinutes: number | null;
  /** True when the event is in an active capture window (pre12/final2h/in_play). */
  inWindow: boolean;
  /** Minutes from now until start (positive = pre-game), null if start unknown. */
  minutesToStart: number | null;
  eventStartMs: number | null;
  eventEndMs: number | null;
}

export interface CadenceOptions {
  eventEnd?: string | number | Date | null;
  sport?: string | null;
  durationMin?: number;
}

/** Determine the capture phase + cadence for an event at time `now`. */
export function getLiquidityCaptureCadence(
  now: string | number | Date,
  eventStart: string | number | Date | null | undefined,
  opts: CadenceOptions = {},
): CaptureCadence {
  const nowMs = toMs(now);
  const startMs = toMs(eventStart);
  const endMs = resolveEventEndMs(eventStart, opts.eventEnd ?? null, opts.sport, opts.durationMin);

  const base: CaptureCadence = {
    phase: "not_started_window",
    cadenceMinutes: null,
    inWindow: false,
    minutesToStart: nowMs !== null && startMs !== null ? (startMs - nowMs) / MIN : null,
    eventStartMs: startMs,
    eventEndMs: endMs,
  };
  if (nowMs === null || startMs === null || endMs === null) return base;

  const preWindowStart = startMs - PRE_WINDOW_START_MS;
  const finalWindowStart = startMs - FINAL_WINDOW_START_MS;

  if (nowMs < preWindowStart) {
    return { ...base, phase: "not_started_window", cadenceMinutes: null, inWindow: false };
  }
  if (nowMs < finalWindowStart) {
    return { ...base, phase: "pre12_to_pre2", cadenceMinutes: PRE12_CADENCE_MIN, inWindow: true };
  }
  if (nowMs < startMs) {
    return { ...base, phase: "final2h", cadenceMinutes: FINAL_CADENCE_MIN, inWindow: true };
  }
  if (nowMs <= endMs) {
    return { ...base, phase: "in_play", cadenceMinutes: IN_PLAY_CADENCE_MIN, inWindow: true };
  }
  return { ...base, phase: "closed", cadenceMinutes: null, inWindow: false };
}

/**
 * True when a capture is due: in an active window AND (never captured OR elapsed
 * since last capture >= the current phase cadence).
 */
export function isLiquidityCaptureDue(
  lastCaptureAt: string | number | Date | null | undefined,
  now: string | number | Date,
  eventStart: string | number | Date | null | undefined,
  opts: CadenceOptions = {},
): boolean {
  const cadence = getLiquidityCaptureCadence(now, eventStart, opts);
  if (cadence.cadenceMinutes === null) return false;
  const lastMs = toMs(lastCaptureAt ?? null);
  if (lastMs === null) return true;
  const nowMs = toMs(now);
  if (nowMs === null) return false;
  const elapsedMin = (nowMs - lastMs) / MIN;
  return elapsedMin >= cadence.cadenceMinutes;
}

/**
 * Next time a capture is due (ms), or null when the event is closed/unknown.
 * - in window, never captured -> now (due immediately)
 * - in window, captured       -> lastCapture + cadence
 * - before window             -> window start (T-12h)
 */
export function nextDueMs(
  lastCaptureAt: string | number | Date | null | undefined,
  now: string | number | Date,
  eventStart: string | number | Date | null | undefined,
  opts: CadenceOptions = {},
): number | null {
  const cadence = getLiquidityCaptureCadence(now, eventStart, opts);
  const nowMs = toMs(now);
  if (nowMs === null) return null;
  if (cadence.phase === "not_started_window" && cadence.eventStartMs !== null) {
    return cadence.eventStartMs - PRE_WINDOW_START_MS;
  }
  if (cadence.phase === "closed") return null;
  if (cadence.cadenceMinutes === null) return null;
  const lastMs = toMs(lastCaptureAt ?? null);
  if (lastMs === null) return nowMs;
  return lastMs + cadence.cadenceMinutes * MIN;
}

export interface ScheduleEventInput {
  key: string;
  eventSlug?: string | null;
  eventId?: string | null;
  eventTitle?: string | null;
  gameStartIso: string | null;
  eventEndIso?: string | null;
  sport?: string | null;
  tokenCount?: number;
  lastCaptureAt?: string | null;
}

export interface CapturePlanEntry {
  key: string;
  eventSlug: string | null;
  eventTitle: string | null;
  sport: string | null;
  phase: CapturePhase;
  cadenceMinutes: number | null;
  inWindow: boolean;
  due: boolean;
  tokenCount: number;
  minutesToStart: number | null;
  eventStartUtc: string | null;
  eventStartMinsk: string | null;
  eventEndUtc: string | null;
  nextDueUtc: string | null;
  nextDueMinsk: string | null;
}

export interface CapturePlan {
  generatedAtUtc: string;
  nowUtc: string;
  windowDays: number;
  totalEvents: number;
  inWindowEvents: number;
  dueEvents: number;
  entries: CapturePlanEntry[];
}

export interface BuildPlanOptions {
  days?: number;
  timezone?: string;
}

const MINSK_TZ = "Europe/Minsk";

/** Format a UTC ms timestamp as "YYYY-MM-DD HH:mm" in the given timezone. */
export function formatInTimezone(ms: number | null, timezone: string = MINSK_TZ): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Build a capture plan for events within the next `days` (or already in window).
 * Pure: callers pass `now` and per-event lastCaptureAt. Display times include
 * Minsk-local strings; scheduling decisions use UTC only.
 */
export function buildLiquidityCapturePlan(
  events: ScheduleEventInput[],
  now: string | number | Date,
  options: BuildPlanOptions = {},
): CapturePlan {
  const days = options.days ?? 7;
  const tz = options.timezone ?? MINSK_TZ;
  const nowMs = toMs(now) ?? Date.now();
  const horizonMs = nowMs + days * 24 * HOUR;

  const entries: CapturePlanEntry[] = [];
  for (const ev of events) {
    const startMs = toMs(ev.gameStartIso);
    const cadence = getLiquidityCaptureCadence(nowMs, ev.gameStartIso, {
      eventEnd: ev.eventEndIso ?? null,
      sport: ev.sport ?? null,
    });
    // Include events that are within the forward horizon OR currently in window.
    const withinHorizon = startMs !== null && startMs >= nowMs && startMs <= horizonMs;
    if (!withinHorizon && !cadence.inWindow) continue;

    const due = isLiquidityCaptureDue(ev.lastCaptureAt ?? null, nowMs, ev.gameStartIso, {
      eventEnd: ev.eventEndIso ?? null,
      sport: ev.sport ?? null,
    });
    const nMs = nextDueMs(ev.lastCaptureAt ?? null, nowMs, ev.gameStartIso, {
      eventEnd: ev.eventEndIso ?? null,
      sport: ev.sport ?? null,
    });

    entries.push({
      key: ev.key,
      eventSlug: ev.eventSlug ?? null,
      eventTitle: ev.eventTitle ?? null,
      sport: ev.sport ?? null,
      phase: cadence.phase,
      cadenceMinutes: cadence.cadenceMinutes,
      inWindow: cadence.inWindow,
      due,
      tokenCount: ev.tokenCount ?? 0,
      minutesToStart: cadence.minutesToStart,
      eventStartUtc: toIso(startMs),
      eventStartMinsk: formatInTimezone(startMs, tz),
      eventEndUtc: toIso(cadence.eventEndMs),
      nextDueUtc: toIso(nMs),
      nextDueMinsk: formatInTimezone(nMs, tz),
    });
  }

  // Soonest start first, then soonest next-due.
  entries.sort((a, b) => {
    const as = a.eventStartUtc ? Date.parse(a.eventStartUtc) : Infinity;
    const bs = b.eventStartUtc ? Date.parse(b.eventStartUtc) : Infinity;
    return as - bs;
  });

  return {
    generatedAtUtc: new Date(nowMs).toISOString(),
    nowUtc: new Date(nowMs).toISOString(),
    windowDays: days,
    totalEvents: entries.length,
    inWindowEvents: entries.filter((e) => e.inWindow).length,
    dueEvents: entries.filter((e) => e.due).length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// CLI entry-point detection + machine-readable output lines (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Cross-platform "is this module the process entry point?" check. The naive
 * `import.meta.url === 'file://' + process.argv[1]` comparison silently fails on
 * Windows (drive letter + backslashes) and on any POSIX path with spaces/special
 * chars (file URLs percent-encode them), so the runner never executes and exits
 * with no output. pathToFileURL produces the correctly-encoded URL to compare.
 */
export function isMainModule(
  importMetaUrl: string | undefined,
  argv1: string | undefined,
): boolean {
  if (!importMetaUrl || !argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

function tz(ms: number | null, timezone?: string): string {
  return formatInTimezone(ms, timezone) ?? "none";
}

/** `LIQUIDITY_AUTO_CAPTURE_PLAN_SUMMARY ...` line. */
export function renderPlanSummaryLine(plan: CapturePlan, dbStatus: string): string {
  const nowMs = Date.parse(plan.nowUtc);
  return (
    `LIQUIDITY_AUTO_CAPTURE_PLAN_SUMMARY days=${plan.windowDays} events=${plan.totalEvents} ` +
    `due_windows=${plan.dueEvents} now_utc=${plan.nowUtc} now_minsk=${tz(nowMs)} db_status=${dbStatus}`
  );
}

/** `LIQUIDITY_AUTO_CAPTURE_EVENT ...` line for one planned event. */
export function renderEventLine(entry: CapturePlanEntry): string {
  return (
    `LIQUIDITY_AUTO_CAPTURE_EVENT event=${entry.eventSlug ?? entry.key} ` +
    `start_utc=${entry.eventStartUtc ?? "none"} start_minsk=${entry.eventStartMinsk ?? "none"} ` +
    `first_capture_utc=${entry.nextDueUtc ?? "none"} first_capture_minsk=${entry.nextDueMinsk ?? "none"} ` +
    `phase=${entry.phase} cadence_min=${entry.cadenceMinutes ?? "none"} due=${entry.due}`
  );
}

/** `LIQUIDITY_AUTO_CAPTURE_DUE_SUMMARY ...` line. */
export function renderDueSummaryLine(plan: CapturePlan, action = "plan_only"): string {
  let nextDueMs: number | null = null;
  for (const e of plan.entries) {
    const ms = e.nextDueUtc ? Date.parse(e.nextDueUtc) : null;
    if (ms !== null && (nextDueMs === null || ms < nextDueMs)) nextDueMs = ms;
  }
  const nextDueUtc = nextDueMs === null ? "none" : new Date(nextDueMs).toISOString();
  return `LIQUIDITY_AUTO_CAPTURE_DUE_SUMMARY due_now=${plan.dueEvents} next_due_utc=${nextDueUtc} action=${action}`;
}

export interface OnceSummaryFields {
  action: "run" | "none" | "error";
  reason: string;
  dueCount: number;
  watchlist?: number;
  snapshots?: number;
  simulations?: number;
}

/** `LIQUIDITY_AUTO_CAPTURE_ONCE_SUMMARY ...` line. */
export function renderOnceSummaryLine(f: OnceSummaryFields): string {
  return (
    `LIQUIDITY_AUTO_CAPTURE_ONCE_SUMMARY action=${f.action} reason=${f.reason} ` +
    `due_count=${f.dueCount} watchlist=${f.watchlist ?? 0} snapshots=${f.snapshots ?? 0} ` +
    `simulations=${f.simulations ?? 0}`
  );
}

/** `LIQUIDITY_AUTO_CAPTURE_ERROR_SUMMARY ...` line (message is pre-sanitized). */
export function renderErrorSummaryLine(action: string, code: string, message: string): string {
  return `LIQUIDITY_AUTO_CAPTURE_ERROR_SUMMARY action=${action} error=${code} message=${message}`;
}
