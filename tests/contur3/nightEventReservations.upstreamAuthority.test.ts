// RESERVATION CONSUMES UPSTREAM AUTHORITY — it does not re-decide market policy.
//   node --import tsx --test tests/contur3/nightEventReservations.upstreamAuthority.test.ts
//
// Companion to buildFireModelCandidates.marketPolicy.test.ts. That suite pins
// the upstream half: market policy is decided BEFORE a row becomes a planning
// candidate, and every emitted candidate carries the structured verdict that
// admitted it. This suite pins the downstream half.
//
// The production dry-run rejected all 22 already-planned physical events with
// NO_FULLMATCH_ANCHOR = 22, because reservation slot allocation ran its own
// full-match classification over candidates upstream had already selected.
// With policy moved upstream that gate is not merely deleted -- it is replaced
// by a read of the upstream verdict, so reservation gains no authority it did
// not have and loses the authority it never should have had.
//
// The discriminating fixtures below are deliberately CONTRADICTORY: a candidate
// whose market TEXT classifies one way carries an upstream verdict pointing the
// other way. Only a reservation that reads the verdict (rather than the text)
// can produce the asserted outcome, in BOTH directions. That is what makes
// these behavioral tests rather than source-text assertions.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFireModelCandidates,
  type FireModelCandidate,
} from "../../lib/executor/buildFireModelCandidates";
import {
  buildReservationPlan,
  marketPolicyFingerprint,
} from "../../lib/executor/nightEventReservations";

/**
 * Re-seal a candidate's upstream verdict after a fixture has rewritten its
 * market surfaces.
 *
 * The verdict is bound to the surfaces it was decided from, so a fixture that
 * edits the text is holding a verdict about a different market and reservation
 * correctly refuses to trust it. Production never mutates a candidate between
 * the selector and reservation; these fixtures do, and re-sealing is what makes
 * them production-shaped again.
 *
 * The fingerprint is an integrity check, NOT a classification: it constrains
 * WHICH candidate a verdict describes, never WHAT the verdict says. That is
 * precisely why the contradictory fixtures below are expressible at all.
 */
function sealed(
  c: FireModelCandidate,
  override: Partial<NonNullable<FireModelCandidate["diagnostics"]["market_policy"]>> = {}
): FireModelCandidate {
  const policy = c.diagnostics.market_policy!;
  return {
    ...c,
    diagnostics: {
      ...c.diagnostics,
      market_policy: {
        ...policy,
        ...override,
        anchor_fingerprint: marketPolicyFingerprint({
          providerMarketQuestion: c.providerMarketQuestion ?? null,
          providerEventTitle: c.providerEventTitle ?? null,
          marketTitle:
            typeof (c.diagnostics as Record<string, unknown>).marketTitle === "string"
              ? ((c.diagnostics as Record<string, unknown>).marketTitle as string)
              : null,
          market_slug: c.market_slug ?? null,
          event_slug: c.event_slug ?? null,
          match_family_key: c.match_family_key ?? null,
          inferred_sport: c.inferred_sport ?? null,
          activity_label_detected: c.activity_label_detected,
        }),
      },
    },
  };
}

const PLAN_MS = Date.parse("2026-07-27T17:30:33.404Z");
const KICKOFF_ISO = "2026-07-27T21:00:00.000Z";
/** Founder live-slot policy in lib/executor/nightEventReservations.ts. */
const TARGET_LIVE_SLOTS = 15;

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

/** Production-shaped full-match moneyline source row. */
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
  total_db_rows: 2475,
  raw_allowed_fullmatch_rows: 151,
  raw_forbidden_rows: 2324,
  fullmatch_admitted_count: 151,
  fullmatch_rejected_by_reason: {},
  market_policy_eligible: 151,
  market_policy_rejected: 2324,
  market_policy_rejected_by_reason: {},
};

/** One real selector-produced candidate, carrying a real upstream verdict. */
async function prototype(): Promise<FireModelCandidate> {
  const built = await at(PLAN_MS, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW] as any, "CONTRACT_A_PLANNING_V1")
  );
  const proto = built.candidates[0];
  assert.ok(proto, "precondition: the planning selector must produce a candidate");
  assert.equal(
    proto.diagnostics.market_policy?.allowed,
    true,
    "precondition: the candidate must carry an upstream-approved market policy verdict"
  );
  return proto;
}

