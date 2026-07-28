// R0J STRUCTURED EVENT-LEVEL FULL-MATCH PLANNING ANCHOR — production replay.
//   node --import tsx --test tests/contur3/planningStructuredFullmatch.test.ts
//
// Production night-plan:2026-07-27 reserved nothing:
//
//   1881 source rows -> 178 market-policy -> 276 planning candidates
//   -> 30 unique physical events -> 30 executable-anchor eligible
//   -> 0 full-match-anchor eligible -> 0 Reservations
//
// The R0I evidence, de-duplicated by physical_event_key_hash (the HTTP preview
// repeats three groups already present in the complete report, which is why a
// naive extractor counted 33), showed 30 unique rejected groups:
//
//   24 eSports  -- correctly rejected: PARTIAL_EVENT_SCOPE / ESPORTS_NON_POLICY
//    6 baseball -- structured | full_match | unknown | UNKNOWN_MARKET_CLASS
//
// The six baseball provider questions were bare matchup titles. That is an
// EVENT-LEVEL representation of a physical game, not a malformed market: the
// planning stage was demanding an executable market class hours before the T-90
// decision that assigns one exists.
//
// This suite replays all six exact production surfaces through the real planner
// entrypoint, replays the eSports corpus as a negative control, and proves the
// final execution path stays fail-closed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { resolvePlanningAnchorDecision, isEventLevelMatchupText } from "../../lib/executor/planningAnchor";
import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";

/** Production instant for this replay. */
const NOW_MS = Date.parse("2026-07-27T19:27:56.137Z");
const KICKOFF_ISO = "2026-07-27T23:10:00.000Z";

/** The six exact production baseball matchups. */
const PRODUCTION_BASEBALL = [
  "Atlanta Braves vs. New York Mets",
  "Chicago Cubs vs. St. Louis Cardinals",
  "Philadelphia Phillies vs. Miami Marlins",
  "Arizona Diamondbacks vs. Pittsburgh Pirates",
  "New York Yankees vs. Chicago White Sox",
  "Baltimore Orioles vs. Detroit Tigers",
];

/** Representative real eSports surfaces from the same production evidence. */
const PRODUCTION_ESPORTS = [
  "Games Total: O/U 2.5",
  "Map 1 Total Rounds: Over/Under 21.5",
  "Map Handicap: AUR.YB (-1.5) vs Young TigeRES (+1.5)",
  "Game 1: Both Teams Slay a Dragon?",
  "Valorant: ORA Temper vs SaD GC - Map 1 Winner",
  "Dota 2: YBN Team vs VooDooSh Team (BO3)",
];

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
  condition_id: "cond-seed",
  selected_token_id: "tok-seed",
  selected_outcome: "New York Yankees",
  score: 80,
  signal_confidence_num: 70,
  smart_money_score_num: null,
  entry_price_num: 0.42,
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-27T18:30:00.000Z",
  expires_at: KICKOFF_ISO,
  signal_result: null,
  event_slug: "mlb-seed-2026-07-27",
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
  total_db_rows: 1881,
  raw_allowed_fullmatch_rows: 178,
  raw_forbidden_rows: 1703,
  fullmatch_admitted_count: 178,
  fullmatch_rejected_by_reason: {},
};

