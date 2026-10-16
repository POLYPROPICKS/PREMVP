import assert from "node:assert/strict";
import { test } from "node:test";

import type { ParsedOrderBook } from "../../lib/liquidity/types";
import { classifyVerification, excludeExistingEconomicUnits, type ForwardCandidate, type ForwardEvidenceSource } from "../../lib/modeling/forwardBetContract";
import {
  evaluateForwardBuy,
  FORWARD_BUY_STAKE_LEDGER,
  FORWARD_BUY_STAKE_USD,
  fillFullStake,
  LEGACY_UNIT_STAKE_USD,
  checkBuyPersistFreshness,
  MAX_DECISION_AFTER_QUOTE_MS,
  MAX_QUOTE_AGE_AT_PERSIST_MS,
  MAX_PROVIDER_QUOTE_AGE_MS,
  summarizeRejections,
  summarizeForwardBuyCycle,
  type BuyFeeAuthority,
  type BuyQuote,
} from "../../lib/modeling/forwardBuyAuthority";
import { acquireAndEvaluateBuy, resolveForwardBuy, type BuyIO } from "../../scripts/modeling/forward-buy-gate";
import { forwardContractSummary, insertChoices, isForwardContractRow, runtimeRow, toDatabaseLedger } from "../../scripts/modeling/live-shadow-cycle";
import type { V4EvidenceRow } from "../../scripts/modeling/prospective-selection-shadow";
import { buildCeoRows, type LedgerLine } from "../../scripts/modeling/forward-bet-ceo-report";

const T0 = Date.parse("2026-10-17T10:00:00.000Z");
const CONDITION = "0xcondition1";
const TOKEN = "tok-selected";
const source: ForwardEvidenceSource = {
  condition_id: CONDITION,
  selected_token_id: TOKEN,
  observed_at: new Date(T0 - 60_000).toISOString(),
  provider_event_id: "evt-1",
  provider_sport_family: "football",
  market_type: "moneyline",
  event_title: "Premier League: Arsenal vs Chelsea",
  market_question: "Will Arsenal win?",
  selected_outcome: "Arsenal",
  game_start_iso: new Date(T0 + 3 * 3_600_000).toISOString(),
};
const candidate: ForwardCandidate = {
  candidateIdentity: `${CONDITION}::${TOKEN}::${source.observed_at}`,
  physicalEventKey: "pek-1",
  decisionTimestamp: source.observed_at,
  eventStart: source.game_start_iso as string,
  entryPrice: 0.51,
  sportFamily: "football",
};
const asks = [{ price: 0.5, size: 3 }, { price: 0.51, size: 10 }, { price: 0.55, size: 100 }];
function book(overrides: Partial<ParsedOrderBook> = {}): ParsedOrderBook {
  return { tokenId: TOKEN, bids: [{ price: 0.49, size: 50 }], asks, tickSize: 0.01, minimumOrderSize: 4, providerTimestampMs: T0 - 2_000, raw: { market: CONDITION, asset_id: TOKEN }, ...overrides };
}
function quote(overrides: Partial<BuyQuote> = {}): BuyQuote {
  return { book: book(), requestStartedAtMs: T0 - 400, receivedAtMs: T0, ...overrides };
}
const fee: BuyFeeAuthority = { ok: true, tokenId: TOKEN, conditionId: CONDITION, feesEnabled: true, takerRate: 0.03, formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID", observedAtIso: new Date(T0).toISOString() };
const decisionAtIso = new Date(T0 + 500).toISOString();
function run(over: Partial<Parameters<typeof evaluateForwardBuy>[0]> = {}) {
  return evaluateForwardBuy({ model: "P50_52_SAFE", source, candidate, quote: quote(), fee, decisionAtIso, ...over });
}
function reason(over: Partial<Parameters<typeof evaluateForwardBuy>[0]> = {}) {
  const result = run(over);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.rejection.reason;
}

test("full-stake VWAP prices the real ask depth, fee on top, stake separate from legacy USD 2", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const shares = 3 + 1 / 0.51;
  assert.ok(Math.abs(result.receipt.shares - shares) < 1e-9);
  assert.ok(Math.abs(result.receipt.vwap - Math.round((2.5 / shares) * 1e6) / 1e6) < 1e-9);
  const fee = 3 * 0.03 * 0.5 * 0.5 + (1 / 0.51) * 0.03 * 0.51 * 0.49;
  assert.ok(Math.abs(result.receipt.fee.usd - fee) < 1e-9);
  assert.ok(Math.abs(result.receipt.allInCostUsd - (2.5 + fee)) < 1e-9);
  assert.equal(result.receipt.stakeUsd, 2.5);
  assert.equal(FORWARD_BUY_STAKE_USD, 2.5);
  assert.equal(LEGACY_UNIT_STAKE_USD, 2);
  assert.equal(result.receipt.stakeLedger, FORWARD_BUY_STAKE_LEDGER);
  assert.equal(result.receipt.depthLevelsUsed, 2);
  assert.equal(result.receipt.bestAsk, 0.5);
  assert.ok(result.receipt.vwap > result.receipt.bestAsk);
  assert.equal(result.columns.executable_price_authority, "CLOB_DEPTH_VWAP");
  assert.equal(result.columns.executable_buy_price, result.receipt.vwap);
  assert.equal(result.receipt.digest.length, 64);
  assert.equal(run().ok && (run() as { receipt: { digest: string } }).receipt.digest, result.receipt.digest);
});

