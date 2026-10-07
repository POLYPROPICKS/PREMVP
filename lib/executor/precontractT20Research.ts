// PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1
//
// OBSERVATIONAL RESEARCH TELEMETRY ONLY. This module is independent of Contract A, Reservation, rebalance selection,
// the Queue, stake, execution and Ireland. It never reads or writes night_event_reservations, reservation_* tables or
// the Queue, and nothing in the live path reads what it writes (public.research_precontract_t20_observations).
//
// Pre-contract source (proven first usable carrier): public.generated_signal_research_snapshots (isolated research
// snapshots written by the feed producer BEFORE any Contract A decision). Per row, diagnostics carries the exact
// provider event identity (providerEventContext.eventId / gameId), the structured provider sport identity
// (providerSportFamily / providerSportCode / providerSportSource) and parentEventVolume24hr.
// The daily universe is reduced to ONE record per physical event SERVER-SIDE (SQL function
// research_precontract_t20_event_candidates) before it reaches this module: no raw-row slice ever defines the cohort.
// No identity is inferred from titles, slugs or free text.
import type { RuntimeSupabaseClient } from "../constructor/bootstrap";
import { fetchOrderBooksConcurrent, type TokenFeeScheduleResult } from "../liquidity/polymarketClient";
import { getBestBidAsk } from "../liquidity/orderbookMath";
import { physicalMatchId } from "./contractADecisions";
import {
  classifyExactEventMarket, defaultExactEventReader, defaultGameEventsReader, inventoryTokens, sameGameLiveUniverse,
  stableTelemetryId, DISCOVERY_AUDIT_OVERFLOW,
} from "./reservationMarketBaseline";

export const PRECONTRACT_RESEARCH_SOURCE = "PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1";
export const RESEARCH_SOURCE_VERSION = "PRECONTRACT_T20_RESEARCH_V1";
export const RESEARCH_TABLE = "research_precontract_t20_observations";
export const RESEARCH_SOURCE_TABLE = "generated_signal_research_snapshots";
/** Existing persisted phase label shared code requires; business meaning is T20. */
export const RESEARCH_OBSERVATION_PHASE = "T_MINUS_10";

export const MAX_RESEARCH_EVENTS_PER_DAY = 100;
export const SOCCER_QUOTA = 40;
export const TENNIS_QUOTA = 20;
export const OTHER_QUOTA = 40;
export const OTHER_DIVERSITY_FLOOR_PER_SPORT = 4;
export const MAX_RESEARCH_TOKEN_ROWS_PER_EVENT = 128;
export const MAX_NEW_EVENTS_PER_TICK = 5;
export const RESEARCH_TICK_BUDGET_MS = 8_000;
export const PRODUCTION_RETENTION_DAYS = 7;
export const RETENTION_DELETE_BATCH = 1_000;
/** Defensive EVENT-level ceiling (never a raw-row slice). Above it the day fails closed with an explicit diagnostic. */
export const EVENT_UNIVERSE_CEILING = 800;
/** Business T20: 9 < minutes_to_start <= 20. */
export const T20_MIN_EXCLUSIVE = 9;
export const T20_MAX_INCLUSIVE = 20;

export const OTHER_SPORT_FAMILIES = ["basketball", "baseball", "hockey", "cricket", "american-football"] as const;
export const TARGET_SPORT_FAMILIES = ["soccer", "tennis", ...OTHER_SPORT_FAMILIES] as const;
export type ResearchSportFamily = typeof TARGET_SPORT_FAMILIES[number];
export const AMERICAN_FOOTBALL_FAMILY = "american-football";
export const AMERICAN_FOOTBALL_NOT_PROVEN = "AMERICAN_FOOTBALL_STRUCTURED_IDENTITY_NOT_PROVEN";
const STRUCTURED_SPORT_SOURCE = "structured_sports_tag";
/** Exact structured provider CODE that proves American football when no structured family is present (research only). */
export const NFL_STRUCTURED_SPORT_CODE = "nfl";
/** Full-event spread/total cannot be proven from structured provider metadata for these families: MONEYLINE only. */
const MONEYLINE_ONLY_FAMILIES: ReadonlySet<string> = new Set(["tennis", "cricket"]);

export type SamplingBucket = "SOCCER" | "TENNIS" | "OTHER_DIVERSITY_FLOOR" | "OTHER_LIQUIDITY_FILL" | "GLOBAL_BACKFILL";

