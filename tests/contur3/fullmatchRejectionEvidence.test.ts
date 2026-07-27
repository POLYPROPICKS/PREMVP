// R0I FULL-MATCH REJECTION EVIDENCE — diagnostics-only capture.
//   node --import tsx --test tests/contur3/fullmatchRejectionEvidence.test.ts
//
// Production run night-plan:2026-07-27 reported:
//
//   first_zero_stage         = FULLMATCH_ANCHOR_ELIGIBLE
//   NO_FULLMATCH_ANCHOR      = 30
//   rejected_partial_count   = 258
//
// The persisted diagnostic report contained generated_at, plan_run_id,
// plan_date_minsk, commit, context, diagnostics, reservation_count and
// reserved_events — and nothing else. A recursive extraction over it found
// evidenceObjectsFound = 0. There was no way to distinguish "30 genuine
// partial-only events, correctly rejected" from "the classifier read the wrong
// surface", because the report never recorded which surfaces it read.
//
// This suite pins the fix and, just as importantly, pins that the fix changes
// NOTHING about admission: same fixtures, same clock, byte-identical business
// outputs before and after.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import {
  buildReservationPlan,
  buildPlanningJobDiagnostics,
  persistReservationPlanDiagnostics,
} from "../../lib/executor/nightEventReservations";
import {
  buildFullmatchRejectionEvidence,
  buildFullmatchRejectionPreview,
  hashPhysicalEventKey,
  FULLMATCH_EVIDENCE_MAX_GROUPS,
  FULLMATCH_EVIDENCE_MAX_CANDIDATES_PER_GROUP,
  FULLMATCH_EVIDENCE_PREVIEW_GROUPS,
  FULLMATCH_EVIDENCE_PREVIEW_CANDIDATES,
  type FullmatchRejectionGroupCapture,
} from "../../lib/executor/fullmatchRejectionEvidence";

const NOW_MS = Date.parse("2026-07-27T17:30:33.404Z");
const KICKOFF_ISO = "2026-07-27T21:00:00.000Z";

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const SOURCE_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  condition_id: "cond-nyy-phi",
  selected_token_id: "tok-nyy-phi-yankees",
  selected_outcome: "New York Yankees",
  score: 80,
  signal_confidence_num: 70,
  smart_money_score_num: null,
  entry_price_num: 0.42,
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-27T13:30:00.000Z",
  expires_at: KICKOFF_ISO,
  signal_result: null,
  event_slug: "mlb-nyy-phi-2026-07-27",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  diagnostics: {
    gameStartIso: KICKOFF_ISO,
    dataCoverage: 60,
    shadowScope: "baseball",
    eventTitle: "New York Yankees vs Philadelphia Phillies",
    marketTitle: "Yankees vs Phillies moneyline",
  },
};

const RAW_DIAGNOSTICS = {
  total_db_rows: 1832,
  raw_allowed_fullmatch_rows: 180,
  raw_forbidden_rows: 1652,
  fullmatch_admitted_count: 180,
  fullmatch_rejected_by_reason: {},
};

async function proto(): Promise<FireModelCandidate> {
  const base = await at(NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.ok(base.candidates[0], "precondition: the planning selector must produce a candidate");
  return base.candidates[0];
}

function inGroup(p: FireModelCandidate, group: number, index: number, over: Partial<FireModelCandidate> = {}) {
  return {
    ...p,
    signal_id: `sig-${group}-${index}`,
    condition_id: `cond-${group}-${index}`,
    token_id: `tok-${group}-${index}`,
    match_family_key: `pair:team-a${group}-vs-team-b${group}:2026-07-27`,
    canonical_event_key: `pair:team-a${group}-vs-team-b${group}:2026-07-27`,
    event_slug: `evt-${group}`,
    ...over,
  } as FireModelCandidate;
}

async function planWith(candidates: FireModelCandidate[], nowMs: number = NOW_MS) {
  return at(nowMs, () =>
    buildReservationPlan(nowMs, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: RAW_DIAGNOSTICS as any }),
    })
  );
}

/** A market surface the canonical classifier rejects as partial-scope. */
const PARTIAL = (g: number) => `Team A${g} vs Team B${g} - 1st Half Winner`;
/** A full-match-LOOKING surface that the classifier still rejects. */
const UNCLASSIFIABLE = (g: number) => `Will anything at all happen in fixture ${g}?`;