test("time ordering: selection <= quote receipt <= decision; original selection time preserved; provider time recorded", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { receipt, columns } = result;
  assert.ok(Date.parse(receipt.selectionObservedAt) <= Date.parse(receipt.quote.receivedAt));
  assert.ok(Date.parse(receipt.quote.requestStartedAt) <= Date.parse(receipt.quote.receivedAt));
  assert.ok(Date.parse(receipt.quote.receivedAt) <= Date.parse(receipt.decisionAt));
  assert.equal(columns.observed_at, source.observed_at, "SAFE selection observation time is never rewritten");
  assert.equal(columns.reference_price, candidate.entryPrice, "frozen reference price is never rewritten");
  assert.equal(columns.executable_quote_at, receipt.quote.receivedAt);
  assert.equal(columns.provider_quote_at, receipt.quote.providerTimestamp);
  assert.equal(columns.decision_generated_at, receipt.decisionAt);
  assert.ok(Date.parse(columns.decision_generated_at) >= Date.parse(columns.executable_quote_at as string));
  assert.equal(reason({ decisionAtIso: new Date(T0 - 1).toISOString() }), "DECISION_BEFORE_QUOTE");
  assert.equal(reason({ decisionAtIso: new Date(T0 + MAX_DECISION_AFTER_QUOTE_MS + 1).toISOString() }), "DECISION_TOO_LONG_AFTER_QUOTE");
  assert.equal(reason({ quote: quote({ requestStartedAtMs: T0 - 61_000, receivedAtMs: T0 - 60_500, book: book({ providerTimestampMs: T0 - 60_600 }) }), decisionAtIso: new Date(T0 - 60_400).toISOString() }), "QUOTE_BEFORE_SELECTION");
  assert.equal(reason({ quote: quote({ requestStartedAtMs: null }) }), "QUOTE_RECEIPT_MISSING");
  assert.equal(reason({ quote: quote({ requestStartedAtMs: T0 + 5, receivedAtMs: T0 }) }), "QUOTE_RECEIPT_MISSING");
});

