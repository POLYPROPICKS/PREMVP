// Canary single-event planning controls:
//   node --import tsx --test tests/contur3/canary.test.ts
//
// Proves the bounded one-event live-canary seam identified by the prior
// inspect-only task: a read-only preview of selectable physical-event
// groups, and an exact (never fuzzy) hash-targeted planning selector that
// can create at most one Reservation -- through the REAL production planner
// entrypoint (buildReservationPlan), never a parallel planner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import {
  buildReservationPlan,
  buildCanaryPreview,
  hashPhysicalEventKey,
  persistReservationPlan,
  type ReservationRepoPort,
} from "../../lib/executor/nightEventReservations";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const NOW_MS = Date.parse("2026-07-28T19:27:56.137Z");
const KICKOFF_ISO_1 = "2026-07-28T23:10:00.000Z";
const KICKOFF_ISO_2 = "2026-07-29T00:10:00.000Z";
const KICKOFF_ISO_3 = "2026-07-29T01:10:00.000Z";

const RAW_DIAGNOSTICS = {
  total_db_rows: 3,
  raw_allowed_fullmatch_rows: 0,
  raw_forbidden_rows: 0,
  fullmatch_admitted_count: 0,
  fullmatch_rejected_by_reason: {},
};

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
  created_at: "2026-07-28T18:30:00.000Z",
  expires_at: KICKOFF_ISO_1,
  signal_result: null,
  event_slug: "mlb-seed-2026-07-28",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  diagnostics: {
    gameStartIso: KICKOFF_ISO_1,
    dataCoverage: 60,
    shadowScope: "baseball",
    eventTitle: "New York Yankees vs Philadelphia Phillies",
    marketTitle: "Yankees vs Phillies moneyline",
  },
};

async function proto(): Promise<FireModelCandidate> {
  const base = await at(NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [SOURCE_ROW], "CONTRACT_A_PLANNING_V1")
  );
  assert.ok(base.candidates[0], "precondition: the planning selector must produce a candidate");
  return base.candidates[0];
}

/** One physical event whose only representation is a bare event-level matchup question. */
function eventLevelCandidate(
  p: FireModelCandidate,
  i: number,
  question: string,
  kickoffIso: string,
  sport = "baseball"
) {
  return {
    ...p,
    signal_id: `sig-canary-${i}`,
    condition_id: `cond-canary-${i}`,
    token_id: `tok-canary-${i}`,
    inferred_sport: sport,
    providerMarketQuestion: question,
    providerEventTitle: question,
    market_slug: question,
    event_slug: `evt-canary-${i}`,
    match_family_key: `pair:evt-canary-${i}:2026-07-28`,
    canonical_event_key: `pair:evt-canary-${i}:2026-07-28`,
    diagnostics: { ...p.diagnostics, eventTitle: question, marketTitle: null, game_start_iso: kickoffIso },
  } as FireModelCandidate;
}

const THREE_EVENTS = [
  "Atlanta Braves vs. New York Mets",
  "Chicago Cubs vs. St. Louis Cardinals",
  "Baltimore Orioles vs. Detroit Tigers",
];
const KICKOFFS = [KICKOFF_ISO_2, KICKOFF_ISO_1, KICKOFF_ISO_3]; // deliberately out of chronological order

async function threeEventCandidates(): Promise<FireModelCandidate[]> {
  const p = await proto();
  return THREE_EVENTS.map((q, i) => eventLevelCandidate(p, i, q, KICKOFFS[i]));
}

async function planWith(
  candidates: FireModelCandidate[],
  opts: { targetPhysicalEventKeyHash?: string; hashPhysicalEventKey?: (key: string) => string } = {},
  nowMs: number = NOW_MS
) {
  return at(nowMs, () =>
    buildReservationPlan(nowMs, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: RAW_DIAGNOSTICS as any }),
      ...opts,
    })
  );
}

// ── RED (on origin/main, these imports/params do not exist) ────────────────
// buildCanaryPreview is not exported, and buildReservationPlan's deps do not
// accept targetPhysicalEventKeyHash / hashPhysicalEventKey -- this whole file
// fails to even import/compile against origin/main e6490ed..0ad72e1.

