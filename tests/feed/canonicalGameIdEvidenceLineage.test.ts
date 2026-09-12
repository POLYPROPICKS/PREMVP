import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStructuredProviderDiagnostics,
  sampleToCandidateMarkets,
  type ParentEventMeta,
} from "../../lib/feed/buildLandingCards";
import { buildPrimaryEvidenceRows } from "../../lib/feed/primaryEvidenceServing";
import type { SportsDiscoverySample } from "../../lib/feed/types";
import type { WritePairsInput } from "../../lib/feed/cacheGeneratedSignals";

const GAME_ID = "canonical-game-sevilla-1";
const OBSERVATION_ID = "00000000-0000-4000-8000-000000000901";

function sample(): SportsDiscoverySample {
  return {
    title: "Sevilla vs Valencia",
    slug: "sevilla-valencia",
    gameId: GAME_ID,
    providerEventId: "fragment-moneyline",
    eventVolumeUsd: 10_000,
    resolvedGameTimeIso: "2026-09-13T16:00:00.000Z",
    gameTimeSource: "canonical-game",
    gameTimeConfidence: "high",
    marketCount: 2,
    strategy: "fixture",
    primaryMarketRaw: {
      conditionId: "condition-moneyline",
      providerMarketId: "market-moneyline",
      sportsMarketType: "moneyline",
      question: "Sevilla vs Valencia: Match winner",
      outcomes: ["Sevilla", "Valencia"],
      outcomePrices: [0.45, 0.55],
      clobTokenIds: ["token-home", "token-away"],
    },
    marketsRaw: [{
      conditionId: "condition-total",
      sportsMarketType: "totals",
      question: "Sevilla vs Valencia: Over/Under 2.5",
      outcomes: ["Over", "Under"],
      outcomePrices: [0.2, 0.8],
      clobTokenIds: ["token-over", "token-under"],
    }],
  } as unknown as SportsDiscoverySample;
}

function parentMeta(providerEventId: string, providerMarketId: string): ParentEventMeta {
  return {
    title: "Sevilla vs Valencia",
    slug: "sevilla-valencia",
    startDate: "2026-09-13T16:00:00.000Z",
    providerEventId,
    providerMarketId,
    sportsMarketType: "moneyline",
    gameId: GAME_ID,
  };
}

function evidenceInput(diagnostics: Record<string, unknown>): WritePairsInput {
  return {
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-14T16:00:00.000Z",
    pairs: [{
      premiumSignal: { eventTitle: "Sevilla vs Valencia", marketQuestion: "fixture", winProbability: 71, metrics: [] },
      marketSource: { headline: "fixture", subline: "", delta: "", type: "market-source" },
      diagnostics,
    }] as never[],
  };
}

test("canonical gameId crosses discovery candidates without changing exact outcome identities", () => {
  const candidates = sampleToCandidateMarkets(sample());
  const identities = candidates.map((candidate) => {
    const meta = (candidate.market as unknown as Record<string, unknown>)._parentMeta as ParentEventMeta;
    assert.equal(meta.gameId, GAME_ID);
    return `${candidate.market.conditionId}::${candidate.forcedOutcome?.selectedTokenId}`;
  });

  assert.deepEqual(new Set(identities), new Set([
    "condition-moneyline::token-home",
    "condition-moneyline::token-away",
    "condition-total::token-over",
    "condition-total::token-under",
  ]));
});

test("multiple provider fragments retain one canonical gameId and distinct exact token identities", () => {
  const moneyline = buildStructuredProviderDiagnostics(parentMeta("fragment-moneyline", "market-moneyline"), {
    id: "condition-moneyline", question: "Winner",
  } as never).providerEventContext;
  const total = buildStructuredProviderDiagnostics(parentMeta("fragment-total", "market-total"), {
    id: "condition-total", question: "Total",
  } as never).providerEventContext;

  assert.ok(moneyline);
  assert.ok(total);
  assert.equal(moneyline.gameId, GAME_ID);
  assert.equal(total.gameId, GAME_ID);
  assert.notEqual(moneyline.eventId, total.eventId);
  assert.notEqual(moneyline.providerMarketId, total.providerMarketId);
});

test("primary evidence preserves gameId and serving projection keeps diagnostics without changing identity, score, or price", () => {
  const diagnostics = buildStructuredProviderDiagnostics(parentMeta("fragment-moneyline", "market-moneyline"), {
    id: "condition-moneyline", question: "Winner",
  } as never).providerEventContext;
  const rows = buildPrimaryEvidenceRows(OBSERVATION_ID, evidenceInput({
    conditionId: "condition-moneyline",
    selectedTokenId: "token-away",
    selectedOutcome: "Valencia",
    currentPrice: 0.55,
    providerEventContext: diagnostics,
  }));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].condition_id, "condition-moneyline");
  assert.equal(rows[0].selected_token_id, "token-away");
  assert.equal(rows[0].entry_price_num, 0.55);
  const rowDiagnostics = rows[0].diagnostics as unknown as Record<string, unknown>;
  const rowContext = rowDiagnostics.providerEventContext as Record<string, unknown>;
  assert.equal(rowContext.gameId, GAME_ID);

  const publication = readFileSync(
    "supabase/migrations/20260912041412_primary_evidence_508_row_ceiling.sql",
    "utf8",
  );
  assert.match(publication, /COALESCE\(item->'diagnostics', '\{\}'::jsonb\)/);
  assert.match(publication, /condition_id, selected_token_id, metric_formula_version/);
});

test("missing canonical gameId remains absent rather than falling back to provider identity", () => {
  const context = buildStructuredProviderDiagnostics({
    ...parentMeta("fragment-no-game", "market-no-game"),
    gameId: undefined,
  }, { id: "condition-no-game", question: "No game id" } as never).providerEventContext;

  assert.ok(context);
  assert.equal(context.gameId, undefined);
  assert.equal(context.eventId, "fragment-no-game");
});