test("stale quote and missing or future provider timestamps fail closed", () => {
  assert.equal(reason({ quote: quote({ book: book({ providerTimestampMs: T0 - MAX_PROVIDER_QUOTE_AGE_MS - 1 }) }) }), "STALE_QUOTE");
  assert.equal(reason({ quote: quote({ book: book({ providerTimestampMs: null }) }) }), "QUOTE_PROVIDER_TIME_MISSING");
  assert.equal(reason({ quote: quote({ book: book({ providerTimestampMs: T0 + 60_000 }) }) }), "QUOTE_PROVIDER_TIME_IN_FUTURE");
  assert.equal(reason({ quote: quote({ book: null }) }), "BOOK_UNAVAILABLE");
  assert.equal(reason({ source: { ...source, game_start_iso: new Date(T0 + 60_000).toISOString() } }), "START_NOT_AFTER_DECISION");
});

test("identity mismatch: token, condition, structured MONEYLINE scope and model eligibility", () => {
  assert.equal(reason({ quote: quote({ book: book({ tokenId: "tok-other" }) }) }), "IDENTITY_TOKEN_MISMATCH");
  assert.equal(reason({ quote: quote({ book: book({ raw: { market: "0xother", asset_id: TOKEN } }) }) }), "IDENTITY_CONDITION_MISMATCH");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), conditionId: "0xother" } }), "FEE_SOURCE_MISMATCH");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), conditionId: null } }), "FEE_SOURCE_MISMATCH");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), tokenId: "tok-other" } }), "FEE_SOURCE_MISMATCH");
  assert.equal(reason({ source: { ...source, market_type: "spreads", market_question: "Spread: Arsenal (-1.5)" } }), "IDENTITY_NOT_STRUCTURED_MONEYLINE");
  assert.equal(reason({ source: { ...source, market_type: null } }), "IDENTITY_NOT_STRUCTURED_MONEYLINE");
  assert.equal(reason({ source: { ...source, market_question: "Will Arsenal win the first half?", market_type: "first_half_moneyline" } }), "IDENTITY_NOT_STRUCTURED_MONEYLINE");
  assert.equal(reason({ source: { ...source, selected_token_id: "" } }), "IDENTITY_NOT_STRUCTURED_MONEYLINE");
  for (const model of ["QUALITY_FILL_A_SAFE", "PORTFOLIO_BROAD_SAFE", "TENNIS_P50_52_SAFE", "UNKNOWN"]) assert.equal(reason({ model }), "MODEL_NOT_BUY_ENABLED");
  assert.equal(run({ model: "QUALITY_FILL_D_SAFE" }).ok, true);
});

test("book-side identity fails closed when the provider omits asset_id or market, even though parseOrderBook echoes the hint", () => {
  assert.equal(reason({ quote: quote({ book: book({ raw: { market: CONDITION } }) }) }), "IDENTITY_TOKEN_MISMATCH");
  assert.equal(reason({ quote: quote({ book: book({ raw: { market: CONDITION, asset_id: "tok-other" } }) }) }), "IDENTITY_TOKEN_MISMATCH");
  assert.equal(reason({ quote: quote({ book: book({ raw: { asset_id: TOKEN } }) }) }), "IDENTITY_CONDITION_UNVERIFIED");
  assert.equal(reason({ quote: quote({ book: book({ raw: null }) }) }), "IDENTITY_TOKEN_MISMATCH");
  assert.equal(reason({ quote: quote({ book: book({ minimumOrderSize: null }) }) }), "MIN_ORDER_SIZE_UNKNOWN");
  assert.equal(reason({ source: { ...source, observed_at: "not-a-date" } }), "QUOTE_BEFORE_SELECTION");
});

