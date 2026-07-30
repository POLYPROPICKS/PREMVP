// Clean-esports full-match group policy.
//   node --import tsx --test tests/contur3/esportsGroupPolicy.test.ts
//
// Founder policy for night-plan:2026-07-30:1700-minsk (26 rejected physical
// groups, 408 rejection candidates):
//
//   MUST become eligible — groups whose every market is a whole-match /
//   whole-series esports market:
//      7  Counter-Strike: OldBoys vs LFO UKRAINE (BO1)
//      9  Counter-Strike: Wave Esports vs Benched gods (BO1)
//     18  LoL: EKO Esports vs Zena Esports (BO1)
//
//   MUST stay rejected — groups that mix a whole-match market with a true
//   sub-event market (Map N total / Map N rounds handicap / prop):
//      5  LPH Gaming vs Glitchtech
//      6  MTX vs Fire Flux Esports
//     13  mellren vs Hermine Esports Club
//
// The policy is GROUP-level and fail-closed: one true sub-event candidate
// poisons the whole physical group, so the clean sibling is never harvested out
// of a mixed group. Non-esports groups are never touched by this module.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEsportsGroupPolicy,
  isCleanEsportsFullMatchCandidate,
} from "../../lib/executor/esportsGroupPolicy";
import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";

/** Canonical decision for one production-shaped market question. */
function decisionFor(providerMarketQuestion: string, eventTitle?: string) {
  return resolveMarketAnchorDecision({
    providerMarketQuestion,
    eventTitle: eventTitle ?? null,
  });
}

function esportsGroup(questions: string[], sport = "esport") {
  return resolveEsportsGroupPolicy({
    sport,
    candidates: questions.map((q) => ({ canonical: decisionFor(q) })),
  });
}

// ── Rule A — clean esports whole-match groups become eligible ────────────────

test("clean Counter-Strike BO1 whole-match group is allowed", () => {
  const result = esportsGroup(["Counter-Strike: OldBoys vs LFO UKRAINE (BO1)"]);

  assert.equal(result.verdict, "ALLOW_CLEAN_ESPORTS_FULL_MATCH");
  assert.equal(result.esports_group, true);
  assert.equal(result.impure_candidate_count, 0);
  assert.ok(result.full_match_candidate_count >= 1);
});

test("second clean Counter-Strike BO1 fixture is allowed", () => {
  const result = esportsGroup(["Counter-Strike: Wave Esports vs Benched gods (BO1)"]);

  assert.equal(result.verdict, "ALLOW_CLEAN_ESPORTS_FULL_MATCH");
  assert.equal(result.impure_candidate_count, 0);
});

test("clean LoL BO1 whole-match group is allowed", () => {
  const result = esportsGroup(["LoL: EKO Esports vs Zena Esports (BO1)"]);

  assert.equal(result.verdict, "ALLOW_CLEAN_ESPORTS_FULL_MATCH");
  assert.equal(result.impure_candidate_count, 0);
});

test("clean esports group with several whole-match markets stays allowed", () => {
  const result = esportsGroup([
    "Counter-Strike: OldBoys vs LFO UKRAINE (BO1)",
    "Counter-Strike: OldBoys vs LFO UKRAINE (BO1) - Match Winner",
  ]);

  assert.equal(result.verdict, "ALLOW_CLEAN_ESPORTS_FULL_MATCH");
  assert.equal(result.impure_candidate_count, 0);
});

// ── Rule B — mixed-scope groups stay rejected, whole group ──────────────────

test("whole-match + Map 1 Total Rounds group is rejected as mixed scope", () => {
  const result = esportsGroup([
    "Counter-Strike: LPH Gaming vs Glitchtech (BO1)",
    "Map 1 Total Rounds: LPH Gaming vs Glitchtech",
  ]);

  assert.equal(result.verdict, "REJECT_GROUP_MIXED_SCOPE");
  assert.equal(result.impure_candidate_count, 1);
  // The clean sibling must NOT be harvested out of a poisoned group.
  assert.ok(result.full_match_candidate_count >= 1, "clean sibling exists but cannot rescue the group");
});

test("whole-match + Map 1 Rounds Handicap group is rejected as mixed scope", () => {
  const result = esportsGroup([
    "Counter-Strike: MTX vs Fire Flux Esports (BO1)",
    "Map 1 Rounds Handicap: MTX vs Fire Flux Esports",
  ]);

  assert.equal(result.verdict, "REJECT_GROUP_MIXED_SCOPE");
  assert.equal(result.impure_candidate_count, 1);
});

