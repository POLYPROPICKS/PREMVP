import test from "node:test";
import assert from "node:assert/strict";

import {
  FIXTURES,
  norm,
  matchesFixture,
  mismatchWarning,
  marketClass,
  admissionVerdict,
  classifyLayerC,
} from "../reservation-capacity-audit.tier-probe";
import type { NightWindow } from "../../../lib/executor/nightWindow";
import type { NightEventReservationRow } from "../../../lib/executor/executorQueueTypes";

const fx = (id: string) => FIXTURES.find((f) => f.id === id)!;

const baseWindow: NightWindow = {
  startMs: Date.parse("2026-07-03T14:00:00.000Z"),
  endMs: Date.parse("2026-07-04T05:00:00.000Z"),
  startIso: "2026-07-03T14:00:00.000Z",
  endIso: "2026-07-04T05:00:00.000Z",
  horizonEndMs: Date.parse("2026-07-04T08:00:00.000Z"),
  horizonEndIso: "2026-07-04T08:00:00.000Z",
  planDateMinsk: "2026-07-03",
};
const nowMs = Date.parse("2026-07-03T15:00:00.000Z");

function candidate(overrides: any = {}): any {
  return {
    strategy: "TIER1_CORE_STRICT_72_COV50",
    match_family_key: "pair:argentina-vs-caboverde:2026-07-03",
    event_slug: "argentina-vs-cabo-verde-moneyline",
    market_slug: "argentina-vs-cabo-verde-moneyline",
    canonical_event_key: null,
    diagnostics: { score: 80, coverage: 60, game_start_iso: "2026-07-03T18:00:00.000Z" },
    ...overrides,
  };
}

function reservationRow(overrides: any = {}): NightEventReservationRow {
  return {
    plan_run_id: "night-plan:2026-07-03:1700-minsk",
    match_family_key: "pair:argentina-vs-caboverde:2026-07-03",
    event_title: "argentina vs caboverde",
    ...overrides,
  } as unknown as NightEventReservationRow;
}

test("fixture matching does not map 'Paraguay vs Australia' to an 'Australia vs Egypt' row", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  const australiaVsEgyptText = norm("australia-vs-egypt-moneyline");
  assert.equal(
    matchesFixture(australiaVsEgyptText, paraguayVsAustralia),
    false,
    "a row containing only 'australia' (not 'paraguay') must not match the Paraguay vs Australia fixture",
  );
});

test("probe fixture list includes all corrected-log fixtures", () => {
  const ids = FIXTURES.map((f) => f.id);
  const expected = [
    "Paraguay vs Australia",
    "Argentina vs Cabo Verde - More Markets",
    "Türkiye vs United States",
    "Colombia vs Ghana - More Markets",
    "Egypt — Match Winner",
    "Switzerland — Match Winner",
    "Portugal — Match Winner",
    "Spain — Match Winner",
  ];
  for (const id of expected) {
    assert.ok(ids.includes(id), `expected fixture list to include "${id}"`);
  }
});

test("Layer B fixture matching finds rows for a title/slug containing 'Paraguay vs Australia' (no false raw=0)", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  const rows = [
    { event_slug: "paraguay-vs-australia", market_slug: "paraguay-vs-australia-moneyline", selected_outcome: "Paraguay" },
    { event_slug: "australia-vs-egypt", market_slug: "australia-vs-egypt-moneyline", selected_outcome: "Australia" },
  ];
  const matched = rows.filter((r) => {
    const tn = norm(`${r.event_slug ?? ""} ${r.market_slug ?? ""} ${r.selected_outcome ?? ""}`);
    return matchesFixture(tn, paraguayVsAustralia);
  });
  assert.equal(matched.length, 1, "exactly the true Paraguay vs Australia row must match");
  assert.equal(matched[0].event_slug, "paraguay-vs-australia");
});

test("single-team 'Match Winner' fixtures require both the team and the market hint", () => {
  const egyptMatchWinner = FIXTURES.find((f) => f.id === "Egypt — Match Winner")!;
  assert.equal(matchesFixture(norm("egypt-match-winner"), egyptMatchWinner), true);
  assert.equal(
    matchesFixture(norm("egypt-corners-total"), egyptMatchWinner),
    false,
    "team present but no 'match winner' market hint must not match",
  );
  assert.equal(
    matchesFixture(norm("morocco-match-winner"), egyptMatchWinner),
    false,
    "market hint present but wrong team must not match",
  );
});

test("mismatch_warning is false for a correctly matched row and true for a mismatched one (visible matched identity)", () => {
  const paraguayVsAustralia = FIXTURES.find((f) => f.id === "Paraguay vs Australia")!;
  assert.equal(mismatchWarning(norm("paraguay-vs-australia-moneyline"), paraguayVsAustralia), false);
  assert.equal(mismatchWarning(norm("australia-vs-egypt-moneyline"), paraguayVsAustralia), true);
});

