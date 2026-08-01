// EXPANDED SPORTS PLANNING SCOPE — recognize explicit upstream sport metadata.
//   node --import tsx --test tests/contur3/buildFireModelCandidates.expandedSportsScope.test.ts
//
// Production evidence (2026-08-01, CONTRACT_A_PLANNING_V1, 2917 source rows):
//
//   UNKNOWN_SCOPE:        576
//   WEAK_EVENT_IDENTITY:  225   (same root cause -- see below)
//
// Both codes share one root cause: StrategicScope recognized only
// WC/SOCCER/MLB/ESPORT. deriveSportScope's own NBA_NHL_RE and TENNIS_RE
// matched basketball/hockey/tennis text and then deliberately forced
// scope: "UNKNOWN" (buildFireModelCandidates.ts, pre-patch), and cricket/mma
// had no recognition path at all. Every expanded-sport row was therefore
// rejected before any identity, start, or market-policy field was read.
//
// This suite pins the correction: an explicit, exact upstream sport value in
// diagnostics.shadowScope (the field the expanded-sports producer already
// sets -- confirmed authoritative by its existing use in resolvePlanningScope
// for WC/SOCCER) is read BEFORE any text-derived guess, for exactly the six
// sports named in the founder contract. Every other gate -- identity, start,
// market policy, score/coverage/tier -- is untouched and still enforced.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const FUTURE_START_ISO = "2026-08-02T21:00:00.000Z";
const NOW_MS = Date.parse("2026-08-01T17:00:00.000Z");

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
 * A production-shaped `shadow-strategic-sports-v1` planning-fallback row:
 * signal_confidence_num is null (that IS the shadow-fallback signature), an
 * explicit upstream sport in diagnostics.shadowScope, a real event/market
 * identity, a valid future kickoff, and an allowed full-match market.
 */
function shadowSportsRow(over: {
  id: string;
  shadowScope: string;
  eventTitle: string;
  marketQuestion: string;
  eventSlug: string;
  gameStartIso?: string | null;
}) {
  return {
    id: over.id,
    condition_id: `cond-${over.id}`,
    selected_token_id: `tok-${over.id}`,
    selected_outcome: "Team A",
    score: null,
    signal_confidence_num: null,
    smart_money_score_num: null,
    entry_price_num: 0.3,
    metric_formula_version: "shadow-strategic-sports-v1",
    created_at: "2026-08-01T16:00:00.000Z",
    expires_at: FUTURE_START_ISO,
    signal_result: null,
    event_slug: over.eventSlug,
    market_slug: over.marketQuestion,
    diagnostics: {
      shadowScope: over.shadowScope,
      gameStartIso: over.gameStartIso === undefined ? FUTURE_START_ISO : over.gameStartIso,
      dataCoverage: 60,
      eventTitle: over.eventTitle,
      marketTitle: over.marketQuestion,
      tier: 1,
      entryPrice: 0.3,
      volumeUsd: 5000,
    },
  };
}

async function planningCandidates(rows: unknown[]) {
  return at(NOW_MS, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildFireModelCandidates(100_000, "all", true, rows as any, "CONTRACT_A_PLANNING_V1")
  );
}

// ── 1-6: the six required sports become planning candidates ────────────────

const REQUIRED_SPORTS: Array<{ id: string; shadowScope: string; label: string }> = [
  { id: "bball", shadowScope: "basketball", label: "basketball" },
  { id: "hockey", shadowScope: "hockey", label: "hockey" },
  { id: "tennis", shadowScope: "tennis", label: "tennis" },
  { id: "cricket", shadowScope: "cricket", label: "cricket" },
  { id: "mma", shadowScope: "mma", label: "mma" },
  { id: "ufc", shadowScope: "ufc", label: "ufc (alias of mma)" },
];

for (const { id, shadowScope, label } of REQUIRED_SPORTS) {
  test(`ES-${id}: ${label} row with explicit upstream sport becomes a planning candidate`, async () => {
    const row = shadowSportsRow({
      id,
      shadowScope,
      eventTitle: "Team Alpha vs. Team Beta",
      marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
      eventSlug: `${id}-alpha-vs-beta-2026-08-02`,
    });
    const { candidates } = await planningCandidates([row]);
    assert.equal(candidates.length, 1, `${label} row must become a planning candidate`);
    assert.equal(candidates[0].strategic_scope !== "UNKNOWN", true, `${label} scope must not be UNKNOWN`);
  });
}