test("persist-time freshness: a quote decided long before the batch insert, or a start that has come close, gets no row", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const quoteMs = Date.parse(result.columns.executable_quote_at);
  assert.equal(checkBuyPersistFreshness(result.columns, quoteMs + 5_000), null);
  assert.equal(checkBuyPersistFreshness(result.columns, quoteMs + MAX_QUOTE_AGE_AT_PERSIST_MS + 1)?.reason, "STALE_AT_PERSIST");
  assert.equal(checkBuyPersistFreshness({ ...result.columns, scheduled_start_at: new Date(quoteMs + 200_000).toISOString() }, quoteMs + 5_000)?.reason, "START_NOT_AFTER_DECISION");
  assert.equal(checkBuyPersistFreshness({ ...result.columns, scheduled_start_at: null }, quoteMs + 5_000)?.reason, "START_NOT_AFTER_DECISION");
});

test("database payload for a BUY row carries the executable columns and none of the DB-computed verification fields", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const row = runtimeRow("P50_52_SAFE", "2026-10-17", candidate, source as V4EvidenceRow, { scoreLevel: 1, dataCoverage: 1 }, result.columns.decision_generated_at, result.columns);
  const payload = toDatabaseLedger(row);
  assert.equal(payload.executable_buy_price, result.receipt.vwap);
  assert.equal(payload.executable_price_authority, "CLOB_DEPTH_VWAP");
  assert.equal(payload.executable_quote_at, result.receipt.quote.receivedAt);
  assert.equal(payload.provider_quote_at, result.receipt.quote.providerTimestamp);
  assert.equal(payload.contract_version, "FORWARD_BET_V1");
  assert.equal(payload.candidate_identity, candidate.candidateIdentity);
  assert.equal(payload.decision_timestamp, candidate.decisionTimestamp, "SAFE selection time column is the original observation");
  for (const key of ["verification_status", "timing_class", "contract_status", "timing_detail", "first_persisted_at", "observation_lag_seconds"]) assert.equal(key in payload, false, key);
});

test("a concurrent same-key same-VWAP row cannot authorize a BUY without an immutable receipt", async () => {
  const evaluated = run();
  assert.equal(evaluated.ok, true);
  if (!evaluated.ok) return;
  const row = runtimeRow("P50_52_SAFE", "2026-10-17", candidate, source as V4EvidenceRow, { scoreLevel: 1, dataCoverage: 1 }, evaluated.columns.decision_generated_at, evaluated.columns);
  const payload = toDatabaseLedger(row);
  // Another writer already owns this key/price, but with a different quote/decision.
  const winner: Record<string, unknown> = { ...payload, executable_quote_at: new Date(T0 - 500).toISOString(), decision_generated_at: new Date(T0 - 400).toISOString() };
  assert.equal(winner.row_key, payload.row_key);
  assert.equal(winner.executable_buy_price, evaluated.receipt.vwap);
  assert.notEqual(winner.executable_quote_at, evaluated.receipt.quote.receivedAt);
  let writes = 0;
  const db = { from: () => ({ upsert: () => {
    writes++;
    return { select: async () => ({ data: [], error: null }) }; // ignored row-key conflict
  } }) } as any;
  await assert.rejects(insertChoices(db, [payload]), /FORWARD_BUY_IMMUTABLE_RECEIPT_REQUIRED/);
  assert.equal(writes, 0, "a mutable CURRENT receipt must never enable a BUY ledger write");
});

test("an executable BUY mixed with legacy rows fails before any database write", async () => {
  let calls = 0;
  const db = { from: () => { calls++; throw Error("must not reach database"); } } as any;
  await assert.rejects(insertChoices(db, [
    { row_key: "legacy" },
    { row_key: "buy", contract_version: "FORWARD_BET_V1", executable_buy_price: 0.5 },
  ]), /FORWARD_BUY_IMMUTABLE_RECEIPT_REQUIRED/);
  assert.equal(calls, 0);
});

