import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFounderRejectionReport,
  type FounderRejectionReport,
} from "../../lib/executor/fullmatchRejectionFounderReport";
import type { FullmatchRejectionEvidenceReport } from "../../lib/executor/fullmatchRejectionEvidence";

const REPORT_VERSION = "founder-rejection-report-v1";

// Helpers to build test fixtures
function evidence(overrides: Record<string, unknown> = {}) {
  return {
    physical_event_key_hash: "abc1234567890def",
    sport: "football",
    candidate_count: 2,
    candidates: [
      {
        provider_market_question: "Will Argentina win?",
        market_title: "Match Winner",
        event_title: "Argentina vs Spain",
        market_slug: "argentina-vs-spain-winner",
        event_slug: "argentina-vs-spain-2026",
        match_family_key: "pair:argentina-vs-spain:2026-07-30",
        market_class: "MONEYLINE",
        event_scope: "FULL_MATCH",
        evidence_source: "polymarket",
        reason_code: "NO_FULLMATCH_ANCHOR",
        allowed: false,
      },
      {
        provider_market_question: "Total goals over/under 2.5",
        market_title: "Total Goals",
        event_title: "Argentina vs Spain",
        market_slug: "argentina-vs-spain-total",
        event_slug: "argentina-vs-spain-2026",
        match_family_key: "pair:argentina-vs-spain:2026-07-30",
        market_class: "TOTAL",
        event_scope: "FULL_MATCH",
        evidence_source: "polymarket",
        reason_code: "NO_FULLMATCH_ANCHOR",
        allowed: false,
      },
    ],
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): FullmatchRejectionEvidenceReport {
  return {
    fullmatch_rejection_groups_total: 1,
    fullmatch_rejection_groups_reported: 1,
    fullmatch_rejection_candidates_total: 2,
    fullmatch_rejection_candidates_reported: 2,
    fullmatch_rejection_evidence_truncated: false,
    fullmatch_rejection_evidence: [evidence()],
    ...overrides,
  };
}

test("buildFounderRejectionReport returns correct structure", () => {
  const result = buildFounderRejectionReport(report());

  assert.equal(result.report_version, REPORT_VERSION);
  assert.equal(result.group_count, 1);
  assert.equal(result.groups.length, 1);
});

test("prints every supplied physical-event group", () => {
  const input = report({
    fullmatch_rejection_groups_total: 3,
    fullmatch_rejection_groups_reported: 3,
    fullmatch_rejection_evidence: [
      evidence({ physical_event_key_hash: "hash1", sport: "football" }),
      evidence({ physical_event_key_hash: "hash2", sport: "basketball" }),
      evidence({ physical_event_key_hash: "hash3", sport: "tennis" }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups.length, 3);
  assert.ok(result.groups.some((g) => g.physical_event_key_hash === "hash1"));
  assert.ok(result.groups.some((g) => g.physical_event_key_hash === "hash2"));
  assert.ok(result.groups.some((g) => g.physical_event_key_hash === "hash3"));
});

test("sorts by sport → event_title → physical_event_key_hash", () => {
  const input = report({
    fullmatch_rejection_groups_total: 3,
    fullmatch_rejection_groups_reported: 3,
    fullmatch_rejection_evidence: [
      evidence({
        sport: "tennis",
        physical_event_key_hash: "z",
        candidates: [{ ...evidence().candidates[0], event_title: "Federer vs Nadal" }],
      }),
      evidence({
        sport: "football",
        physical_event_key_hash: "b",
        candidates: [{ ...evidence().candidates[0], event_title: "Brazil vs Germany" }],
      }),
      evidence({
        sport: "football",
        physical_event_key_hash: "a",
        candidates: [{ ...evidence().candidates[0], event_title: "Argentina vs Spain" }],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  const sortedHashes = result.groups.map((g) => g.physical_event_key_hash);

  assert.deepEqual(sortedHashes, ["a", "b", "z"]);
});

test("deduplicates market questions", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidates: [
          {
            ...evidence().candidates[0],
            provider_market_question: "Will Argentina win?",
          },
          {
            ...evidence().candidates[1],
            provider_market_question: "Will Argentina win?",
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].distinct_market_questions.length, 1);
  assert.equal(result.groups[0].distinct_market_questions[0], "Will Argentina win?");
});

test("deduplicates market classes, scopes and reason codes", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidates: [
          {
            ...evidence().candidates[0],
            market_class: "MONEYLINE",
            event_scope: "FULL_MATCH",
            reason_code: "NO_FULLMATCH_ANCHOR",
          },
          {
            ...evidence().candidates[1],
            market_class: "MONEYLINE",
            event_scope: "FULL_MATCH",
            reason_code: "NO_FULLMATCH_ANCHOR",
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].market_classes.length, 1);
  assert.equal(result.groups[0].event_scopes.length, 1);
  assert.equal(result.groups[0].reason_codes.length, 1);
});

test("preserves true candidate_count", () => {
  const input = report({
    fullmatch_rejection_evidence: [evidence({ candidate_count: 15 })],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].candidate_count, 15);
});

test("exposes candidate_evidence_count", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 15,
        candidates: [evidence().candidates[0], evidence().candidates[1]],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].candidate_evidence_count, 2);
});

test("marks COMPLETE when candidate_count <= candidate_evidence_count", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 2,
        candidates: [evidence().candidates[0], evidence().candidates[1]],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].evidence_completeness, "COMPLETE");
});

test("marks TRUNCATED_NEEDS_DRILLDOWN when candidate_count > candidate_evidence_count", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 15,
        candidates: [evidence().candidates[0], evidence().candidates[1]],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].evidence_completeness, "TRUNCATED_NEEDS_DRILLDOWN");
});

