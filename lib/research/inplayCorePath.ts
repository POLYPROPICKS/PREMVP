// Research-only in-play facts. No consumer on the money path.
import { fetchPolymarketEventsByGameId, GAMMA_GAME_EVENTS_LIMIT } from "../feed/polymarketClient";
import type { PolymarketRawEvent } from "../feed/types";
import { fetchOrderBooksConcurrent } from "../liquidity/polymarketClient";
import { computeDepthWithinPct, computeExecutableExit, computeMidPrice, computeSpread, getBestBidAsk } from "../liquidity/orderbookMath";
import { physicalMatchId } from "../executor/contractADecisions";
import { defaultExactEventReader, defaultGameEventsReader, inventoryTokens, sameGameLiveUniverse, stableTelemetryId } from "../executor/reservationMarketBaseline";
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

export type SportsState = { gameId?: unknown; live?: unknown; ended?: unknown; status?: unknown; period?: unknown; score?: unknown; leagueAbbreviation?: unknown };
export type StructuredState = { gameId: string; eventLiveStatus: "LIVE" | "FINAL"; phase: string | null; sportCode: string | null };

/** The sports socket's score is a formatted string; it is never parsed into numeric sides. */
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

/** One highest-volume condition per core family. Ties without a unique leader are excluded. */
export function selectPrimaryCoreMarkets<T extends { condition_id: string | null; sports_market_type: string | null; provider_market_slug: string | null }>(
  markets: readonly T[], events: readonly PolymarketRawEvent[], family: string,
): T[] {
  const volumes = new Map<string, number>();
  for (const event of events) for (const raw of event.markets ?? []) {
    const value = typeof raw.volume24hr === "number" && Number.isFinite(raw.volume24hr) ? raw.volume24hr
      : typeof raw.volume === "number" && Number.isFinite(raw.volume) ? raw.volume : null;
    if (raw.conditionId && value !== null) volumes.set(raw.conditionId, Math.max(value, volumes.get(raw.conditionId) ?? 0));
  }
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
export async function captureInplayCorePath(raw: SportsState, db: Client, nowMs = Date.now(), isLive: () => boolean = () => true): Promise<number> {
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
  const markets = selectPrimaryCoreMarkets(universe.markets, events, family);
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
      state_period_num: null, state_clock_seconds_remaining: null, side_a_score: null, side_b_score: null,
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
