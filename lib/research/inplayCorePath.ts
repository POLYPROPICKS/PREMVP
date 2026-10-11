// Research-only in-play facts. No consumer on the money path.
import { fetchPolymarketEventsByGameId, GAMMA_GAME_EVENTS_LIMIT } from "../feed/polymarketClient";
import type { PolymarketRawEvent } from "../feed/types";
import { fetchOrderBooksConcurrent } from "../liquidity/polymarketClient";
import { computeDepthWithinPct, computeExecutableExit, computeMidPrice, computeSpread, getBestBidAsk } from "../liquidity/orderbookMath";
import { physicalMatchId } from "../executor/contractADecisions";
import { classifyObservationalMarket, defaultExactEventReader, defaultGameEventsReader, inventoryTokens, sameGameLiveUniverse, stableTelemetryId } from "../executor/reservationMarketBaseline";
import { admitResearchMarket } from "../executor/precontractT20Research";
import { buildExecutableSiblingColumns, fetchFeeSchedulesBounded } from "../executor/t10ExecutableSiblingTelemetry";

export const TABLE = "research_inplay_core_path_observations";
export const SOURCE_VERSION = "INPLAY_CORE_PATH_V1";
export const MAX_DAILY_PHYSICAL_EVENTS = 100;
export const MAX_TRACKED_TOKENS_PER_EVENT = 16;
export const MAX_PERSISTED_OBSERVATIONS_PER_EVENT = 192;
export const MAX_TOTAL_ROWS_PER_DAY = 20000;
export const MAX_INPLAY_LOGICAL_MB_PER_DAY = 20;
export const PRODUCTION_RETENTION_HOURS = 48;
export const HEARTBEAT_MS = 5 * 60_000;
const SPORT_FAMILIES = new Set(["soccer", "tennis", "basketball", "baseball", "hockey", "cricket", "american-football"]);

export type SportsState = { gameId?: unknown; live?: unknown; ended?: unknown; status?: unknown; period?: unknown; score?: unknown; elapsed?: unknown; leagueAbbreviation?: unknown };
export type StructuredState = { gameId: string; eventLiveStatus: "LIVE" | "FINAL"; phase: string | null; sportCode: string | null };

/** Used by the live-socket loop; a state older than this at capture time is not authoritative for the row. */
export const STATE_MAX_AGE_MS = 90_000;

export type SportState = {
  periodNum: number | null; clockSecondsElapsed: number | null;
  sideAScore: number | null; sideBScore: number | null; receivedAt: string | null;
};
const NO_SPORT_STATE: SportState = { periodNum: null, clockSecondsElapsed: null, sideAScore: null, sideBScore: null, receivedAt: null };

/**
 * Typed state from the provider sports socket, soccer only (the one admitted family whose payload carries
 * score + period + elapsed minute; tennis carries a multi-set score and no clock, so it stays null).
 * Provider contract: score is "<home>-<away>" (side A = home, side B = away); elapsed is the count-up match
 * minute (verified live: +1 per wall-clock minute) so it is stored as elapsed seconds and the "remaining"
 * column is never populated. Anything unparseable, inconsistent, stale or without a receipt time yields null.
 * Nothing is derived from prices.
 */
export function deriveSportState(raw: SportsState, family: string, eventLiveStatus: "LIVE" | "FINAL",
  receivedAtMs: number | undefined, nowMs: number): SportState {
  if (family !== "soccer" || receivedAtMs === undefined || !Number.isFinite(receivedAtMs)
    || receivedAtMs > nowMs || nowMs - receivedAtMs > STATE_MAX_AGE_MS) return NO_SPORT_STATE;
  const sides = typeof raw.score === "string" ? /^(\d{1,3})-(\d{1,3})$/.exec(raw.score) : null;
  const period = typeof raw.period === "string" ? raw.period : "";
  let periodNum: number | null = null;
  let clockSecondsElapsed: number | null = null;
  if (eventLiveStatus === "LIVE") {
    periodNum = period === "1H" ? 1 : period === "2H" ? 2 : null;
    const minute = typeof raw.elapsed === "string" && /^\d{1,3}$/.test(raw.elapsed) ? Number.parseInt(raw.elapsed, 10) : null;
    const consistent = minute !== null && (periodNum === 1 ? minute <= 60 : periodNum === 2 ? minute >= 45 && minute <= 130 : false);
    if (consistent) clockSecondsElapsed = minute * 60;
  } else if (period !== "FT") return NO_SPORT_STATE;
  const sideAScore = sides ? Number.parseInt(sides[1], 10) : null;
  const sideBScore = sides ? Number.parseInt(sides[2], 10) : null;
  if (sideAScore === null && periodNum === null && clockSecondsElapsed === null) return NO_SPORT_STATE;
  return { periodNum, clockSecondsElapsed, sideAScore, sideBScore, receivedAt: new Date(receivedAtMs).toISOString() };
}