test("uses visible_has_* for truncated groups and does not claim completeness", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 15,
        candidates: [
          {
            ...evidence().candidates[0],
            market_class: "MONEYLINE",
          },
          {
            ...evidence().candidates[1],
            market_class: "TOTAL",
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  const group = result.groups[0];

  assert.equal(group.evidence_completeness, "TRUNCATED_NEEDS_DRILLDOWN");
  assert.ok("visible_has_moneyline" in group);
  assert.ok("visible_has_spread" in group);
  assert.ok("visible_has_total" in group);
  assert.ok("visible_has_full_match_candidate" in group);
  assert.equal(group.visible_has_moneyline, true);
  assert.equal(group.visible_has_spread, false);
  assert.equal(group.visible_has_total, true);
});

test("uses has_* for complete groups", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 2,
        candidates: [
          {
            ...evidence().candidates[0],
            market_class: "MONEYLINE",
          },
          {
            ...evidence().candidates[1],
            market_class: "TOTAL",
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  const group = result.groups[0];

  assert.equal(group.evidence_completeness, "COMPLETE");
  assert.ok("has_moneyline" in group);
  assert.ok("has_spread" in group);
  assert.ok("has_total" in group);
  assert.ok("has_full_match_candidate" in group);
  assert.ok(!("visible_has_moneyline" in group));
});

test("handles null titles and questions honestly", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidates: [
          {
            ...evidence().candidates[0],
            event_title: null,
            provider_market_question: null,
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].event_title, null);
  assert.equal(result.groups[0].distinct_market_questions.length, 0);
});

test("formatter output is deterministic", () => {
  const input = report({
    fullmatch_rejection_groups_total: 2,
    fullmatch_rejection_groups_reported: 2,
    fullmatch_rejection_evidence: [
      evidence({ physical_event_key_hash: "hash2", candidates: [evidence().candidates[0]] }),
      evidence({ physical_event_key_hash: "hash1", candidates: [evidence().candidates[0]] }),
    ],
  });

  const result1 = buildFounderRejectionReport(input);
  const result2 = buildFounderRejectionReport(input);

  assert.deepEqual(result1, result2);
  assert.equal(result1.groups[0].physical_event_key_hash, "hash1");
  assert.equal(result1.groups[1].physical_event_key_hash, "hash2");
});

test("assigns group_number starting from 1", () => {
  const input = report({
    fullmatch_rejection_groups_total: 3,
    fullmatch_rejection_groups_reported: 3,
    fullmatch_rejection_evidence: [
      evidence({ physical_event_key_hash: "hash1" }),
      evidence({ physical_event_key_hash: "hash2" }),
      evidence({ physical_event_key_hash: "hash3" }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].group_number, 1);
  assert.equal(result.groups[1].group_number, 2);
  assert.equal(result.groups[2].group_number, 3);
});

test("identifies FULL_MATCH_CANDIDATE", () => {
  const input = report({
    fullmatch_rejection_evidence: [
      evidence({
        candidate_count: 2,
        candidates: [
          {
            ...evidence().candidates[0],
            event_scope: "FULL_MATCH",
          },
          {
            ...evidence().candidates[1],
            event_scope: "HALF_MATCH",
          },
        ],
      }),
    ],
  });

  const result = buildFounderRejectionReport(input);
  assert.equal(result.groups[0].has_full_match_candidate, true);
});