test("marketClass and admissionVerdict are unchanged pass-through helpers (regression guard)", () => {
  assert.equal(marketClass("Paraguay vs Australia Moneyline"), "ALLOWED_FULLMATCH");
  assert.equal(marketClass("Paraguay vs Australia Corners Total"), "BLOCKED");
  assert.equal(
    admissionVerdict({ diagnostics: { dataCoverage: 10 }, signal_confidence_num: 90 }),
    "LOW_COVERAGE",
  );
});

// ── LAYER C: planner explanation classification ─────────────────────────────

test("Layer C: 0 builder candidates -> NO_SAFE_ALLOWED_FULLMATCH with SOURCE_MATCH_NOT_FOUND reason", () => {
  const fixture = fx("Paraguay vs Australia");
  const out = classifyLayerC({ fx: fixture, hits: [], tier1Allowed: [], window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.status, "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH");
  assert.match(out.reason, /SOURCE_MATCH_NOT_FOUND/);
  assert.equal(out.inReservationWindow, "unknown");
  assert.equal(out.wouldSelectForReservation, false);
});

test("Layer C: candidate whose start is beyond the horizon -> OUT_OF_RESERVATION_WINDOW", () => {
  const fixture = fx("Argentina vs Cabo Verde - More Markets");
  const hits = [candidate({ diagnostics: { score: 80, coverage: 60, game_start_iso: "2026-07-05T18:00:00.000Z" } })];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: hits, window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.status, "BUILDER_CANDIDATE_OUT_OF_RESERVATION_WINDOW");
  assert.equal(out.inReservationWindow, false);
});

test("Layer C: matching reservation exists -> PLANNER_SELECTED", () => {
  const fixture = fx("Argentina vs Cabo Verde - More Markets");
  const hits = [candidate()];
  const reservations = [reservationRow()];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: hits, window: baseWindow, nowMs, reservations });
  assert.equal(out.status, "BUILDER_CANDIDATE_PLANNER_SELECTED");
  assert.equal(out.existingReservationMatch, true);
});

test("Layer C: in-window Tier1 allowed candidate with no matching reservation -> REJECTED_BY_PLANNER_CAP_OR_DEDUPE", () => {
  const fixture = fx("Colombia vs Ghana - More Markets");
  const hits = [candidate({
    match_family_key: "pair:colombia-vs-ghana:2026-07-03",
    event_slug: "colombia-vs-ghana-moneyline",
    market_slug: "colombia-vs-ghana-moneyline",
  })];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: hits, window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.status, "BUILDER_CANDIDATE_REJECTED_BY_PLANNER_CAP_OR_DEDUPE");
  assert.equal(out.wouldSelectForReservation, true);
});

test("Layer C: weak single-team identity with no Tier1-allowed full-match -> WEAK_IDENTITY", () => {
  const fixture = fx("Egypt — Match Winner");
  const hits = [candidate({
    strategy: "TIER2_SAFE_EXPAND_60_COV50",
    match_family_key: "WEAK_SINGLE_TEAM_MATCH_WINNER:egypt",
    event_slug: "egypt-match-winner",
    market_slug: "egypt-match-winner",
    diagnostics: { score: 65, coverage: 55, game_start_iso: "2026-07-03T18:00:00.000Z" },
  })];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: [], window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.status, "BUILDER_CANDIDATE_WEAK_IDENTITY");
});

test("Layer C: in-window candidates but none Tier1-allowed and not weak -> NO_SAFE_ALLOWED_FULLMATCH", () => {
  const fixture = fx("Switzerland — Match Winner");
  const hits = [candidate({
    strategy: "TIER3_MICRO_EXPAND_50_COV25",
    match_family_key: "pair:switzerland-vs-somebody:2026-07-03",
    event_slug: "switzerland-match-winner",
    market_slug: "switzerland-match-winner",
    diagnostics: { score: 52, coverage: 30, game_start_iso: "2026-07-03T18:00:00.000Z" },
  })];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: [], window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.status, "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH");
});

test("Layer C: candidate missing game_start_iso -> unknown window, UNKNOWN_PLANNER_GAP when otherwise unexplained", () => {
  const fixture = fx("Türkiye vs United States");
  const hits = [candidate({
    strategy: "TIER3_MICRO_EXPAND_50_COV25",
    match_family_key: "pair:turkiye-vs-unitedstates:2026-07-03",
    event_slug: "turkiye-vs-united-states-moneyline",
    market_slug: "turkiye-vs-united-states-moneyline",
    diagnostics: { score: 55, coverage: 30, game_start_iso: null },
  })];
  const out = classifyLayerC({ fx: fixture, hits, tier1Allowed: [], window: baseWindow, nowMs, reservations: [] });
  assert.equal(out.inReservationWindow, "unknown");
  assert.equal(out.status, "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH");
});