/** The sports socket's score is a formatted string; typed sides come only from deriveSportState (soccer). */
export function deriveStructuredState(input: SportsState): StructuredState | null {
  const gameId = typeof input.gameId === "number" && Number.isSafeInteger(input.gameId) && input.gameId > 0
    ? String(input.gameId) : typeof input.gameId === "string" && /^\d+$/.test(input.gameId) ? input.gameId : null;
  const status = typeof input.status === "string" ? input.status.toLowerCase() : "";
  if (!gameId || (input.live !== true && input.ended !== true)) return null;
  if (input.ended !== true && (input.live !== true || status !== "inprogress")) return null;
  const phase = typeof input.period === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(input.period) ? input.period : null;
  const sportCode = typeof input.leagueAbbreviation === "string" && /^[a-z0-9_-]{1,40}$/i.test(input.leagueAbbreviation)
    ? input.leagueAbbreviation.toLowerCase() : null;
  return { gameId, eventLiveStatus: input.ended === true ? "FINAL" : "LIVE", phase, sportCode };
}

/** Exact structured Gamma tag; an ambiguous or absent family fails closed. */
export function admitPhysicalEvent(events: readonly PolymarketRawEvent[], state: StructuredState): { event: PolymarketRawEvent; family: string; start: string } | null {
  if (events.length === 0 || events.length >= GAMMA_GAME_EVENTS_LIMIT) return null;
  const candidates = events.filter((e) => String(e.gameId ?? "") === state.gameId && !e.parentEventId && Array.isArray(e.markets));
  if (candidates.length !== 1) return null;
  const event = candidates[0];
  const families = new Set((event.tags as Array<{ slug?: unknown }> | undefined ?? [])
    .map((tag) => tag.slug).filter((slug): slug is string => typeof slug === "string" && SPORT_FAMILIES.has(slug)));
  const start = event.startTime;
  if (families.size !== 1 || !start || !Number.isFinite(Date.parse(start))) return null;
  return { event, family: [...families][0], start: new Date(start).toISOString() };
}

function conditionVolumes(events: readonly PolymarketRawEvent[]): Map<string, number> {
  const volumes = new Map<string, number>();
  for (const event of events) for (const raw of event.markets ?? []) {
    const value = typeof raw.volume24hr === "number" && Number.isFinite(raw.volume24hr) ? raw.volume24hr
      : typeof raw.volume === "number" && Number.isFinite(raw.volume) ? raw.volume : null;
    if (raw.conditionId && value !== null) volumes.set(raw.conditionId, Math.max(value, volumes.get(raw.conditionId) ?? 0));
  }
  return volumes;
}

/** One highest-volume condition per core family. Ties without a unique leader are excluded. */
export function selectPrimaryCoreMarkets<T extends { condition_id: string | null; sports_market_type: string | null; provider_market_slug: string | null }>(
  markets: readonly T[], events: readonly PolymarketRawEvent[], family: string,
): T[] {
  const volumes = conditionVolumes(events);
  const groups = new Map<string, T[]>();
  for (const market of markets) {
    const verdict = admitResearchMarket(family, market.sports_market_type, market.provider_market_slug);
    if (!verdict.admitted || !market.condition_id) continue;
    const group = groups.get(verdict.type) ?? [];
    group.push(market);
    groups.set(verdict.type, group);
  }
  const chosen: T[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { chosen.push(group[0]); continue; }
    const ordered = group.filter((m) => volumes.has(m.condition_id!))
      .sort((a, b) => volumes.get(b.condition_id!)! - volumes.get(a.condition_id!)!);
    if (ordered.length && (ordered.length === 1 || volumes.get(ordered[0].condition_id!)! > volumes.get(ordered[1].condition_id!)!)) chosen.push(ordered[0]);
  }
  return chosen;
}