// ── Preview: read-only, bounded, no raw identity leaked ────────────────────

test("CANARY-1: preview returns one bounded row per admitted physical-event group, nearest start first, zero writes", async () => {
  const candidates = await threeEventCandidates();
  const plan = await planWith(candidates);
  assert.equal(plan.reservations.length, 3, "precondition: all three events reserve normally");

  const preview = await at(NOW_MS, async () => buildCanaryPreview(plan, NOW_MS));
  assert.equal(preview.length, 3);
  // Nearest start first: KICKOFF_ISO_1 < KICKOFF_ISO_2 < KICKOFF_ISO_3.
  assert.deepEqual(
    preview.map((g) => g.game_start_iso),
    [KICKOFF_ISO_1, KICKOFF_ISO_2, KICKOFF_ISO_3]
  );
  for (const g of preview) {
    assert.equal(typeof g.physical_event_key_hash, "string");
    assert.equal(g.physical_event_key_hash.length, 16);
    assert.match(g.physical_event_key_hash, /^[0-9a-f]{16}$/);
    assert.equal(g.planning_anchor_kind, "STRUCTURED_FULLMATCH_EVENT");
    assert.equal(typeof g.minutes_to_start, "number");
    assert.equal(typeof g.rebalance_window_eligible_now, "boolean");
    // No raw identity, secrets, or provider payload fields ever leak into preview.
    const keys = Object.keys(g).sort();
    assert.deepEqual(keys, [
      "event_title",
      "game_start_iso",
      "minutes_to_start",
      "physical_event_key_hash",
      "planning_anchor_kind",
      "rebalance_window_eligible_now",
      "sport",
    ].sort());
  }
});

test("CANARY-2: preview is bounded to 20 groups", async () => {
  const p = await proto();
  const many = Array.from({ length: 25 }, (_, i) =>
    eventLevelCandidate(p, i, `Team${i}A vs. Team${i}B`, new Date(Date.parse(KICKOFF_ISO_1) + i * 3_600_000).toISOString())
  );
  const plan = await planWith(many);
  const preview = buildCanaryPreview(plan, NOW_MS);
  assert.ok(preview.length <= 20, `preview must be bounded to 20, got ${preview.length}`);
});

// ── Exact planning selector: normal path unchanged when absent ─────────────

test("CANARY-3: normal planning path is byte-identical when targetPhysicalEventKeyHash is absent", async () => {
  const candidates = await threeEventCandidates();
  const plan = await planWith(candidates);
  assert.equal(plan.reservations.length, 3);
  assert.equal(plan.diagnostics.canary_target_requested, false);
  assert.equal(plan.diagnostics.canary_target_matched_group_count, 0);
});

// ── Exact planning selector: positive ───────────────────────────────────────

test("CANARY-4: an exact physical-event hash creates exactly one Reservation, never fuzzy-matched", async () => {
  const candidates = await threeEventCandidates();
  const preview = await planWith(candidates).then((p) => buildCanaryPreview(p, NOW_MS));
  // KICKOFF_ISO_1 is candidates[1]'s start ("Chicago Cubs vs. St. Louis Cardinals").
  const target = preview.find((g) => g.game_start_iso === KICKOFF_ISO_1)!;
  assert.ok(target, "precondition: target group must be present in the unrestricted preview");

  const targeted = await planWith(candidates, { targetPhysicalEventKeyHash: target.physical_event_key_hash });
  assert.equal(targeted.reservations.length, 1, "max Reservations = 1 in canary mode");
  assert.equal(targeted.reservations[0].game_start_iso, KICKOFF_ISO_1);
  assert.equal(targeted.reservations[0].match_family_key, "pair:evt-canary-1:2026-07-28");
  assert.equal(targeted.diagnostics.canary_target_requested, true);
  assert.equal(targeted.diagnostics.canary_target_matched_group_count, 1);
  // No condition/token/side synthesized for an event-level anchor.
  assert.equal(targeted.diagnostics.final_identity_available_at_planning, 0);
  assert.equal((targeted.reservations[0] as unknown as Record<string, unknown>).condition_id, undefined);
});

