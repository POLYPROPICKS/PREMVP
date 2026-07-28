// Tennis full-match planning policy — canonical sport admission.
//   node --import tsx --test tests/contur3/tennisFullMatchPolicy.test.ts
//
// Production symptom: deriveSportScope hard-maps every Tennis identity text
// (TENNIS_RE) to StrategicScope "UNKNOWN". Guard F in buildFireModelCandidates
// ("UNKNOWN is never live-eligible") then drops the row before it ever reaches
// the canonical market-anchor policy (lib/contur3/taxonomy.ts) or the planning
// anchor (lib/executor/planningAnchor.ts) -- so a real Tennis match-winner,
// full-match handicap or full-match total games market can never become a
// FireModelCandidate at all, let alone a Reservation.
//
// This suite proves the RED (Tennis normalizes to unknown / never reaches
// planning admission) and, after the fix, proves the GREEN: Tennis becomes a
// canonical sport ("tennis"), full-match moneyline/spread/total markets are
// admitted, multi-market physical events dedupe into one Reservation, and
// non-execution Tennis markets (completion/retirement/set/game/props) stay
// rejected exactly like every other sport's partial-scope markets.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { resolveMarketAnchorDecision } from "../../lib/contur3/taxonomy";

const NOW_MS = Date.parse("2026-07-28T10:00:00.000Z");
const KICKOFF_ISO = "2026-07-28T15:00:00.000Z";

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

function tennisRow(marketTitle: string, i: number) {
  return {
    id: `00000000-0000-4000-8000-00000000010${i}`,
    condition_id: `cond-tennis-${i}`,
    selected_token_id: `tok-tennis-${i}`,
    selected_outcome: "Alexandra Eala",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.65,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-28T09:30:00.000Z",
    expires_at: KICKOFF_ISO,
    signal_result: null,
    event_slug: "tennis-eala-zheng-2026-07-28",
    market_slug: marketTitle,
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: "tennis",
      // Shared across all markets on this physical event so
      // sport normalization and match_family_key both key off the same pair.
      eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
      marketTitle,
    },
  };
}

async function buildTennisCandidates(rows: ReturnType<typeof tennisRow>[]) {
  return at(NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1")
  );
}

async function planWith(candidates: FireModelCandidate[]) {
  return at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: {} as any }),
    })
  );
}

// ── Sport normalization ─────────────────────────────────────────────────────

test("TENNIS-1: a Tennis match-winner row becomes a candidate with canonical sport tennis", async () => {
  const row = tennisRow("Match Winner: Alexandra Eala vs Qinwen Zheng", 1);
  const built = await buildTennisCandidates([row]);
  assert.equal(built.candidates.length, 1, "Tennis must no longer be dropped by Guard F (UNKNOWN scope)");
  const [c] = built.candidates;
  assert.equal(c.strategic_scope, "TENNIS");
  assert.equal(c.inferred_sport, "tennis");
});

// ── Positive: full-match moneyline / spread / total, and multi-market dedupe ─

test("TENNIS-2: full-match moneyline, spread and total games are all classified as allowed full-match markets", () => {
  const marketTexts = [
    "Match Winner: Alexandra Eala vs Qinwen Zheng",
    "Spread: Alexandra Eala (-3.5)",
    "Total Games: Over/Under 22.5",
  ];
  const expectedClass = [
    "allowed_fullmatch_moneyline",
    "allowed_fullmatch_spread",
    "allowed_fullmatch_total",
  ];
  marketTexts.forEach((text, i) => {
    const decision = resolveMarketAnchorDecision({ marketTitle: text, eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng" });
    assert.equal(decision.market_class, expectedClass[i], text);
    assert.equal(decision.event_scope, "full_match", text);
    assert.equal(decision.allowed, true, text);
  });
});

test("TENNIS-3: winner, spread and total for the same provider event collapse into ONE physical event and ONE Reservation", async () => {
  const rows = [
    tennisRow("Match Winner: Alexandra Eala vs Qinwen Zheng", 1),
    tennisRow("Spread: Alexandra Eala (-3.5)", 2),
    tennisRow("Total Games: Over/Under 22.5", 3),
  ];
  const built = await buildTennisCandidates(rows);
  assert.equal(built.candidates.length, 3, "all three markets must reach planning as candidates");

  const familyKeys = new Set(built.candidates.map((c) => c.match_family_key));
  assert.equal(familyKeys.size, 1, "moneyline/spread/total must share one match_family_key");

  const plan = await planWith(built.candidates);
  assert.equal(plan.diagnostics.event_groups, 1, "one physical-event group, not three");
  assert.equal(plan.reservations.length, 1, "one Reservation, not three");
});

// ── Negative: non-execution Tennis markets stay rejected ───────────────────

test("TENNIS-4: match completion is rejected (unknown market class)", () => {
  const decision = resolveMarketAnchorDecision({
    marketTitle: "Will the match be completed?",
    eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.market_class, "unknown");
});

test("TENNIS-5: retirement / withdrawal / injury markets are rejected", () => {
  for (const text of [
    "Will Zheng retire before the match ends?",
    "Will Eala withdraw before the match?",
    "Injury Timeout Called?",
  ]) {
    const decision = resolveMarketAnchorDecision({ marketTitle: text, eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng" });
    assert.equal(decision.allowed, false, text);
    assert.equal(decision.market_class, "unknown", text);
  }
});

test("TENNIS-6: set winner is rejected as partial scope", () => {
  const decision = resolveMarketAnchorDecision({
    marketTitle: "Set 1 Winner: Alexandra Eala",
    eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, "PARTIAL_EVENT_SCOPE");
});

test("TENNIS-7: game winner is rejected as partial scope", () => {
  const decision = resolveMarketAnchorDecision({
    marketTitle: "Game Winner: Alexandra Eala",
    eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, "PARTIAL_EVENT_SCOPE");
});

test("TENNIS-8: a player prop is rejected", () => {
  const decision = resolveMarketAnchorDecision({
    marketTitle: "Player Prop: Total Aces Over 8.5",
    eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.market_class, "forbidden_props");
});

test("TENNIS-9: a full end-to-end plan never reserves a slot for completion/retirement/set/game/prop markets", async () => {
  const rows = [
    tennisRow("Will the match be completed?", 1),
    tennisRow("Injury Timeout Called?", 2),
    tennisRow("Set 1 Winner: Alexandra Eala", 3),
    tennisRow("Game Winner: Alexandra Eala", 4),
    tennisRow("Player Prop: Total Aces Over 8.5", 5),
  ];
  const built = await buildTennisCandidates(rows);
  const plan = await planWith(built.candidates);
  assert.equal(plan.reservations.length, 0, "none of these Tennis markets may reserve a slot");
});