test("passing quote diagnostics never become persisted or executable BUY authority in CURRENT", () => {
  const evaluated = run();
  assert.equal(evaluated.ok, true);
  if (!evaluated.ok) return;
  const summary = summarizeForwardBuyCycle(25, Array.from({ length: 25 }, () => evaluated.receipt), []);
  assert.equal(summary.passedEvaluationN, 25);
  assert.equal(summary.persistedN, 0);
  assert.equal(summary.executableBuyN, 0);
  assert.equal(summary.receiptAuthority, "UNPROVEN_IMMUTABLE_RECEIPT_REQUIRED");
  assert.deepEqual(summary.receipts, []);
  assert.equal(summary.diagnosticQuoteReceipts.length, 20);
});

test("a stored executable-price column cannot regain authority through the contract-summary fallback", () => {
  const summary = forwardContractSummary([
    { row_key: "old-buy", row_kind: "LEDGER", contract_version: "FORWARD_BET_V1", executable_buy_price: 0.5 } as any,
  ], true, 0);
  assert.equal(summary.executableAuthorityN, 0);
  assert.equal(summary.executablePriceObservationN, 1);
  assert.equal(summary.executableAuthorityStatus, "UNPROVEN_IMMUTABLE_RECEIPT_REQUIRED");
  assert.equal(summary.economics.netRoi, "UNPROVEN");
});

test("the CEO report cannot promote price-only rows to executable economics through its fallback", () => {
  const row: LedgerLine = {
    row_key: "old-buy", model_id: "P50_52_SAFE", physical_event_key: "fixture", canonical_game_key: "game:fixture",
    settlement_state: null, first_persisted_at: new Date(T0).toISOString(), contract_version: "FORWARD_BET_V1",
    contract_status: "COMPLETE", timing_class: "PRE_START_AUTHORITATIVE", verification_status: "VERIFIED",
    game_identity_basis: "PROVIDER_ROOT_CONFIRMED", executable_buy_price: 0.5, executable_price_authority: "CLOB_DEPTH_VWAP",
  };
  const summary = buildCeoRows([row], [{ bet_row_key: row.row_key, outcome: "WIN" }]).find((r) => r.strategy === row.model_id)!;
  assert.equal(summary.forward.gross, "UNPROVEN");
  assert.equal(summary.forward.fees, "UNPROVEN");
  assert.equal(summary.forward.netRoi, "UNPROVEN");
});

test("insufficient depth is never a partial BUY; minimum order size is enforced", () => {
  assert.deepEqual(fillFullStake([{ price: 0.5, size: 4 }], 2.5, 0.03), { filled: false, availableUsd: 2 });
  assert.equal(reason({ quote: quote({ book: book({ asks: [{ price: 0.5, size: 4 }, { price: 0.51, size: 0.5 }] }) }) }), "INSUFFICIENT_DEPTH");
  assert.equal(reason({ quote: quote({ book: book({ asks: [] }) }) }), "NO_ASKS");
  assert.equal(reason({ quote: quote({ book: book({ minimumOrderSize: 50 }) }) }), "BELOW_MIN_ORDER_SIZE");
  // Live CLOB books report min_order_size "5" shares: USD 2.50 buys at most 5 shares only at an ask of 0.50 or below, so any
  // blended fill above 0.50 is below the provider minimum and stays rejected (fail closed, never rounded up to a larger stake).
  assert.equal(reason({ quote: quote({ book: book({ minimumOrderSize: 5 }) }) }), "BELOW_MIN_ORDER_SIZE");
  assert.equal(run({ quote: quote({ book: book({ minimumOrderSize: 5, asks: [{ price: 0.5, size: 100 }] }) }) }).ok, true);
  assert.equal(reason({ quote: quote({ book: book({ minimumOrderSize: 1, asks: [{ price: 0.9, size: 100 }] }) }) }), "PRICE_MOVED_AGAINST_REFERENCE");
  const rejected = run({ quote: quote({ book: book({ asks: [{ price: 0.5, size: 4 }] }) }) });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.deepEqual([rejected.rejection.diagnostics.depthAvailableUsd, rejected.rejection.diagnostics.neededUsd], [2, 2.5]);
});

