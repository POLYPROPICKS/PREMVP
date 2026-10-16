import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCeoRows, type LedgerLine } from "../../scripts/modeling/forward-bet-ceo-report";
import {
  forwardContractSummary,
  independentSettlementCounts,
  isForwardContractRow,
  readIndependentTerminals,
  replayCapital,
  resolveSelectedUnresolved,
  selectionMetrics,
  updateSettlements,
} from "../../scripts/modeling/live-shadow-cycle";

const NOW = "2026-10-13T12:00:00.000Z";
const gammaWinsTokenA = (conditionId: string) => ({ conditionId, closed: true, outcomes: ["A", "B"], outcomePrices: ["1", "0"], clobTokenIds: ["token-a", "token-b"] });

const base = {
  row_kind: "LEDGER", model_id: "P50_52_SAFE", model: "P50_52_SAFE", decision_date: "2026-10-13", date: "2026-10-13",
  decisionTimestamp: "2026-10-13T10:00:00.000Z", eventStart: "2026-10-13T14:00:00.000Z", entryPrice: 0.5, sportFamily: "tennis",
  pre_event_score: 70, data_coverage: 80, settlementState: "UNQUERIED", settlement_checked_at: null, settledAt: null, result: null,
  first_persisted_at: null, unresolved_reason: null,
};
const legacy = (key: string, condition: string) => ({ ...base, row_key: key, candidateIdentity: key, physicalEventKey: `ev-${key}`, condition_id: condition, selected_token_id: "token-a" }) as any;
const contract = (key: string, condition: string, over: Record<string, unknown> = {}) => ({
  ...base, row_key: key, candidateIdentity: key, physicalEventKey: `ev-${key}`, condition_id: condition, selected_token_id: "token-a",
  contract_version: "FORWARD_BET_V1", first_persisted_at: "2026-10-13T10:00:01.000Z", ...over,
}) as any;

test("Gamma WIN never assigns a terminal result to a forward-contract row, while legacy rows on the same condition still resolve", async () => {
  const ledger = [legacy("legacy", "cond-a"), contract("fwd", "cond-a")];
  const before = JSON.stringify(ledger);
  const queried: string[][] = [];
  const fetchMarkets = async (ids: readonly string[]) => {
    queried.push([...ids]);
    return { markets: new Map([["cond-a", gammaWinsTokenA("cond-a")]]), respondedConditionIds: new Set(ids), complete: true };
  };
  const first = await resolveSelectedUnresolved(ledger, fetchMarkets, NOW);
  assert.deepEqual(first.updatedRows.map((row) => [row.row_key, row.settlementState]), [["legacy", "WIN"]]);
  // Repeat checks are stable and never touch the stored choice or the contract row.
  const second = await resolveSelectedUnresolved(ledger, fetchMarkets, "2026-10-13T12:30:00.000Z");
  assert.deepEqual(second.updatedRows.map((row) => row.row_key), ["legacy"]);
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(ledger[1].settlementState, "UNQUERIED");
  assert.equal(ledger[1].result, null);
});

test("a contract-only ledger never calls Gamma at all", async () => {
  let called = false;
  const result = await resolveSelectedUnresolved([contract("fwd", "cond-a")], async () => { called = true; throw new Error("must not be called"); }, NOW);
  assert.equal(called, false);
  assert.deepEqual(result, { updatedRows: [], complete: true, queriedConditionN: 0 });
});

test("the legacy settlement writer refuses to persist anything for a contract row", async () => {
  const writes: unknown[] = [];
  const db: any = { from: () => ({ update: (payload: unknown) => { writes.push(payload); const chain: any = { eq: () => chain, then: (resolve: any) => resolve({ error: null }) }; return chain; } }) };
  await updateSettlements(db, [contract("fwd", "cond-a", { settlementState: "WIN", result: "WIN", settledAt: NOW }), legacy("legacy", "cond-b")]);
  assert.equal(writes.length, 1);
});

