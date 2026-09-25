import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFireModelCandidates,
  resolveUpstreamMarketPolicy,
  type FireModelCandidate,
  type MarketPolicyProbe,
} from "../../lib/executor/buildFireModelCandidates";
import { anchorDecisionForCandidate, buildContractAReservationPlan } from "../../lib/executor/nightEventReservations";
import { buildContractAPlanningDecision } from "../../lib/executor/contractADecisions";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { NightEventReservationRow, EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

function probe(over: Partial<MarketPolicyProbe> = {}): MarketPolicyProbe {
  return {
    market_slug: "Wuxi Wugou vs Guangxi Hengchen - Spread",
    event_slug: "wuxi-guangxi-exact-score",
    match_family_key: "wuxi-guangxi-exact-score",
    inferred_sport: "soccer",
    activity_label_detected: false,
    providerMarketQuestion: "Wuxi Wugou vs Guangxi Hengchen - Spread",
    providerEventTitle: "Wuxi Wugou vs Guangxi Hengchen Exact Score",
    providerEventId: "1073757",
    providerMarketId: "spread-market",
    providerMarketType: "spreads",
    conditionId: "spread-market",
    condition_id: "spread-market",
    token_id: "spread-token",
    side: "Wuxi Wugou",
    ...over,
  };
}

function candidate(p: MarketPolicyProbe): FireModelCandidate {
  const policy = resolveUpstreamMarketPolicy(p);
  return {
    market_slug: p.market_slug,
    event_slug: p.event_slug,
    match_family_key: p.match_family_key,
    providerMarketQuestion: p.providerMarketQuestion,
    providerEventTitle: p.providerEventTitle,
    inferred_sport: p.inferred_sport,
    activity_label_detected: p.activity_label_detected,
    condition_id: p.condition_id,
    token_id: p.token_id,
    side: p.side,
    diagnostics: {
      market_policy: policy,
    },
  } as FireModelCandidate;
}

test("exact full-match spread survives an exact-score parent wrapper", () => {
  const p = probe();
  const verdict = resolveUpstreamMarketPolicy(p);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.market_class, "allowed_fullmatch_spread");
  assert.deepEqual(verdict.exact_identity, {
    condition_id: "spread-market", token_id: "spread-token", side: "Wuxi Wugou",
  });
  assert.equal(anchorDecisionForCandidate(candidate(p)).allowed, true);
});

test("own exact score, corners, and partial market semantics remain blocked", () => {
  for (const [type, question] of [
    ["soccer_exact_score", "Exact Score: 1-0"],
    ["total_corners", "Total Corners Over 9.5"],
    ["spreads", "First Half Spread"],
  ]) {
    assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketType: type, providerMarketQuestion: question })).allowed, false, type);
  }
});

test("sibling market identities receive independent verdicts", () => {
  const spread = resolveUpstreamMarketPolicy(probe());
  const exactScore = resolveUpstreamMarketPolicy(probe({
    providerMarketId: "score-market", conditionId: "score-market", condition_id: "score-market",
    token_id: "score-token", providerMarketType: "soccer_exact_score", providerMarketQuestion: "Exact Score 1-0",
  }));
  assert.equal(spread.allowed, true);
  assert.equal(exactScore.allowed, false);
  assert.notDeepEqual(spread.exact_identity, exactScore.exact_identity);
});

test("parent text cannot revoke a matching exact verdict; identity mismatch fails closed", () => {
  const c = candidate(probe());
  c.event_slug = "another-exact-score-parent";
  c.providerEventTitle = "Another Exact Score Wrapper";
  assert.equal(anchorDecisionForCandidate(c).allowed, true);
  c.token_id = "sibling-token";
  assert.equal(anchorDecisionForCandidate(c).allowed, false);
  c.token_id = "spread-token";
  c.condition_id = "";
  assert.equal(anchorDecisionForCandidate(c).allowed, false);
});

test("incomplete structured market authority fails closed", () => {
  assert.equal(resolveUpstreamMarketPolicy(probe({ token_id: null })).allowed, false);
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketId: null })).allowed, false);
  assert.equal(resolveUpstreamMarketPolicy(probe({ providerMarketQuestion: null })).allowed, false);
});