test("fee authority: unknown, out of bounds, stale and post-decision fees reject", () => {
  assert.equal(reason({ fee: { ok: false, errorCode: "FEE_MARKET_NOT_FOUND" } }), "FEE_UNKNOWN");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), takerRate: 0.2 } }), "FEE_OUT_OF_BOUNDS");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), takerRate: Number.NaN } }), "FEE_OUT_OF_BOUNDS");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), feesEnabled: false, takerRate: 0.03 } }), "FEE_OUT_OF_BOUNDS");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), observedAtIso: new Date(T0 - 120_000).toISOString() } }), "FEE_STALE");
  assert.equal(reason({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), observedAtIso: new Date(T0 + 5_000).toISOString() } }), "FEE_AFTER_DECISION");
  const free = run({ fee: { ...(fee as Extract<BuyFeeAuthority, { ok: true }>), feesEnabled: false, takerRate: 0 } });
  assert.equal(free.ok && free.receipt.fee.usd, 0);
});

test("duplicate economic units: held unit, same-fixture market shards and cross-date reselection never double-count", () => {
  const key = (run() as { columns: { economic_unit_key: string } }).columns.economic_unit_key;
  assert.ok(key.includes("arsenal|chelsea"));
  assert.equal(reason({ heldEconomicUnits: new Set([key]) }), "DUPLICATE_ECONOMIC_UNIT");
  // Another market shard of the same fixture (different provider event id and condition) resolves to the SAME economic unit.
  const shard = { ...source, provider_event_id: "evt-1-more-markets", condition_id: "0xcondition2", market_question: "Will Chelsea win?" };
  assert.equal(reason({ source: shard, heldEconomicUnits: new Set([key]) }), "DUPLICATE_ECONOMIC_UNIT");
  const second = excludeExistingEconomicUnits("P50_52_SAFE", [{ physicalEventKey: "pek-2" }], [{ model_id: "P50_52_SAFE", physicalEventKey: "pek-1", canonical_game_key: key }], () => key);
  assert.deepEqual([second.fresh.length, second.blockedDuplicateUnitN], [0, 1]);
  const otherModel = excludeExistingEconomicUnits("QUALITY_FILL_D_SAFE", [{ physicalEventKey: "pek-2" }], [{ model_id: "P50_52_SAFE", physicalEventKey: "pek-1", canonical_game_key: key }], () => key);
  assert.equal(otherModel.fresh.length, 1, "the unit is per model, matching the database unique index");
  const unknownUnit = run({ source: { ...source, event_title: null, provider_event_id: null, game_start_iso: source.game_start_iso, market_question: "Will Arsenal win?" } });
  assert.equal(unknownUnit.ok, false);
  if (!unknownUnit.ok) assert.equal(unknownUnit.rejection.reason, "ECONOMIC_UNIT_UNKNOWN");
});

test("a BUY never promotes incomplete identity to VERIFIED, and carries no verification fields", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const key of ["verification_status", "timing_class", "contract_status", "timing_detail", "first_persisted_at"]) assert.equal(key in result.columns, false, key);
  assert.equal(result.columns.game_identity_basis, "TEAM_PAIR_START_DEDUP");
  assert.equal(result.columns.authoritative_start_at, null);
  const verdict = classifyVerification({ contractStatus: "COMPLETE", timingClass: "PRE_START_SCHEDULED_ONLY", gameIdentityBasis: result.columns.game_identity_basis, scopeBasis: result.columns.scope_basis });
  assert.equal(verdict.verified, false);
  assert.deepEqual(verdict.unprovenLinks, ["timing_scheduled_only", "game_identity_dedup_only"]);
});