// ── Test A: the evidence the report previously lacked ───────────────────────

test("R0I-A: a group rejected by the full-match gate is explained with candidate surfaces and decisions", async () => {
  const p = await proto();
  // One full-match-LOOKING candidate and one partial candidate; the classifier
  // rejects both, so the group dies at the full-match anchor gate.
  const plan = await planWith([
    inGroup(p, 0, 0, { market_slug: UNCLASSIFIABLE(0), providerMarketQuestion: UNCLASSIFIABLE(0) }),
    inGroup(p, 0, 1, { market_slug: PARTIAL(0), providerMarketQuestion: PARTIAL(0) }),
  ]);

  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, 1, "the group must die at the full-match gate");
  assert.equal(plan.reservations.length, 0);

  const report = plan.fullmatch_rejection;
  assert.equal(report.fullmatch_rejection_groups_total, 1);
  assert.equal(report.fullmatch_rejection_evidence.length, 1);

  const group = report.fullmatch_rejection_evidence[0];
  assert.equal(group.candidate_count, 2);
  assert.equal(group.sport, "baseball");
  // The physical-event key is hashed at group level, never emitted verbatim.
  assert.equal(group.physical_event_key_hash, hashPhysicalEventKey("pair:team-a0-vs-team-b0:2026-07-27"));
  assert.match(group.physical_event_key_hash, /^[0-9a-f]{16}$/);
  assert.notEqual(group.physical_event_key_hash, "pair:team-a0-vs-team-b0:2026-07-27");
  // match_family_key remains present as a CANDIDATE surface: it is one of the six
  // inputs the classifier read, and omitting it would defeat the whole purpose.

  assert.equal(group.candidates.length, 2);
  for (const candidate of group.candidates) {
    // Every decision field the classifier already produced.
    assert.equal(typeof candidate.market_class, "string");
    assert.ok(candidate.market_class.length > 0);
    assert.equal(typeof candidate.event_scope, "string");
    assert.ok(candidate.event_scope.length > 0);
    assert.ok(["structured", "normalized", "text_fallback"].includes(candidate.evidence_source));
    assert.equal(typeof candidate.reason_code, "string");
    assert.ok(candidate.reason_code.length > 0);
    assert.equal(candidate.allowed, false);
    // And the surfaces that decision was read from.
    assert.ok("provider_market_question" in candidate);
    assert.ok("market_title" in candidate);
    assert.ok("event_title" in candidate);
    assert.ok("market_slug" in candidate);
    assert.ok("event_slug" in candidate);
    assert.ok("match_family_key" in candidate);
  }
});

test("R0I-A2: the persisted diagnostic report carries the complete bounded evidence", async () => {
  const p = await proto();
  const plan = await planWith([
    inGroup(p, 0, 0, { market_slug: UNCLASSIFIABLE(0), providerMarketQuestion: UNCLASSIFIABLE(0) }),
  ]);

  const { path: written, error } = await persistReservationPlanDiagnostics(plan, { context: "r0i-test" });
  assert.equal(error, null);
  assert.ok(written, "the diagnostic report must be written");

  const { readFile, rm } = await import("node:fs/promises");
  const payload = JSON.parse(await readFile(written, "utf-8"));
  await rm(written, { force: true });

  // The fields the production report already had.
  for (const field of ["generated_at", "plan_run_id", "plan_date_minsk", "commit", "context", "diagnostics", "reservation_count", "reserved_events"]) {
    assert.ok(field in payload, `report must keep ${field}`);
  }
  // The evidence it lacked — the exact production gap.
  assert.equal(payload.fullmatch_rejection_groups_total, 1);
  assert.equal(payload.fullmatch_rejection_groups_reported, 1);
  assert.equal(payload.fullmatch_rejection_candidates_total, 1);
  assert.equal(payload.fullmatch_rejection_candidates_reported, 1);
  assert.equal(payload.fullmatch_rejection_evidence_truncated, false);
  assert.equal(payload.fullmatch_rejection_evidence.length, 1);
  assert.equal(payload.fullmatch_rejection_evidence[0].candidates[0].allowed, false);
});

// ── Test B: admission behaviour is untouched ───────────────────────────────

