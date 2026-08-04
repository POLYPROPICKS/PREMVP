import { test } from "node:test";
import assert from "node:assert/strict";

import { produceContractAPlanningDecisions } from "../../lib/executor/contractADecisions";
import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const START = "2026-07-27T21:00:00.000Z";
const NOW = Date.parse("2026-07-27T20:00:00.000Z");

const exactSource = {
  id: "00000000-0000-4000-8000-000000000001",
  condition_id: "cond-exact",
  selected_token_id: "token-exact",
  token_id: "token-exact",
  selected_outcome: "Yankees",
  score: 80,
  signal_confidence_num: 70,
  smart_money_score_num: null,
  entry_price_num: 0.42,
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-27T19:30:00.000Z",
  expires_at: START,
  signal_result: null,
  event_slug: "mlb-nyy-phi-2026-07-27",
  market_slug: "New York Yankees vs Philadelphia Phillies - Moneyline",
  diagnostics: { gameStartIso: START, dataCoverage: 60, shadowScope: "baseball" },
};

function at<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(value?: string | number | Date) { super(value ?? NOW); }
    static now() { return NOW; }
  }
  globalThis.Date = FixedDate as DateConstructor;
  return fn().finally(() => { globalThis.Date = RealDate; });
}

function repoFor(reservation: NightEventReservationRow): RebalanceRepoPort & { rows: EventExecutionQueueRow[] } {
  const rows: EventExecutionQueueRow[] = [];
  return {
    rows,
    async loadActiveReservations() { return [reservation]; },
    async loadQueuedReservationIds() { return new Set<string>(); },
    async markReservationsExpired() {},
    async markReservationSkipped() {},
    async markReservationQueued() {},
    async insertQueueRow(row) { rows.push(row); },
  };
}

test("C1 RED: a persisted Step B Reservation reaches Contract A final identity, refreshes its exact token, and queues one immutable instruction", async () => {
  const [planning] = await at(() => produceContractAPlanningDecisions([exactSource]));
  assert.equal(planning.accepted, true);
  if (!planning.accepted) return;

  const reservation: NightEventReservationRow = {
    id: "reservation-exact",
    physical_event_id: planning.decision.physical_event_id,
    event_start_iso: planning.decision.event_start_iso,
    plan_run_id: "plan-c1",
    plan_date_minsk: "2026-07-27",
    window_start_iso: "2026-07-27T17:00:00.000Z",
    window_end_iso: "2026-07-28T05:00:00.000Z",
    match_family_key: planning.decision.physical_event_id,
    event_slug: exactSource.event_slug,
    event_title: "New York Yankees vs Philadelphia Phillies",
    sport: "baseball",
    league: null,
    strategic_scope: "MLB",
    game_start_iso: START,
    event_tier: planning.decision.planning_tier,
    event_score: planning.decision.planning_score,
    best_snapshot_id: exactSource.id,
    reservation_rank: planning.decision.planning_rank,
    status: "RESERVED",
    selection_reason: "CONTRACT_A_PLANNING_DECISION",
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      reservation_authority: "CONTRACT_A_PLANNING_DECISION",
      source_lineage: planning.decision.source_lineage,
    },
  };
  const repo = repoFor(reservation);
  let finalIdentityCalls = 0;
  let orderbookCalls = 0;
  const boundedRows = [
    exactSource,
    { ...exactSource, id: "00000000-0000-4000-8000-000000000002", condition_id: "cond-sibling", token_id: "token-sibling", selected_token_id: "token-sibling", diagnostics: { ...exactSource.diagnostics, gameStartIso: "2026-07-27T22:00:00.000Z" } },
    { ...exactSource, id: "00000000-0000-4000-8000-000000000003", condition_id: "cond-wrong-market", token_id: "token-wrong-market", selected_token_id: "token-wrong-market", selected_outcome: "Phillies" },
  ];
  const finalCandidates = await at(() => buildFireModelCandidates(100, "all", true, boundedRows, "CONTRACT_A_V1"));

  const result = await runEventRebalance(NOW, { write: true }, {
    repo,
    // The production implementation must consume bounded raw rows through the
    // real final-decision producer, never a completed Queue-row fixture.
    fetchCandidates: async () => finalCandidates,
    fetchContractAFinalCandidates: async () => finalCandidates,
    fetchFinalIdentitySourceRows: async () => boundedRows,
    onFinalIdentityAttempt: () => { finalIdentityCalls += 1; },
    fetchExactTokenOrderbook: async (tokenId: string) => {
      orderbookCalls += 1;
      assert.equal(tokenId, "token-exact");
      return { ok: true, tokenId, latencyMs: 7, book: { tokenId, bids: [{ price: 0.41, size: 20 }], asks: [{ price: 0.42, size: 20 }] } };
    },
  } as any);

  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal(repo.rows.length, 1);
  assert.equal(finalIdentityCalls, 1);
  assert.equal(orderbookCalls, 1);
  assert.equal(repo.rows[0].diagnostics.physical_event_id, planning.decision.physical_event_id);
  assert.equal(repo.rows[0].diagnostics.event_start_iso, START);
  assert.equal(repo.rows[0].condition_id, "cond-exact");
  assert.equal(repo.rows[0].token_id, "token-exact");
  assert.equal(repo.rows[0].diagnostics.current_executable_price, 0.42);
});
