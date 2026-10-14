import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVED_SCORED_FORMULA, bookEvidence, buildExecutableLiquidityCohort, confirmProviderIdentity, reduceSourceRows,
  selectExecutableLiquidityCohort, type EvaluatedCandidate, type ProviderMarket, type SourceCandidate, type SourceRow,
} from "../../lib/research/executableLiquidityCohortT90";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";

// Fixtures below prove selection LOGIC only. They are not evidence of any real cohort or BET.
const ASOF = Date.parse("2026-10-14T10:00:00.000Z");
const H = 3_600_000;
const startIn = (hours: number) => new Date(ASOF + hours * H).toISOString();

function row(over: Partial<SourceRow> & { n: number }): SourceRow {
  const { n, ...rest } = over;
  return {
    observation_id: `obs-${n}`, item_observation_id: `item-${n}`, observed_at: new Date(ASOF - 3 * H).toISOString(), ingested_at: new Date(ASOF - 2 * H).toISOString(),
    condition_id: `0xc${n}`, selected_token_id: `tok-${n}-a`, selected_outcome: "Yes", metric_formula_version: APPROVED_SCORED_FORMULA,
    provider_event_id: `ev-${n}`, provider_sport_family: "soccer", market_type: "moneyline", game_start_iso: startIn(10),
    entry_price_num: 0.5, pre_event_score_num: 70, ...rest,
  };
}

test("reduceSourceRows: availability is ingested_at and must precede both as-of and T-90", () => {
  const { candidates, rejected } = reduceSourceRows([
    row({ n: 1 }),
    row({ n: 2, ingested_at: new Date(ASOF + H).toISOString() }),                       // after DB as-of
    row({ n: 3, game_start_iso: startIn(1.4), ingested_at: new Date(ASOF - H).toISOString() }), // start inside T-90 at as-of
    row({ n: 4, game_start_iso: startIn(2), ingested_at: new Date(ASOF + 0.6 * H).toISOString() }), // ingested after start-90
    row({ n: 5, metric_formula_version: "shadow-firemodel1_1_research_v0" }),
    row({ n: 6, game_start_iso: startIn(30) }),                                         // outside the daily horizon
    row({ n: 7, provider_sport_family: "esports" }),
    row({ n: 8, observed_at: new Date(ASOF - H).toISOString(), ingested_at: new Date(ASOF - 2 * H).toISOString() }), // observed after ingested
  ], ASOF);
  assert.deepEqual(candidates.map((c) => c.conditionId), ["0xc1"]);
  const reasons = Object.fromEntries(rejected.map((r) => [r.subject, r.reason]));
  assert.equal(reasons["0xc2"], "SOURCE_INGESTED_AFTER_ASOF");
  assert.equal(reasons["0xc3"], "EVENT_NOT_AFTER_T90_AT_ASOF");
  assert.equal(reasons["0xc4"], "SOURCE_INGESTED_AFTER_ASOF");
  assert.equal(reasons["0xc5"], "FORMULA_NOT_APPROVED");
  assert.equal(reasons["0xc6"], "EVENT_BEYOND_CYCLE_HORIZON");
  assert.equal(reasons["0xc7"], "SPORT_FAMILY_NOT_TARGET");
  assert.equal(reasons["0xc8"], "SOURCE_OBSERVED_AFTER_INGESTED");
});

test("reduceSourceRows: a later row becoming available after T-90 never replaces the causal one; contradictions reject the condition", () => {
  const early = row({ n: 1, game_start_iso: startIn(4) });
  const late = row({ n: 1, item_observation_id: "item-1b", game_start_iso: startIn(4), ingested_at: new Date(ASOF - 0.1 * H).toISOString() });
  // start in 4h => T-90 is at +2.5h; both rows are before it, newest causal row wins.
  assert.equal(reduceSourceRows([early, late], ASOF).candidates[0].itemObservationId, "item-1b");
  const lateOnly = row({ n: 2, game_start_iso: startIn(1.6), ingested_at: new Date(ASOF + 0.2 * H).toISOString() });
  assert.equal(reduceSourceRows([lateOnly], ASOF).candidates.length, 0);
  const clash = reduceSourceRows([row({ n: 3 }), row({ n: 3, item_observation_id: "i2", provider_event_id: "ev-other" })], ASOF);
  assert.equal(clash.candidates.length, 0);
  assert.equal(clash.rejected[0].reason, "CONDITION_PROVIDER_EVENT_CONTRADICTION");
});