test("R0I-B: capturing evidence changes no business output", async () => {
  const p = await proto();
  const scenarios: Array<[string, FireModelCandidate[]]> = [
    ["all rejected at full-match gate", Array.from({ length: 5 }, (_u, g) =>
      inGroup(p, g, 0, { market_slug: UNCLASSIFIABLE(g), providerMarketQuestion: UNCLASSIFIABLE(g) })
    )],
    ["all valid", Array.from({ length: 5 }, (_u, g) => inGroup(p, g, 0))],
    ["mixed", Array.from({ length: 6 }, (_u, g) =>
      g % 2 === 0
        ? inGroup(p, g, 0)
        : inGroup(p, g, 0, { market_slug: UNCLASSIFIABLE(g), providerMarketQuestion: UNCLASSIFIABLE(g) })
    )],
  ];

  for (const [label, candidates] of scenarios) {
    const plan = await planWith(candidates);
    const d = plan.diagnostics;
    // These constants were captured by running these EXACT fixtures at this EXACT
    // clock against unmodified origin/main f7ea608 in a detached worktree; the
    // two outputs diffed byte-identical.
    const business = {
      reserved_count: d.reserved_count,
      skipped_outside_horizon: d.skipped_outside_horizon,
      skipped_non_tier1_event: d.skipped_non_tier1_event,
      skipped_no_executable_anchor: d.skipped_no_executable_anchor,
      skipped_no_fullmatch_anchor: d.skipped_no_fullmatch_anchor,
      skipped_no_planning_identity: d.skipped_no_planning_identity,
      first_zero_stage: d.first_zero_stage,
      first_rejection_code: d.first_rejection_code,
      rejection_counts_by_code: d.rejection_counts_by_code,
    };
    const expected: Record<string, unknown> = {
      "all rejected at full-match gate": {
        reserved_count: 0,
        skipped_outside_horizon: 0,
        skipped_non_tier1_event: 0,
        skipped_no_executable_anchor: 0,
        skipped_no_fullmatch_anchor: 5,
        skipped_no_planning_identity: 0,
        first_zero_stage: "FULLMATCH_ANCHOR_ELIGIBLE",
        first_rejection_code: "NO_FULLMATCH_ANCHOR",
        rejection_counts_by_code: { NO_FULLMATCH_ANCHOR: 5, ANCHOR_FULLMATCH_UNSUPPORTED_SPORT: 5 },
      },
      "all valid": {
        reserved_count: 5,
        skipped_outside_horizon: 0,
        skipped_non_tier1_event: 0,
        skipped_no_executable_anchor: 0,
        skipped_no_fullmatch_anchor: 0,
        skipped_no_planning_identity: 0,
        first_zero_stage: null,
        first_rejection_code: null,
        rejection_counts_by_code: {},
      },
      mixed: {
        reserved_count: 3,
        skipped_outside_horizon: 0,
        skipped_non_tier1_event: 0,
        skipped_no_executable_anchor: 0,
        skipped_no_fullmatch_anchor: 3,
        skipped_no_planning_identity: 0,
        first_zero_stage: null,
        first_rejection_code: "NO_FULLMATCH_ANCHOR",
        rejection_counts_by_code: { NO_FULLMATCH_ANCHOR: 3, ANCHOR_FULLMATCH_UNSUPPORTED_SPORT: 3 },
      },
    };
    assert.deepEqual(business, expected[label], `${label}: business output must be unchanged`);
  }
});

test("R0I-B2: reserved events and their identities are unaffected by evidence capture", async () => {
  const p = await proto();
  const plan = await planWith(Array.from({ length: 4 }, (_u, g) => inGroup(p, g, 0)));

  assert.equal(plan.reservations.length, 4);
  assert.deepEqual(
    plan.reservations.map((r) => r.match_family_key).sort(),
    [0, 1, 2, 3].map((g) => `pair:team-a${g}-vs-team-b${g}:2026-07-27`)
  );
  assert.equal(plan.fullmatch_rejection.fullmatch_rejection_groups_total, 0);
});

// ── Test C: only rejected groups appear ────────────────────────────────────