test("Gamma WIN vs independent CLOB UNKNOWN/LOSS: only the independent journal counts for contract rows", () => {
  // The ledger row even carries a (hypothetical) Gamma WIN; the journal decides.
  const gammaWin = { settlementState: "WIN", result: "WIN", settledAt: NOW };
  const rows = [contract("unknown", "c1", gammaWin), contract("loss", "c2", gammaWin), contract("win", "c3"), contract("void", "c4")];
  const terminals = new Map<string, "WIN" | "LOSS" | "VOID">([["loss", "LOSS"], ["win", "WIN"], ["void", "VOID"]]);
  assert.deepEqual(independentSettlementCounts(rows, terminals), { bet: 4, win: 1, loss: 1, void: 1, unknown: 1 });
  assert.deepEqual(independentSettlementCounts(rows, new Map()), { bet: 4, win: 0, loss: 0, void: 0, unknown: 4 });
  const summary = forwardContractSummary(rows, true, 0, terminals);
  assert.equal(summary.contractRowN, 4);
  assert.deepEqual(summary.independentSettlement, { source: "virtual_bet_settlement_authority", bet: 4, win: 1, loss: 1, void: 1, unknown: 1 });
  assert.deepEqual(summary.economics, { netRoi: "UNPROVEN", priceBasis: "REFERENCE_ONLY" });
});

test("legacy capital replay and legacy tallies exclude contract rows, but the BET is still counted as selected", () => {
  const legacyRows = [legacy("l1", "c1")];
  const withContract = [...legacyRows, contract("fwd-win", "c2", { settlementState: "WIN", result: "WIN", settledAt: NOW, entryPrice: 0.4 }), contract("fwd-noprice", "c3", { entryPrice: Number.NaN })];
  const baselineReplay = replayCapital(legacyRows, NOW).get("P50_52_SAFE")!;
  const mixedReplay = replayCapital(withContract, NOW).get("P50_52_SAFE")!;
  assert.equal(mixedReplay.fixed.pnl, baselineReplay.fixed.pnl);
  assert.equal(mixedReplay.fixed.ledger.length, baselineReplay.fixed.ledger.length);
  assert.equal(mixedReplay.protected.ledger.length, baselineReplay.protected.ledger.length);
  const metrics = selectionMetrics(withContract, "2026-10-13", "P50_52_SAFE", mixedReplay, new Map([["fwd-win", "LOSS"]]));
  assert.equal(metrics.selectedToday, 3);
  assert.equal(metrics.wins, 0);
  assert.equal(metrics.losses, 0);
  assert.equal(metrics.settled, 0);
  assert.equal(metrics.unqueried, 1);
  assert.equal(metrics.fixed.capitalSkips, baselineReplay.fixed.ledger.filter((entry) => entry.stake <= 0).length);
  assert.deepEqual(metrics.forwardBet, { bet: 2, win: 0, loss: 1, void: 0, unknown: 1, economics: "UNPROVEN" });
  assert.equal(isForwardContractRow(withContract[1]), true);
  assert.equal(isForwardContractRow(legacyRows[0]), false);
});

test("CEO report: a Gamma-style ledger WIN on a contract row is not a win without an independent terminal", () => {
  const line = (over: Partial<LedgerLine>): LedgerLine => ({
    row_key: "k", model_id: "P50_52_SAFE", physical_event_key: "g", settlement_state: "UNQUERIED", first_persisted_at: "2026-10-13T10:00:00Z",
    contract_version: "FORWARD_BET_V1", contract_status: "COMPLETE", timing_class: "PRE_START_SCHEDULED_ONLY", executable_buy_price: null,
    executable_price_authority: null, verification_status: "UNVERIFIED:timing_scheduled_only", ...over,
  });
  const ledger = [line({ row_key: "a", physical_event_key: "a", settlement_state: "WIN" }), line({ row_key: "b", physical_event_key: "b", settlement_state: "WIN" })];
  const row = buildCeoRows(ledger, [{ bet_row_key: "b", outcome: "LOSS" }]).find((r) => r.strategy === "P50_52_SAFE")!;
  assert.equal(row.forward.wlvu, "0–1–0–1");
  assert.equal(row.forward.netRoi, "UNPROVEN");
  assert.equal(row.forward.semanticallyValidatedWinPct, "UNPROVEN");
});

test("independent terminal reader tolerates an unapplied schema and pages through the journal", async () => {
  const missing: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: "42P01" } }) }) }) }) }) };
  assert.equal((await readIndependentTerminals(missing)).size, 0);
  const pages = [Array.from({ length: 1000 }, (_, i) => ({ bet_row_key: `k${i}`, outcome: "WIN" })), [{ bet_row_key: "tail", outcome: "LOSS" }, { bet_row_key: "x", outcome: "UNKNOWN" }]];
  let call = 0;
  const paged: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: pages[call++], error: null }) }) }) }) }) };
  const terminals = await readIndependentTerminals(paged);
  assert.equal(terminals.size, 1001);
  assert.equal(terminals.get("tail"), "LOSS");
});
