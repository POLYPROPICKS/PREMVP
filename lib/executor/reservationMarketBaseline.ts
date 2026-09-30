import { createHash } from "node:crypto";
import type { NightEventReservationRow } from "./executorQueueTypes";
import { fetchOrderBooksConcurrent } from "../liquidity/polymarketClient";
import { computeMidPrice, computeSpread, computeSpreadBps, getBestBidAsk } from "../liquidity/orderbookMath";

export const BASELINE_SOURCE_VERSION = "RESERVATION_MARKET_BASELINE_V1";
const PHASE = "RESERVATION_BASELINE";

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

export function stableTelemetryId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try { return stringArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map((v) => typeof v === "string" ? v : "") : [];
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
  // The keyset inventory does not attest that the provider event payload is exhaustive.
  // Even internally consistent sibling counts therefore never certify completeness.
  void input;
  return { complete: false, status: "INCOMPLETE_MARKET_SET" };
}

export async function captureReservationMarketBaseline(
  reservation: NightEventReservationRow,
  deps: {
    readInventory?: (providerEventId: string, eventStartIso: string) => Promise<InventoryMarket[]>;
    fetchBooks?: typeof fetchOrderBooksConcurrent;
    write?: (run: Record<string, unknown>, observations: Record<string, unknown>[]) => Promise<void>;
    observedAt?: string;
  } = {},
): Promise<void> {
  if (!reservation.id) throw new Error("BASELINE_RESERVATION_ID_MISSING");
  const lineage = reservation.diagnostics?.source_lineage as { provider_event_id?: unknown; provider_event_start_iso?: unknown } | undefined;
  const providerEventId = typeof lineage?.provider_event_id === "string" ? lineage.provider_event_id : null;
  const start = reservation.event_start_iso;
  const observedAt = deps.observedAt ?? new Date().toISOString();
  const runId = stableTelemetryId(reservation.id, PHASE, BASELINE_SOURCE_VERSION);
  const readInventory = deps.readInventory ?? defaultInventoryReader;
  let markets: InventoryMarket[] = [];
  let failureReason: string | null = null;
  const expectedPhysicalId = providerEventId && start
    ? `provider:polymarket:${providerEventId.toLowerCase()}:${start.slice(0, 10)}`
    : null;
  if (providerEventId && start && Number.isFinite(Date.parse(start)) &&
      Date.parse(start) === Date.parse(String(lineage?.provider_event_start_iso)) &&
      reservation.physical_event_id === expectedPhysicalId) {
    try { markets = await readInventory(providerEventId, start); }
    catch { failureReason = "INVENTORY_READ_FAILED"; }
  } else {
    failureReason = "PROVIDER_EVENT_IDENTITY_UNRESOLVED";
  }
  const { tokens, expected, missingIdentity } = inventoryTokens(markets);
  const books = await (deps.fetchBooks ?? fetchOrderBooksConcurrent)(tokens.map((t) => t.tokenId), 5);
  const minutesToStart = (Date.parse(start ?? "") - Date.parse(observedAt)) / 60000;
  const observations = tokens.map((token, i) => {
    const result = books[i];
    const book = result?.ok ? result.book : null;
    const { bestBid, bestAsk } = getBestBidAsk(book);
    return {
      id: stableTelemetryId(runId, token.conditionId, token.tokenId, token.side),
      capture_run_id: runId, reservation_id: reservation.id, physical_event_id: reservation.physical_event_id,
      provider_event_id: providerEventId, event_start_iso: start, observation_phase: PHASE,
      observed_at: observedAt, minutes_to_start: minutesToStart,
      condition_id: token.conditionId, token_id: token.tokenId, side: token.side, outcome: token.outcome,
      canonical_market_family: null, canonical_market_type: null,
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
      source_version: BASELINE_SOURCE_VERSION,
    };
  });
  const failed = observations.filter((row) => row.orderbook_fetch_status === "FAILED").length;
  const completeness = baselineCompleteness({ markets: markets.length, siblingCounts: markets.map((m) => m.sibling_market_count), expected, observed: observations.length, failed, missingIdentity });
  const run = {
    id: runId, reservation_id: reservation.id, plan_run_id: reservation.plan_run_id,
    physical_event_id: reservation.physical_event_id, provider_event_id: providerEventId,
    event_start_iso: start, observation_phase: PHASE, observed_at: observedAt, minutes_to_start: minutesToStart,
    source_version: BASELINE_SOURCE_VERSION,
    source_observed_at: markets.length ? markets.reduce((latest, m) => m.last_observed_at > latest ? m.last_observed_at : latest, markets[0].last_observed_at) : null,
    markets_discovered_n: markets.length, market_tokens_expected_n: expected,
    market_tokens_observed_n: observations.length, orderbooks_success_n: observations.length - failed,
    orderbooks_failed_n: failed, capture_complete: completeness.complete,
    capture_status: failureReason ? "CAPTURE_FAILED" : completeness.status,
    failure_reason: failureReason ?? (missingIdentity ? "MARKET_TOKEN_IDENTITY_MISSING" : null),
  };
  await (deps.write ?? defaultWriter)(run, observations);
}

async function defaultInventoryReader(providerEventId: string, eventStartIso: string): Promise<InventoryMarket[]> {
  const { supabaseAdmin } = await import("../supabase/server");
  const rows: InventoryMarket[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabaseAdmin.from("sports_event_market_inventory")
      .select("provider_event_id,event_start_iso,condition_id,clob_token_ids,outcomes,sports_market_type,provider_market_slug,sibling_market_count,last_observed_at")
      .eq("provider", "polymarket").eq("provider_event_id", providerEventId).eq("event_start_iso", eventStartIso)
      .order("provider_market_id").range(offset, offset + 499);
    if (error) throw new Error("BASELINE_INVENTORY_READ_FAILED");
    rows.push(...((data ?? []) as InventoryMarket[]));
    if ((data ?? []).length < 500) break;
  }
  return rows;
}

async function defaultWriter(run: Record<string, unknown>, observations: Record<string, unknown>[]): Promise<void> {
  const { supabaseAdmin } = await import("../supabase/server");
  const { error: runError } = await supabaseAdmin.from("reservation_market_capture_runs").upsert(run, { onConflict: "reservation_id,observation_phase,source_version", ignoreDuplicates: true });
  if (runError) throw new Error("BASELINE_RUN_WRITE_FAILED");
  for (let i = 0; i < observations.length; i += 200) {
    const { error } = await supabaseAdmin.from("reservation_market_observations")
      .upsert(observations.slice(i, i + 200), { onConflict: "capture_run_id,condition_id,token_id,side", ignoreDuplicates: true });
    if (error) throw new Error("BASELINE_OBSERVATION_WRITE_FAILED");
  }
}