type CoreMarket = Parameters<typeof inventoryTokens>[0][number];
type RawTotalFact = { line: number | null; gameId: string; typeIsTotal: boolean };

/** Provider-structured half-goal line only (x.5). Integers, quarter lines and non-numbers are not a covering line. */
function halfGoalLine(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 20 && (value * 2) % 2 === 1 ? value : null;
}

// Fail-closed scope rejectors. These only ever REJECT; a line is never derived from a slug or title.
const NON_FULL_GAME_SLUG = /(?:^|-)(?:1h|2h|ht|half|halves|team|corners?|cards?)(?:-|$)/i;
const SLUG_LINE = /-total-(\d+)pt(\d+)$/;

/** Structured line facts keyed by condition. A condition reported twice with differing facts is "CONFLICT". */
function rawTotalFacts(events: readonly PolymarketRawEvent[]): Map<string, RawTotalFact | "CONFLICT"> {
  const facts = new Map<string, RawTotalFact | "CONFLICT">();
  for (const event of events) for (const raw of event.markets ?? []) {
    if (!raw.conditionId) continue;
    const fact: RawTotalFact = {
      line: halfGoalLine((raw as { line?: unknown }).line), gameId: String(event.gameId ?? ""),
      typeIsTotal: classifyObservationalMarket(raw.sportsMarketType).type === "TOTAL",
    };
    const seen = facts.get(raw.conditionId);
    if (seen === undefined) facts.set(raw.conditionId, fact);
    else if (seen === "CONFLICT" || seen.line !== fact.line || seen.gameId !== fact.gameId || seen.typeIsTotal !== fact.typeIsTotal) facts.set(raw.conditionId, "CONFLICT");
  }
  return facts;
}

function fullGameTotalLine(market: CoreMarket, facts: Map<string, RawTotalFact | "CONFLICT">): { line: number; gameId: string } | null {
  const fact = market.condition_id ? facts.get(market.condition_id) : undefined;
  if (!fact || fact === "CONFLICT" || fact.line === null || !fact.typeIsTotal || !fact.gameId) return null;
  if (admitResearchMarket("soccer", market.sports_market_type, market.provider_market_slug).type !== "TOTAL") return null;
  const slug = market.provider_market_slug ?? "";
  if (NON_FULL_GAME_SLUG.test(slug)) return null;
  const slugLine = SLUG_LINE.exec(slug);
  if (slugLine && Number(`${slugLine[1]}.${slugLine[2]}`) !== fact.line) return null; // metadata disagrees
  return { line: fact.line, gameId: fact.gameId };
}

/** Provider list as supplied (array or JSON string of one). Anything not a list of strings / `{name}` objects is malformed. */
function rawIdentityList(value: unknown, allowNamed: boolean): string[] | null {
  let list = value;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") out.push(item);
    else if (allowNamed && item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") out.push((item as { name: string }).name);
    else return null;
  }
  return out;
}

/** Index-aligned `token|outcome` signature of ONE raw market row, or null unless it is an exact two-way Over/Under. */
function overUnderSignature(market: CoreMarket): string | null {
  if (!market.condition_id?.trim()) return null;
  const tokenIds = rawIdentityList(market.clob_token_ids, false);
  const outcomes = rawIdentityList(market.outcomes, true);
  if (!tokenIds || !outcomes || tokenIds.length !== 2 || outcomes.length !== 2) return null;
  const ids = tokenIds.map((t) => t.trim());
  const sides = outcomes.map((o) => o.trim().toLowerCase());
  if (ids.some((t) => !t) || ids[0] === ids[1]) return null;
  if (!((sides[0] === "over" && sides[1] === "under") || (sides[0] === "under" && sides[1] === "over"))) return null;
  return `${ids[0]}\u0000${sides[0]}\u0001${ids[1]}\u0000${sides[1]}`;
}

