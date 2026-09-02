// eSports main series-winner planning policy — negative markets stay rejected,
// and Tennis/MLB/soccer behavior is unaffected.
//   node --import tsx --test tests/contur3/esportsNegativeAndRegression.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan, fullMatchAnchorDecision } from "../../lib/executor/nightEventReservations";

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

function providerContext(eventSlug: string, eventTitle: string, marketQuestion: string) {
  return {
    v: "v1",
    provider: "polymarket",
    eventSlug,
    eventTitle,
    marketQuestion,
    sportFamily: "esport",
    game: "valorant",
    league: "PRO",
    eventStartIso: KICKOFF_ISO,
  };
}

/**
 * Establishes inferred_sport === "esport" WITHOUT granting a stable provider
 * event identity (no eventSlug/eventId, so providerEventKeyOf returns null)
 * and WITHOUT setting eventTitle/marketQuestion (so it never overrides the
 * market text under test via providerSeriesTitle's own priority order).
 */
function sportOnlyContextNoIdentity() {
  return {
    v: "v1",
    provider: "polymarket",
    sportFamily: "esport",
    game: "valorant",
    league: "PRO",
  };
}

/**
 * Same as sportOnlyContextNoIdentity, but also carries the market text as the
 * provider's OWN structured question (a "title" surface). Some market-scope
 * signals -- notably a bare "game N" segment marker -- are only trusted as
 * partial-scope evidence on a title surface, not an identifier/slug surface
 * (a doubleheader fixture like "mlb-nyy-bos-game-2" is a genuine full match).
 * Tests that assert a segment-qualified market is rejected must supply the
 * text this way, exactly as a real structured provider question would.
 */
function sportOnlyContextWithQuestion(text: string) {
  return { ...sportOnlyContextNoIdentity(), marketQuestion: text };
}

function esportsRow(opts: {
  id: string;
  marketTitle: string;
  eventTitle: string;
  eventSlug: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: Record<string, unknown> | null;
  selectedOutcome?: string;
}) {
  return {
    id: opts.id,
    condition_id: `cond-${opts.id}`,
    selected_token_id: `tok-${opts.id}`,
    selected_outcome: opts.selectedOutcome ?? "Cloud9",
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
      providerEventContext: opts.ctx,
    },
  };
}

