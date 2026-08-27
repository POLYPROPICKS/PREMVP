import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import { produceContractAPlanningDecisions } from "../../lib/executor/contractADecisions";

const NOW = Date.parse("2026-08-10T14:00:00.000Z");
const START = "2026-08-10T19:00:00.000Z";

async function at<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(value?: string | number | Date) { super(value ?? NOW); }
    static now() { return NOW; }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

function source(index: number, sport: string, overrides: Record<string, unknown> = {}) {
  const eventId = `provider-event-${index}`;
  const marketId = `provider-market-${index}`;
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    source: "polymarket",
    formula_version: "shadow-strategic-sports-v1",
    metric_formula_version: "shadow-strategic-sports-v1",
    condition_id: `condition-${index}`,
    selected_token_id: `token-${index}`,
    selected_outcome: "HOME",
    score: null,
    signal_confidence_num: null,
    entry_price_num: 0.35,
    created_at: "2026-08-10T13:30:00.000Z",
    expires_at: START,
    signal_result: null,
    // Deliberately identical and non-matchup-like across every occurrence.
    event_slug: "same display label",
    market_slug: "same display label",
    diagnostics: {
      gameStartIso: START,
      tier: 1,
      volumeUsd: 100_000,
      shadowScope: sport,
      providerEventId: eventId,
      providerMarketId: marketId,
      providerSportCode: sport,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId,
        eventStartIso: START,
        providerMarketId: marketId,
        marketType: "moneyline",
        sportFamily: sport,
      },
    },
    ...overrides,
  };
}

test("real candidate entry admits exact basketball, baseball, cricket and esports occurrences without text identity", async () => {
  const rows = [source(1, "basketball"), source(2, "baseball"), source(3, "cricket"), source(4, "cs2")];
  const built = await at(() => buildFireModelCandidates(100, "all", true, rows, "CONTRACT_A_PLANNING_V1"));
  assert.equal(built.candidates.length, 4);
  assert.deepEqual(new Set(built.candidates.map((candidate) => candidate.providerEventKey)), new Set([
    "polymarket:provider-event-1:2026-08-10",
    "polymarket:provider-event-2:2026-08-10",
    "polymarket:provider-event-3:2026-08-10",
    "polymarket:provider-event-4:2026-08-10",
  ]));

  // Identity resolution above is unchanged. The pre-Reservation B2 event policy
  // (roadmap step 3/5) is a SEPARATE, later gate: these score-null
  // shadow-strategic-sports-v1 rows carry no persisted canonical Signal Score,
  // so none becomes an accepted Planning Decision (SCORE_BELOW_65), and the
  // eSports occurrence is additionally excluded. B2 never re-enters the
  // identity path — only the planning-eligibility verdict changed.
  const decisions = await at(() => produceContractAPlanningDecisions(rows));
  assert.equal(decisions.filter((decision) => decision.accepted).length, 0);
  for (const decision of decisions) {
    if (decision.accepted) continue;
    assert.match(decision.rejection.reason_code, /^B2_/, "every rejection is a B2 pre-Reservation gate");
  }
  assert.ok(
    decisions.some((decision) => !decision.accepted && decision.rejection.reason_code === "B2_SCORE_BELOW_65")
  );
});

test("same title on different IDs stays distinct; same ID at a different occurrence stays distinct", async () => {
  const rows = [
    source(10, "baseball"),
    source(11, "baseball"),
    source(12, "baseball", {
      diagnostics: {
        ...(source(12, "baseball").diagnostics as Record<string, unknown>),
        gameStartIso: "2026-08-11T19:00:00.000Z",
        providerEventId: "provider-event-10",
        providerEventContext: {
          v: "v1", provider: "polymarket", eventId: "provider-event-10",
          eventStartIso: "2026-08-11T19:00:00.000Z", providerMarketId: "provider-market-12",
          marketType: "moneyline", sportFamily: "baseball",
        },
      },
      expires_at: "2026-08-11T19:00:00.000Z",
    }),
  ];
  const built = await at(() => buildFireModelCandidates(100, "all", true, rows, "CONTRACT_A_PLANNING_V1"));
  assert.equal(built.candidates.length, 3);
  assert.equal(new Set(built.candidates.map((candidate) => candidate.providerEventKey)).size, 3);
});

test("missing event ID, market ID, start, condition, sport or official market type fails closed", async () => {
  const fields = ["eventId", "marketId", "start", "condition", "sport", "marketType"] as const;
  for (let i = 0; i < fields.length; i++) {
    const row = source(20 + i, "baseball") as Record<string, unknown>;
    const diagnostics = structuredClone(row.diagnostics as Record<string, unknown>);
    const context = diagnostics.providerEventContext as Record<string, unknown>;
    if (fields[i] === "eventId") { delete context.eventId; delete diagnostics.providerEventId; }
    if (fields[i] === "marketId") { delete context.providerMarketId; delete diagnostics.providerMarketId; }
    if (fields[i] === "start") { delete context.eventStartIso; delete diagnostics.gameStartIso; row.expires_at = null; }
    if (fields[i] === "condition") row.condition_id = null;
    if (fields[i] === "sport") { delete context.sportFamily; delete diagnostics.providerSportCode; diagnostics.shadowScope = ""; }
    if (fields[i] === "marketType") delete context.marketType;
    row.diagnostics = diagnostics;
    const built = await at(() => buildFireModelCandidates(100, "all", true, [row], "CONTRACT_A_PLANNING_V1"));
    assert.equal(built.candidates.length, 0, `${fields[i]} must be required`);
  }
});
