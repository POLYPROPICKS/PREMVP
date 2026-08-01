// UPSTREAM MARKET POLICY — the planning selector must decide market policy.
//   node --import tsx --test tests/contur3/buildFireModelCandidates.marketPolicy.test.ts
//
// Production dry-run of buildReservationPlan reported:
//
//   source rows                     2475
//   diagnostics market-policy rows   151
//   planning candidates              285   <-- larger than its own policy input
//   unique physical events            22
//   fullmatch-anchor events            0   NO_FULLMATCH_ANCHOR = 22
//   proposed reservations              0
//
// 285 > 151 is the whole defect in one line: the planning candidate set cannot be
// a subset of the policy-eligible set, so at least 134 planning candidates were
// rows market policy never approved. buildFireModelCandidates computed
// fmMarketClass / fmIsAllowedFullmatch and used them ONLY to increment rawDiag
// counters, so halftime, corners, props and esports-non-policy rows entered
// FireModelCandidate[] exactly like a full-match moneyline.
//
// Reservation was therefore the only effective market-policy gate in the whole
// planning path, which is what NO_FULLMATCH_ANCHOR = 22 actually measured.
//
// This suite pins the corrected boundary: market policy is decided BEFORE a row
// becomes a planning candidate, using the SAME existing classifier, and every
// emitted planning candidate carries the structured verdict that admitted it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const KICKOFF_ISO = "2026-07-27T21:00:00.000Z";
const NOW_MS = Date.parse("2026-07-27T14:00:00.000Z");

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

/**
 * A production-shaped generated_signal_pairs row. Every field that the planning
 * selector's NON-market gates read (score, coverage, entry price, kickoff,
 * scope, tier, stake) is held identical across the fixtures below, so the ONLY
 * variable between an admitted and a rejected row is its market text.
 */
function sourceRow(over: {
  id: string;
  event_slug: string;
  market_slug: string;
  eventTitle: string;
  marketTitle: string;
  shadowScope: string;
}) {
  return {
    id: over.id,
    condition_id: `cond-${over.id}`,
    selected_token_id: `tok-${over.id}`,
    selected_outcome: "Team A",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-27T13:30:00.000Z",
    expires_at: KICKOFF_ISO,
    signal_result: null,
    event_slug: over.event_slug,
    market_slug: over.market_slug,
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: over.shadowScope,
      eventTitle: over.eventTitle,
      marketTitle: over.marketTitle,
    },
  };
}

/**
 * The five market classes named in the founder contract. Exactly one is an
 * allowed live class (full-match spread); the other four are already-blocked
 * classes that must never become planning candidates.
 */
const ALLOWED_FULLMATCH_SPREAD = sourceRow({
  id: "allowed-spread",
  event_slug: "mlb-nyy-phi-2026-07-27",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Spread",
  eventTitle: "New York Yankees vs Philadelphia Phillies",
  marketTitle: "Yankees vs Phillies spread -1.5",
  shadowScope: "baseball",
});

const HALFTIME = sourceRow({
  id: "halftime",
  event_slug: "soccer-ars-che-2026-07-27",
  market_slug: "arsenal-vs-chelsea-first-half-winner",
  eventTitle: "Arsenal vs Chelsea",
  marketTitle: "First half winner: Arsenal vs Chelsea",
  shadowScope: "soccer",
});

const CORNERS = sourceRow({
  id: "corners",
  event_slug: "soccer-liv-mci-2026-07-27",
  market_slug: "liverpool-vs-man-city-total-corners",
  eventTitle: "Liverpool vs Manchester City",
  marketTitle: "Total corners over 9.5",
  shadowScope: "soccer",
});

const PROP = sourceRow({
  id: "prop",
  event_slug: "soccer-bar-rma-2026-07-27",
  market_slug: "barcelona-vs-real-madrid-anytime-goalscorer",
  eventTitle: "Barcelona vs Real Madrid",
  marketTitle: "Anytime goalscorer: Robert Lewandowski",
  shadowScope: "soccer",
});