/**
 * One physical-event candidate, produced server-side by public.research_precontract_t20_event_candidates from the newest
 * snapshot run of that event. `*_n` are distinct-value counts inside that run (contradiction evidence).
 */
export type ResearchEventCandidateRow = {
  provider_event_id: string;
  provider_game_id: string | null;
  event_start_iso: string;
  snapshot_run_id: string;
  snapshot_at: string;
  provider_sport_family: string | null;
  provider_sport_family_n: number | string | null;
  provider_sport_code: string | null;
  provider_sport_code_n: number | string | null;
  provider_sport_source: string | null;
  provider_sport_source_n: number | string | null;
  parent_event_volume_24h: number | string | null;
  volume_contradiction: boolean | null;
};

export type ResearchEvent = {
  physicalEventId: string;
  providerEventId: string;
  providerGameId: string | null;
  eventStartIso: string;
  sportFamily: string | null;
  sportCode: string | null;
  sportSource: string | null;
  volume: number | null;
  volumeContradiction: boolean;
  sourceId: string;
};

const str = (v: unknown): string | null => typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const finiteNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Research-only sport family. A contradictory structured family is unresolved identity (null). When NO structured
 * family exists, the exact structured provider CODE `nfl` from `structured_sports_tag` (and nothing else) proves
 * American football. The provider code itself is persisted unchanged; score ownership is never consulted.
 */
export function resolveResearchSportFamily(input: {
  family: string | null; familyN: number; code: string | null; codeN: number; source: string | null; sourceN: number;
}): string | null {
  if (input.familyN > 1) return null;
  if (input.familyN === 1) return input.family ? input.family.toLowerCase() : null;
  if (input.codeN === 1 && input.sourceN === 1 && input.source === STRUCTURED_SPORT_SOURCE
    && input.code !== null && input.code.toLowerCase() === NFL_STRUCTURED_SPORT_CODE) return AMERICAN_FOOTBALL_FAMILY;
  return null;
}

/**
 * Candidate rows -> ResearchEvent. The SQL function already emits one row per physical event; a duplicate physical id
 * (identity-rule drift) is collapsed defensively to the newest snapshot, never counted twice.
 */
export function buildResearchEvents(rows: readonly ResearchEventCandidateRow[]): ResearchEvent[] {
  const byEvent = new Map<string, { event: ResearchEvent; snapshotAt: string }>();
  for (const row of rows) {
    const eventId = str(row.provider_event_id);
    const start = str(row.event_start_iso);
    if (!eventId || !start || !Number.isFinite(Date.parse(start))) continue;
    const eventStartIso = new Date(start).toISOString();
    const gameId = str(row.provider_game_id);
    const physicalEventId = physicalMatchId({ eventId, eventStartIso, gameId });
    const familyN = finiteNum(row.provider_sport_family_n) ?? 0;
    const codeN = finiteNum(row.provider_sport_code_n) ?? 0;
    const sourceN = finiteNum(row.provider_sport_source_n) ?? 0;
    const code = codeN === 1 ? str(row.provider_sport_code) : null;
    const sportSource = sourceN === 1 ? str(row.provider_sport_source) : null;
    const event: ResearchEvent = {
      physicalEventId, providerEventId: eventId, providerGameId: gameId, eventStartIso,
      sportFamily: resolveResearchSportFamily({ family: str(row.provider_sport_family), familyN, code, codeN, source: sportSource, sourceN }),
      sportCode: code, sportSource,
      volume: row.volume_contradiction === true ? null : finiteNum(row.parent_event_volume_24h),
      volumeContradiction: row.volume_contradiction === true,
      sourceId: `${RESEARCH_SOURCE_TABLE}:${row.snapshot_run_id}`,
    };
    const prior = byEvent.get(physicalEventId);
    if (!prior || row.snapshot_at > prior.snapshotAt) byEvent.set(physicalEventId, { event, snapshotAt: row.snapshot_at });
  }
  return [...byEvent.values()].map((v) => v.event);
}

/** parentEventVolume24hr DESC, event_start_iso ASC, physical_event_id ASC. */
export function compareLiquidity(a: ResearchEvent, b: ResearchEvent): number {
  return (b.volume ?? 0) - (a.volume ?? 0)
    || Date.parse(a.eventStartIso) - Date.parse(b.eventStartIso)
    || (a.physicalEventId < b.physicalEventId ? -1 : a.physicalEventId > b.physicalEventId ? 1 : 0);
}