/**
 * Exactly one Over and one Under token for the condition, nothing missing, nothing extra. Validated on the raw
 * provider arrays BEFORE any deduplication (inventoryTokens() would collapse [a,a,b]/[Over,Over,Under] into two
 * tokens), and every supplied row of the condition must carry the identical index-aligned identity.
 */
function hasExactOverUnderLinkage(rows: readonly CoreMarket[]): boolean {
  if (rows.length === 0) return false;
  const first = overUnderSignature(rows[0]);
  return first !== null && rows.every((row) => overUnderSignature(row) === first);
}

/**
 * Soccer research only: at most ONE additional full-game TOTALS condition beside the primary TOTALS condition,
 * so two lines of the same physical game can be observed in the same capture cycle. The nearest distinct
 * half-goal line is chosen (Over lower line + Under higher line always pays at least 1 in every score state,
 * and adjacent lines minimise the price of the extra coverage). Selection is by structured provider `line`
 * only and is independent of input order. Any missing/contradictory identity, line, scope, volume or token
 * linkage, or any capacity overflow of MAX_TRACKED_TOKENS_PER_EVENT, yields null and the primaries stay intact.
 * Selection is co-capture only: it makes no claim that the quotes are simultaneously executable.
 */
export function selectLinkedSoccerTotals<T extends CoreMarket>(
  universe: readonly T[], events: readonly PolymarketRawEvent[], family: string, primary: readonly T[],
): T | null {
  if (family !== "soccer") return null;
  const facts = rawTotalFacts(events);
  const anchors = primary.filter((m) => admitResearchMarket(family, m.sports_market_type, m.provider_market_slug).type === "TOTAL");
  if (anchors.length !== 1) return null;
  const anchor = anchors[0];
  const anchorLine = fullGameTotalLine(anchor, facts);
  if (!anchorLine) return null;
  const primaryTokens = inventoryTokens(primary);
  // The anchor condition (every universe row reporting it) must itself be an exact two-way Over/Under market.
  const anchorRows = universe.filter((m) => m.condition_id === anchor.condition_id);
  if (primaryTokens.missingIdentity > 0 || !hasExactOverUnderLinkage([anchor, ...anchorRows])) return null;
  const volumes = conditionVolumes(events);
  const startMs = Date.parse(anchor.event_start_iso);
  const byCondition = new Map<string, T[]>();
  for (const market of universe) {
    if (!market.condition_id || market.condition_id === anchor.condition_id) continue;
    const group = byCondition.get(market.condition_id) ?? [];
    group.push(market);
    byCondition.set(market.condition_id, group);
  }
  const candidates: Array<{ market: T; line: number; conditionId: string }> = [];
  for (const [conditionId, group] of byCondition) {
    const found = fullGameTotalLine(group[0], facts);
    if (!found || found.gameId !== anchorLine.gameId || found.line === anchorLine.line || !volumes.has(conditionId)) continue;
    // Duplicate rows of one condition are one market; any disagreement between them is ambiguity.
    if (group.some((m) => m.provider_game_id !== anchor.provider_game_id || Date.parse(m.event_start_iso) !== startMs
      || fullGameTotalLine(m, facts)?.line !== found.line)) continue;
    if (!hasExactOverUnderLinkage(group)) continue;
    const linked = inventoryTokens(group);
    if (primaryTokens.tokens.length + linked.tokens.length > MAX_TRACKED_TOKENS_PER_EVENT) continue;
    candidates.push({ market: group[0], line: found.line, conditionId });
  }
  candidates.sort((a, b) => Math.abs(a.line - anchorLine.line) - Math.abs(b.line - anchorLine.line)
    || a.line - b.line || (a.conditionId < b.conditionId ? -1 : a.conditionId > b.conditionId ? 1 : 0));
  return candidates[0]?.market ?? null;
}

/** Primary core markets plus, for soccer, at most one linked full-game TOTALS sibling. Token caps are unchanged. */
export function selectCoreCaptureMarkets<T extends CoreMarket>(universe: readonly T[], events: readonly PolymarketRawEvent[], family: string): T[] {
  const primary = selectPrimaryCoreMarkets(universe, events, family);
  const sibling = selectLinkedSoccerTotals(universe, events, family, primary);
  return sibling ? [...primary, sibling] : primary;
}