const ESPORTS_NON_POLICY = sourceRow({
  id: "esports-map",
  event_slug: "valorant-ora-sad-2026-07-27",
  market_slug: "valorant-ora-temper-vs-sad-gc-map-1-winner",
  eventTitle: "Valorant: ORA Temper vs SaD GC",
  marketTitle: "Valorant: ORA Temper vs SaD GC - Map 1 Winner",
  shadowScope: "esports",
});

const ALL_ROWS = [ALLOWED_FULLMATCH_SPREAD, HALFTIME, CORNERS, PROP, ESPORTS_NON_POLICY];

async function planningCandidates(rows: unknown[]) {
  return at(NOW_MS, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildFireModelCandidates(100_000, "all", true, rows as any, "CONTRACT_A_PLANNING_V1")
  );
}

// ── TEST 1 — the upstream filter is real ────────────────────────────────────
//
// RED before the patch: all five rows survive, because no `continue` in the
// planning loop is keyed on market class or event scope.

test("MP-1: only the allowed full-match market becomes a planning candidate", async () => {
  const { candidates } = await planningCandidates(ALL_ROWS);

  const ids = candidates.map((c) => c.generated_signal_pair_id).sort();
  assert.deepEqual(
    ids,
    ["allowed-spread"],
    `policy-rejected rows leaked into the planning candidate set: ${JSON.stringify(ids)}`
  );
});

test("MP-1b: every blocked class is rejected with a structured upstream reason", async () => {
  for (const row of [HALFTIME, CORNERS, PROP]) {
    const { candidates, rawDiagnostics } = await planningCandidates([row]);
    assert.equal(
      candidates.length,
      0,
      `blocked market became a planning candidate: ${row.market_slug}`
    );
    const reasons = Object.keys(rawDiagnostics?.rejected_before_planning_by_reason ?? {});
    assert.ok(
      reasons.some((r) => r.startsWith("MARKET_POLICY_")),
      `no structured MARKET_POLICY_* rejection reason for ${row.market_slug}: ${JSON.stringify(reasons)}`
    );
  }
});

// Esports moved to an EARLIER gate. Product policy excludes esports from the
// planning path outright -- regardless of market class -- so the row is
// rejected as ESPORTS_EXCLUDED before market policy is ever consulted. The
// safety property (never a planning candidate) is unchanged; only the stage
// that owns the decision moved, and it moved deliberately: market policy CAN
// approve a full-series esports moneyline, so it could never enforce this rule.
test("MP-1b-esports: an esports row is rejected by the esports gate, ahead of market policy", async () => {
  const { candidates, rawDiagnostics } = await planningCandidates([ESPORTS_NON_POLICY]);
  assert.equal(candidates.length, 0, "an esports market must never become a planning candidate");
  const reasons = Object.keys(rawDiagnostics?.rejected_before_planning_by_reason ?? {});
  assert.deepEqual(reasons, ["ESPORTS_EXCLUDED"]);
});

// ── TEST 1c — the production arithmetic can no longer happen ────────────────
//
// planning_candidates must be a SUBSET of the policy-eligible rows. The
// production shape (285 candidates from 151 policy-eligible rows) is exactly
// the inequality this asserts against.

test("MP-1c: planning_candidates <= market_policy_eligible (285 > 151 is impossible)", async () => {
  const { candidates, rawDiagnostics } = await planningCandidates(ALL_ROWS);
  assert.ok(rawDiagnostics, "planning mode must produce raw diagnostics");
  assert.ok(
    candidates.length <= rawDiagnostics.market_policy_eligible,
    `planning candidates (${candidates.length}) exceeded policy-eligible rows ` +
      `(${rawDiagnostics.market_policy_eligible}) -- rejected rows leaked forward`
  );
  // The esports row is now rejected by the earlier esports gate and therefore
  // never reaches market policy -- so the market-policy ledger accounts for
  // every row that REACHED it, which is ALL_ROWS minus that one.
  assert.equal(
    rawDiagnostics.market_policy_eligible + rawDiagnostics.market_policy_rejected,
    ALL_ROWS.length - 1,
    "every source row must be accounted as policy-eligible or policy-rejected"
  );
  assert.equal(rawDiagnostics.market_policy_eligible, 1);
  // halftime + corners + prop. The esports row never reaches this ledger.
  assert.equal(rawDiagnostics.market_policy_rejected, 3);
  assert.equal(
    (rawDiagnostics.rejected_before_planning_by_reason ?? {}).ESPORTS_EXCLUDED,
    1,
    "the esports row must still be accounted for -- at its own, earlier gate"
  );
});

