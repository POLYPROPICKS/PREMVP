import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyClobSettlement, reconcileSettlement, type StoredSettlementCheck } from "../../lib/modeling/virtualBetSettlement";
import { runSettlementAuthority } from "../../scripts/modeling/virtual-bet-settlement-authority";

const bet = { conditionId: "0xCOND", selectedTokenId: "tok-a" };
const market = (over: Record<string, unknown> = {}, winnerId: string | null = "tok-a") => ({
  condition_id: "0xcond", closed: true, is_50_50_outcome: false,
  tokens: [{ token_id: "tok-a", outcome: "A", price: winnerId === "tok-a" ? 1 : 0, winner: winnerId === "tok-a" }, { token_id: "tok-b", outcome: "B", price: winnerId === "tok-b" ? 1 : 0, winner: winnerId === "tok-b" }],
  ...over,
});

test("exact winner token decides WIN / LOSS with independent CLOB authority", () => {
  const win = classifyClobSettlement(bet, market());
  assert.deepEqual([win.check_kind, win.outcome, win.source_authority, win.independent_of_selection, win.winner_token_id], ["TERMINAL", "WIN", "CLOB_WINNER_TOKEN", true, "tok-a"]);
  const loss = classifyClobSettlement(bet, market({}, "tok-b"));
  assert.deepEqual([loss.outcome, loss.winner_token_id], ["LOSS", "tok-b"]);
});

test("absence of a result is UNKNOWN, never LOSS; open, mismatched or ambiguous answers are never terminal", () => {
  assert.deepEqual([classifyClobSettlement(bet, null).check_kind, classifyClobSettlement(bet, null).outcome], ["DIAGNOSTIC", "UNKNOWN"]);
  const open = classifyClobSettlement(bet, market({ closed: false }, null));
  assert.deepEqual([open.check_kind, open.outcome, open.reason], ["PENDING", "UNKNOWN", "MARKET_NOT_CLOSED"]);
  assert.equal(classifyClobSettlement(bet, market({ condition_id: "0xother" })).reason, "CONDITION_MISMATCH");
  assert.equal(classifyClobSettlement({ ...bet, selectedTokenId: "tok-z" }, market()).reason, "SELECTED_TOKEN_NOT_IN_MARKET");
  const noWinner = classifyClobSettlement(bet, market({}, null));
  assert.deepEqual([noWinner.check_kind, noWinner.outcome, noWinner.reason], ["DIAGNOSTIC", "UNRESOLVED", "CLOSED_WITHOUT_WINNER"]);
  const two = classifyClobSettlement(bet, market({ tokens: [{ token_id: "tok-a", winner: true, price: 1 }, { token_id: "tok-b", winner: true, price: 1 }] }));
  assert.equal(two.reason, "CLOSED_WITH_MULTIPLE_WINNERS");
});

test("provider 50-50 resolution is VOID, not a win or loss", () => {
  const void5050 = classifyClobSettlement(bet, market({ is_50_50_outcome: true, tokens: [{ token_id: "tok-a", price: 0.5, winner: false }, { token_id: "tok-b", price: 0.5, winner: false }] }, null));
  assert.deepEqual([void5050.check_kind, void5050.outcome, void5050.source_authority], ["TERMINAL", "VOID", "CLOB_5050"]);
});

test("Gamma is auxiliary: it supplies a resolution time, and a disagreement blocks the terminal result", () => {
  const agree = classifyClobSettlement(bet, market(), { closed: true, closedTime: "2026-10-12 19:30:00+00", outcomePrices: '["1","0"]', clobTokenIds: '["tok-a","tok-b"]' });
  assert.equal(agree.outcome, "WIN");
  assert.equal(agree.provider_resolved_at, "2026-10-12T19:30:00.000Z");
  const disagree = classifyClobSettlement(bet, market(), { closed: true, outcomePrices: '["0","1"]', clobTokenIds: '["tok-a","tok-b"]' });
  assert.deepEqual([disagree.check_kind, disagree.outcome, disagree.reason], ["DIAGNOSTIC", "UNRESOLVED", "GAMMA_CLOB_DISAGREE"]);
  const gammaOnlyWin = classifyClobSettlement(bet, market({ closed: false }, null), { closed: true, outcomePrices: '["1","0"]', clobTokenIds: '["tok-a","tok-b"]' });
  assert.equal(gammaOnlyWin.check_kind, "PENDING");
});

const stored = (over: Partial<StoredSettlementCheck>): StoredSettlementCheck => ({ check_id: 1, checked_at: "2026-10-12T20:00:00Z", check_kind: "TERMINAL", outcome: "WIN", reason: "CLOB_EXACT_WINNER_TOKEN", provider_digest: "d", ...over });

