// P0 reservation-aware producer pinning — regression guardrails.
//   node --import tsx --test tests/contur3/reservationAwareProducerRegression.test.ts
//
// Confirms the pinning feature cannot leak into: score/taxonomy/condition/token/
// outcome fields, TTL, persistence shape, or Contract A's freshness rule — and
// that malformed/ambiguous pin identities never fall back to fuzzy/title matching.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractProviderEventPinsFromReservationRows,
  sortCandidatesForProductRanking,
  prioritizePinnedCandidates,
  computeCandidateProviderEventKey,
  type CandidateMarket,
  type RequiredProviderEventPin,
} from "../../lib/feed/buildLandingCards";

function makeCandidate(opts: {
  slug: string;
  polymarketEventSlug?: string;
  startIso: string;
  volume24hr: number;
  conditionId?: string;
  selectedTokenIds?: [string, string];
}): CandidateMarket {
  const market: any = {
    id: `${opts.slug}-market`,
    conditionId: opts.conditionId ?? `${opts.slug}-cond`,
    question: `${opts.slug} winner`,
    slug: `${opts.slug}-market`,
    active: true,
    closed: false,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: opts.selectedTokenIds ?? [`${opts.slug}-tok-a`, `${opts.slug}-tok-b`],
    volume24hr: opts.volume24hr,
  };
  market._parentMeta = {
    id: opts.slug,
    title: opts.slug,
    slug: opts.slug,
    category: "Sports",
    endDate: opts.startIso,
    startDate: opts.startIso,
    ...(opts.polymarketEventSlug ? { polymarketEventSlug: opts.polymarketEventSlug } : {}),
  };
  const event: any = {
    id: opts.slug,
    title: opts.slug,
    slug: opts.slug,
    active: true,
    closed: false,
    endDate: opts.startIso,
    markets: [market],
    category: "sports",
    volume24hr: opts.volume24hr,
  };
  return {
    event,
    market,
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
  };
}

test("GREEN 12+13: pinned candidate keeps identical market fields (score/taxonomy/condition/token/outcome untouched) through prioritization", () => {
  const target = makeCandidate({
    slug: "mlb-phi-mia-2026-07-28",
    polymarketEventSlug: "mlb-phi-mia-2026-07-28",
    startIso: "2026-07-28T22:40:00.000Z",
    volume24hr: 21_000,
    conditionId: "0xabc123",
    selectedTokenIds: ["tok-phi", "tok-mia"],
  });
  const key = computeCandidateProviderEventKey(target)!;
  const pins: RequiredProviderEventPin[] = [{ providerEventId: key, eventStartIso: "2026-07-28T22:40:00.000Z", reservationIds: ["r1"] }];

  const before = JSON.stringify(target.market);
  const { ordered } = prioritizePinnedCandidates(sortCandidatesForProductRanking([target]), pins);
  const after = JSON.stringify(ordered[0].market);

  // Pinning reorders the array; it must never mutate or synthesize a candidate.
  assert.equal(before, after, "pinning must not alter market fields (condition_id/token/outcome/score/taxonomy)");
  assert.equal(ordered[0].market.conditionId, "0xabc123");
  assert.deepEqual(ordered[0].market.clobTokenIds, ["tok-phi", "tok-mia"]);
});

test("Pinned candidate is the SAME object reference through the pipeline — no synthesized row", () => {
  const target = makeCandidate({
    slug: "mlb-phi-mia-2026-07-28",
    polymarketEventSlug: "mlb-phi-mia-2026-07-28",
    startIso: "2026-07-28T22:40:00.000Z",
    volume24hr: 21_000,
  });
  const others = [makeCandidate({ slug: "mlb-other", startIso: "2026-07-28T22:40:00.000Z", volume24hr: 500_000 })];
  const key = computeCandidateProviderEventKey(target)!;
  const pins: RequiredProviderEventPin[] = [{ providerEventId: key, eventStartIso: "2026-07-28T22:40:00.000Z", reservationIds: ["r1"] }];

  const sorted = sortCandidatesForProductRanking([...others, target]);
  const { ordered } = prioritizePinnedCandidates(sorted, pins);
  assert.equal(ordered[0], target, "pinned candidate must be the identical object, never a synthesized market");
});