const providerMarket = (over: Partial<ProviderMarket> = {}): ProviderMarket => ({
  provider_event_id: "ev-1", event_start_iso: startIn(10), condition_id: "0xc1", clob_token_ids: ["tok-1-a", "tok-1-b"], outcomes: ["Home", "Away"],
  sports_market_type: "moneyline", provider_market_slug: "m-1", sibling_market_count: 3, last_observed_at: startIn(0), provider_game_id: "g1", ...over,
});
const source = (over: Partial<SourceCandidate> = {}): SourceCandidate => ({
  conditionId: "0xc1", tokenId: "tok-1-a", outcome: "Home", providerEventId: "ev-1", eventStartIso: startIn(10), sportFamily: "soccer", sourceMarketType: "moneyline",
  observationId: "o", itemObservationId: "i", observedAt: startIn(-3), ingestedAt: startIn(-2), entryPrice: 0.5, score: 70, sourceRowN: 1, ...over,
});

test("confirmProviderIdentity: provider pair, binary tokens, admitted market type, physical id from provider game", () => {
  const ok = confirmProviderIdentity(source(), [providerMarket(), providerMarket({ condition_id: "0xother" })]);
  assert.ok(!("reason" in ok));
  if (!("reason" in ok)) {
    assert.equal(ok.oppositeTokenId, "tok-1-b");
    assert.match(ok.physicalEventId, /^provider:polymarket:game:g1:/);
  }
  const reason = (r: unknown) => (r as { reason: string }).reason;
  assert.equal(reason(confirmProviderIdentity(source(), [])), "CONDITION_NOT_IN_PROVIDER_EVENT");
  assert.equal(reason(confirmProviderIdentity(source({ tokenId: "typo" }), [providerMarket()])), "SELECTED_TOKEN_NOT_IN_PROVIDER_PAIR");
  assert.equal(reason(confirmProviderIdentity(source(), [providerMarket({ clob_token_ids: ["tok-1-a", "tok-1-b", "tok-1-c"], outcomes: ["a", "b", "c"] })])), "PROVIDER_TOKEN_PAIR_NOT_BINARY");
  assert.equal(reason(confirmProviderIdentity(source(), [providerMarket({ sports_market_type: "soccer_first_half_total_corners" })])), "MARKET_TYPE_NOT_ADMITTED");
  assert.equal(reason(confirmProviderIdentity(source({ sourceMarketType: "spreads" }), [providerMarket()])), "SOURCE_PROVIDER_MARKET_TYPE_CONTRADICTION");
  assert.equal(reason(confirmProviderIdentity(source({ sportFamily: "tennis" }), [providerMarket({ sports_market_type: "spreads" })])), "MARKET_TYPE_NOT_ADMITTED");
});

const book = (tokenId: string, askUsd: number, completedAt = ASOF + 60_000, price = 0.5): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 10, requestStartedAtMs: completedAt - 10, responseCompletedAtMs: completedAt,
  book: { tokenId, bids: [{ price: price - 0.02, size: 1000 }], asks: [{ price, size: askUsd / price }], tickSize: 0.01, minimumOrderSize: 5, providerTimestampMs: completedAt },
});

let seq = 0;
function evaluated(sport: string, depthUsd: number, over: Partial<EvaluatedCandidate> = {}): EvaluatedCandidate {
  const n = ++seq;
  const c = source({ conditionId: `0xe${n}`, tokenId: `tok-${n}-a`, providerEventId: `ev${n}`, sportFamily: sport });
  return {
    ...c, physicalEventId: `phys-${n}`, providerGameId: `g${n}`, oppositeTokenId: `tok-${n}-b`, providerMarketType: "MONEYLINE", providerMarketFamily: "MONEYLINE",
    providerMarketSlug: null, book: bookEvidence(c, book(`tok-${n}-a`, depthUsd)), ...over,
  };
}

