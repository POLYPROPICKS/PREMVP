import assert from "node:assert/strict";
import { test } from "node:test";
import { produceFrozenModelV2ShadowDecisions } from "../../lib/modeling/frozenModelProducerV2Shadow";
import {
  compareFrozenAndContur3,
  type Contur3CandidateSlice,
} from "../../lib/modeling/frozenExecutionContractBridge";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";

const AS_OF = "2026-07-20T12:00:00.000Z";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 80,
    entry_price_num: 0.5,
    created_at: "2026-07-20T11:30:00.000Z", // T-90 boundary before a 13:00 start
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    inferred_sport: "NBA",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
    ...overrides,
  };
}

function contur3Candidate(overrides: Partial<Contur3CandidateSlice> = {}): Contur3CandidateSlice {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    side: "TEAM_A",
    selected_outcome: "TEAM_A",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    canonical_event_key: "nba-team-a-vs-team-b",
    match_family_key: "nba-team-a-vs-team-b",
    event_slug: "nba-team-a-vs-team-b",
    max_entry_price: 0.9,
    timing_bucket: "T_1_2H",
    inferred_sport: "NBA",
    market_family: "moneyline",
    ...overrides,
  };
}

function frozenDecisionsFor(rows: Record<string, unknown>[]) {
  const result = produceFrozenModelV2ShadowDecisions(rows as any, AS_OF);
  return { decisions: result.acceptedDecisions, rows };
}

test("exact compatible: same event, condition_id, token_id, side", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  assert.equal(decisions.length, 1);
  const comparison = compareFrozenAndContur3(decisions, rows as any, [contur3Candidate()]);
  assert.equal(comparison.classificationCounts.EXACT_EXECUTION_COMPATIBLE, 1);
  assert.equal(comparison.rows[0].classification, "EXACT_EXECUTION_COMPATIBLE");
});

test("same event, different market -> SAME_EVENT_DIFFERENT_MARKET, not silently EXACT", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const candidate = contur3Candidate({
    market_slug: "nba-team-a-vs-team-b-spread",
    canonical_market_key: "nba-team-a-vs-team-b-spread",
  });
  const comparison = compareFrozenAndContur3(decisions, rows as any, [candidate]);
  assert.equal(comparison.rows[0].classification, "SAME_EVENT_DIFFERENT_MARKET");
});

test("condition_id mismatch -> CONDITION_ID_MISMATCH", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const candidate = contur3Candidate({ condition_id: "cond-other" });
  const comparison = compareFrozenAndContur3(decisions, rows as any, [candidate]);
  assert.equal(comparison.rows[0].classification, "CONDITION_ID_MISMATCH");
});

test("token_id mismatch -> TOKEN_ID_MISMATCH", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const candidate = contur3Candidate({ token_id: "tok-other" });
  const comparison = compareFrozenAndContur3(decisions, rows as any, [candidate]);
  assert.equal(comparison.rows[0].classification, "TOKEN_ID_MISMATCH");
});

test("side mismatch -> SIDE_MISMATCH", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const candidate = contur3Candidate({ side: "TEAM_B", selected_outcome: "TEAM_B" });
  const comparison = compareFrozenAndContur3(decisions, rows as any, [candidate]);
  assert.equal(comparison.rows[0].classification, "SIDE_MISMATCH");
});

test("physical-event grouping: multiple Contur3 markets for one physical event group under one canonical event identity", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const candidates = [
    contur3Candidate(),
    contur3Candidate({
      token_id: "tok-2",
      market_slug: "nba-team-a-vs-team-b-total",
      canonical_market_key: "nba-team-a-vs-team-b-total",
    }),
  ];
  const comparison = compareFrozenAndContur3(decisions, rows as any, candidates);
  const eventKeys = new Set(comparison.rows.map((r) => r.eventKey));
  assert.equal(eventKeys.size, 1);
  assert.equal(comparison.eventCount, 1);
});

test("as-of integrity: a frozen-side row created after --as-of never appears in the comparison", () => {
  const futureRow = sourceRow({
    condition_id: "cond-future",
    token_id: "tok-future",
    event_slug: "nba-future-event",
    market_slug: "nba-future-event-moneyline",
    canonical_market_key: "nba-future-event-moneyline",
    created_at: "2026-07-21T11:30:00.000Z", // after AS_OF
    diagnostics: { gameStartIso: "2026-07-21T13:00:00.000Z" },
  });
  const { decisions, rows } = frozenDecisionsFor([sourceRow(), futureRow]);
  assert.equal(decisions.length, 1);
  const comparison = compareFrozenAndContur3(decisions, rows as any, [contur3Candidate()]);
  assert.ok(!comparison.rows.some((r) => r.frozenObservationId?.includes("cond-future")));
  assert.equal(comparison.rows.some((r) => r.eventKey.includes("future")), false);
});

test("as-of integrity: post-result leakage fields on the frozen source never influence the comparison (frozen model never reads them)", () => {
  const rowWithLeakage = sourceRow({ winning_outcome: "TEAM_A", real_pnl_usd: 42 });
  const { decisions, rows } = frozenDecisionsFor([rowWithLeakage]);
  assert.equal(decisions.length, 1);
  const comparison = compareFrozenAndContur3(decisions, rows as any, [contur3Candidate()]);
  assert.equal(comparison.rows[0].classification, "EXACT_EXECUTION_COMPATIBLE");
});

