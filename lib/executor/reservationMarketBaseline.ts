import { createHash } from "node:crypto";
import type { NightEventReservationRow } from "./executorQueueTypes";
import { fetchOrderBooksConcurrent } from "../liquidity/polymarketClient";
import { computeMidPrice, computeSpread, computeSpreadBps, getBestBidAsk } from "../liquidity/orderbookMath";
import { fetchPolymarketEventById } from "../feed/polymarketClient";
import { compareExactIdentity } from "./exactIdentityOrder";

export const BASELINE_SOURCE_VERSION = "RESERVATION_REFERENCE_BASELINE_V2";
const MARKET_SOURCE_VERSION = "RESERVATION_MARKET_BASELINE_V1";
const PHASE = "RESERVATION_BASELINE";
export type ReservationMarketPhase = typeof PHASE | "T_MINUS_30" | "T_MINUS_10" | "T_MINUS_3" | "LIVE_GUARD";

export function classifyReservationMarketPhase(eventStartIso: string, nowMs: number): Exclude<ReservationMarketPhase, typeof PHASE> | null {
  const minutes = (Date.parse(eventStartIso) - nowMs) / 60_000;
  if (minutes > 20 && minutes <= 30) return "T_MINUS_30";
  if (minutes > 9 && minutes <= 15) return "T_MINUS_10";
  if (minutes > 3 && minutes <= 9) return "T_MINUS_3";
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

export function baselineCompleteness(input: { markets: number; siblingCounts: number[]; expected: number; observed: number; failed: number; missingIdentity: number }): { complete: boolean; status: string } {
  // Complete means every identifiable token supplied by this exact event response
  // was persisted. It does not attest to markets outside the provider response.
  const complete = input.markets > 0 && input.siblingCounts.length === input.markets &&
    input.siblingCounts.every((count) => Number.isFinite(count) && count === input.markets) &&
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
};

type FinalT3ReadPort = {
  readRuns(reservationId: string): Promise<Record<string, unknown>[]>;
  readObservations(captureRunId: string, afterId: string): Promise<Record<string, unknown>[]>;
};

/** One finalized source-set snapshot for one reserved physical event. */
export async function readCompletedFinalT3Universe(
  reservation: NightEventReservationRow,
  port: FinalT3ReadPort = defaultFinalT3ReadPort,
): Promise<FinalT3MarketObservation[]> {
  const id = reservation.id;
  const physicalId = reservation.physical_event_id;
  const start = reservation.event_start_iso;
  const lineage = reservation.diagnostics?.source_lineage as { provider_event_id?: unknown } | undefined;
  const providerId = lineage?.provider_event_id;
  if (!id || !physicalId || !start || !Number.isFinite(Date.parse(start)) ||
      typeof providerId !== "string" || !providerId) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  const runs = await port.readRuns(id);
  if (runs.length !== 1) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  const run = runs[0];
  if (run.reservation_id !== id || run.physical_event_id !== physicalId ||
      run.provider_event_id !== providerId || Date.parse(String(run.event_start_iso)) !== Date.parse(start) ||
      run.observation_phase !== "T_MINUS_3" || run.source_version !== MARKET_SOURCE_VERSION ||
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
    row.observation_phase !== "T_MINUS_3" ||
    ![row.condition_id, row.token_id, row.side].every((value) => typeof value === "string" && value.trim() !== "")
  )) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
  return rows as FinalT3MarketObservation[];
}

const defaultFinalT3ReadPort: FinalT3ReadPort = {
  async readRuns(reservationId) {
    const { supabaseAdmin } = await import("../supabase/server");
    const { data, error } = await supabaseAdmin.from("reservation_market_capture_runs")
      .select("id,reservation_id,physical_event_id,provider_event_id,event_start_iso,observation_phase,source_version,capture_complete,capture_status,market_tokens_expected_n,market_tokens_observed_n")
      .eq("reservation_id", reservationId).eq("observation_phase", "T_MINUS_3")
      .eq("source_version", MARKET_SOURCE_VERSION).limit(2);
    if (error) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    return data ?? [];
  },
  async readObservations(captureRunId, afterId) {
    const { supabaseAdmin } = await import("../supabase/server");
    const { data, error } = await supabaseAdmin.from("reservation_market_observations")
      .select("id,capture_run_id,reservation_id,physical_event_id,provider_event_id,event_start_iso,condition_id,token_id,side,observation_phase,canonical_market_family,canonical_market_type,provider_market_type_raw,market_slug,best_ask,ask_decimal_odds,orderbook_fetch_status")
      .eq("capture_run_id", captureRunId).gt("id", afterId).order("id").limit(200);
    if (error) throw new Error("FINAL_T3_SOURCE_UNAVAILABLE");
    return data ?? [];
  },
};