/**
 * All legs of one capture share a single poll-cycle `observed_at`; individual orderbook acquisition instants are
 * not persisted. Synchronization is therefore UNPROVEN unless every leg carries its own acquisition time and the
 * whole span is within the bound. Never assign a shared synthetic timestamp to satisfy this.
 */
export function assessLinkedQuoteSynchronization(legAcquiredAtMs: ReadonlyArray<number | null | undefined>, maxSpanMs: number): "BOUNDED" | "UNPROVEN" {
  if (legAcquiredAtMs.length < 2 || !Number.isFinite(maxSpanMs) || maxSpanMs < 0) return "UNPROVEN";
  const times = legAcquiredAtMs.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (times.length !== legAcquiredAtMs.length) return "UNPROVEN";
  return Math.max(...times) - Math.min(...times) <= maxSpanMs ? "BOUNDED" : "UNPROVEN";
}

export function decidePersistenceReason(input: {
  previous: { observed_at: string; mid_price: number | null; spread_abs: number | null; state_phase: string | null; event_live_status: string } | null;
  nowMs: number; mid: number | null; spread: number | null; state: StructuredState;
}): "LIVE_OPEN" | "STATE_CHANGE" | "PRICE_MOVE" | "SPREAD_MOVE" | "HEARTBEAT" | "FINAL_STATE" | null {
  const p = input.previous;
  if (!p) return input.state.eventLiveStatus === "FINAL" ? "FINAL_STATE" : "LIVE_OPEN";
  if (input.state.eventLiveStatus === "FINAL") return p.event_live_status === "FINAL" ? null : "FINAL_STATE";
  if (p.state_phase !== input.state.phase || p.event_live_status !== input.state.eventLiveStatus) return "STATE_CHANGE";
  if (p.mid_price !== null && input.mid !== null && Math.abs(input.mid - p.mid_price) >= 0.02 - 1e-9) return "PRICE_MOVE";
  if (p.spread_abs !== null && input.spread !== null && Math.abs(input.spread - p.spread_abs) >= 0.01 - 1e-9) return "SPREAD_MOVE";
  if (input.nowMs - Date.parse(p.observed_at) >= HEARTBEAT_MS) return "HEARTBEAT";
  return null;
}

type Client = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };
type LastRow = { observed_at: string; mid_price: number | null; spread_abs: number | null; state_phase: string | null; event_live_status: string };