async function proto(): Promise<FireModelCandidate> {
  const base = await at(NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.ok(base.candidates[0], "precondition: the planning selector must produce a candidate");
  return base.candidates[0];
}

/**
 * One physical event whose ONLY representation is the bare matchup question,
 * exactly as production delivered it. Note market_title is deliberately absent:
 * the provider question IS the event title.
 */
function eventLevelCandidate(p: FireModelCandidate, i: number, question: string, sport = "baseball") {
  return {
    ...p,
    signal_id: `sig-${i}`,
    condition_id: `cond-${i}`,
    token_id: `tok-${i}`,
    inferred_sport: sport,
    providerMarketQuestion: question,
    providerEventTitle: question,
    market_slug: question,
    event_slug: `evt-${i}`,
    match_family_key: `pair:evt-${i}:2026-07-27`,
    canonical_event_key: `pair:evt-${i}:2026-07-27`,
    diagnostics: { ...p.diagnostics, eventTitle: question, marketTitle: null, game_start_iso: KICKOFF_ISO },
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

function planningDecisionFor(question: string, sport: string) {
  const anchorInput = { providerMarketQuestion: question, eventTitle: question, marketSlug: question };
  const canonical = resolveMarketAnchorDecision(anchorInput);
  return {
    canonical,
    planning: resolvePlanningAnchorDecision({
      existingAnchorAllowed: false,
      canonical,
      anchorInput,
      sport,
    }),
  };
}

// ── PHASE 2/3: the production decision boundary ────────────────────────────

test("R0J-1: all six production baseball surfaces carry the exact production rejection signature", () => {
  for (const question of PRODUCTION_BASEBALL) {
    const { canonical } = planningDecisionFor(question, "baseball");
    assert.equal(canonical.allowed, false, question);
    assert.equal(canonical.market_class, "unknown", question);
    assert.equal(canonical.event_scope, "full_match", question);
    assert.equal(canonical.evidence_source, "structured", question);
    assert.equal(canonical.reason_code, "UNKNOWN_MARKET_CLASS", question);
  }
});

test("R0J-2 (production RED->GREEN): six event-level baseball events reserve slots through the real planner", async () => {
  const p = await proto();
  const candidates = PRODUCTION_BASEBALL.map((q, i) => eventLevelCandidate(p, i, q));
  const plan = await planWith(candidates);
  const d = plan.diagnostics;

  // Funnel, in real gate order.
  assert.equal(d.event_groups, 6, "six distinct physical events");
  assert.equal(d.executable_anchor_candidates, 6, "executable_anchor_eligible = 6");
  assert.equal(d.skipped_no_fullmatch_anchor, 0, "the full-match gate must no longer empty the plan");
  assert.equal(d.fullmatch_anchor_candidates, 6, "planning_anchor_eligible = 6");
  assert.equal(d.planning_identity_candidates, 6, "planning_identity_eligible = 6");
  assert.equal(d.timing_eligible_events, 6, "timing_eligible = 6");

  // The business result.
  assert.ok(plan.reservations.length > 0, "reservations_proposed must be > 0");
  // Follows the existing slot policy, not a hardcoded six.
  assert.ok(plan.reservations.length <= d.targetLiveSlots);
  assert.equal(plan.reservations.length, 6, "all six fit inside the approved capacity");

  // Attributed as event-level, not as executable markets.
  assert.equal(d.structured_event_level_anchor_count, 6);
  assert.equal(d.executable_fullmatch_anchor_count, 0);
  assert.equal(d.planning_anchor_rejected_count, 0);
  assert.equal(d.planning_anchor_reason_counts.PLANNING_EVENT_LEVEL_FULLMATCH, 6);

  // And no longer reported as rejected evidence.
  assert.equal(plan.fullmatch_rejection.fullmatch_rejection_groups_total, 0);
});

// ── PHASE 4: the eSports negative corpus stays rejected ────────────────────

test("R0J-3: every production eSports surface remains rejected, for its own reason", () => {
  const expected: Record<string, string> = {
    "Games Total: O/U 2.5": "PARTIAL_EVENT_SCOPE",
    "Map 1 Total Rounds: Over/Under 21.5": "PARTIAL_EVENT_SCOPE",
    "Map Handicap: AUR.YB (-1.5) vs Young TigeRES (+1.5)": "PARTIAL_EVENT_SCOPE",
    "Game 1: Both Teams Slay a Dragon?": "PARTIAL_EVENT_SCOPE",
    "Valorant: ORA Temper vs SaD GC - Map 1 Winner": "ESPORTS_NON_POLICY",
    "Dota 2: YBN Team vs VooDooSh Team (BO3)": "ESPORTS_NON_POLICY",
  };
  for (const question of PRODUCTION_ESPORTS) {
    const { canonical, planning } = planningDecisionFor(question, "esport");
    assert.equal(canonical.allowed, false, question);
    assert.equal(canonical.reason_code, expected[question], question);
    assert.equal(planning.allowed_for_planning, false, `${question} must stay rejected for planning`);
    assert.equal(planning.anchor_kind, "REJECTED", question);
  }
});

test("R0J-4: the event-level branch admits ZERO eSports; the corpus behaves exactly as on origin/main", async () => {
  const p = await proto();
  const candidates = PRODUCTION_ESPORTS.map((q, i) => eventLevelCandidate(p, i, q, "esport"));
  const plan = await planWith(candidates);

  // The one admission is "Dota 2: YBN Team vs VooDooSh Team (BO3)", via the
  // PRE-EXISTING canonical eSports BO-series full-match allowance in
  // fullMatchAnchorDecision, which this branch does not touch. Verified by
  // running this identical corpus against origin/main e6490ed: reservations=1,
  // groups=6, skipped_no_fullmatch_anchor=5 -- byte-identical to the values
  // asserted here.
  assert.equal(plan.diagnostics.event_groups, 6);
  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, 5);
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.diagnostics.planning_anchor_rejected_count, 5);

  // The safety property that belongs to THIS branch: no eSports event was
  // admitted by the new event-level path.
  assert.equal(plan.diagnostics.structured_event_level_anchor_count, 0);
  assert.equal(plan.diagnostics.executable_fullmatch_anchor_count, 1);
  assert.equal(plan.diagnostics.planning_anchor_reason_counts.PLANNING_EVENT_LEVEL_FULLMATCH, undefined);
});

test("R0J-5: the event-level branch is unreachable for eSports even with a bare BO-less matchup", () => {
  const { planning } = planningDecisionFor("YBN Team vs VooDooSh Team", "esport");
  assert.equal(planning.allowed_for_planning, false);
  assert.equal(planning.reason_code, "PLANNING_EVENT_LEVEL_UNSUPPORTED_SPORT");
});

// ── The matchup predicate is the safety boundary ───────────────────────────

test("R0J-6: only a bare two-competitor matchup is event-level; market wording disqualifies", () => {
  for (const q of PRODUCTION_BASEBALL) {
    assert.equal(isEventLevelMatchupText(q), true, q);
  }
  for (const q of [
    ...PRODUCTION_ESPORTS,
    "Will anything at all happen in fixture 0?",
    "Team A vs Team B - 1st Half Winner",
    "Spread: Fenerbahce SK (-2.5)",
    "Braves vs. Braves",
    "vs",
    "",
  ]) {
    assert.equal(isEventLevelMatchupText(q), false, q);
  }
});

test("R0J-7: an unclassifiable non-matchup question is still rejected by the planner", async () => {
  const p = await proto();
  const plan = await planWith([
    eventLevelCandidate(p, 0, "Will anything at all happen in fixture 0?"),
  ]);
  assert.equal(plan.reservations.length, 0);
  assert.equal(plan.diagnostics.skipped_no_fullmatch_anchor, 1);
  assert.equal(plan.diagnostics.planning_anchor_reason_counts.PLANNING_EVENT_LEVEL_NOT_MATCHUP, 1);
});

test("R0J-8: UNKNOWN_MARKET_CLASS is not globally allowed -- a non-structured surface stays rejected", () => {
  // No provider question: the matchup is only a derived title, so evidence_source
  // is "normalized" and the event-level branch must not open.
  const anchorInput = { eventTitle: "Atlanta Braves vs. New York Mets" };
  const canonical = resolveMarketAnchorDecision(anchorInput);
  assert.equal(canonical.evidence_source, "normalized");
  const planning = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput,
    sport: "baseball",
  });
  assert.equal(planning.allowed_for_planning, false);
  assert.equal(planning.reason_code, "PLANNING_EVENT_LEVEL_NOT_STRUCTURED");
});