// ── TEST 2 — every emitted candidate carries the explicit verdict ───────────

test("MP-2: each planning candidate carries the structured upstream market-policy verdict", async () => {
  const { candidates } = await planningCandidates(ALL_ROWS);
  assert.equal(candidates.length, 1);

  const policy = candidates[0].diagnostics.market_policy;
  assert.ok(policy, "planning candidate carries no market_policy verdict");
  assert.equal(policy.allowed, true);
  assert.equal(policy.market_class, "allowed_fullmatch_spread");
  assert.equal(policy.event_scope, "full_match");
  assert.equal(policy.reason_code, "EXECUTABLE_MARKET");
  assert.equal(policy.anchor_kind, "EXECUTABLE_MARKET");
  assert.equal(policy.decided_by, "CONTRACT_A_PLANNING_V1");
});

// ── The verdict comes from the SAME classifier, not a second one ────────────
//
// The structured full-match EVENT anchor (planningAnchor.ts) is part of the
// existing policy and must survive the move upstream unchanged: a bare
// provider matchup title for a supported non-esports sport is still admitted,
// as PLANNING_EVENT_LEVEL_FULLMATCH rather than as an executable market class.

test("MP-2b: the structured event-level full-match anchor is preserved upstream", async () => {
  const bareMatchup = {
    ...sourceRow({
      id: "structured-event",
      event_slug: "mlb-atl-nym-2026-07-27",
      market_slug: "Atlanta Braves vs. New York Mets",
      eventTitle: "Atlanta Braves vs. New York Mets",
      marketTitle: "Atlanta Braves vs. New York Mets",
      shadowScope: "baseball",
    }),
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: "baseball",
      eventTitle: "Atlanta Braves vs. New York Mets",
      marketTitle: "Atlanta Braves vs. New York Mets",
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: "evt-atl-nym",
        eventSlug: "mlb-atl-nym-2026-07-27",
        eventTitle: "Atlanta Braves vs. New York Mets",
        marketQuestion: "Atlanta Braves vs. New York Mets",
        eventStartIso: KICKOFF_ISO,
      },
    },
  };
  const { candidates } = await planningCandidates([bareMatchup]);
  assert.equal(candidates.length, 1, "the structured event-level full-match anchor was dropped");
  assert.equal(candidates[0].diagnostics.market_policy?.allowed, true);
  assert.equal(
    candidates[0].diagnostics.market_policy?.anchor_kind,
    "STRUCTURED_FULLMATCH_EVENT",
    "the event-level anchor must keep its own kind, not be relabelled an executable market"
  );
});

// ── Scoring, tier and lineage are untouched by this patch ───────────────────

test("MP-3: score, tier and event lineage of an admitted candidate are unchanged", async () => {
  const { candidates } = await planningCandidates([ALLOWED_FULLMATCH_SPREAD]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.diagnostics.score, 70, "model score must not be altered by the policy gate");
  assert.equal(c.diagnostics.coverage, 60, "coverage must not be altered by the policy gate");
  assert.equal(c.condition_id, "cond-allowed-spread", "source market lineage must be preserved");
  assert.equal(c.token_id, "tok-allowed-spread", "source token lineage must be preserved");
  assert.equal(c.event_slug, "mlb-nyy-phi-2026-07-27", "event lineage must be preserved");
  assert.equal(c.diagnostics.game_start_iso, KICKOFF_ISO, "event start must be preserved exactly");
});
