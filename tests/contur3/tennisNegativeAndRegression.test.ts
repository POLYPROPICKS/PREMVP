// Tennis full-match planning policy — ambiguous identity fail-closed, and
// regression guards proving NBA/NHL and eSports behavior is untouched.
//   node --import tsx --test tests/contur3/tennisNegativeAndRegression.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { resolvePlanningAnchorDecision, isEventLevelMatchupText } from "../../lib/executor/planningAnchor";
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

function rowFor(opts: { eventTitle: string; marketTitle: string; eventSlug: string; i: number; selectedOutcome?: string }) {
  return {
    id: `00000000-0000-4000-8000-00000000020${opts.i}`,
    condition_id: `cond-reg-${opts.i}`,
    selected_token_id: `tok-reg-${opts.i}`,
    selected_outcome: opts.selectedOutcome ?? null,
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.65,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-28T09:30:00.000Z",
    expires_at: KICKOFF_ISO,
    signal_result: null,
    event_slug: opts.eventSlug,
    market_slug: opts.marketTitle,
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      eventTitle: opts.eventTitle,
      marketTitle: opts.marketTitle,
    },
  };
}

async function buildCandidates(rows: ReturnType<typeof rowFor>[]) {
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

// ── Fail-closed on ambiguous/missing two-player identity ───────────────────

test("TENNIS-10: an ambiguous Tennis event with no two-player matchup fails closed at the planning anchor", () => {
  const anchorInput = { providerMarketQuestion: "Tennis Match Today", eventTitle: "Tennis Match Today" };
  const canonical = resolveMarketAnchorDecision(anchorInput);
  assert.equal(isEventLevelMatchupText("Tennis Match Today"), false);
  const planning = resolvePlanningAnchorDecision({
    existingAnchorAllowed: false,
    canonical,
    anchorInput,
    sport: "tennis",
  });
  assert.equal(planning.allowed_for_planning, false);
});

test("TENNIS-11: a Tennis row with no derivable team pair never reaches an executable candidate with strong identity", async () => {
  const row = rowFor({
    eventTitle: "Tennis: featured match",
    marketTitle: "Match Winner",
    eventSlug: "",
    i: 1,
    selectedOutcome: "Alexandra Eala",
  });
  const built = await buildCandidates([row]);
  for (const c of built.candidates) {
    assert.notEqual(c.identity_quality, "STRONG", "ambiguous identity must never be treated as STRONG");
  }
});

// ── NBA / NHL unchanged ──────────────────────────────────────────────────────

test("TENNIS-12 (regression): NBA and NHL rows still normalize to UNKNOWN scope and are dropped, unchanged", async () => {
  const nbaRow = rowFor({
    eventTitle: "NBA: Los Angeles Lakers vs Boston Celtics",
    marketTitle: "Moneyline: Los Angeles Lakers vs Boston Celtics",
    eventSlug: "nba-lakers-celtics-2026-07-28",
    i: 2,
  });
  const nhlRow = rowFor({
    eventTitle: "NHL: Toronto Maple Leafs vs Montreal Canadiens",
    marketTitle: "Moneyline: Toronto Maple Leafs vs Montreal Canadiens",
    eventSlug: "nhl-leafs-canadiens-2026-07-28",
    i: 3,
  });
  const built = await buildCandidates([nbaRow, nhlRow]);
  assert.equal(built.candidates.length, 0, "NBA/NHL must still be filtered out by Guard F, exactly as on origin/main");
});

// ── eSports unchanged ────────────────────────────────────────────────────────

test("TENNIS-13 (regression): eSports market-scope/policy reason codes are unaffected by the Tennis fix", () => {
  const expected: Record<string, string> = {
    "Games Total: O/U 2.5": "PARTIAL_EVENT_SCOPE",
    "Map Handicap: AUR.YB (-1.5) vs Young TigeRES (+1.5)": "PARTIAL_EVENT_SCOPE",
    "Valorant: ORA Temper vs SaD GC - Map 1 Winner": "ESPORTS_NON_POLICY",
    "Dota 2: YBN Team vs VooDooSh Team (BO3)": "ESPORTS_NON_POLICY",
  };
  for (const [question, reason] of Object.entries(expected)) {
    const anchorInput = { providerMarketQuestion: question, eventTitle: question, marketSlug: question };
    const canonical = resolveMarketAnchorDecision(anchorInput);
    assert.equal(canonical.allowed, false, question);
    assert.equal(canonical.reason_code, reason, question);
  }
});

test("TENNIS-14 (regression): eSports rows still normalize to inferred_sport esport, not tennis", async () => {
  const row = rowFor({
    eventTitle: "Dota 2: YBN Team vs VooDooSh Team (BO3)",
    marketTitle: "Dota 2: YBN Team vs VooDooSh Team (BO3)",
    eventSlug: "esport-ybn-voodoosh-2026-07-28",
    i: 4,
    selectedOutcome: "YBN Team",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].strategic_scope, "ESPORT");
  assert.equal(built.candidates[0].inferred_sport, "esport");
});