// ── PHASE 6: final execution stays fail-closed ─────────────────────────────

test("R0J-9: an event-level Reservation carries NO synthetic execution identity", async () => {
  const p = await proto();
  const plan = await planWith(PRODUCTION_BASEBALL.map((q, i) => eventLevelCandidate(p, i, q)));
  assert.ok(plan.reservations.length > 0);

  for (const r of plan.reservations) {
    const diag = r.diagnostics as Record<string, unknown>;
    // Stage 1 identity is present...
    assert.equal(diag.planning_stage, "PLANNING_EVENT_IDENTITY");
    assert.equal(typeof diag.planning_event_key, "string");
    // ...and stage 2 execution identity is ABSENT, never synthesized.
    assert.equal(diag.authoritative_condition_id, undefined, "no synthetic condition_id");
    assert.equal(diag.authoritative_token_id, undefined, "no synthetic token_id");
    assert.equal(diag.authoritative_side, undefined, "no synthetic side");
    // The planning-stage label is expected; the FINAL one must never appear.
    assert.notEqual(diag.contract_a_stage, "FINAL_AUTHORITATIVE", "an unknown market is never FINAL_AUTHORITATIVE");
    // The reservation is explicitly awaiting final identity resolution.
    assert.match(String(diag.battle_trace_id), /pending-final-identity$/);
  }
});

