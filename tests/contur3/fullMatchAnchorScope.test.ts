// R0G FULL-MATCH ANCHOR SCOPE — market class vs event scope.
//   node --import tsx --test tests/contur3/fullMatchAnchorScope.test.ts
//
// Production run night-plan:2026-07-27:1700-minsk:
//
//   source_rows                = 1962
//   normalized_physical_events = 25
//   physical_event_groups      = 25
//   planning_eligible_events   = 0
//   reservations_created       = 0
//   first_zero_stage           = PLANNING_ELIGIBLE_EVENTS
//   first_rejection_code       = NO_FULLMATCH_ANCHOR
//   rejection_counts_by_code   = { NO_FULLMATCH_ANCHOR: 25,
//                                  ANCHOR_FULLMATCH_SUBMARKET_REJECTED: 25 }
//
// All 25 physical events were classified as having no valid full-match anchor.
//
// The business contract separates two independent axes:
//
//   market class : winner / spread-handicap / total
//   event scope  : full match / first half / second half / map / round / prop
//
// A FULL-MATCH spread is allowed. A FIRST-HALF spread is blocked. The planner's
// anchor list conflated them: ESPORTS_SUBMARKET_RE (which contains \bhandicap\b,
// \bo/u\b, \bover/under\b, \bplayer\b, \brounds?\b and (map|game)\s*\d+) was
// applied to EVERY candidate regardless of sport, so any full-match handicap or
// over/under market was rejected as a "submarket". The same list simultaneously
// ALLOWED genuinely forbidden markets ("Total cards over 4.5", "Winner group A",
// "CS2 major winner") because it only looked for the words total/winner.
//
// lib/contur3/taxonomy.ts is the canonical single source of truth for market
// class. These tests hold the anchor decision to it, and add the missing event
// scope axis.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyMarketText,
  isAllowedFullMatchMarketClass,
  classifyEventScope,
  resolveMarketAnchorDecision,
} from "../../lib/contur3/taxonomy";
import { fullMatchAnchorDecision, buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { TAXONOMY_CORPUS } from "./fixtures/market-taxonomy-corpus";

// Fixed clock: the exact production planning instant.
const PLANNING_MS = Date.parse("2026-07-27T14:00:39.205Z");
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

/** Minimal candidate carrying only identity text -- the anchor decision's real input. */
function candidateWithTitle(text: string, overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return {
    market_slug: text,
    event_slug: text,
    match_family_key: "pair:team-a-vs-team-b:2026-07-27",
    inferred_sport: "soccer",
    providerMarketQuestion: null,
    providerEventTitle: null,
    activity_label_detected: false,
    live_eligible: true,
    diagnostics: { marketTitle: text },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ── 1. Market class: the anchor decision must agree with the canonical taxonomy ──

test("R0G-1: the planning anchor decision agrees with the canonical taxonomy on every corpus case", () => {
  const divergences: string[] = [];
  for (const c of TAXONOMY_CORPUS) {
    const cls = classifyMarketText(c.text);
    const canonicalAllowed = isAllowedFullMatchMarketClass(cls);
    const decision = fullMatchAnchorDecision(candidateWithTitle(c.text));
    if (canonicalAllowed !== decision.allowed) {
      divergences.push(
        `"${c.text}" canonical=${cls}(allowed=${canonicalAllowed}) anchor=${
          decision.allowed ? "allowed" : decision.reason
        }`
      );
    }
  }
  assert.deepEqual(divergences, [], `anchor decision must not diverge from the canonical taxonomy`);
});

// ── 2. Allowed full-match classes (fixture classes 1-3) ────────────────────

test("R0G-2 (fixture 1): a full-match moneyline is allowed", () => {
  for (const text of [
    "Japan vs Sweden — Match Winner",
    "Turkiye vs USA moneyline",
    "1X2: Paraguay vs Australia",
    "Match result: Curaçao vs Côte d'Ivoire",
    "Draw no bet — Paraguay",
  ]) {
    assert.equal(fullMatchAnchorDecision(candidateWithTitle(text)).allowed, true, text);
  }
});

test("R0G-3 (fixture 2, production defect): a FULL-MATCH spread/handicap is allowed, never a submarket", () => {
  for (const text of ["Japan -1.5 spread", "Asian handicap: Sweden +0.5", "Handicap Ecuador -1"]) {
    const d = fullMatchAnchorDecision(candidateWithTitle(text));
    assert.equal(d.allowed, true, `${text} -> ${d.allowed ? "allowed" : d.reason}`);
  }
});

test("R0G-4 (fixture 3, production defect): a FULL-MATCH total is allowed, never a submarket", () => {
  for (const text of [
    "Total goals over 2.5",
    "Over/Under 3.5 — Japan vs Sweden",
    "Japan vs Sweden totals",
    "Under 2.5 goals",
    "Match total OU 2.5",
  ]) {
    const d = fullMatchAnchorDecision(candidateWithTitle(text));
    assert.equal(d.allowed, true, `${text} -> ${d.allowed ? "allowed" : d.reason}`);
  }
});

// ── 3. Blocked event scopes (fixture classes 4-8) ──────────────────────────

test("R0G-5 (fixture 4): a FIRST-HALF spread is blocked -- same market class, different event scope", () => {
  const d = fullMatchAnchorDecision(candidateWithTitle("First half spread: Japan -0.5"));
  assert.equal(d.allowed, false);
  assert.equal(classifyEventScope("First half spread: Japan -0.5"), "first_half");
});

test("R0G-6 (fixture 5): a SECOND-HALF total is blocked", () => {
  const d = fullMatchAnchorDecision(candidateWithTitle("Second half total over 1.5"));
  assert.equal(d.allowed, false);
  assert.equal(classifyEventScope("Second half total over 1.5"), "second_half");
});

test("R0G-7 (fixture 6): a MAP/ROUND handicap is blocked even though its market class is spread", () => {
  for (const text of ["Map 1 handicap: Team Liquid -1.5", "Round 3 winner", "Game 2 handicap"]) {
    const d = fullMatchAnchorDecision(candidateWithTitle(text));
    assert.equal(d.allowed, false, `${text} must be blocked as a partial-event scope`);
    assert.equal(classifyEventScope(text), "map_or_round", text);
  }
  // The market CLASS is still spread/moneyline -- only the SCOPE blocks it.
  assert.equal(classifyMarketText("Map 1 handicap: Team Liquid -1.5"), "allowed_fullmatch_spread");
});

test("R0G-8 (fixture 7): player/team props are blocked", () => {
  for (const text of ["Total cards over 4.5", "Anytime goalscorer: Haaland", "Player props: shots on target"]) {
    assert.equal(fullMatchAnchorDecision(candidateWithTitle(text)).allowed, false, text);
  }
});

test("R0G-9 (fixture 8 + KC regression): activity-label text is blocked", () => {
  for (const text of ["$52K matched activity", "$1.2M matched"]) {
    assert.equal(fullMatchAnchorDecision(candidateWithTitle(text)).allowed, false, text);
  }
});

test("R0G-10: futures/outrights and esports non-policy text stay blocked (previously ALLOWED by the anchor list)", () => {
  assert.equal(fullMatchAnchorDecision(candidateWithTitle("Winner group A")).allowed, false, "futures");
  assert.equal(fullMatchAnchorDecision(candidateWithTitle("CS2 major winner")).allowed, false, "esports non-policy");
});

// ── 3b. Surface-aware scope: a doubleheader identifier is not a partial scope ──

test("R0G-18 (doubleheader): a bare 'game-2' in the EVENT SLUG does not make a full-match moneyline partial", () => {
  const d = resolveMarketAnchorDecision({
    marketTitle: "Yankees vs Red Sox moneyline",
    marketSlug: "mlb-nyy-bos-game-2-2026-07-27",
    eventSlug: "mlb-nyy-bos-game-2-2026-07-27",
  });
  assert.equal(d.allowed, true, `doubleheader game 2 is a real full match -> ${d.reason_code}`);
  assert.equal(d.event_scope, "full_match");
  assert.equal(d.market_class, "allowed_fullmatch_moneyline");
});

test("R0G-19 (doubleheader, planner path): the same shape is an allowed anchor end to end", () => {
  const c = candidateWithTitle("Yankees vs Red Sox moneyline", {
    market_slug: "mlb-nyy-bos-game-2-2026-07-27",
    event_slug: "mlb-nyy-bos-game-2-2026-07-27",
    match_family_key: "pair:new-york-yankees-vs-boston-red-sox:2026-07-27",
    inferred_sport: "baseball",
  });
  const d = fullMatchAnchorDecision(c);
  assert.equal(d.allowed, true, `${d.allowed ? "" : d.reason}`);
});

test("R0G-20: an EXPLICIT partial marker in the market TITLE still blocks", () => {
  const d = resolveMarketAnchorDecision({
    marketTitle: "Game 2: Yankees vs Red Sox moneyline",
    marketSlug: "mlb-nyy-bos-2026-07-27",
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason_code, "PARTIAL_EVENT_SCOPE");
  assert.equal(d.event_scope, "map_or_round");
});

test("R0G-21: every other partial form stays blocked from ANY surface", () => {
  const blocked: Array<[string, string]> = [
    ["Set 1 winner", "set"],
    ["1st quarter spread", "quarter"],
    ["Map 2 handicap", "map"],
    ["Game Handicap: KC (-1.5) vs Team Vitality (+1.5)", "qualified game handicap"],
  ];
  for (const [text, label] of blocked) {
    // as a title
    assert.equal(
      resolveMarketAnchorDecision({ marketTitle: text }).allowed,
      false,
      `${label} must stay blocked as a title: ${text}`
    );
    // and as a slug-only identifier
    assert.equal(
      resolveMarketAnchorDecision({ marketSlug: text }).allowed,
      false,
      `${label} must stay blocked as a slug: ${text}`
    );
  }
});

// ── 4. The structured decision surface ─────────────────────────────────────

test("R0G-11: the canonical decision returns market_class, event_scope, allowed, reason_code and evidence_source", () => {
  const allowed = resolveMarketAnchorDecision({ marketTitle: "Asian handicap: Sweden +0.5" });
  assert.equal(allowed.market_class, "allowed_fullmatch_spread");
  assert.equal(allowed.event_scope, "full_match");
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason_code, null);
  assert.equal(allowed.evidence_source, "normalized", "a derived title is normalized evidence");

  // Class and scope are independent: a map handicap keeps the SPREAD class and
  // is blocked purely on scope.
  const scopeBlocked = resolveMarketAnchorDecision({ marketTitle: "Map 1 handicap: Team Liquid -1.5" });
  assert.equal(scopeBlocked.market_class, "allowed_fullmatch_spread", "class is still spread");
  assert.equal(scopeBlocked.event_scope, "map_or_round", "scope is what blocks it");
  assert.equal(scopeBlocked.allowed, false);
  assert.equal(scopeBlocked.reason_code, "PARTIAL_EVENT_SCOPE");

  // A first-half line is blocked on BOTH axes; the canonical class already
  // encodes halftime, so the class check fires first.
  const halfBlocked = resolveMarketAnchorDecision({ marketTitle: "First half spread: Japan -0.5" });
  assert.equal(halfBlocked.event_scope, "first_half");
  assert.equal(halfBlocked.allowed, false);
  assert.equal(halfBlocked.reason_code, "FORBIDDEN_MARKET_CLASS");

  const unknown = resolveMarketAnchorDecision({ marketTitle: "Some unrecognizable text" });
  assert.equal(unknown.allowed, false, "unknown scope is never broadly accepted");
  assert.equal(unknown.reason_code, "UNKNOWN_MARKET_CLASS");
});

test("R0G-12: structured provider text wins over display slug, and a title change alone does not flip the decision", () => {
  const structured = resolveMarketAnchorDecision({
    providerMarketQuestion: "Asian handicap: Sweden +0.5",
    marketSlug: "sweden-japan-2026-07-27",
  });
  assert.equal(structured.evidence_source, "structured");
  assert.equal(structured.allowed, true);

  // Same market, different display rendering -> same decision.
  const renamed = resolveMarketAnchorDecision({
    providerMarketQuestion: "ASIAN  HANDICAP  —  Sweden  +0.5",
    marketSlug: "completely-different-slug",
  });
  assert.equal(renamed.allowed, structured.allowed);
  assert.equal(renamed.market_class, structured.market_class);
  assert.equal(renamed.event_scope, structured.event_scope);

  const fallback = resolveMarketAnchorDecision({ marketSlug: "japan-vs-sweden-moneyline" });
  assert.equal(fallback.evidence_source, "text_fallback");
  assert.equal(fallback.allowed, true);
});

// ── 5. Representative selection across a real physical-event group ─────────

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { __diagnostics, ...rest } = overrides as Record<string, unknown> & {
    __diagnostics?: Record<string, unknown>;
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    condition_id: "cond-default",
    selected_token_id: "tok-default",
    selected_outcome: "Japan",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    signal_result: null,
    created_at: "2026-07-27T13:00:00.000Z",
    expires_at: "2026-07-28T00:00:00.000Z",
    event_slug: "soccer-jpn-swe-2026-07-27",
    market_slug: "Japan vs. Sweden - Moneyline",
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: "football",
      eventTitle: "Japan vs Sweden",
      marketTitle: "Japan vs Sweden moneyline",
      ...(__diagnostics ?? {}),
    },
    ...rest,
  };
}

async function planFrom(rows: Record<string, unknown>[]) {
  const planning = await at(PLANNING_MS, () =>
    buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1")
  );
  const plan = await at(PLANNING_MS, () =>
    buildReservationPlan(PLANNING_MS, { fetchCandidates: async () => ({ candidates: planning.candidates }) })
  );
  return { planning: planning.candidates, plan };
}

test("R0G-13 (fixture 9): a group whose HIGHEST-scoring market is a blocked first-half line still reserves via its valid full-match sibling", async () => {
  const blockedTopRanked = sourceRow({
    id: "00000000-0000-4000-8000-00000000000a",
    condition_id: "cond-jpn-swe-1h",
    selected_token_id: "tok-jpn-swe-1h",
    score: 95,
    signal_confidence_num: 95, // ranks ABOVE the valid sibling
    entry_price_num: 0.45,
    market_slug: "Japan vs. Sweden - First Half Spread",
    __diagnostics: { dataCoverage: 80, marketTitle: "First half spread: Japan -0.5" },
  });
  const validSibling = sourceRow({
    id: "00000000-0000-4000-8000-00000000000b",
    condition_id: "cond-jpn-swe-ml",
    selected_token_id: "tok-jpn-swe-ml",
    market_slug: "Japan vs. Sweden - Match Winner",
    __diagnostics: { marketTitle: "Japan vs Sweden match winner" },
  });
  const { plan } = await planFrom([blockedTopRanked, validSibling]);
  assert.equal(plan.reservations.length, 1, "the valid full-match sibling must win the representative slot");
  assert.equal(plan.diagnostics.groups_with_fullmatch_candidate, 1);
  assert.equal(plan.diagnostics.groups_only_partial_or_prop, 0);
});

test("R0G-14 (fixture 10): a group of several VALID full-match markets picks one deterministically", async () => {
  const spread = sourceRow({
    id: "00000000-0000-4000-8000-00000000000c",
    condition_id: "cond-spread",
    selected_token_id: "tok-spread",
    market_slug: "Japan vs. Sweden - Spread",
    __diagnostics: { marketTitle: "Japan -1.5 spread" },
  });
  const total = sourceRow({
    id: "00000000-0000-4000-8000-00000000000d",
    condition_id: "cond-total",
    selected_token_id: "tok-total",
    market_slug: "Japan vs. Sweden - Total",
    __diagnostics: { marketTitle: "Total goals over 2.5" },
  });
  const prop = sourceRow({
    id: "00000000-0000-4000-8000-00000000000e",
    condition_id: "cond-prop",
    selected_token_id: "tok-prop",
    score: 99,
    signal_confidence_num: 99,
    market_slug: "Japan vs. Sweden - Cards",
    __diagnostics: { dataCoverage: 80, marketTitle: "Total cards over 4.5" },
  });
  const first = await planFrom([spread, total, prop]);
  const second = await planFrom([spread, total, prop]);
  assert.equal(first.plan.reservations.length, 1);
  assert.equal(
    first.plan.reservations[0].diagnostics.planning_event_key,
    second.plan.reservations[0].diagnostics.planning_event_key,
    "representative selection must be deterministic"
  );
});

test("R0G-15 (fixture 11): a group with NO valid sibling reports NO_FULLMATCH_ANCHOR", async () => {
  const onlyPartial = sourceRow({
    id: "00000000-0000-4000-8000-00000000000f",
    condition_id: "cond-1h-only",
    selected_token_id: "tok-1h-only",
    market_slug: "Japan vs. Sweden - First Half Result",
    __diagnostics: { marketTitle: "First half result: Japan" },
  });
  const { plan } = await planFrom([onlyPartial]);
  assert.equal(plan.reservations.length, 0);
  // Either explicit anchor code is acceptable -- what matters is that the run
  // names one and attributes the group to "only partial/prop markets".
  assert.match(
    String(plan.diagnostics.first_rejection_code),
    /NO_FULLMATCH_ANCHOR|NO_EXECUTABLE_ANCHOR/
  );
  assert.equal(plan.diagnostics.groups_only_partial_or_prop, 1);
  assert.equal(plan.diagnostics.groups_with_fullmatch_candidate, 0);
  assert.equal(plan.diagnostics.groups_with_valid_sibling_but_wrong_rep, 0);
});

test("R0G-16 (fixture 14): duplicate representations of one physical event still produce one Reservation", async () => {
  const a = sourceRow({ id: "00000000-0000-4000-8000-0000000000aa", condition_id: "cond-a", selected_token_id: "tok-a" });
  const b = sourceRow({ id: "00000000-0000-4000-8000-0000000000bb", condition_id: "cond-b", selected_token_id: "tok-b" });
  const { plan } = await planFrom([a, b]);
  assert.equal(plan.reservations.length, 1);
});

// ── 6. Aggregate planning evidence ─────────────────────────────────────────

test("R0G-17: planning diagnostics explain a 25->0 run -- genuinely blocked vs classifier rejection", async () => {
  const validEvent = sourceRow();
  const partialOnlyEvent = sourceRow({
    id: "00000000-0000-4000-8000-0000000000cc",
    condition_id: "cond-other-1h",
    selected_token_id: "tok-other-1h",
    event_slug: "soccer-bra-arg-2026-07-27",
    market_slug: "Brazil vs. Argentina - First Half Total",
    __diagnostics: { marketTitle: "First half total over 1.5", eventTitle: "Brazil vs Argentina" },
  });
  const { plan } = await planFrom([validEvent, partialOnlyEvent]);
  const d = plan.diagnostics;
  for (const field of [
    "groups_with_fullmatch_candidate",
    "groups_only_partial_or_prop",
    "groups_with_valid_sibling_but_wrong_rep",
    "allowed_moneyline_count",
    "allowed_spread_count",
    "allowed_total_count",
    "rejected_partial_count",
    "rejected_prop_count",
    "rejected_activity_label_count",
  ]) {
    assert.ok(field in d, `planning diagnostics must expose ${field}`);
  }
  assert.equal(d.groups_with_fullmatch_candidate, 1);
  assert.equal(d.groups_only_partial_or_prop, 1);
  assert.equal(d.groups_with_valid_sibling_but_wrong_rep, 0, "representative selection must never discard a valid sibling");
  assert.ok(d.allowed_moneyline_count >= 1);
  assert.ok(d.rejected_partial_count >= 1);
  // No secrets or raw payloads in the aggregate evidence.
  assert.doesNotMatch(JSON.stringify(d), /SUPABASE|SERVICE_ROLE|authorization|api[_-]?key|secret/i);
});
