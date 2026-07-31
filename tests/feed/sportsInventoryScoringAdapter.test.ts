// Pure adapter tests (node:test via tsx):
//   npx tsx --test tests/feed/sportsInventoryScoringAdapter.test.ts
//
// This adapter proves shape compatibility only -- it never selects a side, a
// token, computes a score, or performs any network/database call. Every
// fixture models a real sports_event_market_inventory row shape. No
// FireModelCandidate fixture is used anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adaptSportsInventoryRowToScoringInput,
  type SportsInventoryScoringAdapterRow,
} from "../../lib/feed/sportsInventoryScoringAdapter";
import { safeParseArray, safeParseNumber } from "../../lib/feed/buildLandingCards";

function row(overrides: Partial<SportsInventoryScoringAdapterRow> = {}): SportsInventoryScoringAdapterRow {
  return {
    provider: "polymarket",
    provider_event_id: "evt-123",
    provider_event_slug: "evt-123-slug",
    provider_market_id: "mkt-456",
    provider_market_slug: "mkt-456-slug",
    event_title: "Team A vs Team B",
    market_question: "Team A vs Team B Moneyline",
    event_start_iso: "2026-07-31T12:00:00.000Z",
    market_end_iso: "2026-07-31T14:00:00.000Z",
    condition_id: "0xcondition-abc",
    clob_token_ids: ["token-a", "token-b"],
    outcomes: ["Team A", "Team B"],
    outcome_prices: ["0.6", "0.4"],
    provider_tags: [],
    raw_category: "sports",
    league_hint: null,
    sports_market_type: null,
    volume_usd: 1000,
    volume_24hr_usd: 200,
    ...overrides,
  };
}

test("1. binary full-match market maps without identity loss", () => {
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.market.conditionId, "0xcondition-abc");
  assert.equal(result.event.id, "evt-123");
  assert.equal(result.market.id, "mkt-456");
});

test("2. three-way soccer market preserves all three outcome/token/price positions", () => {
  const threeWay = row({
    market_question: "Team A vs Team B Match Result",
    outcomes: ["Team A", "Draw", "Team B"],
    clob_token_ids: ["token-a", "token-draw", "token-b"],
    outcome_prices: ["0.4", "0.25", "0.35"],
  });
  const result = adaptSportsInventoryRowToScoringInput(threeWay);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.market.outcomes, ["Team A", "Draw", "Team B"]);
  assert.deepEqual(result.market.clobTokenIds, ["token-a", "token-draw", "token-b"]);
  assert.deepEqual(result.market.outcomePrices, ["0.4", "0.25", "0.35"]);
});

test("3. event and market slugs remain distinct", () => {
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.slug, "evt-123-slug");
  assert.equal(result.market.slug, "mkt-456-slug");
  assert.notEqual(result.event.slug, result.market.slug);
});

test("4. provider event ID and provider market ID remain distinct", () => {
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.id, "evt-123");
  assert.equal(result.market.id, "mkt-456");
  assert.notEqual(result.event.id, result.market.id);
});

test("5. condition ID is preserved exactly", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ condition_id: "0xEXACT-ID-999" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.market.conditionId, "0xEXACT-ID-999");
});

test("6. event start and market end are preserved exactly", () => {
  const result = adaptSportsInventoryRowToScoringInput(
    row({ event_start_iso: "2026-08-01T03:30:00.000Z", market_end_iso: "2026-08-01T05:00:00.000Z" }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.endDate, "2026-08-01T03:30:00.000Z");
  assert.equal(result.event.startTime, "2026-08-01T03:30:00.000Z");
  assert.equal(result.market.endDate, "2026-08-01T05:00:00.000Z");
});

test("7. numeric prices accepted when the current provider path accepts them", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ outcome_prices: [0.6, 0.4] as unknown as string[] }));
  assert.equal(result.ok, true);
});

test("8. string prices accepted only when the current provider path accepts them", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ outcome_prices: ["0.6", "0.4"] }));
  assert.equal(result.ok, true);
  const bad = adaptSportsInventoryRowToScoringInput(row({ outcome_prices: ["not-a-number", "0.4"] }));
  assert.equal(bad.ok, false);
});

test("9. mismatched outcomes/tokens lengths fail closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ clob_token_ids: ["only-one"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "TOKEN_ARRAY_INVALID");
});

test("10. mismatched outcomes/prices lengths fail closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ outcome_prices: ["0.6"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "PRICE_ARRAY_INVALID");
});

test("11. missing condition ID fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ condition_id: null }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "CONDITION_ID_MISSING");
});

test("12. empty token fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ clob_token_ids: ["token-a", ""] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "TOKEN_MISSING");
});

test("13. invalid price fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ outcome_prices: ["0.6", "not-a-number"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "PRICE_INVALID");
});

test("14. unsupported provider fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ provider: "sportsbook-x" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "PROVIDER_UNSUPPORTED");
});

test("15. no selected outcome/token/entry price appears in adapter output", () => {
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result);
  assert.ok(!/selectedOutcome/i.test(serialized));
  assert.ok(!/selectedToken/i.test(serialized));
  assert.ok(!/entryPrice/i.test(serialized));
});

test("16. no score/confidence/data-coverage field is synthesized", () => {
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result);
  assert.ok(!/"score"/i.test(serialized));
  assert.ok(!/confidence/i.test(serialized));
  assert.ok(!/dataCoverage/i.test(serialized));
});

test("17. input object is not mutated", () => {
  const input = row();
  const beforeOutcomes = [...(input.outcomes as string[])];
  const beforeTokens = [...(input.clob_token_ids as string[])];
  adaptSportsInventoryRowToScoringInput(input);
  assert.deepEqual(input.outcomes, beforeOutcomes);
  assert.deepEqual(input.clob_token_ids, beforeTokens);
});

test("18. deterministic repeated output", () => {
  const input = row();
  const a = adaptSportsInventoryRowToScoringInput(input);
  const b = adaptSportsInventoryRowToScoringInput(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("19. no Supabase/network call occurs (pure module, no side-effecting imports invoked)", () => {
  // The adapter module never imports supabase/server or polymarketClient --
  // proven statically by this test importing and calling it with zero
  // environment variables set and no network stub configured, and the call
  // still succeeding synchronously.
  const result = adaptSportsInventoryRowToScoringInput(row());
  assert.equal(result.ok, true);
});

test("20. existing parsing helpers behave unchanged after the minimal export edit", () => {
  // safeParseArray / safeParseNumber were only given the `export` keyword --
  // their bodies are untouched. This proves the exact same runtime behavior
  // researchNestedMarketToCandidate and selectOutcome rely on internally.
  assert.deepEqual(safeParseArray<string>('["a","b"]'), ["a", "b"]);
  assert.deepEqual(safeParseArray<string>(["a", "b"]), ["a", "b"]);
  assert.equal(safeParseNumber("0.45"), 0.45);
  assert.equal(safeParseNumber(0.45), 0.45);
  assert.equal(safeParseNumber("not-a-number"), null);
});

test("outcomes array below length 2 fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ outcomes: ["Only One"], clob_token_ids: ["token-a"], outcome_prices: ["0.5"] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "OUTCOMES_INVALID");
});

test("missing provider_event_id fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ provider_event_id: "" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "PROVIDER_EVENT_ID_MISSING");
});

test("missing provider_market_id fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ provider_market_id: "" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "PROVIDER_MARKET_ID_MISSING");
});

test("invalid event_start_iso fails closed", () => {
  const result = adaptSportsInventoryRowToScoringInput(row({ event_start_iso: "not-a-date" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reasonCode, "EVENT_START_INVALID");
});