test("whole-match + Game 1 winner group is rejected as mixed scope", () => {
  const result = esportsGroup([
    "LoL: mellren vs Hermine Esports Club (BO1)",
    "LoL: mellren vs Hermine Esports Club - Game 1 Winner",
  ]);

  assert.equal(result.verdict, "REJECT_GROUP_MIXED_SCOPE");
});

test("pure map-only group is rejected", () => {
  const result = esportsGroup([
    "Map 1 Winner: ORA Temper vs SaD GC",
    "Map 2 Winner: ORA Temper vs SaD GC",
  ]);

  assert.equal(result.verdict, "REJECT_GROUP_MIXED_SCOPE");
  assert.equal(result.full_match_candidate_count, 0);
});

test("pure esports prop group is rejected", () => {
  const result = esportsGroup([
    "Counter-Strike: OldBoys vs LFO UKRAINE - Total Kills Over 45.5",
  ]);

  assert.equal(result.verdict, "REJECT_GROUP_MIXED_SCOPE");
  assert.equal(result.full_match_candidate_count, 0);
});

test("an esports group with no qualifying whole-match candidate is not allowed", () => {
  const result = resolveEsportsGroupPolicy({ sport: "esport", candidates: [] });

  assert.equal(result.verdict, "REJECT_NO_ESPORTS_FULL_MATCH_CANDIDATE");
  assert.equal(result.full_match_candidate_count, 0);
});

// ── Rule C — non-esports groups are untouched ───────────────────────────────

test("non-esports full-match group is not classified by this module", () => {
  const result = esportsGroup(["Atlanta Braves vs. New York Mets"], "baseball");

  assert.equal(result.verdict, "NOT_ESPORTS_GROUP");
  assert.equal(result.esports_group, false);
});

test("non-esports partial-scope group is not classified by this module", () => {
  const result = esportsGroup(["First Half Total Goals Over 1.5"], "soccer");

  assert.equal(result.verdict, "NOT_ESPORTS_GROUP");
  assert.equal(result.esports_group, false);
});

test("a null or unknown sport is never treated as an esports group", () => {
  assert.equal(esportsGroup(["anything at all"], "").verdict, "NOT_ESPORTS_GROUP");
  assert.equal(
    resolveEsportsGroupPolicy({ sport: null, candidates: [] }).verdict,
    "NOT_ESPORTS_GROUP"
  );
});

// ── Diagnostics distinguish the three rejection axes ────────────────────────

test("rejection diagnostics distinguish ESPORTS_NON_POLICY from PARTIAL_EVENT_SCOPE", () => {
  const clean = decisionFor("Counter-Strike: OldBoys vs LFO UKRAINE (BO1)");
  const partial = decisionFor("Map 1 Total Rounds: LPH Gaming vs Glitchtech");

  // The canonical codes are unchanged by this patch.
  assert.equal(clean.reason_code, "ESPORTS_NON_POLICY");
  assert.equal(clean.event_scope, "full_match");
  assert.equal(partial.event_scope, "map_or_round");

  const mixed = esportsGroup([
    "Counter-Strike: LPH Gaming vs Glitchtech (BO1)",
    "Map 1 Total Rounds: LPH Gaming vs Glitchtech",
  ]);
  // The GROUP verdict is a third, distinct axis.
  assert.equal(mixed.verdict, "REJECT_GROUP_MIXED_SCOPE");
  assert.ok(
    mixed.impure_reason_codes.includes("PARTIAL_EVENT_SCOPE"),
    "the poisoning candidate's own canonical code is carried into diagnostics"
  );
});

// ── Candidate-level helper ──────────────────────────────────────────────────

test("isCleanEsportsFullMatchCandidate accepts a whole-match esports market", () => {
  assert.equal(
    isCleanEsportsFullMatchCandidate(decisionFor("Counter-Strike: OldBoys vs LFO UKRAINE (BO1)")),
    true
  );
});

test("isCleanEsportsFullMatchCandidate rejects a map-scope market", () => {
  assert.equal(
    isCleanEsportsFullMatchCandidate(decisionFor("Map 1 Total Rounds: LPH Gaming vs Glitchtech")),
    false
  );
});

test("policy output is deterministic", () => {
  const questions = [
    "Counter-Strike: OldBoys vs LFO UKRAINE (BO1)",
    "Counter-Strike: OldBoys vs LFO UKRAINE (BO1) - Match Winner",
  ];
  assert.deepEqual(esportsGroup(questions), esportsGroup(questions));
});
