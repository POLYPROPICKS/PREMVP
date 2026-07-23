import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan, fullMatchAnchorDecision } from "../../lib/executor/nightEventReservations";
import type { PolymarketRawEvent } from "../../lib/feed/types";
import {
  deriveProviderEsportsGame,
  selectCanonicalEsportsFullMatchMarket,
} from "../../lib/feed/discoverSportsMarkets";

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

test("real Gamma sibling inventory selects only the canonical BO3 moneyline", () => {
  const event: Pick<PolymarketRawEvent, "title" | "markets"> = {
    title: "Dota 2: Team Jenz vs Inner Circle (BO3) - EPL Masters Play-In Group A",
    markets: [
      { id: "game-1", conditionId: "game-1", question: "Dota 2: Team Jenz vs Inner Circle - Game 1 Winner", slug: "game-1", active: true, closed: false, sportsMarketType: "child_moneyline" },
      { id: "full", conditionId: "full", question: "Dota 2: Team Jenz vs Inner Circle (BO3) - EPL Masters Play-In Group A", slug: "full", active: true, closed: false, sportsMarketType: "moneyline" },
      { id: "total", conditionId: "total", question: "Games Total: O/U 2.5", slug: "total", active: true, closed: false, sportsMarketType: "totals" },
      { id: "handicap", conditionId: "handicap", question: "Game Handicap: ICxI (-1.5) vs Team Jenz (+1.5)", slug: "handicap", active: true, closed: false, sportsMarketType: "map_handicap" },
    ],
  };
  const selected = selectCanonicalEsportsFullMatchMarket(event);
  assert.equal(selected?.conditionId, "full");
});

test("authoritative provider game derives from the complete event title", () => {
  assert.equal(deriveProviderEsportsGame("Dota 2: Team Jenz vs Inner Circle (BO3) - EPL"), "Dota 2");
  assert.equal(deriveProviderEsportsGame("Valorant: Evil Geniuses vs Leviatán Esports (BO3) - VCT"), "Valorant");
  assert.equal(deriveProviderEsportsGame("LoL: Karmine Corp Blue vs TLN Pirates (BO1)"), "LoL");
});

test("Tier1 event ranks the canonical full-match market ahead of stronger submarkets", async () => {
  const context = {
    v: "v1",
    provider: "polymarket",
    eventSlug: "val-eg2-lev1-2030-01-02",
    eventTitle: "Valorant: Evil Geniuses vs Leviatán Esports (BO3) - VCT Americas",
    sportFamily: "Esports",
    game: "Valorant",
    eventStartIso: START,
  };
  const result = await buildFireModelCandidates(50, "all", true, [
    row("fullmatch", { ...context, marketQuestion: context.eventTitle }, { signal_confidence_num: 72 }),
    row("map-total", { ...context, marketQuestion: "Map 2 Total Rounds: Over/Under 21.5" }, { signal_confidence_num: 90 }),
    row("handicap", { ...context, marketQuestion: "Map Handicap: LEV (-1.5) vs Evil Geniuses (+1.5)" }, { signal_confidence_num: 88 }),
  ]);
  const plan = await buildReservationPlan(Date.parse("2030-01-01T14:00:00.000Z"), {
    fetchCandidates: async () => ({ candidates: result.candidates }),
  });
  assert.equal(plan.diagnostics.event_groups, 1);
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.reservations[0].best_snapshot_id, "fullmatch");
});

test("Tier1 submarket-only provider event fails closed with a structured reason", async () => {
  const context = {
    v: "v1",
    provider: "polymarket",
    eventSlug: "val-eg2-lev1-2030-01-02",
    eventTitle: "Valorant: Evil Geniuses vs Leviatán Esports (BO3) - VCT Americas",
    sportFamily: "Esports",
    game: "Valorant",
    eventStartIso: START,
  };
  const result = await buildFireModelCandidates(50, "all", true, [
    row("map-total-only", { ...context, marketQuestion: "Map 2 Total Rounds: Over/Under 21.5" }, { signal_confidence_num: 90 }),
    row("game-winner-only", { ...context, marketQuestion: "Valorant: Evil Geniuses vs Leviatán Esports - Game 1 Winner" }, { signal_confidence_num: 89 }),
    row("games-total-only", { ...context, marketQuestion: "Games Total: O/U 2.5" }, { signal_confidence_num: 88 }),
  ]);
  const plan = await buildReservationPlan(Date.parse("2030-01-01T14:00:00.000Z"), {
    fetchCandidates: async () => ({ candidates: result.candidates }),
  });
  assert.equal(plan.diagnostics.event_groups, 1);
  assert.equal(plan.reservations.length, 0);
  assert.equal((plan.diagnostics as any).skipped_no_fullmatch_anchor, 1);
  assert.equal((plan.diagnostics as any).fullmatch_rejection_reasons.FULLMATCH_SUBMARKET_REJECTED, 1);
});