/** American football is admitted ONLY with an exact structured provider family; never from text. */
export function isAdmittedTargetSport(event: Pick<ResearchEvent, "sportFamily" | "sportSource">): boolean {
  const family = event.sportFamily;
  if (!family || !(TARGET_SPORT_FAMILIES as readonly string[]).includes(family)) return false;
  if (family === AMERICAN_FOOTBALL_FAMILY) return event.sportSource === STRUCTURED_SPORT_SOURCE;
  return true;
}

export type CohortSelection = { event: ResearchEvent; bucket: SamplingBucket; rank: number };
export type CohortDiagnostics = {
  eligible_event_n: number;
  eligible_by_sport: Record<string, number>;
  volume_known_event_n: number;
  volume_unknown_event_n: number;
  volume_contradiction_event_n: number;
  soccer_selected_n: number; tennis_selected_n: number;
  basketball_selected_n: number; baseball_selected_n: number; hockey_selected_n: number;
  cricket_selected_n: number; american_football_selected_n: number;
  soccer_quota_underfill_n: number; tennis_quota_underfill_n: number; other_quota_underfill_n: number;
  other_diversity_floor_n: number; other_liquidity_fill_n: number; global_backfill_n: number;
  american_football_identity_state: "ADMITTED" | typeof AMERICAN_FOOTBALL_NOT_PROVEN;
};

/**
 * Daily 40/20/40 cohort. Pure and deterministic. Inputs are already physical-event-deduplicated. Membership depends
 * ONLY on structured sport identity and parentEventVolume24hr: no Contract A / model score / Reservation input exists.
 */
export function selectResearchCohort(events: readonly ResearchEvent[]): { selected: CohortSelection[]; diagnostics: CohortDiagnostics } {
  const contradictions = events.filter((e) => e.volumeContradiction);
  const withVolume = events.filter((e) => !e.volumeContradiction && e.volume !== null);
  const eligible = withVolume.filter(isAdmittedTargetSport).sort(compareLiquidity);
  const rankOf = new Map(eligible.map((e, i) => [e.physicalEventId, i + 1]));
  const byFamily = (family: string) => eligible.filter((e) => e.sportFamily === family);
  const taken = new Set<string>();
  const selected: CohortSelection[] = [];
  const take = (e: ResearchEvent, bucket: SamplingBucket) => {
    if (taken.has(e.physicalEventId)) return;
    taken.add(e.physicalEventId);
    selected.push({ event: e, bucket, rank: rankOf.get(e.physicalEventId) ?? 0 });
  };

  byFamily("soccer").slice(0, SOCCER_QUOTA).forEach((e) => take(e, "SOCCER"));
  byFamily("tennis").slice(0, TENNIS_QUOTA).forEach((e) => take(e, "TENNIS"));
  const soccerN = selected.filter((s) => s.bucket === "SOCCER").length;
  const tennisN = selected.filter((s) => s.bucket === "TENNIS").length;

  const otherPool = eligible.filter((e) => (OTHER_SPORT_FAMILIES as readonly string[]).includes(e.sportFamily ?? ""));
  let floorN = 0;
  for (const family of OTHER_SPORT_FAMILIES) {
    for (const e of otherPool.filter((o) => o.sportFamily === family).slice(0, OTHER_DIVERSITY_FLOOR_PER_SPORT)) {
      if (floorN >= OTHER_QUOTA) break;
      take(e, "OTHER_DIVERSITY_FLOOR"); floorN++;
    }
  }
  let fillN = 0;
  for (const e of otherPool) {
    if (floorN + fillN >= OTHER_QUOTA) break;
    if (taken.has(e.physicalEventId)) continue;
    take(e, "OTHER_LIQUIDITY_FILL"); fillN++;
  }
  const otherN = floorN + fillN;
  const soccerUnder = SOCCER_QUOTA - soccerN;
  const tennisUnder = TENNIS_QUOTA - tennisN;
  const otherUnder = OTHER_QUOTA - otherN;

  // Unused capacity goes to the remaining eligible target sports by GLOBAL liquidity order, never invented.
  let backfillN = 0;
  const spare = soccerUnder + tennisUnder + otherUnder;
  for (const e of eligible) {
    if (backfillN >= spare) break;
    if (taken.has(e.physicalEventId)) continue;
    take(e, "GLOBAL_BACKFILL"); backfillN++;
  }
  const final = selected.slice(0, MAX_RESEARCH_EVENTS_PER_DAY);
  const count = (family: string) => final.filter((s) => s.event.sportFamily === family).length;
  const eligibleBySport: Record<string, number> = {};
  for (const e of eligible) eligibleBySport[e.sportFamily as string] = (eligibleBySport[e.sportFamily as string] ?? 0) + 1;
  return {
    selected: final,
    diagnostics: {
      eligible_event_n: eligible.length, eligible_by_sport: eligibleBySport,
      volume_known_event_n: withVolume.length,
      volume_unknown_event_n: events.filter((e) => !e.volumeContradiction && e.volume === null).length,
      volume_contradiction_event_n: contradictions.length,
      soccer_selected_n: count("soccer"), tennis_selected_n: count("tennis"),
      basketball_selected_n: count("basketball"), baseball_selected_n: count("baseball"), hockey_selected_n: count("hockey"),
      cricket_selected_n: count("cricket"), american_football_selected_n: count(AMERICAN_FOOTBALL_FAMILY),
      soccer_quota_underfill_n: soccerUnder, tennis_quota_underfill_n: tennisUnder, other_quota_underfill_n: otherUnder,
      other_diversity_floor_n: floorN, other_liquidity_fill_n: fillN, global_backfill_n: backfillN,
      american_football_identity_state: eligibleBySport[AMERICAN_FOOTBALL_FAMILY] ? "ADMITTED" : AMERICAN_FOOTBALL_NOT_PROVEN,
    },
  };
}