test("determinism: shuffled input order produces byte-identical normalized comparison output", () => {
  const rowA = sourceRow();
  const rowB = sourceRow({
    condition_id: "cond-2",
    token_id: "tok-2",
    event_slug: "nba-team-c-vs-team-d",
    market_slug: "nba-team-c-vs-team-d-moneyline",
    canonical_market_key: "nba-team-c-vs-team-d-moneyline",
  });
  const candA = contur3Candidate();
  const candB = contur3Candidate({
    condition_id: "cond-2",
    token_id: "tok-2",
    market_slug: "nba-team-c-vs-team-d-moneyline",
    canonical_market_key: "nba-team-c-vs-team-d-moneyline",
    canonical_event_key: "nba-team-c-vs-team-d",
    match_family_key: "nba-team-c-vs-team-d",
    event_slug: "nba-team-c-vs-team-d",
  });

  const forward = frozenDecisionsFor([rowA, rowB]);
  const reversed = frozenDecisionsFor([rowB, rowA]);

  const comparisonForward = compareFrozenAndContur3(forward.decisions, forward.rows as any, [candA, candB]);
  const comparisonReversed = compareFrozenAndContur3(
    [...reversed.decisions].reverse(),
    [...(reversed.rows as any)].reverse(),
    [candB, candA],
  );

  assert.deepEqual(comparisonForward.rows, comparisonReversed.rows);
  assert.deepEqual(comparisonForward.classificationCounts, comparisonReversed.classificationCounts);
});

test("missing execution fields: a Contur3-side candidate missing condition_id/token_id is classified MISSING_EXECUTION_FIELDS, not a crash", () => {
  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const malformed = contur3Candidate({ condition_id: "", token_id: "" });
  assert.doesNotThrow(() => compareFrozenAndContur3(decisions, rows as any, [malformed]));
  const comparison = compareFrozenAndContur3(decisions, rows as any, [malformed]);
  assert.equal(comparison.rows[0].classification, "MISSING_EXECUTION_FIELDS");
});

test("side-effect regression: zero imports of write-side execution modules", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/frozenExecutionContractBridge.ts", import.meta.url),
    "utf8",
  );
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  const forbidden = [
    "nightEventReservations",
    "eventExecutionQueue",
    "executorOrderEvents",
    "executorQueueMark",
    "ireland",
    "Ireland",
    "clob",
    "CLOB",
  ];
  for (const line of importLines) {
    for (const token of forbidden) {
      assert.ok(!line.includes(token), `import line must not reference ${token}: ${line}`);
    }
  }
});

test("real contract regression: constructs a fixture value satisfying the real FireModelCandidate interface", () => {
  const realCandidate: FireModelCandidate = {
    signal_id: "sig-1",
    strategy: "shadow-strategic-sports-v1",
    rank: 1,
    market_slug: "nba-team-a-vs-team-b-moneyline",
    match_family_key: "nba-team-a-vs-team-b",
    match_family_key_source: "event_slug",
    match_family_key_is_weak: false,
    event_slug: "nba-team-a-vs-team-b",
    condition_id: "cond-1",
    token_id: "tok-1",
    side: "TEAM_A",
    selected_outcome: "TEAM_A",
    inferred_sport: "NBA",
    market_family: "moneyline",
    strategic_scope: "OTHER",
    timing_bucket: "T_1_2H",
    identity_quality: "STRONG",
    identity_warning_codes: [],
    canonical_event_key: "nba-team-a-vs-team-b",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    activity_label_detected: false,
    sport_classification_confidence: "HIGH",
    live_eligible: false,
    live_rejection_reason: null,
    side_mapping_status: "PROVEN_BY_TOKEN_ID",
    live_block_reason: null,
    live_policy_version: "live-risk-guard-v1",
    paper_eligible: true,
    max_entry_price: 0.9,
    stake_usd: 7,
    max_order_usd: 7,
    max_spread: 0.05,
    one_order_only: true,
    executor_mode_allowed: "PAPER",
    first_live_test_allowed: false,
    stale_after: "2026-07-20T13:00:00.000Z",
    no_trade_after: null,
    idempotency_key: "idem-1",
    model_rule_id: "rule-1",
    created_at: "2026-07-20T11:30:00.000Z",
    source: "generated_signal_pairs",
    diagnostics: {
      executor_action: "NONE",
      paper_only: true,
      real_trade: false,
      score: 80,
      coverage: 1,
      smart_money: null,
      entry_price: 0.5,
      game_start_iso: "2026-07-20T13:00:00.000Z",
      hours_to_start_now: 1.5,
      fire_model_alias: "shadow-strategic-sports-v1",
      version: "v1",
    },
  };

  const { decisions, rows } = frozenDecisionsFor([sourceRow()]);
  const comparison = compareFrozenAndContur3(decisions, rows as any, [realCandidate]);
  assert.equal(comparison.rows[0].classification, "EXACT_EXECUTION_COMPATIBLE");
});