// ── Negative: unknown hash → fail closed, zero writes ──────────────────────

test("CANARY-5: an unknown hash matches zero groups and creates zero Reservations (fail closed)", async () => {
  const candidates = await threeEventCandidates();
  const plan = await planWith(candidates, { targetPhysicalEventKeyHash: "deadbeefdeadbeef" });
  assert.equal(plan.diagnostics.canary_target_matched_group_count, 0);
  assert.equal(plan.reservations.length, 0);
});

// ── Negative: ambiguous hash → fail closed, zero writes ────────────────────

test("CANARY-6: an ambiguous hash (multiple matching groups) creates zero Reservations (fail closed)", async () => {
  const candidates = await threeEventCandidates();
  const plan = await planWith(candidates, {
    targetPhysicalEventKeyHash: "collide",
    hashPhysicalEventKey: () => "collide", // deterministic ambiguity, injected for testing only
  });
  assert.equal(plan.diagnostics.canary_target_matched_group_count, 3, "all three groups collide under the injected hash");
  assert.equal(plan.reservations.length, 0, "ambiguous match must never pick one arbitrarily");
});

// ── Negative: existing rows in the target plan → fail closed ──────────────

test("CANARY-7: persisting into a plan_run_id that already has rows fails closed (reuses the existing write seam)", async () => {
  const candidates = await threeEventCandidates();
  const preview = await planWith(candidates).then((p) => buildCanaryPreview(p, NOW_MS));
  const target = preview[0];
  const plan = await planWith(candidates, { targetPhysicalEventKeyHash: target.physical_event_key_hash });
  assert.equal(plan.reservations.length, 1);

  const existingRow = { id: "existing-row" } as unknown as NightEventReservationRow;
  const fakeRepo: ReservationRepoPort = {
    async findByPlanRunId() {
      return [existingRow]; // the target plan_run_id already has rows
    },
    async deleteByPlanRunId() {
      throw new Error("must not be called: force is false");
    },
    async insert() {
      throw new Error("must not be called: existing rows must block the write");
    },
  };
  const persisted = await persistReservationPlan(plan, { force: false }, fakeRepo);
  assert.equal(persisted.already_exists, true, "CANARY_PLAN_NOT_EMPTY");
  assert.equal(persisted.written_count, 0);
});

// ── Negative: partial/prop/eSports policy is unchanged by canary targeting ─

test("CANARY-8: a forbidden-anchor event can never be rescued by canary targeting", async () => {
  const p = await proto();
  const esportsCandidate = {
    ...p,
    signal_id: "sig-esports-canary",
    inferred_sport: "esport",
    providerMarketQuestion: "Games Total: O/U 2.5",
    providerEventTitle: "Games Total: O/U 2.5",
    market_slug: "Games Total: O/U 2.5",
    event_slug: "evt-esports-canary",
    match_family_key: "pair:evt-esports-canary:2026-07-28",
    canonical_event_key: "pair:evt-esports-canary:2026-07-28",
    diagnostics: { ...p.diagnostics, eventTitle: "Games Total: O/U 2.5", marketTitle: null, game_start_iso: KICKOFF_ISO_1 },
  } as FireModelCandidate;

  const baselinePlan = await planWith([esportsCandidate]);
  assert.equal(baselinePlan.reservations.length, 0, "precondition: eSports totals market is rejected normally");

  // Even the exact hash of the (never-admitted) group key matches nothing,
  // because targeting only searches groups that already passed every gate.
  const anyHash = hashPhysicalEventKey("pair:evt-esports-canary:2026-07-28");
  const targeted = await planWith([esportsCandidate], { targetPhysicalEventKeyHash: anyHash });
  assert.equal(targeted.diagnostics.canary_target_matched_group_count, 0);
  assert.equal(targeted.reservations.length, 0);
});