test("ES-6-ufc: ufc normalizes to the SAME scope as mma", async () => {
  const mmaRow = shadowSportsRow({
    id: "mma2",
    shadowScope: "mma",
    eventTitle: "Fighter One vs. Fighter Two",
    marketQuestion: "Fighter One vs. Fighter Two - Winner",
    eventSlug: "mma-one-vs-two-2026-08-02",
  });
  const ufcRow = shadowSportsRow({
    id: "ufc2",
    shadowScope: "ufc",
    eventTitle: "Fighter Three vs. Fighter Four",
    marketQuestion: "Fighter Three vs. Fighter Four - Winner",
    eventSlug: "ufc-three-vs-four-2026-08-02",
  });
  const { candidates } = await planningCandidates([mmaRow, ufcRow]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].strategic_scope, candidates[1].strategic_scope, "ufc must normalize to mma's scope");
});

// ── 7: explicit upstream sport wins over ambiguous title text ──────────────

test("ES-7: explicit shadowScope wins over title text that could suggest a different sport", async () => {
  // Title text mentions "world cup" (would drive WC scope via text), but the
  // upstream sport is explicitly basketball. The explicit field must win.
  const row = shadowSportsRow({
    id: "ambiguous",
    shadowScope: "basketball",
    eventTitle: "World Cup Qualifier Exhibition: Team Alpha vs. Team Beta",
    marketQuestion: "World Cup Qualifier Exhibition: Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "bball-alpha-vs-beta-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].strategic_scope, "BASKETBALL", "explicit upstream sport must win over ambiguous title text");
});

// ── 8: unknown sport remains rejected ───────────────────────────────────────