test("failed candidates produce no contract columns; rejection diagnostics are bounded and carry no raw book", () => {
  const big = book({ asks: Array.from({ length: 500 }, (_, i) => ({ price: 0.6 + i * 0.0001, size: 0.001 })) });
  const result = run({ quote: quote({ book: big }) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("columns" in result, false);
  assert.equal(result.rejection.reason, "INSUFFICIENT_DEPTH");
  const serialized = JSON.stringify(result.rejection);
  assert.ok(serialized.length < 600, serialized.length.toString());
  assert.ok(Object.keys(result.rejection.diagnostics).length <= 13);
  assert.ok(Object.values(result.rejection.diagnostics).every((value) => typeof value !== "string" || value.length <= 80));
  const many = Array.from({ length: 100 }, () => result.rejection);
  const summary = summarizeRejections(many);
  assert.deepEqual([summary.total, summary.byReason.INSUFFICIENT_DEPTH, summary.samples.length], [100, 100, 20]);
});

test("IO gate: decision is stamped after the quote receipt; ineligible identity costs no network call; flag is clone-origin only", async () => {
  let calls = 0;
  const clock = [T0 + 300];
  const io: BuyIO = {
    fetchBook: (async () => { calls += 1; return { ok: true, tokenId: TOKEN, latencyMs: 400, book: book(), requestStartedAtMs: T0 - 400, responseCompletedAtMs: T0 }; }) as BuyIO["fetchBook"],
    fetchFee: (async () => { calls += 1; return { ok: true, tokenId: TOKEN, conditionId: CONDITION, feesEnabled: true, takerRate: 0.03, exponent: 1, feeType: null, formulaVersion: "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1", source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID", observedAtIso: new Date(T0).toISOString(), latencyMs: 100 }; }) as BuyIO["fetchFee"],
    nowMs: () => clock[0],
  };
  const ok = await acquireAndEvaluateBuy({ model: "QUALITY_FILL_D_SAFE", source, candidate, io });
  assert.equal(ok.ok, true);
  assert.equal(calls, 2);
  if (ok.ok) assert.ok(Date.parse(ok.receipt.decisionAt) >= Date.parse(ok.receipt.quote.receivedAt));
  calls = 0;
  const skipped = await acquireAndEvaluateBuy({ model: "P50_52_SAFE", source: { ...source, market_type: "totals", market_question: "O/U 2.5" }, candidate, io });
  assert.equal(skipped.ok, false);
  assert.equal(calls, 0);
  const failedBook = await acquireAndEvaluateBuy({ model: "P50_52_SAFE", source, candidate, io: { ...io, fetchBook: (async () => ({ ok: false, tokenId: TOKEN, latencyMs: 1, errorCode: "TIMEOUT" })) as BuyIO["fetchBook"] } });
  assert.equal(failedBook.ok === false && failedBook.rejection.reason, "BOOK_UNAVAILABLE");
  const beforeReceipt = await acquireAndEvaluateBuy({ model: "P50_52_SAFE", source, candidate, io: { ...io, nowMs: () => T0 - 1 } });
  assert.equal(beforeReceipt.ok === false && beforeReceipt.rejection.reason, "DECISION_BEFORE_QUOTE");

  assert.equal(resolveForwardBuy([], "CLONE_ORIGIN"), false);
  assert.equal(resolveForwardBuy(["--origin=clone", "--forward-buy"], "CLONE_ORIGIN"), true);
  assert.throws(() => resolveForwardBuy(["--forward-buy"], "PRODUCTION_TO_CLONE"), /FORWARD_BUY_REQUIRES_CLONE_ORIGIN/);
  assert.throws(() => resolveForwardBuy(["--forward-buy=1"], "CLONE_ORIGIN"), /UNKNOWN_FORWARD_BUY_FLAG/);
});

test("legacy settlement isolation: a BUY row is a forward-contract row, so Gamma settlement and legacy capital replay never see it", () => {
  const result = run();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isForwardContractRow({ contract_version: result.columns.contract_version }), true);
  assert.equal(result.columns.decision_kind, "BET");
  assert.equal(result.columns.contract_version, "FORWARD_BET_V1");
});