/** MONEYLINE / SPREAD / TOTAL via the existing full-event authority; TOTAL_CORNERS only for soccer (exact full match). */
export function admitResearchMarket(family: string | null, rawType: unknown, slug: unknown): { admitted: boolean; family: string; type: string } {
  const market = classifyExactEventMarket(rawType, slug);
  const base = { family: market.family, type: market.type };
  if (market.type === "MONEYLINE") return { admitted: true, ...base };
  if (family && MONEYLINE_ONLY_FAMILIES.has(family)) return { admitted: false, ...base };
  if (market.type === "SPREAD" || market.type === "TOTAL") return { admitted: true, ...base };
  if (market.type === "TOTAL_CORNERS") return { admitted: family === "soccer", ...base };
  return { admitted: false, ...base };
}

export function minutesToStart(eventStartIso: string, nowMs: number): number {
  return (Date.parse(eventStartIso) - nowMs) / 60_000;
}
export function inT20Window(eventStartIso: string, nowMs: number): boolean {
  const m = minutesToStart(eventStartIso, nowMs);
  return m > T20_MIN_EXCLUSIVE && m <= T20_MAX_INCLUSIVE;
}

type FetchBooks = typeof fetchOrderBooksConcurrent;
type FeeFetcher = (tokenId: string, opts: { timeoutMs: number }) => Promise<TokenFeeScheduleResult>;
type Market = Parameters<typeof inventoryTokens>[0][number];

export type EventCaptureOutcome =
  | { kind: "CAPTURED"; rows: Record<string, unknown>[]; unsupported: Record<string, number> }
  | { kind: "TOKEN_BUDGET_EXCEEDED"; unsupported: Record<string, number> }
  | { kind: "FAILED"; reason: string; unsupported: Record<string, number> };

export type ResearchCaptureDeps = {
  readExactEvent?: (providerEventId: string, eventStartIso: string) => Promise<Market[]>;
  readGameEvents?: (gameId: string, eventStartIso: string) => Promise<Market[]>;
  fetchBooks?: FetchBooks;
  fetchFeeSchedule?: FeeFetcher;
  /** Cooperative deadline: once it returns false no NEW provider/DB request is started and the capture is abandoned. */
  isLive?: () => boolean;
};
export const RESEARCH_DEADLINE_EXPIRED = "RESEARCH_DEADLINE_EXPIRED";