export async function captureReservationMarketBaseline(
  reservation: NightEventReservationRow,
  deps: {
    readInventory?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    readExactEvent?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    fetchBooks?: typeof fetchOrderBooksConcurrent;
    write?: (run: Record<string, unknown>, observations: Record<string, unknown>[], strategies?: Record<string, unknown>[]) => Promise<void>;
    observedAt?: string;
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
  await (deps.write ?? defaultWriter)(run, [], []);
}

export async function captureReservationMarketObservation(
  reservation: NightEventReservationRow,
  phase: ReservationMarketPhase,
  deps: {
    readInventory?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    readExactEvent?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    fetchBooks?: typeof fetchOrderBooksConcurrent;
    write?: (run: Record<string, unknown>, observations: Record<string, unknown>[], strategies?: Record<string, unknown>[]) => Promise<void>;
    observedAt?: string;
    alreadyCaptured?: (reservationId: string, phase: ReservationMarketPhase, sourceVersion: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  if (phase === PHASE) return captureReservationMarketBaseline(reservation, deps);
  if (!reservation.id) throw new Error("BASELINE_RESERVATION_ID_MISSING");
  if (await (deps.alreadyCaptured ?? defaultAlreadyCaptured)(reservation.id, phase, MARKET_SOURCE_VERSION)) return;
  const lineage = reservation.diagnostics?.source_lineage as { provider_event_id?: unknown; provider_event_start_iso?: unknown } | undefined;
  const providerEventId = typeof lineage?.provider_event_id === "string" ? lineage.provider_event_id : null;
  const start = reservation.event_start_iso;
  const observedAt = deps.observedAt ?? new Date().toISOString();
  const runId = stableTelemetryId(reservation.id, phase, MARKET_SOURCE_VERSION);
  const readMarkets = deps.readExactEvent ?? defaultExactEventReader;
  let markets: InventoryMarket[] = [];
  let failureReason: string | null = null;
  const expectedPhysicalId = providerEventId && start
    ? `provider:polymarket:${providerEventId.toLowerCase()}:${start.slice(0, 10)}`
    : null;
  if (providerEventId && start && Number.isFinite(Date.parse(start)) &&
      Date.parse(start) === Date.parse(String(lineage?.provider_event_start_iso)) &&
      reservation.physical_event_id === expectedPhysicalId) {
    try { markets = await readMarkets(providerEventId, start); }
    catch { failureReason = "RESERVED_EVENT_MARKET_SET_UNAVAILABLE"; }
  } else {
    failureReason = "PROVIDER_EVENT_IDENTITY_UNRESOLVED";
  }
  if (markets.length === 0 && !failureReason) {
    failureReason = "RESERVED_EVENT_MARKET_SET_UNAVAILABLE";
  }
  const { tokens, expected, missingIdentity } = inventoryTokens(markets);
  const books = await (deps.fetchBooks ?? fetchOrderBooksConcurrent)(tokens.map((t) => t.tokenId), 5);
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
      tick_size: null, minimum_order_size: null,
      orderbook_fetch_latency_ms: result?.latencyMs ?? null,
      orderbook_fetch_status: result?.ok ? "SUCCESS" : "FAILED",
      orderbook_failure_reason: result?.ok ? null : result?.errorCode ?? "UNKNOWN_FAILURE",
      source_version: MARKET_SOURCE_VERSION,
    };
  });
  const failed = observations.filter((row) => row.orderbook_fetch_status === "FAILED").length;
  const completeness = baselineCompleteness({ markets: markets.length, siblingCounts: markets.map((m) => m.sibling_market_count), expected, observed: observations.length, failed, missingIdentity });
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
  };
  await (deps.write ?? defaultWriter)(run, observations, strategyRowsForMarketObservations(observations));
}

async function defaultAlreadyCaptured(reservationId: string, phase: ReservationMarketPhase, sourceVersion: string): Promise<boolean> {
  const { supabaseAdmin } = await import("../supabase/server");
  const { data, error } = await supabaseAdmin.from("reservation_market_capture_runs")
    .select("id,capture_status").eq("reservation_id", reservationId).eq("observation_phase", phase)
    .eq("source_version", sourceVersion).limit(1);
  if (error) throw new Error("MILESTONE_CAPTURE_EXISTENCE_CHECK_FAILED");
  return (data ?? []).some((row) => row.capture_status !== "WRITE_INCOMPLETE");
}

async function defaultExactEventReader(providerEventId: string, eventStartIso: string): Promise<InventoryMarket[]> {
  const event = await fetchPolymarketEventById(providerEventId);
  if (!event) throw new Error("RESERVED_EVENT_MARKET_SET_UNAVAILABLE");
  const eventTimes = [event.endDate, event.endDateIso, event.startTime]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  if (!eventTimes.includes(Date.parse(eventStartIso))) {
    throw new Error("RESERVED_EVENT_START_MISMATCH");
  }
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
  }));
}