/** N distinct physical events off the real prototype. */
async function physicalEvents(
  count: number,
  override: (index: number, candidate: FireModelCandidate) => FireModelCandidate = (_i, c) => c
): Promise<FireModelCandidate[]> {
  const proto = await prototype();
  return Array.from({ length: count }, (_unused, i) =>
    sealed(
      override(i, {
        ...proto,
        signal_id: `sig-${i}`,
        condition_id: `cond-${i}`,
        token_id: `tok-${i}`,
        match_family_key: `pair:team-a${i}-vs-team-b${i}:2026-07-27`,
        canonical_event_key: `pair:team-a${i}-vs-team-b${i}:2026-07-27`,
        providerEventKey: null,
        event_slug: `evt-${i}`,
      })
    )
  );
}

async function planWith(candidates: FireModelCandidate[]) {
  return at(PLAN_MS, () =>
    buildReservationPlan(PLAN_MS, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: RAW_DIAGNOSTICS as any }),
    })
  );
}

/** Rewrite every market surface so the LOCAL classifier would reject the row. */
function withForbiddenMarketText(c: FireModelCandidate): FireModelCandidate {
  return {
    ...c,
    market_slug: "first-half-winner-team-a-vs-team-b",
    providerMarketQuestion: "First half winner: Team A vs Team B",
    providerEventTitle: "Team A vs Team B",
    diagnostics: {
      ...c.diagnostics,
      marketTitle: "First half winner: Team A vs Team B",
    } as FireModelCandidate["diagnostics"],
  };
}

// ── TEST 3 — Reservation consumes the verdict, in BOTH directions ───────────
//
// RED before the patch: reservation re-classifies the market text, the
// forbidden-anchor filter and the full-match gate both fire, and the plan is
// empty with NO_EXECUTABLE_ANCHOR / NO_FULLMATCH_ANCHOR.

test("UA-3a: an upstream-APPROVED candidate is reserved even when its market text would be rejected locally", async () => {
  const [candidate] = await physicalEvents(1, (_i, c) => withForbiddenMarketText(c));
  assert.equal(
    candidate.diagnostics.market_policy?.allowed,
    true,
    "fixture: the upstream verdict must say approved"
  );

  const plan = await planWith([candidate]);

  assert.equal(
    plan.reservations.length,
    1,
    "reservation re-classified an already-approved candidate instead of consuming the verdict"
  );
  assert.equal(
    plan.diagnostics.skipped_no_fullmatch_anchor,
    0,
    "no NO_FULLMATCH_ANCHOR rejection may occur for upstream-approved input"
  );
  assert.equal(
    plan.diagnostics.skipped_no_executable_anchor,
    0,
    "no NO_EXECUTABLE_ANCHOR rejection may occur for upstream-approved input"
  );
});

test("UA-3b: an upstream-REJECTED candidate is refused even when its market text would pass locally", async () => {
  // Market text is an untouched, genuinely allowed full-match moneyline; only
  // the upstream verdict says rejected. The local classifier would admit it.
  const [base] = await physicalEvents(1);
  const candidate = sealed(base, {
    allowed: false,
    reason_code: "PARTIAL_EVENT_SCOPE",
    anchor_kind: "REJECTED",
  });

  const plan = await planWith([candidate]);

  assert.equal(
    plan.reservations.length,
    0,
    "a candidate upstream explicitly rejected entered reservation through the local classifier"
  );
});

test("UA-3c: the production 22 -> 0 collapse cannot recur for approved events", async () => {
  const plan = await planWith(await physicalEvents(22));
  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, 0);
  assert.equal(plan.reservations.length, TARGET_LIVE_SLOTS);
  assert.equal(
    plan.diagnostics.upstream_approved_candidates,
    22,
    "reservation must report how many approved planning candidates it received"
  );
  assert.equal(plan.diagnostics.unique_physical_events, 22);
  assert.equal(plan.diagnostics.slot_candidates_considered, 22);
  assert.equal(plan.diagnostics.slot_allocated, TARGET_LIVE_SLOTS);
  assert.equal(plan.diagnostics.slot_remaining, 0);
});

// ── TEST 4 — one Reservation per exact physical occurrence ──────────────────