function nonEsportRow(opts: { id: string; eventTitle: string; marketTitle: string; eventSlug: string; selectedOutcome?: string }) {
  return {
    id: opts.id,
    condition_id: `cond-${opts.id}`,
    selected_token_id: `tok-${opts.id}`,
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

async function buildCandidates(rows: (ReturnType<typeof esportsRow> | ReturnType<typeof nonEsportRow>)[]) {
  return at(NOW_MS, () => buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1"));
}

async function planWith(candidates: FireModelCandidate[]) {
  return at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchCandidates: async () => ({ candidates, rawDiagnostics: {} as any }),
    })
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function decisionFor(marketTitle: string, ctx: Record<string, unknown> | null = sportOnlyContextNoIdentity()) {
  // event_slug carries the SAME text as market_slug (the real production shape
  // for a provider slug that embeds the title) so anchorTitle()'s fallback
  // chain -- providerMarketQuestion -> diagnostics.marketTitle -> event_slug ->
  // market_slug -- resolves to the exact text under test regardless of which
  // field wins, exactly as lib/executor/nightEventReservations.ts's own R0A
  // scheduler fixtures do (market_slug === event_slug).
  const row = esportsRow({ id: `neg-${Math.random()}`, marketTitle, eventTitle: marketTitle, eventSlug: marketTitle, ctx });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1, marketTitle);
  return fullMatchAnchorDecision(built.candidates[0]);
}

test("ESPORTS-6: Map 1 winner is rejected", async () => {
  const d = await decisionFor("Map 1 Winner: Cloud9 vs LOUD");
  assert.equal(d.allowed, false);
});

test("ESPORTS-7: Game 1 winner is rejected", async () => {
  const text = "Game 1 Winner: Cloud9 vs LOUD";
  const d = await decisionFor(text, sportOnlyContextWithQuestion(text));
  assert.equal(d.allowed, false);
});

test("ESPORTS-8: round winner is rejected", async () => {
  const d = await decisionFor("Round Winner: Cloud9 vs LOUD");
  assert.equal(d.allowed, false);
});

test("ESPORTS-9: a player performance prop is rejected", async () => {
  const d = await decisionFor("Player Prop: Total Kills Over 20.5 - Cloud9 vs LOUD");
  assert.equal(d.allowed, false);
});

test("ESPORTS-10: an exact series score is rejected even with strong provider identity", async () => {
  const text = "Exact Series Score: Cloud9 vs LOUD 2-1";
  const strongIdentity = providerContext("cloud9-loud-score-2026-07-28", text, text);
  const d = await decisionFor(text, strongIdentity);
  assert.equal(d.allowed, false);
});

test("ESPORTS-11: a tournament/futures winner (one team, no matchup) is rejected", async () => {
  const d = await decisionFor("CS2 Major Winner: Cloud9");
  assert.equal(d.allowed, false);
});

test("ESPORTS-12: an outright market is rejected", async () => {
  const d = await decisionFor("Cloud9 to Win Outright");
  assert.equal(d.allowed, false);
});

test("ESPORTS-13: an ambiguous competitor identity (same team both sides) is rejected", async () => {
  const d = await decisionFor("Cloud9 vs Cloud9 (BO3)");
  assert.deepEqual(d, { allowed: false, reason: "FULLMATCH_TWO_COMPETITORS_MISSING" });
});

test("ESPORTS-14: missing stable provider event identity, no BO marker, is rejected", async () => {
  const d = await decisionFor("Cloud9 vs LOUD", sportOnlyContextNoIdentity());
  assert.deepEqual(d, { allowed: false, reason: "FULLMATCH_SERIES_MARKER_MISSING" });
});

test("ESPORTS-15: a full end-to-end plan never reserves a slot for map/game/round/prop/score/futures markets", async () => {
  const ctx = sportOnlyContextNoIdentity();
  const titles = [
    "Map 1 Winner: Cloud9 vs LOUD",
    "Round Winner: Cloud9 vs LOUD",
    "Player Prop: Total Kills Over 20.5 - Cloud9 vs LOUD",
    "CS2 Major Winner: Cloud9",
  ];
  const rows = titles.map((title, i) =>
    esportsRow({ id: `e${i}`, marketTitle: title, eventTitle: title, eventSlug: title, ctx })
  );
  const built = await buildCandidates(rows);
  const plan = await planWith(built.candidates);
  assert.equal(plan.reservations.length, 0);
});

// ── Regression: Tennis / MLB / soccer unaffected ────────────────────────────

test("ESPORTS-16 (regression): Tennis sport-normalization behavior on this branch is unaffected by the eSports change", async () => {
  // This branch is cut directly from origin/main and deliberately does NOT
  // include the separate Tennis policy patch (PR #69) -- Tennis still
  // normalizes to StrategicScope "UNKNOWN" here and is dropped by Guard F,
  // exactly as on unmodified origin/main. This test proves the eSports change
  // does not alter that behavior one way or the other.
  const row = nonEsportRow({
    id: "tennis-reg",
    eventTitle: "Tennis: Alexandra Eala vs Qinwen Zheng",
    marketTitle: "Match Winner: Alexandra Eala vs Qinwen Zheng",
    eventSlug: "tennis-reg-2026-07-28",
    selectedOutcome: "Alexandra Eala",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 0, "unchanged: Tennis is not yet a supported sport on this branch");
});

test("ESPORTS-17 (regression): an MLB full-match moneyline is unaffected by the eSports change", async () => {
  const row = nonEsportRow({
    id: "mlb-reg",
    eventTitle: "New York Yankees vs Boston Red Sox",
    marketTitle: "New York Yankees vs Boston Red Sox - Moneyline",
    eventSlug: "mlb-reg-2026-07-28",
    selectedOutcome: "New York Yankees",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].inferred_sport, "baseball");
  assert.deepEqual(fullMatchAnchorDecision(built.candidates[0]), { allowed: true });
});

test("ESPORTS-18 (regression): a soccer full-match moneyline is unaffected by the eSports change", async () => {
  const row = nonEsportRow({
    id: "soccer-reg",
    eventTitle: "Manchester United vs Chelsea - Premier League",
    marketTitle: "Match Result: Manchester United vs Chelsea",
    eventSlug: "soccer-reg-2026-07-28",
    selectedOutcome: "Manchester United",
  });
  const built = await buildCandidates([row]);
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].inferred_sport, "soccer");
  assert.deepEqual(fullMatchAnchorDecision(built.candidates[0]), { allowed: true });
});