test("bookEvidence: independent full-stake executable evidence; thin or capped books are not executable", () => {
  const c = source();
  assert.equal(bookEvidence(c, book("tok-1-a", 500)).executable, true);
  assert.equal(bookEvidence(c, book("tok-1-a", 500)).askDepthUsd, 500);
  assert.equal(bookEvidence(c, book("tok-1-a", 1)).executable, false);               // < $2.50 full stake
  assert.equal(bookEvidence(c, book("tok-1-a", 500, ASOF, 0.7)).executable, false); // only above the approved 0.555 cap
  assert.equal(bookEvidence(c, null).state, "UNKNOWN_BOOK_UNAVAILABLE");
});

test("selection: 50/25/25 per-sport executable-liquidity ranking, no cross-quota backfill, deterministic", () => {
  seq = 0;
  const pool: EvaluatedCandidate[] = [];
  for (let i = 0; i < 70; i++) pool.push(evaluated("soccer", 100 + i));
  for (let i = 0; i < 40; i++) pool.push(evaluated("tennis", 1000 + i));            // deeper than soccer: must NOT be globally outranked
  for (const f of ["basketball", "baseball", "hockey", "cricket", "american-football"]) for (let i = 0; i < 8; i++) pool.push(evaluated(f, 50 + i));
  const a = selectExecutableLiquidityCohort(pool, ASOF);
  const b = selectExecutableLiquidityCohort([...pool].reverse(), ASOF);
  assert.deepEqual(a.selected.map((s) => s.event.conditionId), b.selected.map((s) => s.event.conditionId));
  assert.equal(a.diagnostics.soccer_selected_n, 50);
  assert.equal(a.diagnostics.tennis_selected_n, 25);
  assert.equal(a.diagnostics.other_selected_n, 25);
  assert.equal(a.selected.length, 100);
  assert.equal(a.diagnostics.global_backfill_n, 0);
  const soccer = a.selected.filter((s) => s.bucket === "SOCCER");
  assert.deepEqual(soccer.map((s) => s.event.book.askDepthUsd), Array.from({ length: 50 }, (_, i) => 169 - i));
  assert.equal(a.diagnostics.depth_cutoff_usd.soccer, 120);
  const others = a.selected.filter((s) => s.bucket.startsWith("OTHER"));
  for (const f of ["basketball", "baseball", "hockey", "cricket", "american-football"]) {
    assert.ok(others.filter((s) => s.event.sportFamily === f && s.bucket === "OTHER_DIVERSITY_FLOOR").length === 4, f);
  }
  assert.equal(new Set(a.selected.map((s) => s.event.physicalEventId)).size, 100);
});

test("selection: shortfall is an explicit underfill, never filled from another sport", () => {
  seq = 0;
  const pool = [...Array.from({ length: 10 }, (_, i) => evaluated("soccer", 100 + i)), ...Array.from({ length: 60 }, (_, i) => evaluated("tennis", 100 + i))];
  const r = selectExecutableLiquidityCohort(pool, ASOF);
  assert.equal(r.diagnostics.soccer_selected_n, 10);
  assert.equal(r.diagnostics.soccer_quota_underfill_n, 40);
  assert.equal(r.diagnostics.tennis_selected_n, 25);
  assert.equal(r.diagnostics.other_quota_underfill_n, 25);
  assert.equal(r.selected.length, 35);
});