test("UA-4: several approved markets for one occurrence yield exactly one reservation", async () => {
  const proto = await prototype();
  const sameEvent = ["moneyline", "spread", "total"].map((family, i) => ({
    ...proto,
    signal_id: `sig-${family}`,
    condition_id: `cond-${family}`,
    token_id: `tok-${family}`,
    match_family_key: "pair:team-a-vs-team-b:2026-07-27",
    canonical_event_key: "pair:team-a-vs-team-b:2026-07-27",
    providerEventKey: null,
    event_slug: "evt-shared",
    diagnostics: { ...proto.diagnostics, score: 70 - i },
  }));

  const plan = await planWith(sameEvent);

  assert.equal(plan.reservations.length, 1, "one physical occurrence must consume exactly one slot");
  assert.equal(plan.reservations[0].physical_event_id, "pair:team-a-vs-team-b:2026-07-27");
  assert.equal(
    plan.reservations[0].event_start_iso,
    KICKOFF_ISO,
    "exact event_start_iso must remain invariant"
  );
  assert.equal(plan.diagnostics.unique_physical_events, 1);
  assert.equal(plan.diagnostics.duplicate_events_removed, 2);
});

// ── TEST 5 — top 15 unique events by the EXISTING comparator ────────────────

test("UA-5: exactly 15 of 20 approved events are reserved, highest-ranked first", async () => {
  // Descending score by index: event 0 is the strongest, event 19 the weakest.
  const events = await physicalEvents(20, (i, c) => ({
    ...c,
    diagnostics: { ...c.diagnostics, score: 90 - i },
  }));

  const plan = await planWith(events);

  assert.equal(plan.reservations.length, TARGET_LIVE_SLOTS, "slot capacity must remain 15");
  const scores = plan.reservations.map((r) => r.event_score);
  assert.deepEqual(
    scores,
    Array.from({ length: TARGET_LIVE_SLOTS }, (_u, i) => 90 - i),
    "the reserved set must be the top 15 by the existing deterministic comparator"
  );
  const reservedKeys = new Set(plan.reservations.map((r) => r.physical_event_id));
  assert.equal(
    reservedKeys.has("pair:team-a15-vs-team-b15:2026-07-27"),
    false,
    "the sixteenth-ranked event must not be reserved"
  );
  assert.equal(reservedKeys.size, TARGET_LIVE_SLOTS, "every reserved slot is a distinct occurrence");
});

// ── TEST 6 — the final execution market is NOT frozen at reservation ────────
//
// Reservation books a physical match slot. The planning market it carries is
// lineage/evidence; the T-70..T-3 rebalance must stay free to select a
// different currently-allowed market for the same occurrence.

test("UA-6: reservation is keyed by occurrence, and never declares the planning market final", async () => {
  const plan = await planWith(await physicalEvents(3));

  for (const r of plan.reservations) {
    // Occurrence identity is the key.
    assert.ok(r.physical_event_id, "reservation must be keyed by physical_event_id");
    assert.equal(r.event_start_iso, KICKOFF_ISO, "exact occurrence start must be preserved");
    assert.equal(r.match_family_key, r.physical_event_id, "the canonical occurrence key is the join key");

    const diag = (r.diagnostics ?? {}) as Record<string, unknown>;
    // The planning-stage identity IS persisted: that is what the rebalance
    // joins on. The FINAL executable identity is NOT -- its absence is exactly
    // what leaves the rebalance free to choose the market later.
    assert.ok(diag.planning_event_key, "planning lineage must be persisted as evidence");
    assert.equal(
      diag.authoritative_condition_id,
      undefined,
      "a planning reservation must not declare a final condition_id"
    );
    assert.equal(
      diag.authoritative_token_id,
      undefined,
      "a planning reservation must not declare a final token_id"
    );
    assert.equal(diag.contract_a_stage, "PLANNING", "the reservation must stay at the PLANNING stage");
  }

  // Occurrence identity is not reconstructed from titles or slugs.
  const keys = plan.reservations.map((r) => r.physical_event_id);
  assert.deepEqual(keys, [
    "pair:team-a0-vs-team-b0:2026-07-27",
    "pair:team-a1-vs-team-b1:2026-07-27",
    "pair:team-a2-vs-team-b2:2026-07-27",
  ]);
});
