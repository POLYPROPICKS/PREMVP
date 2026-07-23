import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan, fullMatchAnchorDecision } from "../../lib/executor/nightEventReservations";

const START = "2030-01-02T00:00:00.000Z";

function row(id: string, context: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id,
    condition_id: `condition-${id}`,
    selected_token_id: `token-${id}`,
    selected_outcome: "Blue Otter",
    entry_price_num: 0.42,
    signal_confidence_num: 72,
    smart_money_score_num: null,
    market_slug: "Will LoL: Blue Otter beat Cupid Esports (BO3)?",
    event_slug: "Will LoL: Blue Otter beat Cupid Esports...",
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-21T12:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    diagnostics: { gameStartIso: START, dataCoverage: 80, providerEventContext: context },
    ...overrides,
  };
}

const blueContext = {
  v: "v1",
  provider: "polymarket",
  eventSlug: "lol-blue-cpd-2026-07-23",
  eventTitle: "LoL: Blue Otter vs Cupid Esports (BO3) - LFL",
  marketQuestion: "Will LoL: Blue Otter beat Cupid Esports (BO3)?",
  sportFamily: "esport",
  game: "lol",
  league: "LFL",
  eventStartIso: START,
};

test("provider context is authoritative for full-match identity and sport", async () => {
  const result = await buildFireModelCandidates(50, "all", true, [row("blue", blueContext)]);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0] as any;
  assert.equal(candidate.providerEventKey, "polymarket:lol-blue-cpd-2026-07-23:2030-01-02");
  assert.equal(candidate.providerEventTitle, blueContext.eventTitle);
  assert.equal(candidate.inferred_sport, "esport");
});

test("shared provider event identity consumes one reservation slot before ranking", async () => {
  const result = await buildFireModelCandidates(50, "all", true, [
    row("blue-a", blueContext),
    row("blue-b", blueContext, { signal_confidence_num: 73, selected_outcome: "Cupid Esports" }),
  ]);
  const plan = await buildReservationPlan(Date.parse("2030-01-01T14:00:00.000Z"), {
    fetchCandidates: async () => ({ candidates: result.candidates }),
  });
  assert.equal(plan.diagnostics.event_groups, 1);
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.reservations[0].best_snapshot_id, "blue-b");
});

test("authoritative esport context defeats a misleading legacy Pirates title", async () => {
  const context = { ...blueContext, eventSlug: "lol-kcb-tln-2030-01-02", eventTitle: "LoL: Karmine Corp Blue vs TLN Pirates (BO1)", game: "lol" };
  const result = await buildFireModelCandidates(50, "all", true, [row("pirates", context, { market_slug: "LoL: Karmine Corp Blue vs TLN Pirates..." })]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].inferred_sport, "esport");
});

test("old rows without provider context retain legacy fail-closed behavior", async () => {
  const result = await buildFireModelCandidates(50, "all", true, [row("old", {}, { diagnostics: { gameStartIso: START, dataCoverage: 80 }, event_slug: "LoL: Blue Otter vs Cupid Esports (B..." })]);
  assert.equal(result.candidates[0].providerEventKey, null);
  assert.deepEqual(fullMatchAnchorDecision(result.candidates[0]), { allowed: false, reason: "FULLMATCH_SERIES_MARKER_MISSING" });
});