/** A single message/poll captures at most one physical game and sixteen tokens. */
export async function captureInplayCorePath(raw: SportsState, db: Client, nowMs = Date.now(), isLive: () => boolean = () => true, stateReceivedAtMs?: number): Promise<number> {
  const state = deriveStructuredState(raw);
  if (!state || !isLive()) return 0;
  const events = await fetchPolymarketEventsByGameId(state.gameId);
  if (!events || !isLive()) return 0;
  const admitted = admitPhysicalEvent(events, state);
  if (!admitted) return 0;
  const { event, family, start } = admitted;
  if (nowMs < Date.parse(start) - 5 * 60_000 || nowMs >= Date.parse(start) + 47 * 60 * 60_000) return 0;
  const own = await defaultExactEventReader(String(event.id), start);
  if (!isLive()) return 0;
  const discovered = await defaultGameEventsReader(state.gameId, start);
  if (!isLive()) return 0;
  const universe = sameGameLiveUniverse(state.gameId, start, own, discovered);
  if (universe.audit.audit_overflow || !universe.eventSetsComplete) return 0;
  const markets = selectCoreCaptureMarkets(universe.markets, events, family);
  const inventory = inventoryTokens(markets);
  if (inventory.missingIdentity || inventory.tokens.length === 0 || inventory.tokens.length > MAX_TRACKED_TOKENS_PER_EVENT) return 0;
  const tokens = inventory.tokens;
  const physicalEventId = physicalMatchId({ gameId: state.gameId, eventId: String(event.id), eventStartIso: start });
  const prior = await db.from(TABLE).select("token_id,observed_at,mid_price,spread_abs,state_phase,event_live_status")
    .eq("physical_event_id", physicalEventId)
    .order("observed_at", { ascending: false }).limit(MAX_PERSISTED_OBSERVATIONS_PER_EVENT);
  if (prior.error) throw new Error(`INPLAY_PRIOR_READ:${prior.error.message}`);
  if (!isLive()) return 0;
  const rows = (prior.data ?? []) as Array<LastRow & { token_id: string }>;
  if (rows.length >= MAX_PERSISTED_OBSERVATIONS_PER_EVENT) return 0;
  if (state.eventLiveStatus === "LIVE" && rows.length >= MAX_PERSISTED_OBSERVATIONS_PER_EVENT - MAX_TRACKED_TOKENS_PER_EVENT) return 0;
  const last = new Map<string, LastRow>();
  for (const row of rows) if (!last.has(row.token_id)) last.set(row.token_id, row);
  const books = await fetchOrderBooksConcurrent(tokens.map((t) => t.tokenId), 5);
  if (!isLive()) return 0;
  const fees = await fetchFeeSchedulesBounded(tokens);
  if (!isLive()) return 0;
  const observedAt = new Date(nowMs).toISOString();
  const sport = deriveSportState(raw, family, state.eventLiveStatus, stateReceivedAtMs, nowMs);
  let saved = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!isLive()) return saved;
    const token = tokens[i];
    const result = books[i];
    const book = result?.ok ? result.book : null;
    const mid = computeMidPrice(book);
    const spread = computeSpread(book);
    const reason = decidePersistenceReason({ previous: last.get(token.tokenId) ?? null, nowMs, mid, spread, state });
    if (!reason) continue;
    const { bestBid, bestAsk } = getBestBidAsk(book);
    const depth = computeDepthWithinPct(book, 0.02);
    const exec = buildExecutableSiblingColumns({ token, result, fee: fees.get(token.tokenId) ?? null });
    const shares = typeof exec.full_stake_shares === "number" ? exec.full_stake_shares : null;
    const exit = book && shares !== null ? computeExecutableExit(book.bids, shares, 0.02) : null;
    const market = admitResearchMarket(family, token.market.sports_market_type, token.market.provider_market_slug);
    const row = {
      id: stableTelemetryId(physicalEventId, token.tokenId, observedAt, reason),
      physical_event_id: physicalEventId, provider_game_id: state.gameId, provider_event_id: String(event.id),
      provider_sport_family: family, provider_sport_code: state.sportCode, provider_sport_source: "gamma_event_structured_tag",
      event_start_iso: start, observed_at: observedAt, source_version: SOURCE_VERSION,
      event_live_status: state.eventLiveStatus, state_authority: "SPORTS_WS_STRUCTURED_STATUS", state_phase: state.phase,
      state_period_num: sport.periodNum, state_clock_seconds_remaining: null, state_clock_seconds_elapsed: sport.clockSecondsElapsed,
      side_a_score: sport.sideAScore, side_b_score: sport.sideBScore, state_received_at: sport.receivedAt,
      side_a_red_cards: null, side_b_red_cards: null,
      condition_id: token.conditionId, token_id: token.tokenId, side: token.side,
      canonical_market_family: market.family, canonical_market_type: market.type,
      provider_market_type_raw: token.market.sports_market_type, market_slug: token.market.provider_market_slug,
      best_bid: bestBid, best_ask: bestAsk, mid_price: mid, spread_abs: spread,
      tick_size: book?.tickSize ?? null, minimum_order_size: book?.minimumOrderSize ?? null,
      bid_depth_relevant_usd: depth.bidDepthUsd, ask_depth_relevant_usd: exec.ask_depth_relevant_usd ?? null,
      full_stake_executable_vwap: exec.full_stake_executable_vwap ?? null,
      full_stake_shares: shares, full_stake_exit_vwap: exit?.fullyFilled ? exit.avgPrice : null,
      full_stake_exit_fully_filled: exit?.fullyFilled ?? null, taker_fee_usd: exec.taker_fee_usd ?? null,
      orderbook_fetch_status: result?.ok ? "SUCCESS" : "FAILED", persistence_reason: reason,
      sequence_in_event: 0, created_at: observedAt,
    };
    const write = await db.rpc("research_insert_inplay_core_path", { p_row: row });
    if (write.error) throw new Error(`INPLAY_WRITE:${write.error.message}`);
    if (write.data === true) saved++;
  }
  return saved;
}