async function defaultWriter(run: Record<string, unknown>, observations: Record<string, unknown>[], _strategies: Record<string, unknown>[] = []): Promise<void> {
  const { supabaseAdmin } = await import("../supabase/server");
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
  for (let i = 0; i < observations.length; i += 200) {
    const { error } = await supabaseAdmin.from("reservation_market_observations")
      .upsert(observations.slice(i, i + 200), { onConflict: "capture_run_id,condition_id,token_id,side", ignoreDuplicates: true });
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
  { family: "MONEYLINE", type: "MONEYLINE", min: 1.85, max: 2.00 },
  { family: "TOTALS", type: "TOTAL", min: 1.85, max: 2.00 },
] as const;

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
        row.observation_phase !== "T_MINUS_3" ||
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
  } = {},
): Promise<{ a: ReservationStrategyDecisionInput; b: ReservationStrategyDecisionInput }> {
  const universe = await (deps.readUniverse ?? readCompletedFinalT3Universe)(reservation);
  const decisions = selectReservationT3AbDecisions(reservation, universe);
  const record = deps.recordDecision ?? recordReservationStrategyDecision;
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
  const store = deps.store ?? defaultDecisionStore;
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

const defaultDecisionStore: ReservationStrategyDecisionStore = {
  async readObservations(captureRunId, afterId, limit) {
    const { supabaseAdmin } = await import("../supabase/server");
    const { data, error } = await supabaseAdmin.from("reservation_market_observations")
      .select("id,capture_run_id,reservation_id,physical_event_id,condition_id,token_id,side,observation_phase,observed_at,minutes_to_start,best_ask,ask_decimal_odds,spread_abs,ask_depth_relevant_usd")
      .eq("capture_run_id", captureRunId).gt("id", afterId).order("id").limit(limit);
    if (error) throw new Error("STRATEGY_DECISION_SOURCE_READ_FAILED");
    return (data ?? []) as Record<string, unknown>[];
  },
  async readDecisions(captureRunId, strategyVariant, afterId, limit) {
    const { supabaseAdmin } = await import("../supabase/server");
    const { data, error } = await supabaseAdmin.from("reservation_strategy_observations")
      .select("id,market_observation_id,evaluation_state,eligible,rejection_reason,strategy_version")
      .eq("capture_run_id", captureRunId).eq("strategy_variant", strategyVariant)
      .gt("id", afterId).order("id").limit(limit);
    if (error) throw new Error("STRATEGY_DECISION_READ_FAILED");
    return (data ?? []) as Record<string, unknown>[];
  },
  async upsertDecisions(rows) {
    const { supabaseAdmin } = await import("../supabase/server");
    const { error } = await supabaseAdmin.from("reservation_strategy_observations")
      .upsert(rows, { onConflict: "market_observation_id,strategy_variant", ignoreDuplicates: true });
    if (error) throw new Error("STRATEGY_DECISION_WRITE_FAILED");
  },
};

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

export async function persistLiveGuardTelemetry(reservation: NightEventReservationRow, input: LiveGuardTelemetryInput): Promise<void> {
  const rows = liveGuardTelemetryRows(reservation, input);
  await defaultWriter(rows.run, [rows.observation], rows.strategies);
}

export async function captureReservationMarketMilestones(
  nowMs: number,
  deps: {
    load?: (lowerIso: string, upperIso: string) => Promise<NightEventReservationRow[]>;
    capture?: (reservation: NightEventReservationRow, phase: ReservationMarketPhase, observedAt: string) => Promise<void>;
    onError?: (code: string) => void;
  } = {},
): Promise<void> {
  const observedAt = new Date(nowMs).toISOString();
  const lower = new Date(nowMs + 3 * 60_000).toISOString();
  const upper = new Date(nowMs + 30 * 60_000).toISOString();
  const rows = await (deps.load ?? defaultMilestoneReservationLoader)(lower, upper);
  for (const reservation of rows.slice(0, 200)) {
    const phase = classifyReservationMarketPhase(reservation.event_start_iso ?? "", nowMs);
    if (!phase) continue;
    try {
      if (deps.capture) await deps.capture(reservation, phase, observedAt);
      else {
        await captureReservationMarketObservation(reservation, phase, { observedAt });
        if (phase === "T_MINUS_3") await persistReservationT3AbDecisions(reservation);
      }
    } catch {
      (deps.onError ?? ((code) => console.error(`[reservation-market-milestone] ${code}`)))("CAPTURE_FAILED");
    }
  }
}

async function defaultMilestoneReservationLoader(lowerIso: string, upperIso: string): Promise<NightEventReservationRow[]> {
  const { supabaseAdmin } = await import("../supabase/server");
  const { data, error } = await supabaseAdmin.from("night_event_reservations")
    .select("id,plan_run_id,physical_event_id,event_start_iso,diagnostics")
    .gt("event_start_iso", lowerIso).lte("event_start_iso", upperIso)
    .order("event_start_iso").order("id").limit(200);
  if (error) throw new Error("MILESTONE_RESERVATION_COHORT_READ_FAILED");
  return (data ?? []) as unknown as NightEventReservationRow[];
}