/** One bounded event capture: exact event -> same-game full-event universe -> admitted tokens -> books -> scalar rows. */
export async function captureResearchEvent(
  selection: CohortSelection, observedAt: string, deps: ResearchCaptureDeps = {},
): Promise<EventCaptureOutcome> {
  const { event } = selection;
  const unsupported: Record<string, number> = {};
  const live = () => deps.isLive ? deps.isLive() : true;
  const expired = (): EventCaptureOutcome => ({ kind: "FAILED", reason: RESEARCH_DEADLINE_EXPIRED, unsupported });
  let markets: Market[] = [];
  try {
    if (!live()) return expired();
    const own = await (deps.readExactEvent ?? defaultExactEventReader)(event.providerEventId, event.eventStartIso);
    if (!live()) return expired();
    const gameIds = new Set(own.map((m) => m.provider_game_id).filter((g): g is string => !!g));
    if (own.length === 0 || gameIds.size !== 1) return { kind: "FAILED", reason: "EVENT_GAME_IDENTITY_UNRESOLVED", unsupported };
    const gameId = [...gameIds][0];
    if (event.providerGameId && event.providerGameId !== gameId) return { kind: "FAILED", reason: "EVENT_GAME_IDENTITY_CONTRADICTION", unsupported };
    const discovered = await (deps.readGameEvents ?? defaultGameEventsReader)(gameId, event.eventStartIso);
    if (!live()) return expired();
    const universe = sameGameLiveUniverse(gameId, event.eventStartIso, own, discovered);
    if (universe.audit.audit_overflow) return { kind: "FAILED", reason: DISCOVERY_AUDIT_OVERFLOW, unsupported };
    markets = universe.markets;
  } catch {
    return { kind: "FAILED", reason: "EVENT_MARKET_SET_UNAVAILABLE", unsupported };
  }
  const admittedMarkets = markets.filter((m) => {
    const verdict = admitResearchMarket(event.sportFamily, m.sports_market_type, m.provider_market_slug);
    if (!verdict.admitted) unsupported[verdict.type] = (unsupported[verdict.type] ?? 0) + 1;
    return verdict.admitted;
  });
  const { tokens } = inventoryTokens(admittedMarkets);
  if (tokens.length === 0) return { kind: "FAILED", reason: "NO_ADMISSIBLE_TOKENS", unsupported };
  // Never truncate: an over-budget event fails closed.
  if (tokens.length > MAX_RESEARCH_TOKEN_ROWS_PER_EVENT) return { kind: "TOKEN_BUDGET_EXCEEDED", unsupported };
  if (!live()) return expired();
  const telemetry = await import("./t10ExecutableSiblingTelemetry").catch(() => null);
  if (!live()) return expired();
  const [books, fees] = await Promise.all([
    (deps.fetchBooks ?? fetchOrderBooksConcurrent)(tokens.map((t) => t.tokenId), 5),
    telemetry
      ? Promise.resolve().then(() => telemetry.fetchFeeSchedulesBounded(tokens, { fetchFee: deps.fetchFeeSchedule })).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!live()) return expired();
  const rows = tokens.map((token, i) => {
    const result = books[i];
    const book = result?.ok ? result.book : null;
    const { bestBid, bestAsk } = getBestBidAsk(book);
    const market = admitResearchMarket(event.sportFamily, token.market.sports_market_type, token.market.provider_market_slug);
    let exec: Record<string, unknown> = {};
    try {
      exec = telemetry?.buildExecutableSiblingColumns({ token, result, fee: fees === null ? { ok: false as const, tokenId: token.tokenId, errorCode: "FEE_LEG_UNAVAILABLE", latencyMs: 0 } : fees.get(token.tokenId) ?? null }) ?? {};
    } catch { exec = {}; }
    return {
      id: stableTelemetryId(event.physicalEventId, token.conditionId, token.tokenId, token.side),
      physical_event_id: event.physicalEventId, provider_game_id: event.providerGameId, provider_event_id: event.providerEventId,
      source_id: event.sourceId, source_version: RESEARCH_SOURCE_VERSION,
      event_start_iso: event.eventStartIso, observed_at: observedAt, observation_phase: RESEARCH_OBSERVATION_PHASE,
      parent_event_volume_24h: event.volume, daily_volume_rank: selection.rank, sampling_bucket: selection.bucket,
      provider_sport_family: event.sportFamily, provider_sport_code: event.sportCode, provider_sport_source: event.sportSource,
      condition_id: token.conditionId, token_id: token.tokenId, side: token.side,
      canonical_market_family: market.family, canonical_market_type: market.type,
      provider_market_type_raw: token.market.sports_market_type, market_slug: token.market.provider_market_slug,
      best_bid: bestBid, best_ask: bestAsk, tick_size: book?.tickSize ?? null, minimum_order_size: book?.minimumOrderSize ?? null,
      orderbook_fetch_status: result?.ok ? "SUCCESS" : "FAILED",
      requested_stake_usd: exec.requested_stake_usd ?? null, execution_price_cap: exec.execution_price_cap ?? null,
      ask_depth_relevant_usd: exec.ask_depth_relevant_usd ?? null, full_stake_executable_vwap: exec.full_stake_executable_vwap ?? null,
      full_stake_shares: exec.full_stake_shares ?? null, executable_full_stake: exec.executable_full_stake ?? null,
      executable_full_stake_state: exec.executable_full_stake_state ?? null,
      taker_fee_state: exec.taker_fee_state ?? null, taker_fee_usd: exec.taker_fee_usd ?? null,
    };
  });
  return { kind: "CAPTURED", rows, unsupported };
}

export type ResearchStore = {
  /**
   * ONE row per physical event starting inside [fromIso, toIso), aggregated server-side. Returns at most
   * `ceiling + 1` rows: more than `ceiling` means the universe exceeds the defensive ceiling (caller fails closed).
   */
  loadEventCandidates(fromIso: string, toIso: string, ceiling: number): Promise<ResearchEventCandidateRow[]>;
  /** physical_event_ids of the given events that already carry a research snapshot. */
  capturedAmong(physicalEventIds: string[]): Promise<Set<string>>;
  /** Distinct physical events already captured for events starting inside the window. */
  capturedEventCount(fromIso: string, toIso: string): Promise<number>;
  writeRows(rows: Record<string, unknown>[]): Promise<void>;
  /** Deletes at most `limit` rows older than the cutoff; returns the number deleted. */
  purgeExpired(cutoffIso: string, limit: number): Promise<number>;
};

export function createResearchStore(getClient: () => RuntimeSupabaseClient | Promise<RuntimeSupabaseClient>): ResearchStore {
  return {
    async loadEventCandidates(fromIso, toIso, ceiling) {
      const client = await getClient();
      const { data, error } = await client.rpc("research_precontract_t20_event_candidates", { p_from: fromIso, p_to: toIso, p_ceiling: ceiling });
      if (error) throw new Error("RESEARCH_SOURCE_READ_FAILED");
      return (data ?? []) as unknown as ResearchEventCandidateRow[];
    },
    async capturedAmong(ids) {
      if (ids.length === 0) return new Set();
      const client = await getClient();
      const { data, error } = await client.from(RESEARCH_TABLE).select("physical_event_id")
        .in("physical_event_id", ids).limit(ids.length * MAX_RESEARCH_TOKEN_ROWS_PER_EVENT);
      if (error) throw new Error("RESEARCH_CAPTURED_READ_FAILED");
      return new Set((data ?? []).map((r: { physical_event_id: string }) => r.physical_event_id));
    },
    async capturedEventCount(fromIso, toIso) {
      const client = await getClient();
      const { data, error } = await client.from(RESEARCH_TABLE).select("physical_event_id")
        .gte("event_start_iso", fromIso).lt("event_start_iso", toIso)
        .limit(MAX_RESEARCH_EVENTS_PER_DAY * MAX_RESEARCH_TOKEN_ROWS_PER_EVENT);
      if (error) throw new Error("RESEARCH_CAPTURED_COUNT_FAILED");
      return new Set((data ?? []).map((r: { physical_event_id: string }) => r.physical_event_id)).size;
    },
    async writeRows(rows) {
      const client = await getClient();
      const { error } = await client.from(RESEARCH_TABLE)
        .upsert(rows, { onConflict: "physical_event_id,condition_id,token_id,side", ignoreDuplicates: true });
      if (error) throw new Error("RESEARCH_WRITE_FAILED");
    },
    async purgeExpired(cutoffIso, limit) {
      const client = await getClient();
      const { data, error } = await client.from(RESEARCH_TABLE).select("id")
        .lt("observed_at", cutoffIso).order("observed_at").limit(Math.min(limit, RETENTION_DELETE_BATCH));
      if (error) throw new Error("RESEARCH_PURGE_READ_FAILED");
      const ids = (data ?? []).map((r: { id: string }) => r.id);
      if (ids.length === 0) return 0;
      const { error: delError } = await client.from(RESEARCH_TABLE).delete().in("id", ids);
      if (delError) throw new Error("RESEARCH_PURGE_DELETE_FAILED");
      return ids.length;
    },
  };
}

export type ResearchTickResult = {
  status: "success" | "empty" | "error";
  diagnostics: Record<string, unknown>;
};

function utcDayBounds(ms: number): { fromIso: string; toIso: string } {
  const start = Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
  return { fromIso: new Date(start).toISOString(), toIso: new Date(start + 86_400_000).toISOString() };
}

export type ResearchTickDeps = ResearchCaptureDeps & {
  store: ResearchStore;
  writeJobRun?: (input: {
    source: string; formulaVersion: string; startedAt: string; finishedAt: string; status: "success" | "empty" | "error";
    generatedCount: number; rejectedCount: number; durationMs: number; errorMessage?: string; diagnostics?: Record<string, unknown>;
  }) => Promise<void>;
  budgetMs?: number;
  /** Test seam only: defaults to captureResearchEvent. */
  capture?: (selection: CohortSelection, observedAt: string, deps: ResearchCaptureDeps) => Promise<EventCaptureOutcome>;
};

/**
 * One best-effort research tick. NEVER throws and never touches Contract A / Reservation / Queue: on any failure or
 * timeout it records aggregate evidence and returns.
 *
 * Deadline: ONE monotonic authority (performance.now) latched by the timeout timer. It is checked before every new
 * async operation and immediately after every await, so after expiry nothing new starts (no event capture, provider
 * request, research DB write or retention delete) and a late in-flight result is discarded without being processed.
 * An already-issued bounded request may finish internally; its result is ignored.
 */
export async function runPrecontractT20ResearchTick(nowMs: number, deps: ResearchTickDeps): Promise<ResearchTickResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const budgetMs = deps.budgetMs ?? RESEARCH_TICK_BUDGET_MS;
  const t0 = performance.now();
  let expiredLatch = false;
  const live = () => !expiredLatch && performance.now() - t0 < budgetMs;
  const remaining = () => budgetMs - (performance.now() - t0);
  const counters = {
    captured_event_n: 0, already_captured_event_n: 0, failed_event_n: 0, token_rows_written_n: 0,
    token_budget_exceeded_event_n: 0, purged_row_n: 0, event_universe_ceiling_exceeded_day_n: 0,
  };
  const unsupportedCounts: Record<string, number> = {};
  let cohortDiagnostics: Record<string, unknown> = {};
  let status: "success" | "empty" | "error" = "empty";
  let errorMessage: string | undefined;
  const expire = () => { expiredLatch = true; status = "error"; errorMessage ??= "RESEARCH_TICK_TIMEOUT"; };
  const captureDeps: ResearchCaptureDeps = { ...deps, isLive: live };
  const capture = deps.capture ?? captureResearchEvent;

  const work = async () => {
    const days = new Map<string, { fromIso: string; toIso: string }>();
    for (const ms of [nowMs + (T20_MIN_EXCLUSIVE + 1) * 60_000, nowMs + T20_MAX_INCLUSIVE * 60_000]) {
      const bounds = utcDayBounds(ms);
      days.set(bounds.fromIso, bounds);
    }
    let newEvents = 0;
    for (const bounds of days.values()) {
      if (newEvents >= MAX_NEW_EVENTS_PER_TICK || !live()) break;
      const candidates = await deps.store.loadEventCandidates(bounds.fromIso, bounds.toIso, EVENT_UNIVERSE_CEILING);
      if (!live()) return expire();
      const dayKey = `day_${bounds.fromIso.slice(0, 10)}`;
      if (candidates.length > EVENT_UNIVERSE_CEILING) {
        // Fail closed: an incomplete universe must never be ranked as if it were the daily liquidity Top-100.
        counters.event_universe_ceiling_exceeded_day_n++;
        cohortDiagnostics = { ...cohortDiagnostics, event_universe_ceiling: EVENT_UNIVERSE_CEILING, [`${dayKey}_event_universe_ceiling_exceeded`]: true };
        continue;
      }
      const { selected, diagnostics } = selectResearchCohort(buildResearchEvents(candidates));
      cohortDiagnostics = days.size === 1
        ? { ...cohortDiagnostics, ...diagnostics, universe_event_n: candidates.length }
        : { ...cohortDiagnostics, [dayKey]: { ...diagnostics, universe_event_n: candidates.length } };
      const due = selected.filter((s) => inT20Window(s.event.eventStartIso, nowMs));
      if (due.length === 0) continue;
      const captured = await deps.store.capturedAmong(due.map((s) => s.event.physicalEventId));
      if (!live()) return expire();
      counters.already_captured_event_n += due.filter((s) => captured.has(s.event.physicalEventId)).length;
      const todo = due.filter((s) => !captured.has(s.event.physicalEventId)).sort((a, b) => compareLiquidity(a.event, b.event));
      if (todo.length === 0) continue;
      // Daily cap guard independent of cohort drift between ticks (fail-closed on read error).
      let dayCaptured = await deps.store.capturedEventCount(bounds.fromIso, bounds.toIso);
      if (!live()) return expire();
      for (const selection of todo) {
        if (newEvents >= MAX_NEW_EVENTS_PER_TICK || !live() || dayCaptured >= MAX_RESEARCH_EVENTS_PER_DAY) break;
        newEvents++;
        const outcome = await capture(selection, new Date(nowMs).toISOString(), captureDeps);
        // A capture that settles after the deadline is discarded: never counted, never written.
        if (!live()) return expire();
        for (const [type, n] of Object.entries(outcome.unsupported)) unsupportedCounts[type] = (unsupportedCounts[type] ?? 0) + n;
        if (outcome.kind === "TOKEN_BUDGET_EXCEEDED") { counters.token_budget_exceeded_event_n++; continue; }
        if (outcome.kind === "FAILED") { counters.failed_event_n++; continue; }
        try {
          await deps.store.writeRows(outcome.rows);
          if (!live()) return expire();
          counters.captured_event_n++; dayCaptured++;
          counters.token_rows_written_n += outcome.rows.length;
        } catch { if (!live()) return expire(); counters.failed_event_n++; }
      }
    }
    // Bounded retention: one capped purge call per tick, only while the deadline has not expired.
    if (live() && remaining() > 500) {
      const cutoff = new Date(nowMs - PRODUCTION_RETENTION_DAYS * 86_400_000).toISOString();
      const purged = await deps.store.purgeExpired(cutoff, RETENTION_DELETE_BATCH).catch(() => 0);
      if (!live()) return expire();
      counters.purged_row_n = purged;
    }
    status = counters.captured_event_n > 0 ? "success" : "empty";
    if (counters.event_universe_ceiling_exceeded_day_n > 0) { status = "error"; errorMessage = "RESEARCH_EVENT_UNIVERSE_CEILING_EXCEEDED"; }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { expiredLatch = true; errorMessage = "RESEARCH_TICK_TIMEOUT"; status = "error"; resolve(); }, budgetMs);
      }),
    ]);
  } catch (err) {
    expiredLatch = true;
    status = "error";
    errorMessage = err instanceof Error ? err.message.slice(0, 120) : "RESEARCH_TICK_FAILED";
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Whatever happens next, no straggler from this tick may start new work.
  expiredLatch = true;
  const durationMs = Date.now() - startedMs;
  const diagnostics = { ...cohortDiagnostics, ...counters, unsupported_market_type_counts: unsupportedCounts, duration_ms: durationMs };
  try {
    await deps.writeJobRun?.({
      source: PRECONTRACT_RESEARCH_SOURCE, formulaVersion: RESEARCH_SOURCE_VERSION, startedAt, finishedAt: new Date().toISOString(),
      status, generatedCount: counters.captured_event_n, rejectedCount: counters.failed_event_n + counters.token_budget_exceeded_event_n,
      durationMs, errorMessage, diagnostics,
    });
  } catch { /* evidence is best-effort */ }
  return { status, diagnostics };
}

/** Fail-soft live hook: swallows everything. The caller's result is never read from or altered by research. */
export async function runPrecontractT20ResearchFailSoft(
  nowMs: number, deps: ResearchTickDeps | (() => Promise<ResearchTickDeps>),
): Promise<void> {
  try {
    await runPrecontractT20ResearchTick(nowMs, typeof deps === "function" ? await deps() : deps);
  } catch {
    console.error("[precontract-t20-research] tick failed");
  }
}