test("ES-8: an unrecognized upstream sport remains rejected as UNKNOWN_SCOPE/WEAK_EVENT_IDENTITY", async () => {
  const row = shadowSportsRow({
    id: "unknown-sport",
    shadowScope: "curling",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "curling-alpha-vs-beta-2026-08-02",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "an unrecognized sport must not become a planning candidate");
  const reasons = {
    ...(rawDiagnostics?.rejected_before_planning_by_reason ?? {}),
  };
  assert.ok(
    "WEAK_EVENT_IDENTITY" in reasons || "UNKNOWN_SCOPE" in reasons,
    `unrecognized sport must fail closed with an explicit scope reason: ${JSON.stringify(reasons)}`
  );
});

// ── 9: missing sport metadata stays fail-closed unless text genuinely recognizes it ──

test("ES-9a: missing shadowScope with no recognizable title text stays fail-closed", async () => {
  const row = shadowSportsRow({
    id: "no-sport-meta",
    shadowScope: "",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "unlabeled-alpha-vs-beta-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "absent sport metadata with no recognizable text must stay fail-closed");
});

test("ES-9b: missing shadowScope with genuinely recognizable existing text fallback still works", async () => {
  const row = shadowSportsRow({
    id: "mlb-text-only",
    shadowScope: "",
    eventTitle: "New York Yankees vs. Boston Red Sox",
    marketQuestion: "New York Yankees vs. Boston Red Sox - Moneyline",
    eventSlug: "mlb-nyy-bos-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1, "the pre-existing MLB text fallback must be unchanged");
  assert.equal(candidates[0].strategic_scope, "MLB");
});

// ── 10/11: expanded sport still enforces start validation ──────────────────

test("ES-10: a recognized sport with a missing game start still rejects as MISSING_GAME_START", async () => {
  const row = shadowSportsRow({
    id: "bball-no-start",
    shadowScope: "basketball",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "bball-alpha-vs-beta-no-start",
    gameStartIso: null,
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0);
  assert.ok((rawDiagnostics?.rejected_before_planning_by_reason ?? {}).MISSING_GAME_START >= 1);
});

test("ES-11: a recognized sport with a started/invalid game rejects as GAME_STARTED_OR_INVALID", async () => {
  const row = shadowSportsRow({
    id: "bball-started",
    shadowScope: "basketball",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "bball-alpha-vs-beta-started",
    gameStartIso: "2026-07-30T21:00:00.000Z",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0);
  assert.ok((rawDiagnostics?.rejected_before_planning_by_reason ?? {}).GAME_STARTED_OR_INVALID >= 1);
});

// ── 12: esports remains rejected under current policy ──────────────────────

test("ES-12: esports is not admitted through the expanded-sport path", async () => {
  const row = shadowSportsRow({
    id: "esports-row",
    shadowScope: "esports",
    eventTitle: "Valorant: Team Alpha vs. Team Beta",
    marketQuestion: "Valorant: Team Alpha vs Team Beta - Map 1 Winner",
    eventSlug: "valorant-alpha-vs-beta-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "esports must not be admitted by the expanded-sport shadowScope path");
});

// ── 13: corners/halftime/prop markets still rejected for expanded sports ───

test("ES-13: a corners/halftime/prop market for an expanded sport is still rejected by market policy", async () => {
  const row = shadowSportsRow({
    id: "bball-prop",
    shadowScope: "basketball",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - 1st Quarter Spread",
    eventSlug: "bball-alpha-vs-beta-q1",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "a partial-scope market for an expanded sport must still be rejected");
  const reasons = Object.keys(rawDiagnostics?.market_policy_rejected_by_reason ?? {});
  assert.ok(reasons.length > 0, "the rejection must be attributable to market policy, not silently dropped");
});

// ── 14: no event identity or start is synthesized from title ───────────────

test("ES-14: identity and start are read verbatim, never synthesized from title text", async () => {
  const row = shadowSportsRow({
    id: "bball-identity",
    shadowScope: "basketball",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "bball-alpha-vs-beta-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.event_slug, "bball-alpha-vs-beta-2026-08-02", "event_slug must come from the source row, not be derived from title");
  assert.equal(c.diagnostics.game_start_iso, FUTURE_START_ISO, "game start must be read verbatim from diagnostics.gameStartIso");
  assert.equal(c.condition_id, "cond-bball-identity", "condition_id lineage must be preserved");
  assert.equal(c.token_id, "tok-bball-identity", "token_id lineage must be preserved");
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — EVENT-LEVEL SPORT EVIDENCE + UNCONDITIONAL ESPORTS EXCLUSION
// ═══════════════════════════════════════════════════════════════════════════
//
// Production (2026-08, HEAD 373872a): 179 market-policy-eligible rows, 0
// planning candidates, WEAK_EVENT_IDENTITY = 179.
//
// Root cause: buildIdentityText's planningSources array returns the FIRST
// non-empty surface, and providerContext.marketQuestion sits above
// diag.eventTitle / row.event_slug. A row whose provider context carries a
// market question but no event title therefore yields an identityText of
// "team liquid to win 2-0?" -- and deriveSportScope classifies only THAT,
// returning UNKNOWN even though row.event_slug says "Dota 2: Team Liquid vs
// GamerLegion (BO3)". The sport is identifiable; the classifier was simply
// never shown the surface that identifies it.
//
// Second, independent defect: scope ESPORT has NO unconditional rejection
// before candidate emission. The ES-12 fixture above passes only because its
// "Map 1 Winner" market is a submarket that market policy rejects -- it never
// proved esports exclusion. A full-series BO3 moneyline would be ADMITTED.
// Repairing sport classification therefore REQUIRES adding that gate, or the
// repair would do nothing but admit esports.
//
// Sport classification and physical identity remain different concerns: event
// title/slug is read ONLY to decide the sport, never to build a
// physical_event_id, provider event ID, or grouping key.

/**
 * A production-shaped row whose sport is identifiable ONLY from event-level
 * surfaces: the provider context carries a market question but NO event
 * title, and diagnostics.shadowScope is absent. This is the exact shape the
 * production samples showed.
 */
function eventLevelSportRow(over: {
  id: string;
  eventTitle: string;
  marketQuestion: string;
  eventSlug: string;
  shadowScope?: string;
}) {
  return {
    id: over.id,
    condition_id: `cond-${over.id}`,
    selected_token_id: `tok-${over.id}`,
    selected_outcome: "Team A",
    score: null,
    signal_confidence_num: null,
    smart_money_score_num: null,
    entry_price_num: 0.3,
    metric_formula_version: "shadow-strategic-sports-v1",
    created_at: "2026-08-01T16:00:00.000Z",
    expires_at: FUTURE_START_ISO,
    signal_result: null,
    event_slug: over.eventSlug,
    market_slug: over.marketQuestion,
    diagnostics: {
      // No shadowScope: the explicit-metadata path must NOT be what rescues
      // these rows -- the event-level text fallback is what is under test.
      ...(over.shadowScope ? { shadowScope: over.shadowScope } : {}),
      gameStartIso: FUTURE_START_ISO,
      dataCoverage: 60,
      // Event-level title: the strong surface buildIdentityText skips over.
      eventTitle: over.eventTitle,
      marketTitle: over.marketQuestion,
      tier: 1,
      entryPrice: 0.3,
      volumeUsd: 5000,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        // marketQuestion present, eventTitle DELIBERATELY absent -- this is
        // what makes identityText resolve to the market-level question.
        marketQuestion: over.marketQuestion,
        eventStartIso: FUTURE_START_ISO,
      },
    },
  };
}

// ── A. Event-level sport priority ──────────────────────────────────────────

const EVENT_LEVEL_SPORTS: Array<{ id: string; eventTitle: string; eventSlug: string; scope: string }> = [
  { id: "el-bball", eventTitle: "NBA: Los Angeles Lakers vs. Boston Celtics", eventSlug: "nba-lal-bos-2026-08-02", scope: "BASKETBALL" },
  { id: "el-hockey", eventTitle: "NHL: Toronto Maple Leafs vs. Montreal Canadiens", eventSlug: "nhl-tor-mtl-2026-08-02", scope: "HOCKEY" },
  { id: "el-tennis", eventTitle: "Tennis: Player One vs. Player Two", eventSlug: "tennis-one-vs-two-2026-08-02", scope: "TENNIS" },
  { id: "el-cricket", eventTitle: "Cricket: India vs. Australia", eventSlug: "cricket-ind-aus-2026-08-02", scope: "CRICKET" },
  { id: "el-mma", eventTitle: "UFC: Fighter One vs. Fighter Two", eventSlug: "ufc-one-vs-two-2026-08-02", scope: "MMA" },
];

for (const { id, eventTitle, eventSlug, scope } of EVENT_LEVEL_SPORTS) {
  test(`ES-B1-${id}: sport resolved from EVENT-LEVEL text when the market question names no sport -> ${scope}`, async () => {
    const row = eventLevelSportRow({
      id,
      eventTitle,
      eventSlug,
      // Generic: contains no sport token whatsoever.
      marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    });
    const { candidates } = await planningCandidates([row]);
    assert.equal(candidates.length, 1, `${scope} must be resolvable from event-level text alone`);
    assert.equal(candidates[0].strategic_scope, scope);
  });
}

test("ES-B6: explicit diagnostics.shadowScope still outranks event-level text", async () => {
  const row = eventLevelSportRow({
    id: "el-priority",
    // Event-level text says hockey; explicit upstream metadata says basketball.
    eventTitle: "NHL: Toronto Maple Leafs vs. Montreal Canadiens",
    eventSlug: "nhl-tor-mtl-2026-08-02",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    shadowScope: "basketball",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].strategic_scope, "BASKETBALL", "explicit shadowScope must remain the highest-priority sport source");
});

test("ES-B7: a market question must not override a stronger event-level sport surface", async () => {
  const row = eventLevelSportRow({
    id: "el-override",
    eventTitle: "NBA: Los Angeles Lakers vs. Boston Celtics",
    eventSlug: "nba-lal-bos-2026-08-02",
    // Market question mentions a World Cup phrase; event level says basketball.
    marketQuestion: "World Cup Warmup: Team Alpha vs. Team Beta - Moneyline",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].strategic_scope, "BASKETBALL", "event-level sport evidence must win over market-question text");
});

// ── B. Unconditional esports exclusion ─────────────────────────────────────

const FULL_SERIES_ESPORTS: Array<{ id: string; eventTitle: string; eventSlug: string; label: string }> = [
  { id: "es-dota", eventTitle: "Dota 2: Team Liquid vs GamerLegion (BO3)", eventSlug: "dota2-liquid-vs-gl-2026-08-02", label: "Dota 2" },
  { id: "es-valorant", eventTitle: "Valorant: Team Alpha vs Team Beta (BO3)", eventSlug: "valorant-alpha-vs-beta-2026-08-02", label: "Valorant" },
  { id: "es-cs", eventTitle: "Counter-Strike: Team Alpha vs Team Beta (BO3)", eventSlug: "cs2-alpha-vs-beta-2026-08-02", label: "Counter-Strike" },
];

for (const { id, eventTitle, eventSlug, label } of FULL_SERIES_ESPORTS) {
  test(`ES-B8-${id}: a FULL-SERIES ${label} market is rejected as ESPORTS_EXCLUDED`, async () => {
    const row = eventLevelSportRow({
      id,
      eventTitle,
      eventSlug,
      // A generic full-series moneyline -- market policy would APPROVE this
      // market class. Only an explicit esports gate can reject it.
      marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    });
    const { candidates, rawDiagnostics } = await planningCandidates([row]);
    assert.equal(candidates.length, 0, `${label} must never become a planning candidate`);
    assert.equal(
      (rawDiagnostics?.rejected_before_planning_by_reason ?? {}).ESPORTS_EXCLUDED,
      1,
      `${label} must be rejected by the explicit esports gate, not incidentally`
    );
  });
}

test("ES-B11: the Map 1 esports fixture is rejected as ESPORTS_EXCLUDED, not merely as a submarket", async () => {
  const row = eventLevelSportRow({
    id: "es-map1",
    eventTitle: "Valorant: Team Alpha vs Team Beta",
    eventSlug: "valorant-alpha-vs-beta-map1",
    marketQuestion: "Valorant: Team Alpha vs Team Beta - Map 1 Winner",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0);
  assert.equal(
    (rawDiagnostics?.rejected_before_planning_by_reason ?? {}).ESPORTS_EXCLUDED,
    1,
    "the esports gate must fire before market policy, so the reason is esports -- not submarket"
  );
});

test("ES-B12: an explicit diagnostics.shadowScope esports value is rejected unconditionally", async () => {
  const row = eventLevelSportRow({
    id: "es-explicit",
    eventTitle: "Team Alpha vs. Team Beta",
    eventSlug: "series-alpha-vs-beta-2026-08-02",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    shadowScope: "esport",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "an explicitly esports-labelled row must never be admitted");
  assert.equal((rawDiagnostics?.rejected_before_planning_by_reason ?? {}).ESPORTS_EXCLUDED, 1);
});

// ── C. Safety regressions for the event-level path ─────────────────────────

test("ES-B18: event-level sport text never becomes physical identity", async () => {
  const row = eventLevelSportRow({
    id: "el-identity",
    eventTitle: "NBA: Los Angeles Lakers vs. Boston Celtics",
    eventSlug: "nba-lal-bos-2026-08-02",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  // event_slug is read verbatim from the row; nothing is derived from the title.
  assert.equal(c.event_slug, "nba-lal-bos-2026-08-02");
  assert.equal(c.condition_id, "cond-el-identity");
  assert.equal(c.token_id, "tok-el-identity");
  assert.equal(c.diagnostics.game_start_iso, FUTURE_START_ISO);
  // The sport-classification text must not have leaked into any identity field.
  assert.ok(
    !c.match_family_key.includes("NBA:"),
    "the event-level sport title must never appear inside the match family key"
  );
});

test("ES-B19: an event-level sport with a missing start still rejects as MISSING_GAME_START", async () => {
  const row = {
    ...eventLevelSportRow({
      id: "el-no-start",
      eventTitle: "NBA: Los Angeles Lakers vs. Boston Celtics",
      eventSlug: "nba-lal-bos-no-start",
      marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (row.diagnostics as any).gameStartIso = null;
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0);
  assert.ok((rawDiagnostics?.rejected_before_planning_by_reason ?? {}).MISSING_GAME_START >= 1);
});

test("ES-B20: an event-level sport with a partial-scope market is still rejected by market policy", async () => {
  const row = eventLevelSportRow({
    id: "el-partial",
    eventTitle: "NBA: Los Angeles Lakers vs. Boston Celtics",
    eventSlug: "nba-lal-bos-q1",
    marketQuestion: "Team Alpha vs. Team Beta - 1st Quarter Spread",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "market policy must still reject a partial-scope market");
  assert.ok(
    Object.keys(rawDiagnostics?.market_policy_rejected_by_reason ?? {}).length > 0,
    "the rejection must remain attributable to market policy"
  );
});

test("ES-B21: an event-level surface naming no sport stays fail-closed", async () => {
  const row = eventLevelSportRow({
    id: "el-nosport",
    eventTitle: "Team Alpha vs. Team Beta",
    eventSlug: "unlabeled-alpha-vs-beta-2026-08-02",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 0, "no recognizable sport on any surface must stay fail-closed");
});