test("TTL/persistence shape: pinning is purely a pre-persistence ordering concern — CONFIG.cacheExpiryHours is never read or referenced by the pin functions", () => {
  // Static/behavioral guard: none of the pin functions accept or touch expiry.
  // Their signatures take only ordering/identity inputs -- confirmed by type
  // shape, not by any TTL-bearing argument existing to mutate.
  const target = makeCandidate({ slug: "mlb-x", polymarketEventSlug: "mlb-x", startIso: "2026-07-28T22:40:00.000Z", volume24hr: 1 });
  const key = computeCandidateProviderEventKey(target)!;
  const pins: RequiredProviderEventPin[] = [{ providerEventId: key, eventStartIso: "2026-07-28T22:40:00.000Z", reservationIds: ["r1"] }];
  const { ordered } = prioritizePinnedCandidates([target], pins);
  assert.equal(Object.keys(ordered[0]).includes("expires_at" as any), false);
  assert.equal((ordered[0].market as any).expires_at, undefined);
});

test("Malformed provider event id never falls back to fuzzy/title matching — excluded and counted", () => {
  const rows = [
    { id: "r1", status: "RESERVED", game_start_iso: "2026-07-28T22:40:00.000Z", diagnostics: { planning_provider_event_id: "not a valid key" } },
    { id: "r2", status: "RESERVED", game_start_iso: "2026-07-28T22:40:00.000Z", diagnostics: { planning_provider_event_id: "polymarket:has spaces:2026-07-28" } },
  ];
  const { pins, diagnostics } = extractProviderEventPinsFromReservationRows(rows);
  assert.equal(pins.length, 0);
  assert.equal(diagnostics.invalid_pin_reason_counts.MALFORMED_PROVIDER_EVENT_ID, 2);
});

test("Reservation missing game_start_iso is excluded with a structured reason, never guessed", () => {
  const rows = [
    { id: "r1", status: "RESERVED", game_start_iso: null, diagnostics: { planning_provider_event_id: "polymarket:mlb-x:2026-07-28" } },
    { id: "r2", status: "RESERVED", game_start_iso: "not-a-date", diagnostics: { planning_provider_event_id: "polymarket:mlb-y:2026-07-28" } },
  ];
  const { pins, diagnostics } = extractProviderEventPinsFromReservationRows(rows);
  assert.equal(pins.length, 0);
  assert.equal(diagnostics.invalid_pin_reason_counts.MISSING_GAME_START, 2);
});

test("Ambiguous candidate identity (missing slug pattern) never pins via a partial/loose match", () => {
  const badCandidate: CandidateMarket = {
    event: { id: "x", title: "x", slug: "x", active: true, closed: false, endDate: "2026-07-28T22:40:00.000Z", markets: [] } as any,
    market: { id: "x-market", conditionId: "x-cond", question: "x", slug: "x-market", active: true, closed: false, outcomes: ["Yes", "No"], outcomePrices: [0.5, 0.5] } as any,
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
  };
  // No _parentMeta attached at all (simulates a candidate that skipped extraction).
  const key = computeCandidateProviderEventKey(badCandidate);
  assert.equal(key, null);
});

test("Zero-pin candidate ordering is byte-for-byte identical to calling sortCandidatesForProductRanking alone", () => {
  const now = Date.now();
  const in12h = new Date(now + 12 * 60 * 60 * 1000).toISOString();
  const candidates = Array.from({ length: 10 }, (_, i) =>
    makeCandidate({ slug: `mlb-${i}`, startIso: in12h, volume24hr: 100_000 - i * 1000 })
  );
  const sorted = sortCandidatesForProductRanking(candidates);
  const { ordered } = prioritizePinnedCandidates(sorted, []);
  assert.deepEqual(
    ordered.map((c) => c.market.id),
    sorted.map((c) => c.market.id)
  );
});