test("reconciliation is idempotent and records contradictions without rewriting the terminal row", () => {
  const now = Date.parse("2026-10-12T21:00:00Z");
  const win = classifyClobSettlement(bet, market());
  assert.equal(reconcileSettlement([], win, now).action, "INSERT");
  assert.equal(reconcileSettlement([stored({ provider_digest: win.provider_digest })], win, now).action, "SKIP_IDENTICAL");
  const flipped = classifyClobSettlement(bet, market({}, "tok-b"));
  const conflict = reconcileSettlement([stored({ provider_digest: win.provider_digest })], flipped, now);
  assert.equal(conflict.action, "INSERT_CONFLICT");
  assert.equal((conflict as any).check.check_kind, "CONFLICT");
  assert.equal((conflict as any).check.conflicts_with_check_id, 1);
  const reopened = reconcileSettlement([stored({})], classifyClobSettlement(bet, market({ closed: false }, null)), now);
  assert.equal(reopened.action, "INSERT_CONFLICT");
  assert.equal((reopened as any).check.outcome, "UNRESOLVED");
  // the same contradiction is not recorded twice
  const again = reconcileSettlement([stored({}), stored({ check_id: 2, check_kind: "CONFLICT", outcome: "LOSS", reason: `CONFLICT_WITH_TERMINAL:${flipped.reason}`, provider_digest: flipped.provider_digest })], flipped, now);
  assert.equal(again.action, "SKIP_IDENTICAL");
  // pending answers are recorded on change or once per 24h, not on every cycle
  const pending = classifyClobSettlement(bet, market({ closed: false }, null));
  const lastPending = stored({ check_kind: "PENDING", outcome: "UNKNOWN", reason: pending.reason, provider_digest: pending.provider_digest, checked_at: "2026-10-12T20:30:00Z" });
  assert.equal(reconcileSettlement([lastPending], pending, now).action, "SKIP_IDENTICAL");
  assert.equal(reconcileSettlement([lastPending], pending, Date.parse("2026-10-13T21:00:00Z")).action, "INSERT");
});

function memoryDb() {
  const bets = [{ row_key: "B1", condition_id: "0xcond", selected_token_id: "tok-a", model_id: "P50_52_SAFE" }];
  const checks: any[] = [];
  let id = 0;
  const db = {
    from(table: string) {
      const filter: Record<string, unknown> = {};
      const builder: any = {
        select: () => builder, eq: (k: string, v: unknown) => { filter[k] = v; return builder; }, not: () => builder, order: () => builder, in: () => builder, limit: () => Promise.resolve({ data: [], error: null }),
        range: () => Promise.resolve({ data: table === "prospective_selection_shadow_runtime" ? bets : [], error: null }),
        then: (resolve: any) => resolve({ data: table === "virtual_bet_settlement_authority" ? [...checks].reverse() : bets, error: null }),
        insert: (row: any) => {
          if (row.check_kind === "TERMINAL" && checks.some((c) => c.bet_row_key === row.bet_row_key && c.check_kind === "TERMINAL")) return Promise.resolve({ error: { code: "23505" } });
          checks.push({ ...row, check_id: ++id, checked_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return { db: db as any, checks };
}

test("settlement runner: pending -> terminal -> repeat is idempotent, one terminal economic outcome, no schema = no-op", async () => {
  const now = new Date();
  const state = { closed: false, winner: null as string | null };
  const fetchMarket = async () => market({ closed: state.closed }, state.winner);
  const fetchAux = async () => null;
  const { db, checks } = memoryDb();
  const first = await runSettlementAuthority(db, now, fetchMarket as any, fetchAux);
  assert.equal(first.pendingOrDiagnosticRecorded, 1);
  assert.equal(checks.at(-1).outcome, "UNKNOWN");
  state.closed = true; state.winner = "tok-a";
  const second = await runSettlementAuthority(db, now, fetchMarket as any, fetchAux);
  assert.equal(second.terminalInserted, 1);
  const third = await runSettlementAuthority(db, now, fetchMarket as any, fetchAux);
  assert.deepEqual([third.terminalInserted, third.skippedIdentical], [0, 1]);
  assert.equal(checks.filter((c) => c.check_kind === "TERMINAL").length, 1);
  state.winner = "tok-b";
  const fourth = await runSettlementAuthority(db, now, fetchMarket as any, fetchAux);
  assert.equal(fourth.conflictsRecorded, 1);
  assert.equal(checks.filter((c) => c.check_kind === "TERMINAL").length, 1);
  assert.equal(checks.find((c) => c.check_kind === "TERMINAL").outcome, "WIN");
  const missing = await runSettlementAuthority({ from: () => ({ select: () => ({ limit: () => Promise.resolve({ error: { code: "PGRST205" } }) }) }) } as any, now, fetchMarket as any, fetchAux);
  assert.equal(missing.schemaApplied, false);
});
