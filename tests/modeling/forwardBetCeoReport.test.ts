import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCeoRows, MIN_FORWARD_GAMES_FOR_VERDICT, renderFunnelMarkdown, renderMarkdown, type LedgerLine } from "../../scripts/modeling/forward-bet-ceo-report";

const line = (over: Partial<LedgerLine>): LedgerLine => ({
  row_key: "k", model_id: "P50_52_SAFE", physical_event_key: "g", settlement_state: "UNQUERIED", first_persisted_at: null,
  contract_version: null, contract_status: null, timing_class: null, executable_buy_price: null, executable_price_authority: null, ...over,
});
const contract = (key: string, over: Partial<LedgerLine> = {}): LedgerLine => line({
  row_key: key, physical_event_key: key, canonical_game_key: `game:${key}`, first_persisted_at: "2026-10-13T10:00:00Z", contract_version: "FORWARD_BET_V1",
  contract_status: "COMPLETE", timing_class: "PRE_START_SCHEDULED_ONLY", game_identity_basis: "TEAM_PAIR_START_DEDUP",
  verification_status: "UNVERIFIED:timing_scheduled_only,game_identity_dedup_only", ...over,
});

test("scheduled-only text-identity BETs are recorded and DB-first but are neither authoritative nor verified independent games", () => {
  const ledger = [
    line({ row_key: "h1", settlement_state: "WIN", physical_event_key: "h1" }),
    line({ row_key: "h2", settlement_state: "LOSS", physical_event_key: "h2" }),
    line({ row_key: "legacy", first_persisted_at: "2026-10-12T12:31:00Z", physical_event_key: "lf" }),
    contract("f1"),
    contract("f2", { timing_class: "LATE_OR_REPLAY", verification_status: "UNVERIFIED:timing_late_or_replay,game_identity_dedup_only" }),
    contract("f3", { contract_status: "INCOMPLETE:line_value", verification_status: "UNVERIFIED:contract_incomplete,timing_scheduled_only,game_identity_dedup_only" }),
    contract("a1", { timing_class: "PRE_START_AUTHORITATIVE", game_identity_basis: "PROVIDER_ROOT_CONFIRMED", verification_status: "VERIFIED" }),
  ];
  const [row] = buildCeoRows(ledger, [{ bet_row_key: "f1", outcome: "WIN" }, { bet_row_key: "a1", outcome: "LOSS" }]);
  assert.equal(row.historical.bet, 2);
  assert.equal(row.historical.originalWinPct, "50.0%");
  assert.equal(row.historical.semanticallyValidatedWinPct, "UNPROVEN");
  assert.equal(row.legacyForwardWithoutContract.bet, 1);
  assert.deepEqual({ ...row.funnel, settled: undefined, unprovenLinks: undefined }, {
    recordedBet: 7, dbFirstPersisted: 5, scheduledOnlyPreMatch: 2, authoritativelyProvenPreMatchGames: 1, verifiedIndependentGames: 1,
    settled: undefined, lateOrReplay: 1, timingUnproven: 0, unprovenLinks: undefined,
  });
  assert.equal(row.funnel.settled.contractWlvu, "1–1–0–2");
  assert.equal(row.funnel.settled.verifiedWlvu, "0–1–0–0");
  assert.deepEqual(row.funnel.unprovenLinks, { timing_scheduled_only: 2, game_identity_dedup_only: 3, timing_late_or_replay: 1, contract_incomplete: 1 });
  // the win% that counts is verified-only; the settlement-only figure is labelled as unverified scope
  assert.equal(row.forward.semanticallyValidatedWinPct, "0.0%");
  assert.equal(row.forward.settlementOnlyWinPctUnverifiedScope, "50.0%");
  assert.equal(row.forward.netRoi, "UNPROVEN");
  assert.equal(row.forward.furtherGamesNeeded, MIN_FORWARD_GAMES_FOR_VERDICT - 1);
  assert.equal(row.forward.verdict, "NO_VERDICT_INSUFFICIENT_FORWARD_SAMPLE");
});

test("only scheduled-only contract BETs: zero authoritative games, zero independent games, explicit verdict", () => {
  const [row] = buildCeoRows([contract("s1"), contract("s2")], []);
  assert.equal(row.funnel.scheduledOnlyPreMatch, 2);
  assert.equal(row.funnel.authoritativelyProvenPreMatchGames, 0);
  assert.equal(row.funnel.verifiedIndependentGames, 0);
  assert.equal(row.forward.independentProvenGames, 0);
  assert.equal(row.forward.semanticallyValidatedWinPct, "UNPROVEN");
  assert.equal(row.forward.verdict, "FORWARD_RECORDED_NOT_VERIFIED");
  assert.equal(buildCeoRows([], [])[0].forward.verdict, "NO_FORWARD_CONTRACT_BETS_YET");
  const verifiedPending = buildCeoRows([contract("v1", { timing_class: "PRE_START_AUTHORITATIVE", game_identity_basis: "PROVIDER_ROOT_CONFIRMED", verification_status: "VERIFIED" })], [])[0];
  assert.equal(verifiedPending.forward.verdict, "TERMINAL_OUTCOME_PENDING");
  const md = renderFunnelMarkdown(buildCeoRows([contract("s1")], []));
  assert.match(md, /Все записанные BET \| DB-first/);
  assert.match(md, /timing_scheduled_only:1, game_identity_dedup_only:1/);
  assert.match(renderMarkdown("t", buildCeoRows([], [])), /Gross \| Fees \| Net ROI/);
});