test("source row carries its exact spread verdict into the Planning candidate", async () => {
  const start = "2026-09-25T12:00:00.000Z";
  const row = {
    id: "00000000-0000-4000-8000-000000000123",
    condition_id: "spread-market",
    selected_token_id: "spread-token",
    selected_outcome: "Wuxi Wugou",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.51,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-09-25T02:30:00.000Z",
    expires_at: start,
    signal_result: null,
    event_slug: "wuxi-guangxi-exact-score",
    market_slug: "Wuxi Wugou vs Guangxi Hengchen - Spread",
    diagnostics: {
      gameStartIso: start,
      dataCoverage: 60,
      shadowScope: "soccer",
      eventTitle: "Wuxi Wugou vs Guangxi Hengchen Exact Score",
      marketTitle: "Wuxi Wugou vs Guangxi Hengchen - Spread",
      providerEventContext: {
        v: "v1", provider: "polymarket", eventId: "1073757",
        eventStartIso: start, providerMarketId: "spread-market",
        marketType: "spreads", sportFamily: "soccer", league: "soccer",
        marketQuestion: "Wuxi Wugou vs Guangxi Hengchen - Spread",
        eventTitle: "Wuxi Wugou vs Guangxi Hengchen Exact Score",
      },
    },
  };
  const result = await buildFireModelCandidates(100_000, "all", true, [row], "CONTRACT_A_PLANNING_V1", Date.parse("2026-09-25T05:00:00.000Z"));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].diagnostics.market_policy?.allowed, true);
  assert.equal(result.candidates[0].condition_id, "spread-market");
  assert.equal(result.candidates[0].token_id, "spread-token");
  assert.equal(result.candidates[0].side, "Wuxi Wugou");
  const planning = buildContractAPlanningDecision(result.candidates[0], row.diagnostics);
  assert.equal(planning.accepted, true);
  if (planning.accepted) {
    assert.deepEqual(planning.decision.final_identity_evidence && {
      condition_id: planning.decision.final_identity_evidence.condition_id,
      token_id: planning.decision.final_identity_evidence.token_id,
      side: planning.decision.final_identity_evidence.side,
    }, { condition_id: "spread-market", token_id: "spread-token", side: "Wuxi Wugou" });
    assert.deepEqual(planning.decision.planning_policy_verdict?.exact_identity,
      result.candidates[0].diagnostics.market_policy?.exact_identity);
    const sibling = {
      ...row,
      id: "00000000-0000-4000-8000-000000000124",
      condition_id: "score-market",
      selected_token_id: "score-token",
      diagnostics: {
        ...row.diagnostics,
        marketTitle: "Exact Score 1-0",
        providerEventContext: {
          ...row.diagnostics.providerEventContext,
          providerMarketId: "score-market", marketType: "soccer_exact_score",
          marketQuestion: "Exact Score 1-0",
        },
      },
    };
    const plan = await buildContractAReservationPlan(Date.parse("2026-09-25T07:00:00.000Z"), {
      fetchSourceRows: async () => [row, sibling],
      produceDecisions: async () => [planning],
    });
    assert.equal(plan.reservations.length, 1);
    assert.equal(plan.reservations[0].diagnostics.candidate_manifest_version, "RESERVATION_CANDIDATE_MANIFEST_V1");
    assert.deepEqual(plan.reservations[0].diagnostics.planning_policy_verdict?.exact_identity,
      planning.decision.planning_policy_verdict?.exact_identity);
    assert.equal(plan.reservations[0].diagnostics.planning_policy_verdict?.exact_identity?.condition_id, "spread-market");
    assert.equal(plan.reservations[0].diagnostics.planning_final_identity_evidence?.condition_id, "spread-market");
    assert.ok(plan.reservations[0].diagnostics.candidate_manifest.some((entry) => entry.condition_id === "score-market"));
    const queued: EventExecutionQueueRow[] = [];
    const repoFor = (reservation: NightEventReservationRow): RebalanceRepoPort => ({
      async loadActiveReservations() { return [reservation]; },
      async loadQueuedReservationIds() { return new Set<string>(); },
      async markReservationsExpired() {},
      async markReservationSkipped() {},
      async markReservationQueued() {},
      async insertQueueRow(queueRow) { queued.push(queueRow); },
    });
    const fetchExactTokenOrderbook = async (tokenId: string) => ({
      ok: true as const, tokenId, latencyMs: 30,
      book: { tokenId, bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.51, size: 100 }] },
    });
    const rebalanceNow = Date.parse("2026-09-25T11:00:00.000Z");
    const queuedResult = await runEventRebalance(rebalanceNow, { write: true }, {
      repo: repoFor(plan.reservations[0]), fetchExactTokenOrderbook,
    });
    assert.equal(queuedResult.queued_count, 1, JSON.stringify(queuedResult.outcomes));
    assert.equal(queued[0].condition_id, "spread-market");
    assert.equal(queued[0].token_id, "spread-token");
    assert.equal(queued[0].side, "Wuxi Wugou");
    assert.equal(queued[0].diagnostics.max_entry_price, 0.54);

    const altered = structuredClone(plan.reservations[0]);
    altered.diagnostics.planning_final_identity_evidence = {
      ...altered.diagnostics.planning_final_identity_evidence!,
      condition_id: "score-market", token_id: "score-token",
    };
    assert.equal(altered.diagnostics.planning_final_identity_evidence.condition_id, "score-market");
    queued.length = 0;
    const blocked = await runEventRebalance(rebalanceNow, { write: true }, {
      repo: repoFor(altered), fetchExactTokenOrderbook,
    });
    assert.equal(blocked.queued_count, 0);
    assert.equal(queued.length, 0);
    assert.match(JSON.stringify(blocked.outcomes), /PLANNING_MARKET_POLICY_IDENTITY_MISMATCH/);
  }
});