test("R0I-C: a group that PASSES the full-match gate never appears in rejection evidence", async () => {
  const p = await proto();
  const plan = await planWith([
    inGroup(p, 0, 0), // valid full-match moneyline -> reserved
    inGroup(p, 1, 0, { market_slug: UNCLASSIFIABLE(1), providerMarketQuestion: UNCLASSIFIABLE(1) }),
  ]);

  assert.equal(plan.reservations.length, 1);
  const report = plan.fullmatch_rejection;
  assert.equal(report.fullmatch_rejection_groups_total, 1, "only the rejected group is captured");

  const reservedHash = hashPhysicalEventKey("pair:team-a0-vs-team-b0:2026-07-27");
  const rejectedHash = hashPhysicalEventKey("pair:team-a1-vs-team-b1:2026-07-27");
  const hashes = report.fullmatch_rejection_evidence.map((g) => g.physical_event_key_hash);
  assert.ok(!hashes.includes(reservedHash), "a reserved group must not be reported as rejected");
  assert.deepEqual(hashes, [rejectedHash]);
});

test("R0I-C2: a group rejected at a LATER gate is not attributed to the full-match gate", async () => {
  const p = await proto();
  // Passes the full-match gate, then dies at the planning-identity gate.
  const plan = await planWith([
    inGroup(p, 0, 0, { diagnostics: { ...p.diagnostics, game_start_iso: null as unknown as string } }),
  ]);

  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, 0);
  assert.equal(plan.diagnostics.skipped_no_planning_identity, 1);
  assert.equal(plan.fullmatch_rejection.fullmatch_rejection_groups_total, 0);
  assert.deepEqual(plan.fullmatch_rejection.fullmatch_rejection_evidence, []);
});

// ── Test D: bounded, deterministic output ──────────────────────────────────

test("R0I-D: more than 30 groups and more than 10 candidates per group truncate deterministically", async () => {
  const p = await proto();
  const candidates: FireModelCandidate[] = [];
  const GROUPS = 42;
  const PER_GROUP = 14;
  for (let g = 0; g < GROUPS; g += 1) {
    for (let i = 0; i < PER_GROUP; i += 1) {
      candidates.push(
        inGroup(p, g, i, { market_slug: UNCLASSIFIABLE(g), providerMarketQuestion: UNCLASSIFIABLE(g) })
      );
    }
  }
  const plan = await planWith(candidates);
  const report = plan.fullmatch_rejection;

  assert.equal(report.fullmatch_rejection_groups_total, GROUPS);
  assert.equal(report.fullmatch_rejection_groups_reported, FULLMATCH_EVIDENCE_MAX_GROUPS);
  assert.equal(report.fullmatch_rejection_candidates_total, GROUPS * PER_GROUP);
  assert.equal(
    report.fullmatch_rejection_candidates_reported,
    FULLMATCH_EVIDENCE_MAX_GROUPS * FULLMATCH_EVIDENCE_MAX_CANDIDATES_PER_GROUP
  );
  assert.equal(report.fullmatch_rejection_evidence_truncated, true);
  for (const group of report.fullmatch_rejection_evidence) {
    assert.equal(group.candidate_count, PER_GROUP, "the true group size survives truncation");
    assert.equal(group.candidates.length, FULLMATCH_EVIDENCE_MAX_CANDIDATES_PER_GROUP);
  }

  // Deterministic: the same input yields the identical serialization.
  const again = await planWith(candidates);
  assert.equal(
    JSON.stringify(again.fullmatch_rejection),
    JSON.stringify(report),
    "evidence ordering must be deterministic"
  );
  // And ordered by key hash, independent of upstream map iteration order.
  const hashes = report.fullmatch_rejection_evidence.map((g) => g.physical_event_key_hash);
  assert.deepEqual(hashes, [...hashes].sort());
});

test("R0I-D2: an untruncated run reports truncated=false", () => {
  const groups: FullmatchRejectionGroupCapture[] = [
    {
      physicalEventKey: "pair:a-vs-b:2026-07-27",
      sport: "baseball",
      candidates: [
        {
          anchorInput: { providerMarketQuestion: "Will anything happen?", marketSlug: "x" },
          decision: {
            market_class: "forbidden_props",
            event_scope: "prop_or_other",
            allowed: false,
            reason_code: "FORBIDDEN_MARKET_CLASS",
            evidence_source: "structured",
          },
        },
      ],
    },
  ];
  const report = buildFullmatchRejectionEvidence(groups);
  assert.equal(report.fullmatch_rejection_evidence_truncated, false);
  assert.equal(report.fullmatch_rejection_groups_reported, 1);
  assert.equal(report.fullmatch_rejection_candidates_reported, 1);
  // Absent surfaces are total and null, never undefined.
  const c = report.fullmatch_rejection_evidence[0].candidates[0];
  assert.equal(c.market_title, null);
  assert.equal(c.event_title, null);
  assert.equal(c.event_slug, null);
  assert.equal(c.match_family_key, null);
  assert.equal(c.provider_market_question, "Will anything happen?");
});

