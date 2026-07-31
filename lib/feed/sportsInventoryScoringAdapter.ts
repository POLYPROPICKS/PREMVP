// Pure shape adapter: sports_event_market_inventory row -> the existing raw
// Polymarket event/market input consumed by lib/feed/buildLandingCards.ts's
// enrichment path (PolymarketRawEvent / PolymarketRawMarket).
//
// This adapter proves shape compatibility only. It does not certify group
// policy, score quality, liquidity, or executability -- those remain the
// caller's responsibility (see lib/reporting/sportsInventoryFunnelReport.ts
// for the read-only funnel measurement that already covers strict full-event
// group policy).
//
// It never selects a side, a token, an entry price, a score, or a confidence
// value: selectOutcome() in buildLandingCards.ts already derives the
// outcome from a raw PolymarketRawMarket's outcomes/outcomePrices/
// clobTokenIds arrays on its own, so no selection is required before this
// boundary. This module stops exactly at that boundary.
//
// No env, no DB, no network, no filesystem, no clock reads, no side effects.

import type { PolymarketRawEvent, PolymarketRawMarket, PolymarketRawOutcome } from "@/lib/feed/types";
import { safeParseArray, safeParseNumber } from "@/lib/feed/buildLandingCards";

export type SportsInventoryScoringAdapterReasonCode =
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_EVENT_ID_MISSING"
  | "PROVIDER_MARKET_ID_MISSING"
  | "CONDITION_ID_MISSING"
  | "EVENT_START_INVALID"
  | "OUTCOMES_INVALID"
  | "TOKEN_ARRAY_INVALID"
  | "PRICE_ARRAY_INVALID"
  | "TOKEN_MISSING"
  | "PRICE_INVALID";

export interface SportsInventoryScoringAdapterRow {
  provider: string | null;
  provider_event_id: string | null;
  provider_event_slug: string | null;
  provider_market_id: string | null;
  provider_market_slug: string | null;

  event_title: string | null;
  market_question: string | null;
  event_start_iso: string | null;
  market_end_iso: string | null;

  condition_id: string | null;
  clob_token_ids: unknown;
  outcomes: unknown;
  outcome_prices: unknown;

  provider_tags: unknown;
  raw_category: string | null;
  league_hint: string | null;
  sports_market_type: string | null;

  volume_usd: number | null;
  volume_24hr_usd: number | null;
}

export type SportsInventoryScoringAdapterResult =
  | {
      ok: true;
      event: PolymarketRawEvent;
      market: PolymarketRawMarket;
    }
  | {
      ok: false;
      reasonCode: SportsInventoryScoringAdapterReasonCode;
    };

// Only the "polymarket" provider is supported: PolymarketRawEvent /
// PolymarketRawMarket are Polymarket-specific raw types.
const SUPPORTED_PROVIDER = "polymarket";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function fail(reasonCode: SportsInventoryScoringAdapterReasonCode): { ok: false; reasonCode: SportsInventoryScoringAdapterReasonCode } {
  return { ok: false, reasonCode };
}

/**
 * Pure, deterministic adapter. Converts one production-shaped
 * sports_event_market_inventory row into the exact raw event/market shape
 * the existing enrichment path (enrichMarket/selectOutcome in
 * buildLandingCards.ts) already consumes. Handles exactly one observation --
 * reschedule reconciliation and group-level market policy remain out of
 * scope here.
 */
export function adaptSportsInventoryRowToScoringInput(
  row: SportsInventoryScoringAdapterRow,
): SportsInventoryScoringAdapterResult {
  if (row.provider !== SUPPORTED_PROVIDER) {
    return fail("PROVIDER_UNSUPPORTED");
  }
  if (!isNonEmptyString(row.provider_event_id)) {
    return fail("PROVIDER_EVENT_ID_MISSING");
  }
  if (!isNonEmptyString(row.provider_market_id)) {
    return fail("PROVIDER_MARKET_ID_MISSING");
  }
  if (!isNonEmptyString(row.condition_id)) {
    return fail("CONDITION_ID_MISSING");
  }
  if (!isNonEmptyString(row.event_start_iso) || !Number.isFinite(Date.parse(row.event_start_iso))) {
    return fail("EVENT_START_INVALID");
  }

  // safeParseArray mirrors the exact runtime parsing selectOutcome() applies
  // to a raw market's outcomes/outcomePrices/clobTokenIds -- copying its
  // behavior here (rather than importing it) would duplicate scoring-path
  // logic, so the real exported helper is reused instead.
  const outcomes = safeParseArray<unknown>(row.outcomes);
  if (outcomes.length < 2) {
    return fail("OUTCOMES_INVALID");
  }

  const tokens = safeParseArray<unknown>(row.clob_token_ids);
  if (tokens.length !== outcomes.length) {
    return fail("TOKEN_ARRAY_INVALID");
  }

  const prices = safeParseArray<unknown>(row.outcome_prices);
  if (prices.length !== outcomes.length) {
    return fail("PRICE_ARRAY_INVALID");
  }

  // Every element must round-trip -- silently dropping a sibling outcome
  // would misrepresent the market's real shape to the scoring path.
  for (const token of tokens) {
    if (!isNonEmptyString(token)) {
      return fail("TOKEN_MISSING");
    }
  }
  for (const price of prices) {
    if (safeParseNumber(price) === null) {
      return fail("PRICE_INVALID");
    }
  }

  const outcomeNames = outcomes.map((o) => String(o));
  const tokenIds = tokens.map((t) => String(t));
  // outcomePrices is typed Record<string, number> | string on
  // PolymarketRawMarket, but the real Gamma runtime shape (and every
  // existing adapter in buildLandingCards.ts) is a positional array cast
  // through `unknown` -- mirrored here rather than reinvented.
  const outcomePrices = prices as unknown as Record<string, number> | string;

  const eventStartIso = row.event_start_iso;

  const market: PolymarketRawMarket = {
    id: row.provider_market_id,
    conditionId: row.condition_id,
    question: row.market_question ?? row.event_title ?? "",
    slug: row.provider_market_slug ?? row.provider_market_id,
    active: true,
    closed: false,
    sportsMarketType: row.sports_market_type ?? undefined,
    category: row.raw_category ?? undefined,
    endDate: row.market_end_iso ?? undefined,
    outcomes: outcomeNames as unknown as PolymarketRawOutcome[] | string,
    outcomePrices,
    clobTokenIds: tokenIds,
    volume24hr: row.volume_24hr_usd ?? undefined,
  };

  const event: PolymarketRawEvent = {
    id: row.provider_event_id,
    title: row.event_title ?? row.market_question ?? "",
    slug: row.provider_event_slug ?? row.provider_event_id,
    active: true,
    closed: false,
    // event.endDate carries the game-time proxy in this codebase's existing
    // adapters (sampleToCandidateMarket, researchNestedMarketToCandidate) --
    // mirrored here for the same downstream readers (e.g. gameStartIso
    // derivation), alongside the more literally named startTime field.
    endDate: eventStartIso,
    startTime: eventStartIso,
    markets: [market],
    volume24hr: row.volume_usd ?? undefined,
  };

  return { ok: true, event, market };
}