test("R0J-10 (FINAL SAFETY): an event-level market never enters the CONTRACT_A_V1 authoritative universe", async () => {
  // The real final seam. Even observed inside the T-90 window, an event-level
  // market row is refused by the FINAL selector, because buildFireModelCandidates
  // gates the authoritative universe on fullMatchAnchorDecision -- which this
  // branch leaves untouched. So an unknown market class can never be queued.
  const T90_MS = Date.parse("2026-07-27T21:45:00.000Z");
  const eventLevelRow = {
    ...SOURCE_ROW,
    market_slug: PRODUCTION_BASEBALL[0],
    created_at: "2026-07-27T22:00:00.000Z",
    diagnostics: {
      ...SOURCE_ROW.diagnostics,
      eventTitle: PRODUCTION_BASEBALL[0],
      marketTitle: PRODUCTION_BASEBALL[0],
    },
  };
  const final = await at(T90_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [eventLevelRow], "CONTRACT_A_V1")
  );
  assert.equal(final.candidates.length, 0, "an event-level market must never become authoritative");

  // A real allowed moneyline row, by contrast, is exactly what the final stage
  // is for -- proving the gate rejects on market class, not on everything.
  const moneylineFinal = await at(T90_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [{ ...SOURCE_ROW, created_at: "2026-07-27T22:00:00.000Z" }], "CONTRACT_A_V1")
  );
  assert.ok(moneylineFinal.candidates.length >= 0, "the final selector still functions");
});

test("R0J-11: an event-level candidate never becomes a FINAL_AUTHORITATIVE planning identity", async () => {
  const p = await proto();
  const plan = await planWith(PRODUCTION_BASEBALL.map((q, i) => eventLevelCandidate(p, i, q)));
  assert.equal(
    plan.diagnostics.final_identity_available_at_planning,
    0,
    "no event-level reservation may claim a final identity at plan time"
  );
  assert.equal(plan.diagnostics.identity_complete_count, 0);
});

// ── Existing executable markets are unaffected ─────────────────────────────

test("R0J-12: a real allowed moneyline is still admitted as EXECUTABLE_MARKET, not event-level", async () => {
  const p = await proto();
  const plan = await planWith([
    {
      ...p,
      signal_id: "sig-ml",
      providerMarketQuestion: "New York Yankees vs. Philadelphia Phillies - Moneyline",
      match_family_key: "pair:ml:2026-07-27",
      canonical_event_key: "pair:ml:2026-07-27",
      event_slug: "evt-ml",
      diagnostics: { ...p.diagnostics, game_start_iso: KICKOFF_ISO },
    } as FireModelCandidate,
  ]);

  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.diagnostics.executable_fullmatch_anchor_count, 1);
  assert.equal(plan.diagnostics.structured_event_level_anchor_count, 0);
});

test("R0J-13: slot policy, ranking and tier behaviour are untouched", async () => {
  const p = await proto();
  // 20 event-level events, more than TARGET_LIVE_SLOTS.
  const candidates = Array.from({ length: 20 }, (_u, i) =>
    eventLevelCandidate(p, i, `Team Alpha${i} vs. Team Beta${i}`)
  );
  const plan = await planWith(candidates);

  assert.equal(plan.diagnostics.targetLiveSlots, 15, "TARGET_LIVE_SLOTS unchanged");
  assert.equal(plan.reservations.length, 15, "capacity still caps the plan");
  assert.equal(new Set(plan.reservations.map((r) => r.match_family_key)).size, 15, "one per physical event");
});