test("selection: one candidate per physical event (no duplicate/opposing sides); non-executable and non-causal quotes rejected", () => {
  seq = 0;
  const a = evaluated("soccer", 300, { physicalEventId: "phys-same", conditionId: "0xA" });
  const opposing = evaluated("soccer", 900, { physicalEventId: "phys-same", conditionId: "0xB", tokenId: "tok-other-side" });
  const thin = evaluated("soccer", 1);
  const lateQuote = evaluated("soccer", 500, { eventStartIso: startIn(1.4) });
  lateQuote.book = bookEvidence(lateQuote, book(lateQuote.tokenId, 500, ASOF + 0.2 * H));
  const staleQuote = evaluated("soccer", 500);
  staleQuote.book = bookEvidence(staleQuote, book(staleQuote.tokenId, 500, ASOF - 1000));
  const r = selectExecutableLiquidityCohort([a, opposing, thin, lateQuote, staleQuote], ASOF);
  assert.deepEqual(r.selected.map((s) => s.event.conditionId), ["0xB"]);
  const reasons = r.rejected.map((x) => x.reason);
  assert.ok(reasons.includes("EVENT_ALTERNATE_CANDIDATE_LOWER_LIQUIDITY"));
  assert.ok(reasons.some((x) => x.startsWith("NOT_EXECUTABLE:")));
  assert.ok(reasons.includes("QUOTE_AFTER_T90"));
  assert.ok(reasons.includes("QUOTE_TIMESTAMP_MISSING_OR_BEFORE_ASOF"));
  const clash = selectExecutableLiquidityCohort([evaluated("soccer", 100, { physicalEventId: "p" }), evaluated("tennis", 100, { physicalEventId: "p" })], ASOF);
  assert.equal(clash.selected.length, 0);
  assert.ok(clash.rejected.some((x) => x.reason === "PHYSICAL_EVENT_SPORT_CONTRADICTION"));
});

test("orchestrator: injected providers only; Gamma identity + CLOB book decide the cohort and ranking is by depth, not source order", async () => {
  const rows = [row({ n: 1 }), row({ n: 2 }), row({ n: 3 }), row({ n: 4, selected_token_id: "typo-token" })];
  const depth: Record<string, number> = { "tok-1-a": 100, "tok-2-a": 900, "tok-3-a": 400, "typo-token": 800 };
  const result = await buildExecutableLiquidityCohort({
    readSource: async () => ({ asOfMs: ASOF, rows }),
    readProviderEvent: async (eventId) => {
      const n = eventId.replace("ev-", "");
      return [providerMarket({ provider_event_id: eventId, condition_id: `0xc${n}`, clob_token_ids: [`tok-${n}-a`, `tok-${n}-b`], provider_game_id: `g${n}` })];
    },
    fetchBooks: async (ids) => ids.map((id) => book(id, depth[id] ?? 0)),
    fetchFee: async (tokenId) => ({ ok: false, tokenId, errorCode: "TEST_NO_FEE", latencyMs: 0 }),
  });
  assert.deepEqual(result.selection.selected.map((s) => s.event.conditionId), ["0xc2", "0xc3", "0xc1"]);
  assert.deepEqual(result.selection.selected.map((s) => s.sportRank), [1, 2, 3]);
  assert.ok(result.rejected.some((r) => r.reason === "SELECTED_TOKEN_NOT_IN_PROVIDER_PAIR" && r.subject === "0xc4"));
  assert.equal(result.selection.diagnostics.soccer_quota_underfill_n, 47);
});

test("module is read-only and never ranks by historical volume, score or settlement", () => {
  const src = readFileSync("lib/research/executableLiquidityCohortT90.ts", "utf8");
  const runner = readFileSync("scripts/research-t90-liquidity-cohort.ts", "utf8");
  for (const code of [src, runner]) {
    assert.doesNotMatch(code, /\.from\(["`]|\.(insert|upsert|rpc)\(|createClient/);
    assert.doesNotMatch(code, /signal_result|market_outcome_current|labelAsOf/);
  }
  assert.doesNotMatch(src, /selectResearchCohort|parentEventVolume|volume_usd|parent_event_volume/);
  assert.match(runner, /method: "GET"/);
  assert.doesNotMatch(runner, /method: "(POST|PATCH|PUT|DELETE)"/);
});
