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
import { fetchPolymarketEventStartsByIds, GAMMA_EVENTS_BATCH_LIMIT, type GammaEventStart, type GammaEventStartsBatch } from "../feed/polymarketClient";
import { physicalMatchId } from "./contractADecisions";
import {
  classifyExactEventMarket, defaultExactEventReader, defaultGameEventsReader, inventoryTokens, sameGameLiveUniverse,
  stableTelemetryId, DISCOVERY_AUDIT_OVERFLOW, PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS,
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
/**
 * SOFT start guard (cooperative, strictly inside the unchanged 8s HARD budget). A NEW event capture is started only if the
 * remaining tick budget covers (a) this floor, which is the existing per-call provider timeout authority
 * (t10ExecutableSiblingTelemetry FEE_FETCH_PER_CALL_TIMEOUT_MS = 2_500) so the first provider round-trip can complete, and
 * (b) the longest capture+write observed so far in THIS tick times the safety factor. Otherwise the event is left
 * uncaptured (SAFE_BUDGET_DEFER) and the next cron tick resumes it via capturedAmong() while it is still inside T20.
 */
export const SOFT_EVENT_START_MIN_REMAINING_MS = 2_500;
export const SOFT_EVENT_DURATION_SAFETY_FACTOR = 1.25;
export const PRODUCTION_RETENTION_DAYS = 7;
export const RETENTION_DELETE_BATCH = 1_000;
/** Defensive EVENT-level ceiling (never a raw-row slice). Above it the day fails closed with an explicit diagnostic. */
export const EVENT_UNIVERSE_CEILING = 800;
/** Business T20: 9 < minutes_to_start <= 20. */
export const T20_MIN_EXCLUSIVE = 9;
export const T20_MAX_INCLUSIVE = 20;
/**
 * Source-start band, in BOTH directions, inside which a selected event is reconciled against Gamma's CURRENT start before
 * T20 eligibility is decided. A rescheduled event is discoverable while its snapshot start lies within
 * (now + 9min - H, now + 20min + H]. Larger shifts are not recoverable here (fail closed; the snapshot start is the only lineage).
 */
export const T20_RESCHEDULE_HORIZON_MINUTES = 120;
/** A provider start is re-requested once it is older than this (bounds Gamma load; 8s ticks reuse it). */
export const PROVIDER_START_REFRESH_TTL_MS = 45_000;
/** A provider start older than this at decision time is STALE and cannot define T20 eligibility (fail closed). */
export const PROVIDER_START_MAX_AGE_MS = 90_000;
/** Hard provider bound per tick: batches x GAMMA_EVENTS_BATCH_LIMIT events (sent in parallel, one round trip). */
export const MAX_START_RECHECK_BATCHES_PER_TICK = 2;
/**
 * Hard sub-deadline of the whole provider-start phase (both parallel batches) inside the unchanged 8s tick. It is the existing
 * per-call provider timeout authority, so a slow/hung Gamma can never consume the budget the ordinary T20 captures need.
 */
export const PROVIDER_START_PHASE_BUDGET_MS = 2_500;
export const PROVIDER_START_SOURCE = "gamma_events_batch:startTime";
/** Only when Gamma states no startTime and its endDate/endDateIso equals the snapshot start (the exact reader's legacy match). */
export const PROVIDER_START_SOURCE_LEGACY = "gamma_events_batch:endDate_legacy_match";
const CAPTURED_MEMO_CEILING = 5_000;
const START_CACHE_PRUNE_AGE_MS = 600_000;

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
  /**
   * Verified CURRENT provider start. `eventStartIso` (and `physicalEventId`, `sourceId`) stay the immutable snapshot lineage;
   * this is stored separately and decides ONLY the actual T20 window. Absent = never reconciled (capture uses the snapshot start).
   */
  providerStart?: ProviderStartEvidence | null;
};

