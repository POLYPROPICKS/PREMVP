import type { RuntimeSupabaseClient } from "../constructor/bootstrap";
import { createHash } from "node:crypto";
import type { NightEventReservationRow } from "./executorQueueTypes";
import { fetchOrderBooksConcurrent, type TokenFeeScheduleResult } from "../liquidity/polymarketClient";
import { computeMidPrice, computeSpread, computeSpreadBps, getBestBidAsk } from "../liquidity/orderbookMath";
import { GAMMA_GAME_EVENTS_LIMIT, fetchPolymarketEventById, fetchPolymarketEventsByGameId } from "../feed/polymarketClient";
import type { PolymarketRawEvent } from "../feed/types";
import { compareExactIdentity } from "./exactIdentityOrder";
import { physicalMatchId } from "./contractADecisions";

export const BASELINE_SOURCE_VERSION = "RESERVATION_REFERENCE_BASELINE_V2";
const MARKET_SOURCE_VERSION = "RESERVATION_MARKET_BASELINE_V1";
const PHASE = "RESERVATION_BASELINE";
export type ReservationMarketPhase = typeof PHASE | "T_MINUS_30" | "T_MINUS_10" | "T_MINUS_3" | "LIVE_GUARD";

/** Single authority for the live Final Rebalance source phase (T_MINUS_3 is historical-only). */
export const FINAL_REBALANCE_PHASE = "T_MINUS_10" as const;

/**
 * T10_EXECUTABLE_SIBLING_TELEMETRY_V1: every key every T_MINUS_10 observation row carries, so one bulk
 * upsert is homogeneous. Evidence only: nothing in selection, Queue, stake or Ireland reads it, and no T30-derived value is part of it.
 * The computation lives in t10ExecutableSiblingTelemetry.ts (loaded lazily: import-cyclic with this file).
 */
export const T10_EXECUTABLE_TELEMETRY_VERSION = "T10_EXECUTABLE_SIBLING_TELEMETRY_V1" as const;
export const T10_EXECUTABLE_TELEMETRY_KEYS = [
  "executable_telemetry_version", "requested_stake_usd", "execution_price_cap", "ask_depth_relevant_usd",
  "full_stake_executable_vwap", "full_stake_shares", "full_stake_worst_ask_price", "executable_full_stake",
  "executable_full_stake_state", "taker_fee_state", "taker_fee_reason", "taker_fee_rate", "taker_fee_usd",
  "taker_effective_cost_per_share", "taker_fee_formula_version",
] as const;

/** Typed, honest failure row: the sibling still gets its telemetry row, with UNKNOWN and a reason. Never invents a number. */
export function executableTelemetryFailureColumns(reason: string): Record<string, unknown> {
  return {
    ...Object.fromEntries(T10_EXECUTABLE_TELEMETRY_KEYS.map((key) => [key, null])),
    executable_telemetry_version: T10_EXECUTABLE_TELEMETRY_VERSION,
    executable_full_stake_state: "UNKNOWN_TELEMETRY_COMPUTE_FAILED",
    taker_fee_state: "UNKNOWN", taker_fee_reason: reason,
  };
}

/** Columns ADDED by migration 20261005090000 (the other keys above pre-exist from the LIVE_GUARD telemetry migration). */
const T10_REUSED_EXISTING_COLUMNS: readonly string[] = ["requested_stake_usd", "execution_price_cap", "ask_depth_relevant_usd", "full_stake_executable_vwap"];
export const T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS: readonly string[] =
  T10_EXECUTABLE_TELEMETRY_KEYS.filter((key) => !T10_REUSED_EXISTING_COLUMNS.includes(key));

/**
 * True only for PostgREST PGRST204 / Postgres 42703 whose message names one of the NEW telemetry columns, i.e. the
 * production schema is not migrated yet. Any other write error is NOT a missing-telemetry-schema signal.
 */
export function isMissingTelemetryColumnError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  if (!e || (e.code !== "PGRST204" && e.code !== "42703")) return false;
  const message = typeof e.message === "string" ? e.message : "";
  return T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS.some((column) => message.includes(column));
}

export function withoutNewTelemetryColumns(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !T10_EXECUTABLE_TELEMETRY_NEW_COLUMNS.includes(key)));
}

/**
 * Hard wall-clock ceiling for the telemetry-only fee leg that runs inside the live rebalance tick. The fee fetcher is
 * already bounded internally (5s budget, +250ms floor); this is the outer deadline. On expiry the leg resolves null and
 * every sibling gets a typed UNKNOWN fee state. Never rejects.
 */
export const T10_TELEMETRY_FEE_DEADLINE_MS = 5_500;
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * T40_T20_CAPTURE_ALIGNMENT_V1 (Founder contract: early capture = T-40, money / final rebalance = T-20).
 * T_MINUS_30 = legacy persisted label, business target now T40.
 * T_MINUS_10 = legacy persisted label, business target now T20.
 * The DB phase labels are NOT renamed in this hotfix (rows, unique keys and readers depend on them); only the effective
 * early window moved from (20, 30] to (20, 40]. The early phase is still captured exactly once: the first eligible
 * tick (~T-40) persists the run, and `defaultAlreadyCaptured` + the (reservation_id, observation_phase, source_version)
 * upsert key make every later tick through T-20 a no-op for a non-WRITE_INCOMPLETE run.
 */
export const EARLY_CAPTURE_WINDOW_OPEN_MINUTES = 40;
const FINAL_WINDOW_OPEN_MINUTES = 20;
const FINAL_WINDOW_CLOSE_MINUTES = 9;

/**
 * Phase windows (minutes before the physical event start). The two windows are adjacent and never overlap.
 *   T_MINUS_30: (20, 40]  research telemetry only -- it never authorizes, vetoes, prices or ranks a live action.
 *                         Legacy persisted label; business target is T40 (first eligible tick ~T-40).
 *   T_MINUS_10: (9, 20]   the Final Rebalance source (name kept: it is a persisted phase label, not a time).
 *                         Legacy persisted label; business target is T20.
 * LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2: the T_MINUS_10 window now OPENS at T-20 (was T-15), so on the every-minute
 * rebalance cron the capture and the economic action / Queue creation happen at ~T-20 (T-22..T-18) and the primary
 * MAKER gets ~440 s before primary_maker_cancel_by (T-12m40s), well above Ireland's 180 s pre-claim minimum. The
 * lower edge (9) is unchanged, so a tick that missed the first minutes still captures later (a TAKER_FIRST needs no
 * primary window; a MAKER_FIRST at/after cancel_by fails closed).
 */
export function classifyReservationMarketPhase(eventStartIso: string, nowMs: number): Exclude<ReservationMarketPhase, typeof PHASE> | null {
  const minutes = (Date.parse(eventStartIso) - nowMs) / 60_000;
  if (minutes > FINAL_WINDOW_OPEN_MINUTES && minutes <= EARLY_CAPTURE_WINDOW_OPEN_MINUTES) return "T_MINUS_30";
  if (minutes > FINAL_WINDOW_CLOSE_MINUTES && minutes <= FINAL_WINDOW_OPEN_MINUTES) return "T_MINUS_10";
  return null;
}

type InventoryMarket = {
  provider_event_id: string;
  event_start_iso: string;
  condition_id: string | null;
  clob_token_ids: unknown;
  outcomes: unknown;
  sports_market_type: string | null;
  provider_market_slug: string | null;
  sibling_market_count: number;
  last_observed_at: string;
  /** Event-level provider match key of the event this market was read from. */
  provider_game_id?: string | null;
};

type Token = { conditionId: string; tokenId: string; side: string; outcome: string | null; market: InventoryMarket };

export type ObservationalMarketFamily = "MONEYLINE" | "SPREADS" | "TOTALS" | "TOTAL_CORNERS" | "OTHER_STRUCTURED" | "UNKNOWN";
export type ObservationalMarketType = "MONEYLINE" | "SPREAD" | "TOTAL" | "TOTAL_CORNERS" | "OTHER_STRUCTURED" | "UNKNOWN";

const STRUCTURED_MARKET_IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/;

// Telemetry-only classification of the structured provider market type.
// Never parses title/slug and must not feed live eligibility or admission.
export function classifyObservationalMarket(rawType: unknown): { family: ObservationalMarketFamily; type: ObservationalMarketType } {
  const normalized = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (!STRUCTURED_MARKET_IDENTIFIER.test(normalized)) return { family: "UNKNOWN", type: "UNKNOWN" };
  switch (normalized) {
    case "moneyline": return { family: "MONEYLINE", type: "MONEYLINE" };
    case "spread":
    case "spreads": return { family: "SPREADS", type: "SPREAD" };
    case "total":
    case "totals": return { family: "TOTALS", type: "TOTAL" };
    case "total_corners": return { family: "TOTAL_CORNERS", type: "TOTAL_CORNERS" };
    default: return { family: "OTHER_STRUCTURED", type: "OTHER_STRUCTURED" };
  }
}

// The structured provider type is necessary but a slug identifying a team,
// period, race or other corner derivative cannot certify full-match totals.
const CORNER_DERIVATIVE_RE = /(?:^|[-_])(team|home|away|first|last|1st|2nd|second|half|halftime|race|odd|even)(?:$|[-_])/i;
export function classifyExactEventMarket(rawType: unknown, slug: unknown): { family: ObservationalMarketFamily; type: ObservationalMarketType } {
  const market = classifyObservationalMarket(rawType);
  if (market.family === "TOTAL_CORNERS" && typeof slug === "string" && CORNER_DERIVATIVE_RE.test(slug)) {
    return { family: "OTHER_STRUCTURED", type: "OTHER_STRUCTURED" };
  }
  return market;
}