test("R0I-D3: the HTTP preview is strictly smaller than the report evidence", async () => {
  const p = await proto();
  const candidates: FireModelCandidate[] = [];
  for (let g = 0; g < 8; g += 1) {
    for (let i = 0; i < 6; i += 1) {
      candidates.push(
        inGroup(p, g, i, { market_slug: UNCLASSIFIABLE(g), providerMarketQuestion: UNCLASSIFIABLE(g) })
      );
    }
  }
  const plan = await planWith(candidates);
  const preview = buildFullmatchRejectionPreview(plan.fullmatch_rejection);

  assert.equal(preview.length, FULLMATCH_EVIDENCE_PREVIEW_GROUPS);
  for (const group of preview) {
    assert.equal(group.candidates.length, FULLMATCH_EVIDENCE_PREVIEW_CANDIDATES);
  }

  // job_runs.diagnostics carries the totals and the preview -- never the full set.
  const jobDiag = buildPlanningJobDiagnostics(plan) as Record<string, unknown>;
  assert.equal(jobDiag.fullmatch_rejection_groups_total, 8);
  assert.equal(jobDiag.fullmatch_rejection_candidates_total, 48);
  assert.deepEqual(jobDiag.fullmatch_rejection_evidence_preview, preview);
  assert.equal(jobDiag.fullmatch_rejection_evidence, undefined, "the full evidence must not enlarge job_runs");
});

// ── Test E: no sensitive data ──────────────────────────────────────────────

test("R0I-E: serialized evidence contains no identifiers, secrets or raw payloads", async () => {
  const p = await proto();
  const candidates: FireModelCandidate[] = [];
  for (let g = 0; g < 6; g += 1) {
    for (let i = 0; i < 4; i += 1) {
      candidates.push(
        inGroup(p, g, i, { market_slug: UNCLASSIFIABLE(g), providerMarketQuestion: UNCLASSIFIABLE(g) })
      );
    }
  }
  const plan = await planWith(candidates);
  const serialized = JSON.stringify(plan.fullmatch_rejection);

  for (const forbidden of [
    "condition_id",
    "token_id",
    "secret",
    "authorization",
    "service_role",
    "raw_payload",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"), `evidence must not contain ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /SUPABASE|api[_-]?key|bearer/i);

  // The candidate shape is exactly the eleven agreed keys — nothing leaks in.
  const keys = Object.keys(plan.fullmatch_rejection.fullmatch_rejection_evidence[0].candidates[0]).sort();
  assert.deepEqual(keys, [
    "allowed",
    "event_scope",
    "event_slug",
    "event_title",
    "evidence_source",
    "market_class",
    "market_slug",
    "market_title",
    "match_family_key",
    "provider_market_question",
    "reason_code",
  ]);
  // And the group shape is exactly four keys.
  assert.deepEqual(Object.keys(plan.fullmatch_rejection.fullmatch_rejection_evidence[0]).sort(), [
    "candidate_count",
    "candidates",
    "physical_event_key_hash",
    "sport",
  ]);
});

test("R0I-E2: the persisted report as a whole carries no secrets", async () => {
  const p = await proto();
  const plan = await planWith([
    inGroup(p, 0, 0, { market_slug: UNCLASSIFIABLE(0), providerMarketQuestion: UNCLASSIFIABLE(0) }),
  ]);
  const { path: written } = await persistReservationPlanDiagnostics(plan, { context: "r0i-test" });
  assert.ok(written);

  const { readFile, rm } = await import("node:fs/promises");
  const raw = await readFile(written, "utf-8");
  await rm(written, { force: true });

  assert.doesNotMatch(raw, /SUPABASE|SERVICE_ROLE|authorization|api[_-]?key|secret|bearer/i);
});
