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
  providerSportCode?: unknown;
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
      ...(over.providerSportCode === undefined ? {} : { providerSportCode: over.providerSportCode }),
      gameStartIso: over.gameStartIso === undefined ? FUTURE_START_ISO : over.gameStartIso,
      dataCoverage: 60,
      eventTitle: over.eventTitle,
      marketTitle: over.marketQuestion,
      tier: 1,
      entryPrice: 0.3,
      volumeUsd: 5000,
    } as Record<string, unknown>,
  };
}

test("providerSportCode is the primary structured model input and wins over shadowScope/text", async () => {
  const row = shadowSportsRow({
    id: "provider-basketball",
    providerSportCode: "basketball",
    shadowScope: "soccer",
    eventTitle: "World Cup Qualifier: Team Alpha vs. Team Beta",
    marketQuestion: "World Cup Qualifier: Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "basketball-alpha-vs-beta-2026-08-02",
  });
  const { candidates } = await planningCandidates([row]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].strategic_scope, "BASKETBALL");
  assert.equal(candidates[0].diagnostics.provider_sport_code, "basketball");
  assert.equal(candidates[0].diagnostics.provider_sport_source, "providerSportCode");
  assert.equal(candidates[0].diagnostics.legacy_text_fallback_used, false);
});

for (const [providerSportCode, expectedScope] of [
  ["nba", "BASKETBALL"],
  ["nhl", "HOCKEY"],
  ["mlb", "MLB"],
  ["ufc", "MMA"],
] as const) {
  test(`providerSportCode alias ${providerSportCode} normalizes at the model boundary`, async () => {
    const row = shadowSportsRow({
      id: `provider-${providerSportCode}`,
      providerSportCode,
      shadowScope: "",
      eventTitle: "Team Alpha vs. Team Beta",
      marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
      eventSlug: `${providerSportCode}-alpha-vs-beta-2026-08-02`,
    });
    const { candidates } = await planningCandidates([row]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].strategic_scope, expectedScope);
  });
}

test("unsupported providerSportCode reaches the model and is explicitly rejected", async () => {
  const row = shadowSportsRow({
    id: "provider-rugby",
    providerSportCode: "rugby-sevens",
    shadowScope: "",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "rugby-alpha-vs-beta-2026-08-02",
  });
  const { candidates, rawDiagnostics } = await planningCandidates([row]);
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.UNSUPPORTED_PROVIDER_SPORT, 1);
  assert.equal(rawDiagnostics?.model_input_rows_by_raw_provider_sport?.["rugby-sevens"], 1);
  assert.equal(
    rawDiagnostics?.rejected_before_planning_by_reason.WEAK_EVENT_IDENTITY,
    undefined,
    "a valid-but-unrecognized providerSportCode must reject as UNSUPPORTED_PROVIDER_SPORT, never WEAK_EVENT_IDENTITY"
  );
});

// ── Malformed structured provider sport (2026-08 boundary correction) ──────
// diagnostics.providerSportCode PRESENT but not a usable trimmed non-empty
// string (object/array/number/boolean/empty/whitespace-only) must fail closed
// at the model boundary: it must never be treated as absent and fall through
// to shadowScope or title text, even when both would otherwise produce a
// misleading MLB candidate from team-name text.

const MALFORMED_PROVIDER_SPORT_CASES: Array<{ label: string; value: unknown }> = [
  { label: "object", value: {} },
  { label: "array", value: ["nba"] },
  { label: "number", value: 42 },
  { label: "boolean", value: true },
  { label: "empty-string", value: "" },
  { label: "whitespace-only-string", value: "   " },
];

for (const { label, value } of MALFORMED_PROVIDER_SPORT_CASES) {
  test(`MPS-${label}: a malformed providerSportCode (${label}) fails closed and never falls back to shadowScope or text`, async () => {
    const row = shadowSportsRow({
      id: `malformed-${label}`,
      shadowScope: "mlb",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      marketQuestion: "New York Yankees vs. Boston Red Sox - Moneyline",
      eventSlug: `malformed-${label}-yankees-redsox-2026-08-02`,
    });
    (row.diagnostics as Record<string, unknown>).providerSportCode = value;

    const { candidates, rawDiagnostics } = await planningCandidates([row]);
    assert.equal(candidates.length, 0, `malformed providerSportCode (${label}) must never emit a candidate`);
    assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.MALFORMED_PROVIDER_SPORT, 1);
    assert.equal(rawDiagnostics?.malformed_provider_sport_count, 1);
    assert.equal(
      rawDiagnostics?.rejected_before_planning_by_reason.UNSUPPORTED_PROVIDER_SPORT,
      undefined,
      "malformed data has no valid raw provider string, so it must not be classified as UNSUPPORTED_PROVIDER_SPORT"
    );
    assert.equal(
      rawDiagnostics?.rejected_before_planning_by_reason.WEAK_EVENT_IDENTITY,
      undefined,
      "malformed data must not reach the shadow-fallback scope resolver at all"
    );
  });
}

test("provider metadata and each token/outcome lineage survive model admission independently", async () => {
  const base = shadowSportsRow({
    id: "lineage-a",
    providerSportCode: "nba",
    shadowScope: "",
    eventTitle: "Team Alpha vs. Team Beta",
    marketQuestion: "Team Alpha vs. Team Beta - Moneyline",
    eventSlug: "nba-alpha-vs-beta-2026-08-02",
  });
  base.diagnostics = {
    ...base.diagnostics,
    providerSportSource: "sports-tag",
    providerEventId: "event-42",
    providerMarketId: "market-42",
    gameId: "game-42",
  };
  const second = {
    ...base,
    id: "lineage-b",
    selected_token_id: "tok-lineage-b",
    selected_outcome: "Team B",
    entry_price_num: 0.7,
  };
  const { candidates } = await planningCandidates([base, second]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(c => [c.token_id, c.selected_outcome, c.diagnostics.entry_price]), [
    ["tok-lineage-a", "Team A", 0.3],
    ["tok-lineage-b", "Team B", 0.7],
  ]);
  assert.deepEqual(candidates[0].diagnostics, {
    ...candidates[0].diagnostics,
    provider_sport_code: "nba",
    provider_sport_source: "sports-tag",
    provider_event_id: "event-42",
    provider_market_id: "market-42",
    provider_game_id: "game-42",
  });
});

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