export const PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION = "PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION";
const LIVE_B_UNIVERSE_FAMILIES: ReadonlySet<ObservationalMarketFamily> =
  new Set<ObservationalMarketFamily>(["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);

/** Exact score, halftime, team/period derivatives and props are never in the live B universe. */
export function isLiveBUniverseMarket(m: Pick<InventoryMarket, "sports_market_type" | "provider_market_slug">): boolean {
  return LIVE_B_UNIVERSE_FAMILIES.has(classifyExactEventMarket(m.sports_market_type, m.provider_market_slug).family);
}

/**
 * Pure. Does the authoritative exact-event payload for a provider event
 * contradict what Planning claimed about it? Structured fields only.
 *  - GAME_ID_MISMATCH: the payload belongs to a different physical match.
 *  - CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT: Planning claimed a supported live
 *    family (e.g. moneyline) but the event holds only derivative markets
 *    (e.g. soccer_exact_score / soccer_halftime_result).
 */
export function providerEventIdentityContradiction(
  claim: { gameId: string | null; marketType: string | null },
  payloadMarkets: readonly InventoryMarket[],
): "GAME_ID_MISMATCH" | "CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT" | null {
  const payloadGameId = payloadMarkets.find((m) => m.provider_game_id)?.provider_game_id ?? null;
  // Fail closed: a claimed gameId must be confirmed by the exact-event payload.
  if (claim.gameId && payloadMarkets.length > 0 && claim.gameId !== payloadGameId) return "GAME_ID_MISMATCH";
  const claimedFamily = classifyObservationalMarket(claim.marketType).family;
  if (LIVE_B_UNIVERSE_FAMILIES.has(claimedFamily) &&
      !payloadMarkets.some((m) => classifyExactEventMarket(m.sports_market_type, m.provider_market_slug).family === claimedFamily)) {
    return "CLAIMED_FAMILY_ABSENT_FROM_EXACT_EVENT";
  }
  return null;
}

export const PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS = "PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS";
export const PHYSICAL_EVENT_GAME_ID_UNRESOLVED = "PHYSICAL_EVENT_GAME_ID_UNRESOLVED";

export const DISCOVERY_AUDIT_VERSION = "T10_DISCOVERY_AUDIT_V1";
export const DISCOVERY_AUDIT_MAX_MARKET_TYPES = 64;
export const DISCOVERY_AUDIT_OVERFLOW = "DISCOVERY_AUDIT_OVERFLOW";
export const DISCOVERY_AUDIT_TYPE_KEY_MISSING = "__missing__";
export const DISCOVERY_AUDIT_TYPE_KEY_INVALID = "__invalid_format__";

export type DiscoveryAuditReason =
  | "OTHER_GAME_ID" | "OTHER_EVENT_START" | "PROVIDER_EVENT_ID_INVALID"
  | "STRUCTURED_MARKET_TYPE_MISSING" | "UNSUPPORTED_STRUCTURED_MARKET_TYPE"
  | "CORNER_DERIVATIVE_TEAM" | "CORNER_DERIVATIVE_FIRST_HALF" | "CORNER_DERIVATIVE_SECOND_HALF"
  | "CORNER_DERIVATIVE_FIRST_LAST" | "CORNER_DERIVATIVE_ODD_EVEN"
  | "MARKET_TOKEN_IDENTITY_MISSING" | "SUPPORTED_FULL_MATCH_MARKET";
export type DiscoveryAuditExclusionReason = Exclude<DiscoveryAuditReason, "SUPPORTED_FULL_MATCH_MARKET">;

export type DiscoveryAuditMarketType = {
  raw_discovered_n: number; same_game_n: number; same_start_n: number; identity_valid_n: number;
  canonical_market_family: ObservationalMarketFamily; canonical_market_type: ObservationalMarketType;
  admitted_n: number; excluded_n: number;
  exclusion_reason_counts: Partial<Record<DiscoveryAuditExclusionReason, number>>;
};

/** Compact counts only: never raw provider payloads, books, titles or slugs. */
export type DiscoveryAuditV1 = {
  version: typeof DISCOVERY_AUDIT_VERSION;
  provider_game_id: string;
  provider_events_discovered_n: number;
  raw_markets_discovered_n: number;
  admitted_markets_n: number;
  excluded_markets_n: number;
  market_types: Record<string, DiscoveryAuditMarketType>;
  /** Set only when the provider exceeded the bounded market-type key space (fail closed). */
  audit_overflow?: true;
  distinct_market_types_n?: number;
};

const CORNER_DERIVATIVE_EXACT: Readonly<Record<string, DiscoveryAuditExclusionReason>> = {
  soccer_team_total_corners: "CORNER_DERIVATIVE_TEAM",
  soccer_first_half_total_corners: "CORNER_DERIVATIVE_FIRST_HALF",
  soccer_second_half_total_corners: "CORNER_DERIVATIVE_SECOND_HALF",
  soccer_game_corners_odd_even: "CORNER_DERIVATIVE_ODD_EVEN",
  soccer_first_corner: "CORNER_DERIVATIVE_FIRST_LAST",
  soccer_last_corner: "CORNER_DERIVATIVE_FIRST_LAST",
};

/** Names WHY a corner derivative is excluded. Never grants admission. */
function cornerDerivativeReason(text: string, requireCornerWord: boolean): DiscoveryAuditExclusionReason | null {
  const exact = CORNER_DERIVATIVE_EXACT[text];
  if (exact) return exact;
  if (requireCornerWord && !/corner/.test(text)) return null;
  const words = new Set(text.split(/[-_]/));
  const has = (...w: string[]) => w.some((x) => words.has(x));
  if (has("odd", "even")) return "CORNER_DERIVATIVE_ODD_EVEN";
  if (has("half", "halftime")) {
    if (has("second", "2nd")) return "CORNER_DERIVATIVE_SECOND_HALF";
    if (has("first", "1st")) return "CORNER_DERIVATIVE_FIRST_HALF";
    return null;
  }
  if (has("team", "home", "away")) return "CORNER_DERIVATIVE_TEAM";
  if (has("first", "last")) return "CORNER_DERIVATIVE_FIRST_LAST";
  return null;
}

function discoveryAuditTypeKey(rawType: unknown): string {
  const normalized = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  if (!normalized) return DISCOVERY_AUDIT_TYPE_KEY_MISSING;
  if (normalized.length > 64 || !STRUCTURED_MARKET_IDENTIFIER.test(normalized)) return DISCOVERY_AUDIT_TYPE_KEY_INVALID;
  return normalized;
}

function marketIdentityValid(m: Pick<InventoryMarket, "condition_id" | "clob_token_ids" | "outcomes">): boolean {
  const ids = stringArray(m.clob_token_ids);
  const outcomes = stringArray(m.outcomes);
  return !!m.condition_id?.trim() && ids.length > 0 && ids.length === outcomes.length &&
    ids.every((id, i) => id.trim() !== "" && outcomes[i].trim() !== "");
}

/**
 * Pure. Classifies ONE pre-filter discovered market through every source->canonical
 * edge, independently. The reason is the first failing edge in pipeline order.
 */
function classifyDiscoveredMarket(m: InventoryMarket, gameId: string, startMs: number) {
  const eventIdValid = typeof m.provider_event_id === "string" && /^\d+$/.test(m.provider_event_id);
  const sameGame = m.provider_game_id === gameId;
  const sameStart = Date.parse(m.event_start_iso) === startMs;
  const typeKey = discoveryAuditTypeKey(m.sports_market_type);
  const typePresent = typeKey !== DISCOVERY_AUDIT_TYPE_KEY_MISSING && typeKey !== DISCOVERY_AUDIT_TYPE_KEY_INVALID;
  const identityValid = marketIdentityValid(m);
  const typeLevel = classifyObservationalMarket(m.sports_market_type);
  const exact = classifyExactEventMarket(m.sports_market_type, m.provider_market_slug);
  let reason: DiscoveryAuditReason;
  if (!eventIdValid) reason = "PROVIDER_EVENT_ID_INVALID";
  else if (!sameGame) reason = "OTHER_GAME_ID";
  else if (!sameStart) reason = "OTHER_EVENT_START";
  else if (!typePresent) reason = "STRUCTURED_MARKET_TYPE_MISSING";
  else if (!LIVE_B_UNIVERSE_FAMILIES.has(exact.family)) {
    // Raw `total_corners` demoted by a derivative slug is named from the slug;
    // every other unsupported structured type is named from its own type.
    const slug = typeof m.provider_market_slug === "string" ? m.provider_market_slug.toLowerCase() : "";
    reason = (typeLevel.family === "TOTAL_CORNERS" ? cornerDerivativeReason(slug, false) : cornerDerivativeReason(typeKey, true))
      ?? "UNSUPPORTED_STRUCTURED_MARKET_TYPE";
  } else if (!identityValid) reason = "MARKET_TOKEN_IDENTITY_MISSING";
  else reason = "SUPPORTED_FULL_MATCH_MARKET";
  return { eventIdValid, sameGame, sameStart, typeKey, identityValid, typeLevel, reason };
}

/**
 * Pure. The CURRENT supported market universe of ONE physical match, from the
 * Reservation's exact lineage event plus the provider events returned by the
 * gameId-scoped Gamma query. The frozen Planning candidate_manifest is never
 * consulted: it is Planning evidence, not live market inventory.
 *
 * Every discovered market must independently carry the same gameId, a numeric
 * provider event id and the Reservation's event start; anything else is dropped,
 * never substituted. Only live-B families are returned. `eventSetsComplete`
 * attests that each contributing provider event supplied all of its own markets
 * (unsupported families are deliberately excluded and are not incompleteness).
 */
export function sameGameLiveUniverse(
  gameId: string,
  eventStartIso: string,
  own: readonly InventoryMarket[],
  discovered: readonly InventoryMarket[],
): { markets: InventoryMarket[]; eventSetsComplete: boolean; audit: DiscoveryAuditV1 } {
  const startMs = Date.parse(eventStartIso);
  const byEvent = new Map<string, InventoryMarket[]>();
  const accept = (m: InventoryMarket) => {
    const eventId = m.provider_event_id;
    if (typeof eventId !== "string" || !/^\d+$/.test(eventId)) return;
    if (m.provider_game_id !== gameId) return;
    if (Date.parse(m.event_start_iso) !== startMs) return;
    const list = byEvent.get(eventId);
    if (list) list.push(m); else byEvent.set(eventId, [m]);
  };
  const ownEventIds = new Set(own.map((m) => m.provider_event_id));
  const preFilter = [...own, ...discovered.filter((m) => !ownEventIds.has(m.provider_event_id))];
  preFilter.forEach(accept);
  let eventSetsComplete = byEvent.size > 0;
  const markets: InventoryMarket[] = [];
  for (const list of byEvent.values()) {
    if (!list.every((m) => m.sibling_market_count === list.length)) eventSetsComplete = false;
    markets.push(...list.filter(isLiveBUniverseMarket));
  }
  return { markets, eventSetsComplete, audit: buildDiscoveryAudit(gameId, startMs, preFilter) };
}

/** Pure. Built from the PRE-filter discovered set, never inferred from the final universe. */
export function buildDiscoveryAudit(gameId: string, startMs: number, preFilter: readonly InventoryMarket[]): DiscoveryAuditV1 {
  const marketTypes: Record<string, DiscoveryAuditMarketType> = {};
  let admitted = 0;
  let excluded = 0;
  for (const m of preFilter) {
    const c = classifyDiscoveredMarket(m, gameId, startMs);
    let entry = marketTypes[c.typeKey];
    if (!entry) {
      entry = marketTypes[c.typeKey] = {
        raw_discovered_n: 0, same_game_n: 0, same_start_n: 0, identity_valid_n: 0,
        canonical_market_family: c.typeLevel.family, canonical_market_type: c.typeLevel.type,
        admitted_n: 0, excluded_n: 0, exclusion_reason_counts: {},
      };
    }
    entry.raw_discovered_n++;
    if (c.sameGame) entry.same_game_n++;
    if (c.sameStart) entry.same_start_n++;
    if (c.identityValid) entry.identity_valid_n++;
    if (c.reason === "SUPPORTED_FULL_MATCH_MARKET") { entry.admitted_n++; admitted++; }
    else {
      entry.excluded_n++; excluded++;
      entry.exclusion_reason_counts[c.reason] = (entry.exclusion_reason_counts[c.reason] ?? 0) + 1;
    }
  }
  const base = {
    version: DISCOVERY_AUDIT_VERSION, provider_game_id: gameId,
    provider_events_discovered_n: new Set(preFilter.map((m) => String(m.provider_event_id))).size,
    raw_markets_discovered_n: preFilter.length,
  } as const;
  const distinct = Object.keys(marketTypes).length;
  // Fail closed: never silently truncate an over-wide provider market-type space.
  if (distinct > DISCOVERY_AUDIT_MAX_MARKET_TYPES) {
    return { ...base, admitted_markets_n: 0, excluded_markets_n: 0, market_types: {}, audit_overflow: true, distinct_market_types_n: distinct };
  }
  return { ...base, admitted_markets_n: admitted, excluded_markets_n: excluded, market_types: marketTypes };
}

const STRATEGY_VARIANTS = ["S1_TAKER_HOLD", "S2_FIXED_MAKER_HOLD", "S3_MAKER_VALUE_BAND_HOLD"] as const;

export function strategyRowsForMarketObservations(observations: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return observations.flatMap((market) => STRATEGY_VARIANTS.map((variant) => ({
    id: stableTelemetryId(String(market.id), variant),
    market_observation_id: market.id, capture_run_id: market.capture_run_id,
    reservation_id: market.reservation_id, physical_event_id: market.physical_event_id,
    condition_id: market.condition_id, token_id: market.token_id, side: market.side,
    observation_phase: market.observation_phase, evaluated_at: market.observed_at,
    minutes_to_start: market.minutes_to_start, strategy_variant: variant,
    strategy_version: null, evaluation_state: "NOT_EVALUATED", eligible: null,
    rejection_reason: variant === "S1_TAKER_HOLD" ? "CANONICAL_POLICY_NOT_AVAILABLE_AT_TELEMETRY_SEAM" : null,
    available_best_ask: variant === "S1_TAKER_HOLD" ? market.best_ask : null,
    available_decimal_odds: variant === "S1_TAKER_HOLD" ? market.ask_decimal_odds : null,
    spread_abs: variant === "S1_TAKER_HOLD" ? market.spread_abs : null,
    executable_depth_usd: variant === "S1_TAKER_HOLD" ? market.ask_depth_relevant_usd ?? null : null,
    maker_target_price: null, maker_target_decimal_odds: null,
    maker_target_state: variant === "S2_FIXED_MAKER_HOLD" ? "NOT_DEFINED_YET" : null,
    target_policy_version: null, target_touched: null,
    maker_band_min_price: null, maker_band_max_price: null,
    maker_band_min_odds: null, maker_band_max_odds: null,
    maker_band_state: variant === "S3_MAKER_VALUE_BAND_HOLD" ? "NOT_DEFINED_YET" : null,
    maker_band_version: null, acceptable_band_observed: null,
  })));
}

export function stableTelemetryId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try { return stringArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map((v) => typeof v === "string" ? v :
    v && typeof v === "object" && typeof v.name === "string" ? v.name : "") : [];
}

export function inventoryTokens(markets: readonly InventoryMarket[]): { tokens: Token[]; expected: number; missingIdentity: number } {
  const tokens: Token[] = [];
  let expected = 0;
  let missingIdentity = 0;
  const seen = new Set<string>();
  const seenSupplied = new Set<string>();
  for (const market of markets) {
    const ids = stringArray(market.clob_token_ids);
    const outcomes = stringArray(market.outcomes);
    for (let i = 0; i < ids.length; i++) {
      const tokenId = ids[i];
      const conditionId = market.condition_id?.trim() ?? "";
      const outcome = outcomes[i] || null;
      const suppliedKey = `${conditionId}\u0000${tokenId}\u0000${outcome ?? ""}`;
      if (seenSupplied.has(suppliedKey)) continue;
      seenSupplied.add(suppliedKey);
      expected++;
      if (!conditionId || !tokenId || !outcome) { missingIdentity++; continue; }
      const key = `${conditionId}\u0000${tokenId}\u0000${outcome}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ conditionId, tokenId, side: outcome, outcome, market });
    }
  }
  return { tokens, expected, missingIdentity };
}

export function baselineCompleteness(input: { markets: number; siblingCounts: number[]; expected: number; observed: number; failed: number; missingIdentity: number; eventSetsComplete?: boolean }): { complete: boolean; status: string } {
  // Complete means every identifiable token supplied by this exact event response
  // was persisted. It does not attest to markets outside the provider response.
  // A same-game capture spans several provider events, so per-event completeness
  // is attested by the caller (`eventSetsComplete`) instead of one event's count.
  const sourceSetComplete = input.eventSetsComplete !== undefined
    ? input.eventSetsComplete
    : input.siblingCounts.length === input.markets &&
      input.siblingCounts.every((count) => Number.isFinite(count) && count === input.markets);
  const complete = input.markets > 0 && sourceSetComplete &&
    input.expected > 0 && input.missingIdentity === 0 && input.observed === input.expected;
  // Orderbook failures are retained on observations, independently of source-set completeness.
  return { complete, status: complete ? "COMPLETE" : "INCOMPLETE_MARKET_SET" };
}

export type FinalT3MarketObservation = {
  capture_run_id: string; reservation_id: string; physical_event_id: string;
  provider_event_id: string; event_start_iso: string; observation_phase: string;
  condition_id: string; token_id: string; side: string;
  canonical_market_family: string | null; canonical_market_type: string | null;
  provider_market_type_raw?: string | null; market_slug?: string | null;
  best_ask: number | null; ask_decimal_odds: number | null;
  orderbook_fetch_status: string | null;
  /** Persisted on every observation; read for exact-market reference witnesses. */
  best_bid?: number | null; observed_at?: string | null;
};

type FinalT3ReadPort = {
  /** `phase` defaults to FINAL_REBALANCE_PHASE (T_MINUS_10). */
  readRuns(reservationId: string, phase?: string): Promise<Record<string, unknown>[]>;
  readObservations(captureRunId: string, afterId: string): Promise<Record<string, unknown>[]>;
};

/** One finalized source-set snapshot for one reserved physical event. */
export async function readCompletedFinalT3Universe(
  reservation: NightEventReservationRow,
  port: FinalT3ReadPort = createFinalT3ReadPort(),
): Promise<FinalT3MarketObservation[]> {
  return readCompletedPhaseUniverse(reservation, FINAL_REBALANCE_PHASE, port);
}

/**
 * The same complete, lineage-checked source-set read for the T_MINUS_30 phase.
 * Used only as the T30_EXACT_BID_ANCHOR_V1 price-authority witness source.
 */
export async function readCompletedT30Universe(
  reservation: NightEventReservationRow,
  port: FinalT3ReadPort = createFinalT3ReadPort(),
): Promise<FinalT3MarketObservation[]> {
  return readCompletedPhaseUniverse(reservation, "T_MINUS_30", port);
}

async function readCompletedPhaseUniverse(
  reservation: NightEventReservationRow,
  phase: string,
  port: FinalT3ReadPort,
): Promise<FinalT3MarketObservation[]> {
  const id = reservation.id;
  const physicalId = reservation.physical_event_id;
  const start = reservation.event_start_iso;
  const lineage = reservation.diagnostics?.source_lineage as { provider_event_id?: unknown } | undefined;
  const providerId = lineage?.provider_event_id;
  if (!id || !physicalId || !start || !Number.isFinite(Date.parse(start)) ||
      typeof providerId !== "string" || !providerId) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  const runs = phase === FINAL_REBALANCE_PHASE ? await port.readRuns(id) : await port.readRuns(id, phase);
  if (runs.length !== 1) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  const run = runs[0];
  if (run.reservation_id !== id || run.physical_event_id !== physicalId ||
      run.provider_event_id !== providerId || Date.parse(String(run.event_start_iso)) !== Date.parse(start) ||
      run.observation_phase !== phase || run.source_version !== MARKET_SOURCE_VERSION ||
      run.capture_complete !== true || run.capture_status !== "COMPLETE" ||
      typeof run.id !== "string" || !run.id ||
      !Number.isSafeInteger(run.market_tokens_observed_n) || Number(run.market_tokens_observed_n) <= 0 ||
      run.market_tokens_expected_n !== run.market_tokens_observed_n) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  const rows: Record<string, unknown>[] = [];
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await port.readObservations(run.id, afterId);
    rows.push(...page);
    if (rows.length > Number(run.market_tokens_observed_n) || page.length > 200) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    if (page.length < 200) break;
    const nextId = page.at(-1)?.id;
    if (typeof nextId !== "string" || nextId <= afterId) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    afterId = nextId;
  }
  if (rows.length !== run.market_tokens_observed_n || rows.some((row) =>
    row.capture_run_id !== run.id || row.reservation_id !== id || row.physical_event_id !== physicalId ||
    row.provider_event_id !== providerId || Date.parse(String(row.event_start_iso)) !== Date.parse(start) ||
    row.observation_phase !== phase ||
    ![row.condition_id, row.token_id, row.side].every((value) => typeof value === "string" && value.trim() !== "")
  )) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  return rows as FinalT3MarketObservation[];
}

export type RuntimeClientGetter = () => RuntimeSupabaseClient | Promise<RuntimeSupabaseClient>;
async function defaultProcessClient(): Promise<RuntimeSupabaseClient> {
  const supabaseAdmin = await (await import("@/lib/constructor/runtimeScope")).scopedSupabaseAdmin();
  return supabaseAdmin;
}

/** Final-T3 reader bound to a client getter; default = the process-wide supabaseAdmin (unchanged). */
export function createFinalT3ReadPort(getClient: RuntimeClientGetter = defaultProcessClient): FinalT3ReadPort {
  return {
  async readRuns(reservationId, phase = FINAL_REBALANCE_PHASE) {
    const supabaseAdmin = await getClient();
    const { data, error } = await supabaseAdmin.from("reservation_market_capture_runs")
      .select("id,reservation_id,physical_event_id,provider_event_id,event_start_iso,observation_phase,source_version,capture_complete,capture_status,market_tokens_expected_n,market_tokens_observed_n")
      .eq("reservation_id", reservationId).eq("observation_phase", phase)
      .eq("source_version", MARKET_SOURCE_VERSION).limit(2);
    if (error) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    return data ?? [];
  },
  async readObservations(captureRunId, afterId) {
    const supabaseAdmin = await getClient();
    const { data, error } = await supabaseAdmin.from("reservation_market_observations")
      .select("id,capture_run_id,reservation_id,physical_event_id,provider_event_id,event_start_iso,condition_id,token_id,side,observation_phase,canonical_market_family,canonical_market_type,provider_market_type_raw,market_slug,best_ask,ask_decimal_odds,orderbook_fetch_status,best_bid,observed_at")
      .eq("capture_run_id", captureRunId).gt("id", afterId).order("id").limit(200);
    if (error) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    return data ?? [];
  },
};
}

export async function captureReservationMarketBaseline(
  reservation: NightEventReservationRow,
  deps: {
    readInventory?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    readExactEvent?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    fetchBooks?: typeof fetchOrderBooksConcurrent;
    write?: (run: Record<string, unknown>, observations: Record<string, unknown>[], strategies?: Record<string, unknown>[]) => Promise<void>;
    observedAt?: string;
    /** Runtime-bound client getter; omitted => process-wide client. */
    getClient?: RuntimeClientGetter;
  } = {},
): Promise<void> {
  if (!reservation.id) throw new Error("BASELINE_RESERVATION_ID_MISSING");
  if (!reservation.event_start_iso || !Number.isFinite(Date.parse(reservation.event_start_iso))) {
    throw new Error("BASELINE_EVENT_START_MISSING");
  }
  const lineage = reservation.diagnostics?.source_lineage as { provider_event_id?: unknown } | undefined;
  const observedAt = deps.observedAt ?? new Date().toISOString();
  const run = {
    id: stableTelemetryId(reservation.id, PHASE, BASELINE_SOURCE_VERSION),
    reservation_id: reservation.id, plan_run_id: reservation.plan_run_id,
    physical_event_id: reservation.physical_event_id,
    provider_event_id: typeof lineage?.provider_event_id === "string" ? lineage.provider_event_id : null,
    event_start_iso: reservation.event_start_iso, observation_phase: PHASE,
    observed_at: observedAt,
    minutes_to_start: (Date.parse(reservation.event_start_iso) - Date.parse(observedAt)) / 60_000,
    source_version: BASELINE_SOURCE_VERSION, source_observed_at: null,
    markets_discovered_n: 0, market_tokens_expected_n: 0, market_tokens_observed_n: 0,
    orderbooks_success_n: 0, orderbooks_failed_n: 0,
    capture_complete: true, capture_status: "REFERENCE_ONLY", failure_reason: null,
  };
  await (deps.write ?? ((r, o, st) => defaultWriter(r, o, st, deps.getClient)))(run, [], []);
}

export async function captureReservationMarketObservation(
  reservation: NightEventReservationRow,
  phase: ReservationMarketPhase,
  deps: {
    readInventory?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    readExactEvent?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    /** Current provider events of ONE gameId, flat (each market carries its own provider_event_id/provider_game_id). */
    readGameEvents?: (gameId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    fetchBooks?: typeof fetchOrderBooksConcurrent;
    write?: (run: Record<string, unknown>, observations: Record<string, unknown>[], strategies?: Record<string, unknown>[]) => Promise<void>;
    observedAt?: string;
    alreadyCaptured?: (reservationId: string, phase: ReservationMarketPhase, sourceVersion: string) => Promise<boolean>;
    getClient?: RuntimeClientGetter;
    /** T10 executable-sibling telemetry only (evidence): token-specific taker fee schedule, default = Gamma. */
    fetchFeeSchedule?: (tokenId: string, opts: { timeoutMs: number }) => Promise<TokenFeeScheduleResult>;
    /** Test seam: hard deadline of the telemetry-only fee leg (default 5.5s). */
    telemetryDeadlineMs?: { fee?: number };
  } = {},
): Promise<void> {
  if (phase === PHASE) return captureReservationMarketBaseline(reservation, deps);
  if (!reservation.id) throw new Error("BASELINE_RESERVATION_ID_MISSING");
  if (await (deps.alreadyCaptured ?? ((id, ph, sv) => defaultAlreadyCaptured(id, ph, sv, deps.getClient)))(reservation.id, phase, MARKET_SOURCE_VERSION)) return;
  const lineage = reservation.diagnostics?.source_lineage as {
    provider_event_id?: unknown; provider_event_start_iso?: unknown; provider_game_id?: unknown; provider_market_type?: unknown;
  } | undefined;
  const providerEventId = typeof lineage?.provider_event_id === "string" ? lineage.provider_event_id : null;
  const claimedGameId = typeof lineage?.provider_game_id === "string" && lineage.provider_game_id ? lineage.provider_game_id : null;
  const claimedMarketType = typeof lineage?.provider_market_type === "string" ? lineage.provider_market_type : null;
  const start = reservation.event_start_iso;
  const observedAt = deps.observedAt ?? new Date().toISOString();
  const runId = stableTelemetryId(reservation.id, phase, MARKET_SOURCE_VERSION);
  const readMarkets = deps.readExactEvent ?? defaultExactEventReader;
  let markets: InventoryMarket[] = [];
  let failureReason: string | null = null;
  let eventSetsComplete: boolean | undefined;
  let discoveryAudit: DiscoveryAuditV1 | null = null;
  // The Reservation owns the physical MATCH (game id when structured, else the
  // legacy provider event id); the provider event id is source lineage only.
  const expectedPhysicalId = providerEventId && start
    ? physicalMatchId({ eventId: providerEventId, eventStartIso: start, gameId: claimedGameId })
    : null;
  if (providerEventId && start && Number.isFinite(Date.parse(start)) &&
      Date.parse(start) === Date.parse(String(lineage?.provider_event_start_iso)) &&
      reservation.physical_event_id === expectedPhysicalId) {
    try {
      // The exact lineage event proves WHICH physical match this Reservation is
      // (its structured gameId); it is never the whole market universe.
      const own = await readMarkets(providerEventId, start);
      const ownGameIds = new Set(own.map((m) => m.provider_game_id).filter((g): g is string => !!g));
      if (own.length === 0) failureReason = "RESERVED_EVENT_MARKET_SET_UNAVAILABLE";
      else if (ownGameIds.size > 1) failureReason = PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS;
      else if (ownGameIds.size === 0) failureReason = PHYSICAL_EVENT_GAME_ID_UNRESOLVED;
      else {
        const providerGameId = [...ownGameIds][0];
        // A game-based Reservation's stored gameId must agree with the provider; a
        // legacy Reservation (no stored gameId) derives it here, at observation
        // time, without rewriting its persisted identity.
        if (claimedGameId && claimedGameId !== providerGameId) failureReason = PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION;
        else {
          const contradiction = providerEventIdentityContradiction({ gameId: providerGameId, marketType: claimedMarketType }, own);
          try {
            const discovered = await (deps.readGameEvents ?? defaultGameEventsReader)(providerGameId, start);
            const universe = sameGameLiveUniverse(providerGameId, start, own, discovered);
            discoveryAudit = universe.audit;
            markets = universe.audit.audit_overflow ? [] : universe.markets;
            eventSetsComplete = universe.eventSetsComplete;
            if (universe.audit.audit_overflow) failureReason = DISCOVERY_AUDIT_OVERFLOW;
          } catch (error) {
            failureReason = error instanceof Error && error.message === PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS
              ? PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS : "RESERVED_EVENT_MARKET_SET_UNAVAILABLE";
          }
          if (!failureReason && !markets.some(isLiveBUniverseMarket)) {
            failureReason = contradiction ? PHYSICAL_EVENT_PROVIDER_IDENTITY_CONTRADICTION : "RESERVED_EVENT_MARKET_SET_UNAVAILABLE";
          }
        }
      }
    }
    catch { failureReason = "RESERVED_EVENT_MARKET_SET_UNAVAILABLE"; }
  } else {
    failureReason = "PROVIDER_EVENT_IDENTITY_UNRESOLVED";
  }
  if (markets.length === 0 && !failureReason) {
    failureReason = "RESERVED_EVENT_MARKET_SET_UNAVAILABLE";
  }
  const { tokens, expected, missingIdentity } = inventoryTokens(markets);
  // T10_EXECUTABLE_SIBLING_TELEMETRY_V1 (evidence only, T_MINUS_10 only). The fee schedules are fetched in
  // parallel with the books, bounded, and can never reject; a missing/failed schedule is typed UNKNOWN.
  const telemetry = phase === FINAL_REBALANCE_PHASE && tokens.length > 0
    ? await import("./t10ExecutableSiblingTelemetry").catch((error: unknown) => {
      console.error("[reservation-market-baseline] T10_TELEMETRY_MODULE_UNAVAILABLE", error instanceof Error ? error.message : "unknown");
      return null;
    }) : null;
  // Books and fee schedules run concurrently, the telemetry leg under a hard deadline, so telemetry adds ~no wall
  // time to the capture and can never hang it.
  const [books, feeByToken] = await Promise.all([
    (deps.fetchBooks ?? fetchOrderBooksConcurrent)(tokens.map((t) => t.tokenId), 5),
    telemetry
      ? withDeadline(Promise.resolve().then(() => telemetry.fetchFeeSchedulesBounded(tokens, { fetchFee: deps.fetchFeeSchedule })).catch(() => null),
        deps.telemetryDeadlineMs?.fee ?? T10_TELEMETRY_FEE_DEADLINE_MS)
      : Promise.resolve(null),
  ]);
  const executableColumns = phase !== FINAL_REBALANCE_PHASE ? null : tokens.map((token, i) => {
    if (!telemetry) return executableTelemetryFailureColumns("TELEMETRY_MODULE_UNAVAILABLE");
    try {
      return telemetry.buildExecutableSiblingColumns({
        token, result: books[i],
        fee: feeByToken === null
          ? { ok: false as const, tokenId: token.tokenId, errorCode: "FEE_LEG_UNAVAILABLE", latencyMs: 0 }
          : feeByToken.get(token.tokenId) ?? null,
      });
    } catch { return executableTelemetryFailureColumns("TELEMETRY_COMPUTE_FAILED"); }
  });
  const minutesToStart = (Date.parse(start ?? "") - Date.parse(observedAt)) / 60000;
  const observations = tokens.map((token, i) => {
    const result = books[i];
    const book = result?.ok ? result.book : null;
    const { bestBid, bestAsk } = getBestBidAsk(book);
    const market = classifyExactEventMarket(token.market.sports_market_type, token.market.provider_market_slug);
    return {
      id: stableTelemetryId(runId, token.conditionId, token.tokenId, token.side),
      capture_run_id: runId, reservation_id: reservation.id, physical_event_id: reservation.physical_event_id,
      provider_event_id: providerEventId, event_start_iso: start, observation_phase: phase,
      observed_at: observedAt, minutes_to_start: minutesToStart,
      condition_id: token.conditionId, token_id: token.tokenId, side: token.side, outcome: token.outcome,
      canonical_market_family: market.family, canonical_market_type: market.type,
      provider_market_type_raw: token.market.sports_market_type, market_slug: token.market.provider_market_slug,
      live_policy_eligibility: null, live_policy_rejection_reason: null,
      best_bid: bestBid, best_ask: bestAsk, mid_price: computeMidPrice(book),
      bid_decimal_odds: bestBid && bestBid > 0 ? 1 / bestBid : null,
      ask_decimal_odds: bestAsk && bestAsk > 0 ? 1 / bestAsk : null,
      spread_abs: computeSpread(book), spread_bps: computeSpreadBps(book),
      // No canonical Reservation stake reference exists at this phase.
      bid_depth_relevant_usd: null, ask_depth_relevant_usd: null,
      tick_size: book?.tickSize ?? null, minimum_order_size: book?.minimumOrderSize ?? null,
      orderbook_fetch_latency_ms: result?.latencyMs ?? null,
      orderbook_fetch_status: result?.ok ? "SUCCESS" : "FAILED",
      orderbook_failure_reason: result?.ok ? null : result?.errorCode ?? "UNKNOWN_FAILURE",
      source_version: MARKET_SOURCE_VERSION,
      ...(executableColumns?.[i] ?? {}),
    };
  });
  const failed = observations.filter((row) => row.orderbook_fetch_status === "FAILED").length;
  const completeness = baselineCompleteness({ markets: markets.length, siblingCounts: markets.map((m) => m.sibling_market_count), expected, observed: observations.length, failed, missingIdentity, eventSetsComplete });
  const run = {
    id: runId, reservation_id: reservation.id, plan_run_id: reservation.plan_run_id,
    physical_event_id: reservation.physical_event_id, provider_event_id: providerEventId,
    event_start_iso: start, observation_phase: phase, observed_at: observedAt, minutes_to_start: minutesToStart,
    source_version: MARKET_SOURCE_VERSION,
    source_observed_at: markets.length ? markets.reduce((latest, m) => m.last_observed_at > latest ? m.last_observed_at : latest, markets[0].last_observed_at) : null,
    markets_discovered_n: markets.length, market_tokens_expected_n: expected,
    market_tokens_observed_n: observations.length, orderbooks_success_n: observations.length - failed,
    orderbooks_failed_n: failed, capture_complete: completeness.complete,
    capture_status: failureReason ? "CAPTURE_FAILED" : completeness.status,
    failure_reason: failureReason ?? (missingIdentity ? "MARKET_TOKEN_IDENTITY_MISSING" : null),
    discovery_audit_v1: discoveryAudit,
  };
  await (deps.write ?? ((r, o, st) => defaultWriter(r, o, st, deps.getClient)))(run, observations, strategyRowsForMarketObservations(observations));
}

async function defaultAlreadyCaptured(reservationId: string, phase: ReservationMarketPhase, sourceVersion: string, getClient: RuntimeClientGetter = defaultProcessClient): Promise<boolean> {
  const supabaseAdmin = await getClient();
  const { data, error } = await supabaseAdmin.from("reservation_market_capture_runs")
    .select("id,capture_status").eq("reservation_id", reservationId).eq("observation_phase", phase)
    .eq("source_version", sourceVersion).limit(1);
  if (error) throw new Error("MILESTONE_CAPTURE_EXISTENCE_CHECK_FAILED");
  return (data ?? []).some((row) => row.capture_status !== "WRITE_INCOMPLETE");
}

function eventStartMatches(event: { endDate?: string; endDateIso?: string; startTime?: string }, eventStartIso: string): boolean {
  const times = [event.endDate, event.endDateIso, event.startTime].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return times.includes(Date.parse(eventStartIso));
}

function inventoryMarketsFromEvent(event: PolymarketRawEvent, providerEventId: string, eventStartIso: string): InventoryMarket[] {
  const observedAt = new Date().toISOString();
  return event.markets.map((market) => ({
    provider_event_id: providerEventId,
    event_start_iso: eventStartIso,
    condition_id: market.conditionId ?? null,
    clob_token_ids: market.clobTokenIds ?? [],
    outcomes: market.outcomes ?? [],
    sports_market_type: market.sportsMarketType ?? null,
    provider_market_slug: market.slug ?? null,
    sibling_market_count: event.markets.length,
    last_observed_at: observedAt,
    provider_game_id: event.gameId === undefined || event.gameId === null ? null : String(event.gameId).trim() || null,
  }));
}

async function defaultExactEventReader(providerEventId: string, eventStartIso: string): Promise<InventoryMarket[]> {
  const event = await fetchPolymarketEventById(providerEventId);
  if (!event) throw new Error("RESERVED_EVENT_MARKET_SET_UNAVAILABLE");
  if (!eventStartMatches(event, eventStartIso)) throw new Error("RESERVED_EVENT_START_MISMATCH");
  return inventoryMarketsFromEvent(event, providerEventId, eventStartIso);
}

/** The event's start as the provider states it; the Reservation start when any provider time matches it. */
function providerEventStartIso(event: PolymarketRawEvent, reservationStartIso: string): string {
  if (eventStartMatches(event, reservationStartIso)) return reservationStartIso;
  return [event.startTime, event.endDateIso, event.endDate].find((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v))) ?? "";
}

/**
 * One bounded gameId-scoped Gamma query. A full page, or a non-list response, is ambiguous and fails closed.
 * Returns the RAW discovered set: other-game, other-start and invalid-id markets are NOT dropped here, so the
 * pre-filter discovery audit sees them; `sameGameLiveUniverse` is the single place that filters (never substitutes).
 */
async function defaultGameEventsReader(gameId: string, eventStartIso: string): Promise<InventoryMarket[]> {
  const events = await fetchPolymarketEventsByGameId(gameId);
  if (events === null) throw new Error("RESERVED_EVENT_MARKET_SET_UNAVAILABLE");
  if (events.length >= GAMMA_GAME_EVENTS_LIMIT) throw new Error(PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS);
  const markets: InventoryMarket[] = [];
  for (const event of events) {
    if (!event || !Array.isArray(event.markets)) continue;
    markets.push(...inventoryMarketsFromEvent(event, String(event.id ?? ""), providerEventStartIso(event, eventStartIso)));
  }
  return markets;
}

async function defaultWriter(run: Record<string, unknown>, observations: Record<string, unknown>[], _strategies: Record<string, unknown>[] = [], getClient: RuntimeClientGetter = defaultProcessClient): Promise<void> {
  const supabaseAdmin = await getClient();
  if (run.observation_phase === PHASE) {
    const { error } = await supabaseAdmin.from("reservation_market_capture_runs")
      .upsert(run, { onConflict: "reservation_id,observation_phase,source_version", ignoreDuplicates: true });
    if (error) throw new Error("REFERENCE_BASELINE_WRITE_FAILED");
    return;
  }
  const { error: runError } = await supabaseAdmin.from("reservation_market_capture_runs").upsert(
    { ...run, capture_status: "WRITE_INCOMPLETE" },
    { onConflict: "reservation_id,observation_phase,source_version", ignoreDuplicates: true },
  );
  if (runError) throw new Error("BASELINE_RUN_WRITE_FAILED");
  // Telemetry must never be able to take the live T10 source down. If the production schema does not yet carry the
  // NEW executable-sibling columns (code shipped before migration 20261005090000, or a runtime-scoped DB that is not
  // migrated), write the observation rows WITHOUT them instead of failing the whole capture. The gap is loud (log) and
  // measurable (rows have executable_telemetry_version NULL, so coverage_complete=false). Any other error still throws.
  let telemetryColumnsMissing = false;
  for (let i = 0; i < observations.length; i += 200) {
    const chunk = observations.slice(i, i + 200);
    const upsertRows = (rows: Record<string, unknown>[]) => supabaseAdmin.from("reservation_market_observations")
      .upsert(rows, { onConflict: "capture_run_id,condition_id,token_id,side", ignoreDuplicates: true });
    let { error } = await upsertRows(telemetryColumnsMissing ? chunk.map(withoutNewTelemetryColumns) : chunk);
    if (error && !telemetryColumnsMissing && isMissingTelemetryColumnError(error)) {
      telemetryColumnsMissing = true;
      console.error("[reservation-market-baseline] T10_TELEMETRY_COLUMNS_UNAVAILABLE: observation rows written without executable-sibling telemetry columns (migration 20261005090000 not applied on this database)");
      ({ error } = await upsertRows(chunk.map(withoutNewTelemetryColumns)));
    }
    if (error) throw new Error("BASELINE_OBSERVATION_WRITE_FAILED");
  }
  // Re-read persisted scalar rows so a retry repairs strategy rows for any
  // observation written before a prior process interruption.
  const persisted: Record<string, unknown>[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { data, error } = await supabaseAdmin.from("reservation_market_observations")
      .select("id,capture_run_id,reservation_id,physical_event_id,condition_id,token_id,side,observation_phase,observed_at,minutes_to_start,best_ask,ask_decimal_odds,spread_abs,ask_depth_relevant_usd")
      .eq("capture_run_id", run.id).gt("id", lastId).order("id").limit(200);
    if (error) throw new Error("STRATEGY_SOURCE_READ_FAILED");
    const page = (data ?? []) as Record<string, unknown>[];
    persisted.push(...page);
    if (page.length < 200) break;
    lastId = String(page[page.length - 1].id);
  }
  const persistedStrategies = strategyRowsForMarketObservations(persisted);
  for (let i = 0; i < persistedStrategies.length; i += 200) {
    const { error } = await supabaseAdmin.from("reservation_strategy_observations")
      .upsert(persistedStrategies.slice(i, i + 200), { onConflict: "market_observation_id,strategy_variant", ignoreDuplicates: true });
    if (error) throw new Error("STRATEGY_OBSERVATION_WRITE_FAILED");
  }
  const { error: finishError } = await supabaseAdmin.from("reservation_market_capture_runs")
    .update({ capture_status: run.capture_status, market_tokens_observed_n: persisted.length })
    .eq("id", run.id).eq("capture_status", "WRITE_INCOMPLETE");
  if (finishError) throw new Error("MARKET_CAPTURE_FINALIZE_FAILED");
}

export const AB_STRATEGY_VARIANTS = ["A_CURRENT_CONTROL", "B_FOUR_MARKET_PRIORITY_V1"] as const;
export type ReservationAbStrategyVariant = (typeof AB_STRATEGY_VARIANTS)[number];

export type ReservationStrategyDecisionInput = {
  captureRunId: string;
  strategyVariant: ReservationAbStrategyVariant;
  strategyVersion: string;
  selectedIdentity: { conditionId: string; tokenId: string; side: string } | null;
  decisionReason: string;
};

const AB_VERSION = "P1B1_T3_AB_V1";
const B_SUPPORT = [
  { family: "SPREADS", type: "SPREAD", min: 1.85, max: 2.00 },
  { family: "TOTAL_CORNERS", type: "TOTAL_CORNERS", min: 2.25, max: 2.50 },
  // MONEYLINE_SUPPORT_AND_MAKER_PRICE_AUTHORITY_FIX_V1: Founder-authorized 1.85 -> 1.70 (MONEYLINE only).
  // This is the ONE canonical MONEYLINE band; it widens candidate admission, never what PREMVP may pay.
  { family: "MONEYLINE", type: "MONEYLINE", min: 1.70, max: 2.00 },
  { family: "TOTALS", type: "TOTAL", min: 1.85, max: 2.00 },
] as const;

export function bStrategySupportRegion(family: string): { min: number; max: number } | null {
  const region = B_SUPPORT.find((item) => item.family === family);
  return region ? { min: region.min, max: region.max } : null;
}

const hasT3Book = (row: FinalT3MarketObservation) => row.orderbook_fetch_status === "SUCCESS" &&
  typeof row.best_ask === "number" && Number.isFinite(row.best_ask) && row.best_ask > 0 &&
  typeof row.ask_decimal_odds === "number" && Number.isFinite(row.ask_decimal_odds) && row.ask_decimal_odds > 0;

/**
 * FAMILY/TYPE admission (price-agnostic): family + type + usable T3 book + raw total_corners proof.
 * The price band is NOT part of this predicate: TAKER and MAKER each prove the band against the price
 * they would actually transact at (see isBSupportPriceInBand and the T10 economic action policy).
 */
export function isBSupportFamilyEligible(row: FinalT3MarketObservation): boolean {
  return B_SUPPORT.some((support) => row.canonical_market_family === support.family &&
    row.canonical_market_type === support.type && hasT3Book(row) &&
    (support.family !== "TOTAL_CORNERS" ||
      (row.provider_market_type_raw?.trim().toLowerCase() === "total_corners" &&
        classifyExactEventMarket(row.provider_market_type_raw, row.market_slug).family === "TOTAL_CORNERS")));
}

/** True when `price` (a probability price in (0,1]) maps to decimal odds inside the family's canonical band. */
export function isBSupportPriceInBand(family: string, price: number | null | undefined): boolean {
  const region = bStrategySupportRegion(family);
  if (!region || typeof price !== "number" || !Number.isFinite(price) || !(price > 0)) return false;
  const odds = 1 / price;
  return odds >= region.min - 1e-9 && odds <= region.max + 1e-9;
}

/**
 * CANDIDATE authority at the CURRENT ASK (initial TAKER support evidence): family admission plus the T10
 * ask odds inside the canonical band. Shared by the B priority selector and the T10 economic action policy.
 */
export function isBSupportEligible(row: FinalT3MarketObservation): boolean {
  return isBSupportFamilyEligible(row) && B_SUPPORT.some((support) =>
    row.canonical_market_family === support.family && row.canonical_market_type === support.type &&
    row.ask_decimal_odds! >= support.min && row.ask_decimal_odds! <= support.max);
}

export function selectReservationT3AbDecisions(
  reservation: NightEventReservationRow,
  universe: readonly FinalT3MarketObservation[],
): { a: ReservationStrategyDecisionInput; b: ReservationStrategyDecisionInput } {
  const captureRunId = universe[0]?.capture_run_id;
  const reservationStart = reservation.event_start_iso;
  if (!captureRunId || !reservation.id || !reservation.physical_event_id || !reservationStart ||
      universe.some((row) => row.capture_run_id !== captureRunId || row.reservation_id !== reservation.id ||
        row.physical_event_id !== reservation.physical_event_id ||
        Date.parse(row.event_start_iso) !== Date.parse(reservationStart) ||
        row.observation_phase !== FINAL_REBALANCE_PHASE ||
        ![row.condition_id, row.token_id, row.side].every((v) => typeof v === "string" && v.trim() !== ""))) {
    throw new Error("AB_T3_UNIVERSE_LINEAGE_INVALID");
  }
  const identity = (row: FinalT3MarketObservation) => ({ conditionId: row.condition_id, tokenId: row.token_id, side: row.side });
  const hasBook = (row: FinalT3MarketObservation) => row.orderbook_fetch_status === "SUCCESS" &&
    typeof row.best_ask === "number" && Number.isFinite(row.best_ask) && row.best_ask > 0 &&
    typeof row.ask_decimal_odds === "number" && Number.isFinite(row.ask_decimal_odds) && row.ask_decimal_odds > 0;
  const rawPlanning = reservation.diagnostics?.planning_final_identity_evidence as Record<string, unknown> | undefined;
  const planning = rawPlanning && [rawPlanning.condition_id, rawPlanning.token_id, rawPlanning.side]
    .every((v) => typeof v === "string" && v.trim() !== "") ? rawPlanning : null;
  const planningMatches = planning ? universe.filter((row) => row.condition_id === planning.condition_id &&
    row.token_id === planning.token_id && row.side === planning.side) : [];
  const aSelected = planningMatches.length === 1 && hasBook(planningMatches[0]) ? planningMatches[0] : null;
  const aReason = !planning ? "PLANNING_IDENTITY_MISSING" : planningMatches.length === 0
    ? "PLANNING_IDENTITY_NOT_IN_T3" : planningMatches.length > 1
      ? "PLANNING_IDENTITY_AMBIGUOUS" : !aSelected ? "PLANNING_T3_BOOK_UNAVAILABLE" : "PLANNING_EXACT_T3_BOOK_SUPPORTED";

  let bSelected: FinalT3MarketObservation | null = null;
  let bReason = "NO_SUPPORTED_T3_CANDIDATE";
  for (const support of B_SUPPORT) {
    const qualifying = universe.filter((row) => row.canonical_market_family === support.family &&
      row.canonical_market_type === support.type && hasBook(row) &&
      row.ask_decimal_odds! >= support.min && row.ask_decimal_odds! <= support.max &&
      (support.family !== "TOTAL_CORNERS" ||
        (row.provider_market_type_raw?.trim().toLowerCase() === "total_corners" &&
          classifyExactEventMarket(row.provider_market_type_raw, row.market_slug).family === "TOTAL_CORNERS")));
    if (qualifying.length === 0) continue;
    qualifying.sort(compareExactIdentity);
    if (qualifying.length > 1 && compareExactIdentity(qualifying[0], qualifying[1]) === 0) {
      bReason = "AMBIGUOUS_EXACT_IDENTITY_ORDER";
      break;
    }
    bSelected = qualifying[0];
    bReason = `PRIORITY_${support.family}_IN_SUPPORT`;
    break;
  }
  return {
    a: { captureRunId, strategyVariant: "A_CURRENT_CONTROL", strategyVersion: AB_VERSION,
      selectedIdentity: aSelected ? identity(aSelected) : null, decisionReason: aReason },
    b: { captureRunId, strategyVariant: "B_FOUR_MARKET_PRIORITY_V1", strategyVersion: AB_VERSION,
      selectedIdentity: bSelected ? identity(bSelected) : null, decisionReason: bReason },
  };
}

export async function persistReservationT3AbDecisions(
  reservation: NightEventReservationRow,
  deps: {
    readUniverse?: typeof readCompletedFinalT3Universe;
    recordDecision?: typeof recordReservationStrategyDecision;
    getClient?: RuntimeClientGetter;
  } = {},
): Promise<{ a: ReservationStrategyDecisionInput; b: ReservationStrategyDecisionInput }> {
  const universe = await (deps.readUniverse ?? ((r) => readCompletedFinalT3Universe(r, createFinalT3ReadPort(deps.getClient))))(reservation);
  const decisions = selectReservationT3AbDecisions(reservation, universe);
  const record = deps.recordDecision ?? ((i) => recordReservationStrategyDecision(i, { store: createReservationStrategyDecisionStore(deps.getClient) }));
  await record(decisions.a);
  await record(decisions.b);
  return decisions;
}

export type ReservationStrategyDecisionStore = {
  // Both readers page by ascending id, strictly after `afterId`.
  readObservations(captureRunId: string, afterId: string, limit: number): Promise<Record<string, unknown>[]>;
  readDecisions(captureRunId: string, strategyVariant: string, afterId: string, limit: number): Promise<Record<string, unknown>[]>;
  upsertDecisions(rows: Record<string, unknown>[]): Promise<void>;
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DECISION_PAGE_SIZE = 200;

async function readAllPages(read: (afterId: string, limit: number) => Promise<Record<string, unknown>[]>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let lastId = NIL_UUID;
  for (;;) {
    const page = await read(lastId, DECISION_PAGE_SIZE);
    out.push(...page);
    if (page.length < DECISION_PAGE_SIZE) break;
    lastId = String(page[page.length - 1].id ?? page[page.length - 1].market_observation_id);
  }
  return out;
}

// Records an ALREADY-MADE A/B strategy decision for one capture run. It never ranks markets
// and is not called by any live flow; the caller (future Rebalance) supplies the decision.
export async function recordReservationStrategyDecision(
  input: ReservationStrategyDecisionInput,
  deps: { store?: ReservationStrategyDecisionStore } = {},
): Promise<{ total: number; selected: number; written: number }> {
  if (!(AB_STRATEGY_VARIANTS as readonly string[]).includes(input.strategyVariant)) throw new Error("STRATEGY_DECISION_UNSUPPORTED_VARIANT");
  if (!input.captureRunId || !input.strategyVersion?.trim()) throw new Error("STRATEGY_DECISION_INPUT_INVALID");
  if (!input.decisionReason?.trim()) throw new Error("STRATEGY_DECISION_INPUT_INVALID");
  const selectedIdentity = input.selectedIdentity;
  if (selectedIdentity && !(selectedIdentity.conditionId && selectedIdentity.tokenId && selectedIdentity.side)) {
    throw new Error("STRATEGY_DECISION_SELECTED_IDENTITY_INVALID");
  }
  const store = deps.store ?? createReservationStrategyDecisionStore();
  const observations = (await readAllPages((after, limit) => store.readObservations(input.captureRunId, after, limit)))
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  if (observations.length === 0) throw new Error("STRATEGY_DECISION_NO_OBSERVATIONS");
  if (observations.some((row) => row.capture_run_id !== input.captureRunId)) throw new Error("STRATEGY_DECISION_CAPTURE_RUN_MISMATCH");
  let selectedId: string | null = null;
  if (selectedIdentity) {
    const matches = observations.filter((row) => row.condition_id === selectedIdentity.conditionId
      && row.token_id === selectedIdentity.tokenId && row.side === selectedIdentity.side);
    if (matches.length === 0) throw new Error("STRATEGY_DECISION_SELECTED_IDENTITY_NOT_FOUND");
    if (matches.length > 1) throw new Error("STRATEGY_DECISION_SELECTED_IDENTITY_AMBIGUOUS");
    selectedId = String(matches[0].id);
  }
  const rows = observations.map((market) => {
    const selected = String(market.id) === selectedId;
    return {
      id: stableTelemetryId(String(market.id), input.strategyVariant),
      market_observation_id: market.id, capture_run_id: market.capture_run_id,
      reservation_id: market.reservation_id, physical_event_id: market.physical_event_id,
      condition_id: market.condition_id, token_id: market.token_id, side: market.side,
      observation_phase: market.observation_phase, evaluated_at: market.observed_at,
      minutes_to_start: market.minutes_to_start, strategy_variant: input.strategyVariant,
      strategy_version: input.strategyVersion,
      evaluation_state: selected ? "SELECTED" : "EVALUATED_NOT_SELECTED", eligible: selected,
      rejection_reason: selected ? null : selectedIdentity ? "NOT_SELECTED_BY_STRATEGY" : input.decisionReason,
      available_best_ask: market.best_ask ?? null, available_decimal_odds: market.ask_decimal_odds ?? null,
      spread_abs: market.spread_abs ?? null, executable_depth_usd: market.ask_depth_relevant_usd ?? null,
    };
  });
  const persisted = new Map<string, Record<string, unknown>>();
  for (const row of await readAllPages((after, limit) => store.readDecisions(input.captureRunId, input.strategyVariant, after, limit))) {
    persisted.set(String(row.market_observation_id), row);
  }
  for (const row of rows) {
    const existing = persisted.get(String(row.market_observation_id));
    if (existing && (existing.evaluation_state !== row.evaluation_state || existing.eligible !== row.eligible
      || (existing.rejection_reason ?? null) !== row.rejection_reason || existing.strategy_version !== row.strategy_version)) {
      throw new Error("STRATEGY_DECISION_CONFLICT");
    }
  }
  const missing = rows.filter((row) => !persisted.has(String(row.market_observation_id)));
  for (let i = 0; i < missing.length; i += DECISION_PAGE_SIZE) await store.upsertDecisions(missing.slice(i, i + DECISION_PAGE_SIZE));
  return { total: rows.length, selected: selectedId ? 1 : 0, written: missing.length };
}

/** Strategy-decision store bound to a client getter; default = the process-wide supabaseAdmin (unchanged). */
export function createReservationStrategyDecisionStore(getClient: RuntimeClientGetter = defaultProcessClient): ReservationStrategyDecisionStore {
  return {
  async readObservations(captureRunId, afterId, limit) {
    const supabaseAdmin = await getClient();
    const { data, error } = await supabaseAdmin.from("reservation_market_observations")
      .select("id,capture_run_id,reservation_id,physical_event_id,condition_id,token_id,side,observation_phase,observed_at,minutes_to_start,best_ask,ask_decimal_odds,spread_abs,ask_depth_relevant_usd")
      .eq("capture_run_id", captureRunId).gt("id", afterId).order("id").limit(limit);
    if (error) throw new Error("STRATEGY_DECISION_SOURCE_READ_FAILED");
    return (data ?? []) as Record<string, unknown>[];
  },
  async readDecisions(captureRunId, strategyVariant, afterId, limit) {
    const supabaseAdmin = await getClient();
    const { data, error } = await supabaseAdmin.from("reservation_strategy_observations")
      .select("id,market_observation_id,evaluation_state,eligible,rejection_reason,strategy_version")
      .eq("capture_run_id", captureRunId).eq("strategy_variant", strategyVariant)
      .gt("id", afterId).order("id").limit(limit);
    if (error) throw new Error("STRATEGY_DECISION_READ_FAILED");
    return (data ?? []) as Record<string, unknown>[];
  },
  async upsertDecisions(rows) {
    const supabaseAdmin = await getClient();
    const { error } = await supabaseAdmin.from("reservation_strategy_observations")
      .upsert(rows, { onConflict: "market_observation_id,strategy_variant", ignoreDuplicates: true });
    if (error) throw new Error("STRATEGY_DECISION_WRITE_FAILED");
  },
};
}

export type LiveGuardTelemetryInput = {
  attemptId: string;
  observedAt: string;
  conditionId: string;
  tokenId: string;
  side: string;
  marketSlug: string | null;
  referenceEntryPrice: number;
  executionPriceCap: number;
  requestedStakeUsd: number;
  pass: boolean;
  rejectionReason: string | null;
  fetchStatus: string;
  fetchFailureReason: string | null;
  fetchLatencyMs: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  capEligibleAskDepthUsd: number | null;
  fullStakeExecutableVwap: number | null;
};

export function liveGuardTelemetryRows(reservation: NightEventReservationRow, input: LiveGuardTelemetryInput) {
  if (!reservation.id || !reservation.event_start_iso) throw new Error("LIVE_GUARD_RESERVATION_LINEAGE_MISSING");
  const sourceVersion = `LIVE_GUARD_V1:${input.attemptId}`;
  const runId = stableTelemetryId(reservation.id, "LIVE_GUARD", sourceVersion);
  const observedN = input.fetchStatus === "SUCCESS" ? 1 : 0;
  const minutesToStart = (Date.parse(reservation.event_start_iso) - Date.parse(input.observedAt)) / 60_000;
  const run = {
    id: runId, reservation_id: reservation.id, plan_run_id: reservation.plan_run_id,
    physical_event_id: reservation.physical_event_id, provider_event_id: null,
    event_start_iso: reservation.event_start_iso, observation_phase: "LIVE_GUARD",
    observed_at: input.observedAt, minutes_to_start: minutesToStart,
    source_version: sourceVersion, source_observed_at: input.fetchStatus === "SUCCESS" ? input.observedAt : null,
    markets_discovered_n: 1, market_tokens_expected_n: 1, market_tokens_observed_n: observedN,
    orderbooks_success_n: observedN, orderbooks_failed_n: 1 - observedN,
    capture_complete: observedN === 1, capture_status: observedN === 1 ? "COMPLETE" : "CAPTURE_FAILED",
    failure_reason: input.fetchFailureReason,
  };
  const observation = {
    id: stableTelemetryId(runId, input.conditionId, input.tokenId, input.side),
    capture_run_id: runId, reservation_id: reservation.id, physical_event_id: reservation.physical_event_id,
    provider_event_id: null, event_start_iso: reservation.event_start_iso, observation_phase: "LIVE_GUARD",
    observed_at: input.observedAt, minutes_to_start: minutesToStart,
    condition_id: input.conditionId, token_id: input.tokenId, side: input.side, outcome: null,
    canonical_market_family: null, canonical_market_type: null, provider_market_type_raw: null,
    market_slug: input.marketSlug, live_policy_eligibility: input.pass,
    live_policy_rejection_reason: input.rejectionReason,
    best_bid: input.bestBid, best_ask: input.bestAsk, mid_price: input.bestBid !== null && input.bestAsk !== null ? (input.bestBid + input.bestAsk) / 2 : null,
    bid_decimal_odds: input.bestBid ? 1 / input.bestBid : null,
    ask_decimal_odds: input.bestAsk ? 1 / input.bestAsk : null,
    spread_abs: input.spread, spread_bps: null,
    bid_depth_relevant_usd: null, ask_depth_relevant_usd: input.capEligibleAskDepthUsd,
    tick_size: null, minimum_order_size: null,
    orderbook_fetch_latency_ms: input.fetchLatencyMs, orderbook_fetch_status: input.fetchStatus,
    orderbook_failure_reason: input.fetchFailureReason,
    reference_entry_price: input.referenceEntryPrice, execution_price_cap: input.executionPriceCap,
    requested_stake_usd: input.requestedStakeUsd, full_stake_executable_vwap: input.fullStakeExecutableVwap,
    source_version: sourceVersion,
  };
  return { run, observation, strategies: strategyRowsForMarketObservations([observation]) };
}

export async function persistLiveGuardTelemetry(reservation: NightEventReservationRow, input: LiveGuardTelemetryInput, getClient?: RuntimeClientGetter): Promise<void> {
  const rows = liveGuardTelemetryRows(reservation, input);
  await defaultWriter(rows.run, [rows.observation], rows.strategies, getClient);
}

export async function captureReservationMarketMilestones(
  nowMs: number,
  deps: {
    load?: (lowerIso: string, upperIso: string) => Promise<NightEventReservationRow[]>;
    capture?: (reservation: NightEventReservationRow, phase: ReservationMarketPhase, observedAt: string) => Promise<void>;
    onError?: (code: string) => void;
    getClient?: RuntimeClientGetter;
  } = {},
): Promise<void> {
  const observedAt = new Date(nowMs).toISOString();
  const lower = new Date(nowMs + 3 * 60_000).toISOString();
  // Cohort upper bound must equal the early window's open edge, or a T-40 reservation is never loaded.
  const upper = new Date(nowMs + EARLY_CAPTURE_WINDOW_OPEN_MINUTES * 60_000).toISOString();
  const rows = await (deps.load ?? ((lo, up) => defaultMilestoneReservationLoader(lo, up, deps.getClient)))(lower, upper);
  for (const reservation of rows.slice(0, 200)) {
    const phase = classifyReservationMarketPhase(reservation.event_start_iso ?? "", nowMs);
    if (!phase) continue;
    try {
      if (deps.capture) await deps.capture(reservation, phase, observedAt);
      else {
        await captureReservationMarketObservation(reservation, phase, { observedAt, getClient: deps.getClient });
        if (phase === FINAL_REBALANCE_PHASE) await persistReservationT3AbDecisions(reservation, { getClient: deps.getClient });
      }
    } catch {
      (deps.onError ?? ((code) => console.error(`[reservation-market-milestone] ${code}`)))("CAPTURE_FAILED");
    }
  }
}

async function defaultMilestoneReservationLoader(lowerIso: string, upperIso: string, getClient: RuntimeClientGetter = defaultProcessClient): Promise<NightEventReservationRow[]> {
  const supabaseAdmin = await getClient();
  const { data, error } = await supabaseAdmin.from("night_event_reservations")
    .select("id,plan_run_id,physical_event_id,event_start_iso,diagnostics")
    .gt("event_start_iso", lowerIso).lte("event_start_iso", upperIso)
    .order("event_start_iso").order("id").limit(200);
  if (error) throw new Error("MILESTONE_RESERVATION_COHORT_READ_FAILED");
  return (data ?? []) as unknown as NightEventReservationRow[];
}