export type ProviderStartEvidence = { startIso: string; acquiredAtMs: number; source: string };

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
export const RESEARCH_WRITE_FAILED = "RESEARCH_WRITE_FAILED";
/**
 * Exact-reader errors that name a distinct business cause. Anything else stays the generic EVENT_MARKET_SET_UNAVAILABLE,
 * so the aggregate failure-reason keys are a bounded, fixed set (never raw provider text).
 */
const TYPED_EXACT_READ_ERRORS: ReadonlySet<string> = new Set(["RESERVED_EVENT_START_MISMATCH", PHYSICAL_EVENT_GAME_DISCOVERY_AMBIGUOUS]);

/** One bounded event capture: exact event -> same-game full-event universe -> admitted tokens -> books -> scalar rows. */
export async function captureResearchEvent(
  selection: CohortSelection, observedAt: string, deps: ResearchCaptureDeps = {},
): Promise<EventCaptureOutcome> {
  const { event } = selection;
  // Provider reads (exact-event start check, same-game universe) use the verified CURRENT provider start; the persisted
  // lineage (physical id, event_start_iso, source_id) keeps the snapshot start.
  const readStartIso = event.providerStart?.startIso ?? event.eventStartIso;
  const unsupported: Record<string, number> = {};
  const live = () => deps.isLive ? deps.isLive() : true;
  const expired = (): EventCaptureOutcome => ({ kind: "FAILED", reason: RESEARCH_DEADLINE_EXPIRED, unsupported });
  let markets: Market[] = [];
  try {
    if (!live()) return expired();
    const own = await (deps.readExactEvent ?? defaultExactEventReader)(event.providerEventId, readStartIso);
    if (!live()) return expired();
    const gameIds = new Set(own.map((m) => m.provider_game_id).filter((g): g is string => !!g));
    // The provider authors no gameId for some MONEYLINE-only events (e.g. international cricket). physicalMatchId already
    // keys such an event on its provider event id, and only that event's own MONEYLINE can be admitted, so when neither
    // the source nor the exact event states a gameId the exact event's own markets are the complete admissible set.
    // Every other gameId-less event (any other family) still fails closed as unresolved.
    if (own.length > 0 && gameIds.size === 0 && !event.providerGameId && event.sportFamily && MONEYLINE_ONLY_FAMILIES.has(event.sportFamily)) {
      markets = own;
    } else {
      if (own.length === 0 || gameIds.size !== 1) return { kind: "FAILED", reason: "EVENT_GAME_IDENTITY_UNRESOLVED", unsupported };
      const gameId = [...gameIds][0];
      if (event.providerGameId && event.providerGameId !== gameId) return { kind: "FAILED", reason: "EVENT_GAME_IDENTITY_CONTRADICTION", unsupported };
      const discovered = await (deps.readGameEvents ?? defaultGameEventsReader)(gameId, readStartIso);
      if (!live()) return expired();
      const universe = sameGameLiveUniverse(gameId, readStartIso, own, discovered);
      if (universe.audit.audit_overflow) return { kind: "FAILED", reason: DISCOVERY_AUDIT_OVERFLOW, unsupported };
      markets = universe.markets;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return { kind: "FAILED", reason: TYPED_EXACT_READ_ERRORS.has(message) ? message : "EVENT_MARKET_SET_UNAVAILABLE", unsupported };
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
      provider_start_iso: event.providerStart?.startIso ?? null,
      provider_start_acquired_at: event.providerStart ? new Date(event.providerStart.acquiredAtMs).toISOString() : null,
      provider_start_source: event.providerStart?.source ?? null,
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


// ── Provider start reconciliation (TELEMETRY-08C) ─────────────────────────────────────────────────────────────────────
// The candidate universe is frozen at snapshot time, so a Gamma reschedule moves the ACTUAL T20 window away from the
// snapshot start. Before T20 eligibility is decided, every selected, uncaptured event whose snapshot start lies in the
// reschedule band is reconciled against Gamma's CURRENT event start, fetched by exact persisted provider event id in
// batches of <= GAMMA_EVENTS_BATCH_LIMIT. Cohort membership/rank stay source-based (never changed by provider state).

type StartEntry =
  | { ok: true; event: GammaEventStart; acquiredAtMs: number }
  | { ok: false; reason: string; attemptedAtMs: number };

/** Process-local reuse of recent provider starts and of already-captured physical ids. Correctness never depends on it. */
export type ResearchStartState = { starts: Map<string, StartEntry>; captured: Set<string> };
export const createResearchStartState = (): ResearchStartState => ({ starts: new Map(), captured: new Set() });
const DEFAULT_START_STATE = createResearchStartState();

export type FetchProviderStarts = (eventIds: string[]) => Promise<GammaEventStartsBatch | null>;

export const PROVIDER_START_REASONS = {
  BATCH_UNAVAILABLE: "PROVIDER_START_BATCH_UNAVAILABLE",
  BATCH_ANOMALY: "PROVIDER_START_BATCH_ANOMALY",
  EVENT_MISSING: "PROVIDER_START_EVENT_MISSING",
  IDENTITY_AMBIGUOUS: "PROVIDER_START_IDENTITY_AMBIGUOUS",
  IDENTITY_CONTRADICTION: "PROVIDER_START_IDENTITY_CONTRADICTION",
  STALE: "PROVIDER_START_STALE",
  UNVERIFIED: "PROVIDER_START_UNVERIFIED",
  MISSING: "PROVIDER_START_MISSING",
} as const;

/** Requested ids -> entries. A missing/duplicated id is that event's failure; an unrequested id poisons the whole batch. */
export function entriesFromBatch(ids: readonly string[], batch: GammaEventStartsBatch | null, attemptedAtMs: number): Map<string, StartEntry> {
  const out = new Map<string, StartEntry>();
  const fail = (id: string, reason: string) => out.set(id, { ok: false, reason, attemptedAtMs });
  if (!batch) { ids.forEach((id) => fail(id, PROVIDER_START_REASONS.BATCH_UNAVAILABLE)); return out; }
  const requested = new Set(ids);
  const byId = new Map<string, GammaEventStart[]>();
  for (const e of batch.events) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  if ([...byId.keys()].some((id) => !requested.has(id))) { ids.forEach((id) => fail(id, PROVIDER_START_REASONS.BATCH_ANOMALY)); return out; }
  for (const id of ids) {
    const found = byId.get(id) ?? [];
    if (found.length === 0) fail(id, PROVIDER_START_REASONS.EVENT_MISSING);
    else if (found.length > 1) fail(id, PROVIDER_START_REASONS.IDENTITY_AMBIGUOUS);
    else out.set(id, { ok: true, event: found[0], acquiredAtMs: batch.acquiredAtMs });
  }
  return out;
}

/**
 * One event's CURRENT provider start, or the exact reason it is unverified. `startTime` is the authority (live-proven equal to
 * every market's gameStartTime, i.e. to the value the snapshot froze). Never infers from titles, slugs or other fields.
 */
export function resolveProviderStart(
  sourceStartIso: string, sourceGameId: string | null, entry: StartEntry | undefined, nowMs: number,
): { ok: true; evidence: ProviderStartEvidence } | { ok: false; reason: string } {
  if (!entry) return { ok: false, reason: PROVIDER_START_REASONS.UNVERIFIED };
  if (!entry.ok) return { ok: false, reason: entry.reason };
  if (!(entry.acquiredAtMs >= nowMs - PROVIDER_START_MAX_AGE_MS)) return { ok: false, reason: PROVIDER_START_REASONS.STALE };
  const { event, acquiredAtMs } = entry;
  if (sourceGameId && event.gameId && sourceGameId.toLowerCase() !== event.gameId.toLowerCase()) {
    return { ok: false, reason: PROVIDER_START_REASONS.IDENTITY_CONTRADICTION };
  }
  const startMs = Date.parse(event.startTime ?? "");
  if (Number.isFinite(startMs)) return { ok: true, evidence: { startIso: new Date(startMs).toISOString(), acquiredAtMs, source: PROVIDER_START_SOURCE } };
  const sourceMs = Date.parse(sourceStartIso);
  if (!event.startTime && [event.endDate, event.endDateIso].some((v) => Date.parse(v ?? "") === sourceMs)) {
    return { ok: true, evidence: { startIso: new Date(sourceMs).toISOString(), acquiredAtMs, source: PROVIDER_START_SOURCE_LEGACY } };
  }
  return { ok: false, reason: PROVIDER_START_REASONS.MISSING };
}

/** Reasons meaning "Gamma gave no usable answer" (transport/timeout/deferral/age), as opposed to a content disagreement. */
const UNREACHED_PROVIDER_REASONS: ReadonlySet<string> = new Set([
  PROVIDER_START_REASONS.BATCH_UNAVAILABLE, PROVIDER_START_REASONS.UNVERIFIED, PROVIDER_START_REASONS.STALE,
]);

/** Stable provider identity of an event across physical ids (used to catch the same match under two UTC-day keys). */
export const providerIdentityKey = (e: Pick<ResearchEvent, "providerGameId" | "providerEventId">): string =>
  e.providerGameId ? `g:${e.providerGameId.toLowerCase()}` : `e:${e.providerEventId.toLowerCase()}`;
const physicalDate = (physicalEventId: string): string => physicalEventId.slice(-10);

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

/** Currently-due events: earliest event_start first (the one about to leave T20), then the existing liquidity tie-breaker. */
export function compareUrgency(a: ResearchEvent, b: ResearchEvent): number {
  const start = (e: ResearchEvent) => Date.parse(e.providerStart?.startIso ?? e.eventStartIso);
  return start(a) - start(b) || compareLiquidity(a, b);
}

export type ResearchTickDeps = ResearchCaptureDeps & {
  store: ResearchStore;
  writeJobRun?: (input: {
    source: string; formulaVersion: string; startedAt: string; finishedAt: string; status: "success" | "empty" | "error";
    generatedCount: number; rejectedCount: number; durationMs: number; errorMessage?: string; diagnostics?: Record<string, unknown>;
  }) => Promise<void>;
  budgetMs?: number;
  /** Minimum remaining budget required to start a NEW event (soft guard); defaults to SOFT_EVENT_START_MIN_REMAINING_MS. */
  softStartMinRemainingMs?: number;
  /** Gamma current-start batch fetch (<= GAMMA_EVENTS_BATCH_LIMIT ids); defaults to fetchPolymarketEventStartsByIds. */
  fetchProviderStarts?: FetchProviderStarts;
  /** Test seam: overrides PROVIDER_START_PHASE_BUDGET_MS. */
  providerStartPhaseBudgetMs?: number;
  /** Provider-start reuse + captured memo; defaults to a process-local singleton. Tests inject a fresh one. */
  startState?: ResearchStartState;
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
  const softMinRemainingMs = deps.softStartMinRemainingMs ?? SOFT_EVENT_START_MIN_REMAINING_MS;
  let longestEventMs = 0;
  let budgetDeferred = false;
  let hardTimeoutHit = false;
  /** Enough bounded runtime left to start (and likely finish) one more event capture + write? */
  const canStartEvent = () => remaining() >= Math.max(softMinRemainingMs, longestEventMs * SOFT_EVENT_DURATION_SAFETY_FACTOR);
  const counters = {
    due_event_n: 0, attempted_event_n: 0, deferred_budget_event_n: 0,
    captured_event_n: 0, already_captured_event_n: 0, failed_event_n: 0, token_rows_written_n: 0,
    token_budget_exceeded_event_n: 0, purged_row_n: 0, event_universe_ceiling_exceeded_day_n: 0,
    provider_start_batch_n: 0, provider_start_refresh_deferred_n: 0, provider_start_unverified_event_n: 0,
    provider_start_unchanged_event_n: 0, provider_start_rescheduled_event_n: 0, provider_start_rescheduled_into_window_event_n: 0,
    identity_ambiguous_event_n: 0, provider_start_cross_utc_day_event_n: 0, provider_start_phase_timeout_n: 0, provider_start_unreconciled_snapshot_window_event_n: 0,
  };
  let providerStartBatchLatencyMsMax = 0;
  /** Aggregate-only: provider-start failure reason -> events this tick (no ids, no payloads). */
  const providerStartFailureCounts: Record<string, number> = {};
  const rememberCaptured = (physicalEventId: string) => {
    const memo = (deps.startState ?? DEFAULT_START_STATE).captured;
    if (memo.size >= CAPTURED_MEMO_CEILING) memo.clear();
    memo.add(physicalEventId);
  };
  const unsupportedCounts: Record<string, number> = {};
  /** Aggregate-only: reason -> number of failed captures this tick (no event ids, no raw provider payloads). */
  const failedReasonCounts: Record<string, number> = {};
  const noteFailure = (reason: string) => { counters.failed_event_n++; failedReasonCounts[reason] = (failedReasonCounts[reason] ?? 0) + 1; };
  let cohortDiagnostics: Record<string, unknown> = {};
  let status: "success" | "empty" | "error" = "empty";
  let errorMessage: string | undefined;
  const expire = () => { expiredLatch = true; hardTimeoutHit = true; status = "error"; errorMessage ??= "RESEARCH_TICK_TIMEOUT"; };
  const captureDeps: ResearchCaptureDeps = { ...deps, isLive: live };
  const capture = deps.capture ?? captureResearchEvent;

  const work = async () => {
    // Source-start band: the snapshot start of any event that can be inside its ACTUAL T20 window now, given a provider
    // reschedule of up to +/- T20_RESCHEDULE_HORIZON_MINUTES. Each UTC day touched by the band is one existing RPC call.
    const horizonMs = T20_RESCHEDULE_HORIZON_MINUTES * 60_000;
    const bandFromMs = nowMs + T20_MIN_EXCLUSIVE * 60_000 - horizonMs;
    const bandToMs = nowMs + T20_MAX_INCLUSIVE * 60_000 + horizonMs;
    const inBand = (startIso: string) => { const t = Date.parse(startIso); return t > bandFromMs && t <= bandToMs; };
    const days = new Map<string, { fromIso: string; toIso: string }>();
    for (const ms of [bandFromMs, bandToMs]) {
      const bounds = utcDayBounds(ms);
      days.set(bounds.fromIso, bounds);
    }
    const state = deps.startState ?? DEFAULT_START_STATE;
    const dayCtxs: { bounds: { fromIso: string; toIso: string }; selected: CohortSelection[] }[] = [];
    const universe: ResearchEvent[] = [];
    // Phase 1: complete source-day universes and the source-based 40/20/40 cohort (provider state never changes them).
    for (const bounds of days.values()) {
      if (!live()) break;
      const candidates = await deps.store.loadEventCandidates(bounds.fromIso, bounds.toIso, EVENT_UNIVERSE_CEILING);
      if (!live()) return expire();
      const dayKey = `day_${bounds.fromIso.slice(0, 10)}`;
      if (candidates.length > EVENT_UNIVERSE_CEILING) {
        // Fail closed: an incomplete universe must never be ranked as if it were the daily liquidity Top-100.
        counters.event_universe_ceiling_exceeded_day_n++;
        cohortDiagnostics = { ...cohortDiagnostics, event_universe_ceiling: EVENT_UNIVERSE_CEILING, [`${dayKey}_event_universe_ceiling_exceeded`]: true };
        continue;
      }
      const events = buildResearchEvents(candidates);
      const { selected, diagnostics } = selectResearchCohort(events);
      cohortDiagnostics = days.size === 1
        ? { ...cohortDiagnostics, ...diagnostics, universe_event_n: candidates.length }
        : { ...cohortDiagnostics, [dayKey]: { ...diagnostics, universe_event_n: candidates.length } };
      dayCtxs.push({ bounds, selected });
      universe.push(...events);
    }

    // Phase 2: reconcile the CURRENT provider start of every selected, not-yet-captured event in the band BEFORE deciding
    // actual T20 eligibility. Events that cannot be verified are never due (fail closed).
    const identityGroups = new Map<string, Set<string>>();
    for (const e of universe) {
      const key = providerIdentityKey(e);
      identityGroups.set(key, (identityGroups.get(key) ?? new Set()).add(e.physicalEventId));
    }
    const bandSelections = dayCtxs.flatMap((d) => d.selected).filter((sel) => inBand(sel.event.eventStartIso) && !state.captured.has(sel.event.physicalEventId));
    const refreshable = bandSelections.filter((sel) => /^\d+$/.test(sel.event.providerEventId));
    const attemptedAt = (id: string) => { const e = state.starts.get(id); return e ? (e.ok ? e.acquiredAtMs : e.attemptedAtMs) : -Infinity; };
    const needsRefresh = refreshable
      .filter((sel) => attemptedAt(sel.event.providerEventId) < nowMs - PROVIDER_START_REFRESH_TTL_MS)
      .sort((a, b) => attemptedAt(a.event.providerEventId) - attemptedAt(b.event.providerEventId) || compareUrgency(a.event, b.event));
    const refreshIds = [...new Set(needsRefresh.map((sel) => sel.event.providerEventId))];
    const batchIds: string[][] = [];
    for (let i = 0; i < refreshIds.length && batchIds.length < MAX_START_RECHECK_BATCHES_PER_TICK; i += GAMMA_EVENTS_BATCH_LIMIT) batchIds.push(refreshIds.slice(i, i + GAMMA_EVENTS_BATCH_LIMIT));
    counters.provider_start_refresh_deferred_n += refreshIds.length - batchIds.reduce((n, ids) => n + ids.length, 0);
    // The whole provider phase has its own sub-deadline: on expiry (slow/hung Gamma) the late result is DISCARDED (never cached,
    // never used), no further request is started, and the ordinary captures below keep their budget.
    const phaseMs = Math.min(deps.providerStartPhaseBudgetMs ?? PROVIDER_START_PHASE_BUDGET_MS, remaining() - softMinRemainingMs);
    if (batchIds.length > 0 && live()) {
      if (phaseMs > 0) {
        const fetchStarts = deps.fetchProviderStarts ?? fetchPolymarketEventStartsByIds;
        let phaseTimer: ReturnType<typeof setTimeout> | undefined;
        const results = await Promise.race([
          Promise.all(batchIds.map((ids) => Promise.resolve().then(() => fetchStarts(ids)).catch(() => null))),
          new Promise<null>((resolve) => { phaseTimer = setTimeout(() => resolve(null), phaseMs); }),
        ]);
        if (phaseTimer) clearTimeout(phaseTimer);
        if (!live()) return expire();
        if (results === null) counters.provider_start_phase_timeout_n++;
        batchIds.forEach((ids, i) => {
          counters.provider_start_batch_n++;
          providerStartBatchLatencyMsMax = Math.max(providerStartBatchLatencyMsMax, results?.[i]?.latencyMs ?? 0);
          for (const [id, entry] of entriesFromBatch(ids, results?.[i] ?? null, nowMs)) state.starts.set(id, entry);
        });
      } else {
        counters.provider_start_refresh_deferred_n += refreshIds.length;
      }
    }
    for (const [id, entry] of state.starts) {
      if ((entry.ok ? entry.acquiredAtMs : entry.attemptedAtMs) < nowMs - START_CACHE_PRUNE_AGE_MS) state.starts.delete(id);
    }
    const dueByDay = new Map<string, CohortSelection[]>();
    const addDue = (bandSelection: CohortSelection, event: ResearchEvent) => {
      const bucketDay = dayCtxs.find((d) => d.selected.includes(bandSelection));
      if (!bucketDay) return;
      const key = bucketDay.bounds.fromIso;
      dueByDay.set(key, [...(dueByDay.get(key) ?? []), { ...bandSelection, event }]);
    };
    for (const bandSelection of bandSelections) {
      const { event } = bandSelection;
      const group = identityGroups.get(providerIdentityKey(event)) ?? new Set<string>();
      const resolved = resolveProviderStart(event.eventStartIso, event.providerGameId, state.starts.get(event.providerEventId), nowMs);
      if (!resolved.ok) {
        counters.provider_start_unverified_event_n++;
        providerStartFailureCounts[resolved.reason] = (providerStartFailureCounts[resolved.reason] ?? 0) + 1;
        // No provider answer was obtained (unavailable / timed out / deferred / stale): an event still inside its SNAPSHOT window
        // keeps the pre-08C path, so Gamma trouble can never starve ordinary T20 capture. The capture's exact reader then proves
        // the provider start still equals the snapshot start (a reschedule fails closed as RESERVED_EVENT_START_MISMATCH). A
        // provider CONTENT disagreement (missing/duplicate/contradiction/anomaly) never takes this path.
        if (UNREACHED_PROVIDER_REASONS.has(resolved.reason) && inT20Window(event.eventStartIso, nowMs)) {
          if (group.size > 1) { counters.identity_ambiguous_event_n++; continue; }
          counters.provider_start_unreconciled_snapshot_window_event_n++;
          addDue(bandSelection, event);
        }
        continue;
      }
      const changed = Date.parse(resolved.evidence.startIso) !== Date.parse(event.eventStartIso);
      counters[changed ? "provider_start_rescheduled_event_n" : "provider_start_unchanged_event_n"]++;
      if (!inT20Window(resolved.evidence.startIso, nowMs)) continue;
      // The daily 100-event cap, the cohort and the physical id are all keyed on the SNAPSHOT UTC date. A verified start on a
      // DIFFERENT UTC date would be charged to the wrong day's allocation, so it fails closed (same-day reschedules proceed).
      if (resolved.evidence.startIso.slice(0, 10) !== event.eventStartIso.slice(0, 10)) { counters.provider_start_cross_utc_day_event_n++; continue; }
      // One physical match: the same provider identity under two UTC-day keys is owned only by the key whose UTC date is the
      // verified start date, else it fails closed.
      if (group.size > 1) {
        const startDate = resolved.evidence.startIso.slice(0, 10);
        const owners = [...group].filter((id) => physicalDate(id) === startDate);
        if (owners.length !== 1 || owners[0] !== event.physicalEventId) { counters.identity_ambiguous_event_n++; continue; }
      }
      if (changed) counters.provider_start_rescheduled_into_window_event_n++;
      addDue(bandSelection, { ...event, providerStart: resolved.evidence });
    }

    // Phase 3: capture, <= MAX_NEW_EVENTS_PER_TICK new events per tick, daily cap per source day.
    let newEvents = 0;
    for (const day of dayCtxs) {
      if (newEvents >= MAX_NEW_EVENTS_PER_TICK || !live()) break;
      const due = dueByDay.get(day.bounds.fromIso) ?? [];
      counters.due_event_n += due.length;
      if (due.length === 0) continue;
      // A captured sibling under another UTC-day key of the same provider identity also counts as already captured.
      const idsToCheck = [...new Set(due.flatMap((sel) => [...(identityGroups.get(providerIdentityKey(sel.event)) ?? [sel.event.physicalEventId])]))];
      const capturedIds = await deps.store.capturedAmong(idsToCheck);
      if (!live()) return expire();
      const isCaptured = (sel: CohortSelection) => [...(identityGroups.get(providerIdentityKey(sel.event)) ?? [sel.event.physicalEventId])].some((id) => capturedIds.has(id));
      for (const sel of due) if (isCaptured(sel)) rememberCaptured(sel.event.physicalEventId);
      counters.already_captured_event_n += due.filter(isCaptured).length;
      const todo = due.filter((s) => !isCaptured(s)).sort((a, b) => compareUrgency(a.event, b.event));
      if (todo.length === 0) continue;
      // Daily cap guard independent of cohort drift between ticks (fail-closed on read error).
      let dayCaptured = await deps.store.capturedEventCount(day.bounds.fromIso, day.bounds.toIso);
      if (!live()) return expire();
      for (let i = 0; i < todo.length; i++) {
        const selection = todo[i];
        if (newEvents >= MAX_NEW_EVENTS_PER_TICK || !live() || dayCaptured >= MAX_RESEARCH_EVENTS_PER_DAY) break;
        if (!canStartEvent()) {
          // SAFE_BUDGET_DEFER: not started, not captured, not failed/rejected. The next tick resumes it (capturedAmong).
          counters.deferred_budget_event_n += todo.length - i;
          budgetDeferred = true;
          break;
        }
        newEvents++;
        counters.attempted_event_n++;
        const eventStartedMs = performance.now();
        const outcome = await capture(selection, new Date(nowMs).toISOString(), captureDeps);
        // A capture that settles after the deadline is discarded: never counted, never written.
        if (!live()) return expire();
        for (const [type, n] of Object.entries(outcome.unsupported)) unsupportedCounts[type] = (unsupportedCounts[type] ?? 0) + n;
        if (outcome.kind === "TOKEN_BUDGET_EXCEEDED") { counters.token_budget_exceeded_event_n++; longestEventMs = Math.max(longestEventMs, performance.now() - eventStartedMs); continue; }
        if (outcome.kind === "FAILED") { noteFailure(outcome.reason); longestEventMs = Math.max(longestEventMs, performance.now() - eventStartedMs); continue; }
        try {
          await deps.store.writeRows(outcome.rows);
          if (!live()) return expire();
          counters.captured_event_n++; dayCaptured++;
          counters.token_rows_written_n += outcome.rows.length;
          rememberCaptured(selection.event.physicalEventId);
        } catch { if (!live()) return expire(); noteFailure(RESEARCH_WRITE_FAILED); }
        longestEventMs = Math.max(longestEventMs, performance.now() - eventStartedMs);
      }
      if (budgetDeferred) break;
    }
    // Bounded retention: one capped purge call per tick, only while the deadline has not expired. Skipped after a soft
    // deferral: the leftover budget is by definition too small, and a slow purge must not turn durable progress into a
    // false RESEARCH_TICK_TIMEOUT (retention is 7 days, so a skipped purge is harmless; the next tick purges).
    if (live() && !budgetDeferred && remaining() > 500) {
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
        timer = setTimeout(() => { expiredLatch = true; hardTimeoutHit = true; errorMessage = "RESEARCH_TICK_TIMEOUT"; status = "error"; resolve(); }, budgetMs);
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
  const diagnostics = {
    ...cohortDiagnostics, ...counters, budget_deferred: budgetDeferred, hard_timeout_hit: hardTimeoutHit,
    reschedule_horizon_minutes: T20_RESCHEDULE_HORIZON_MINUTES, provider_start_batch_latency_ms_max: providerStartBatchLatencyMsMax,
    provider_start_failure_counts: providerStartFailureCounts,
    unsupported_market_type_counts: unsupportedCounts, failed_reason_counts: failedReasonCounts, duration_ms: durationMs,
  };
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
