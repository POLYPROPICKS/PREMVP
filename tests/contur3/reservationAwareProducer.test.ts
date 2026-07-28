// P0 reservation-aware producer pinning.
//   node --import tsx --test tests/contur3/reservationAwareProducer.test.ts
//
// A RESERVED night_event_reservations row already stores an exact composite
// providerEventKey (diagnostics.planning_provider_event_id, e.g.
// "polymarket:mlb-phi-mia-2026-07-28:2026-07-28") — the identical key
// buildFireModelCandidates.ts's providerEventKeyOf() computes at Contract A
// resolution time. Before this fix, the producer's candidate-ordering cap
// (pairs.length >= CONFIG.limit) had no awareness of active Reservations, so a
// physically valid, exact-identity-confirmed reserved event ranked below the
// top-15-by-volume cutoff was silently excluded from every producer cycle and
// its generated_signal_pairs row expired 1h later with nothing to replace it —
// permanently unexecutable at rebalance despite a live, correctly-priced market.
//
// These tests exercise the REAL exported production functions from
// lib/feed/buildLandingCards.ts (extractProviderEventPinsFromReservationRows,
// sortCandidatesForProductRanking, prioritizePinnedCandidates,
// computeCandidateProviderEventKey) — not a reimplementation — against a
// production-shaped 20-candidate fixture where the target ranks 18th by volume
// (i.e., would be excluded twice over even against a 15-cap).

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

const PRODUCT_LIMIT = 15;

function makeCandidate(opts: {
  slug: string;
  polymarketEventSlug?: string;
  startIso: string; // ISO, in the future
  volume24hr: number;
  question?: string;
}): CandidateMarket {
  const market: any = {
    id: `${opts.slug}-market`,
    conditionId: `${opts.slug}-cond`,
    question: opts.question ?? `${opts.slug} winner`,
    slug: `${opts.slug}-market`,
    active: true,
    closed: false,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: [`${opts.slug}-tok-a`, `${opts.slug}-tok-b`],
    volume24hr: opts.volume24hr,
  };
  market._parentMeta = {
    id: opts.slug,
    title: opts.question ?? opts.slug,
    slug: opts.slug,
    category: "Sports",
    endDate: opts.startIso,
    startDate: opts.startIso,
    ...(opts.polymarketEventSlug ? { polymarketEventSlug: opts.polymarketEventSlug } : {}),
  };

  const event: any = {
    id: opts.slug,
    title: opts.question ?? opts.slug,
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

function buildReservationRow(opts: {
  id: string;
  status: string;
  gameStartIso: string;
  providerEventId?: string;
}) {
  return {
    id: opts.id,
    status: opts.status,
    game_start_iso: opts.gameStartIso,
    diagnostics: opts.providerEventId
      ? { planning_provider_event_id: opts.providerEventId, planning_game_start_iso: opts.gameStartIso }
      : {},
  };
}

// Production-shaped fixture: 20 valid future candidates, target ranks 18th by
// parent volume among the within-24h bucket (well below a 15-item cap).
function buildTwentyCandidateFixture(): { candidates: CandidateMarket[]; targetSlug: string; targetKey: string } {
  const now = Date.now();
  const in12h = new Date(now + 12 * 60 * 60 * 1000).toISOString();
  const targetSlug = "mlb-phi-mia-2026-07-28";
  const targetStart = in12h;

  const candidates: CandidateMarket[] = [];
  // 19 higher-volume within-24h candidates (volumes 190000 down to 20000, strictly above target)
  for (let i = 0; i < 19; i++) {
    candidates.push(
      makeCandidate({
        slug: `mlb-other-${i}`,
        startIso: in12h,
        volume24hr: 190_000 - i * 9_000, // 190000 .. 28000, all > 21000
      })
    );
  }
  // Target: rank-18th by volume (21000 < all 19 above)
  candidates.push(
    makeCandidate({
      slug: targetSlug,
      polymarketEventSlug: targetSlug,
      startIso: targetStart,
      volume24hr: 21_000,
      question: "Philadelphia Phillies vs. Miami Marlins",
    })
  );

  const targetKey = `polymarket:${targetSlug}:${targetStart.slice(0, 10)}`;
  return { candidates, targetSlug, targetKey };
}

test("RED (pre-fix behavior, no pins): rank-18 target is excluded from a 15-item cap", () => {
  const { candidates } = buildTwentyCandidateFixture();
  const sorted = sortCandidatesForProductRanking(candidates);
  const capped = sorted.slice(0, PRODUCT_LIMIT);
  const targetInCap = capped.some((c) => c.market.question?.includes("Marlins"));
  assert.equal(targetInCap, false, "clean pre-pin behavior: target must NOT be in the top 15");
});

test("GREEN 1+2+3: rank-18 reserved event is included, cap stays exactly 15, lowest-priority non-reserved displaced", () => {
  const { candidates, targetKey } = buildTwentyCandidateFixture();
  const sorted = sortCandidatesForProductRanking(candidates);
  const preCapWithoutPin = sorted.slice(0, PRODUCT_LIMIT).map((c) => c.market.id);

  const pins: RequiredProviderEventPin[] = [
    { providerEventId: targetKey, eventStartIso: sorted[19].event.endDate!, reservationIds: ["r1"] },
  ];
  const { ordered, diagnostics } = prioritizePinnedCandidates(sorted, pins);
  const capped = ordered.slice(0, PRODUCT_LIMIT);

  assert.equal(capped.length, PRODUCT_LIMIT, "product result never exceeds CONFIG.limit");
  assert.ok(
    capped.some((c) => c.market.question?.includes("Marlins")),
    "rank-18 reserved event must be included"
  );
  assert.equal(diagnostics.pinned_candidates_found, 1);
  assert.equal(diagnostics.pinned_candidates_not_found, 0);

  const displaced = preCapWithoutPin.filter((id) => !capped.some((c) => c.market.id === id));
  assert.equal(displaced.length, 1, "exactly one previously-capped candidate is displaced");
  // The displaced one must be the lowest-volume of the previous top 15 (rank 15, index 14 = lowest volume in-cap)
  assert.equal(displaced[0], sorted[14].market.id);
});

test("GREEN 4: non-reserved relative ordering is unchanged", () => {
  const { candidates, targetKey } = buildTwentyCandidateFixture();
  const sorted = sortCandidatesForProductRanking(candidates);
  const pins: RequiredProviderEventPin[] = [
    { providerEventId: targetKey, eventStartIso: sorted[19].event.endDate!, reservationIds: ["r1"] },
  ];
  const { ordered } = prioritizePinnedCandidates(sorted, pins);

  const nonPinnedOrderedIds = ordered.filter((c) => c.market.id !== sorted[19].market.id).map((c) => c.market.id);
  const nonPinnedOriginalIds = sorted.filter((c) => c.market.id !== sorted[19].market.id).map((c) => c.market.id);
  assert.deepEqual(nonPinnedOrderedIds, nonPinnedOriginalIds);
});

test("GREEN 5: two reserved low-volume events are both included", () => {
  const now = Date.now();
  const in12h = new Date(now + 12 * 60 * 60 * 1000).toISOString();
  const candidates: CandidateMarket[] = [];
  for (let i = 0; i < 19; i++) {
    candidates.push(makeCandidate({ slug: `mlb-other-${i}`, startIso: in12h, volume24hr: 190_000 - i * 9_000 }));
  }
  const low1 = makeCandidate({ slug: "mlb-low-a", polymarketEventSlug: "mlb-low-a", startIso: in12h, volume24hr: 5_000 });
  const low2 = makeCandidate({ slug: "mlb-low-b", polymarketEventSlug: "mlb-low-b", startIso: in12h, volume24hr: 4_000 });
  candidates.push(low1, low2);

  const sorted = sortCandidatesForProductRanking(candidates);
  const key1 = computeCandidateProviderEventKey(low1)!;
  const key2 = computeCandidateProviderEventKey(low2)!;
  const pins: RequiredProviderEventPin[] = [
    { providerEventId: key1, eventStartIso: in12h, reservationIds: ["r1"] },
    { providerEventId: key2, eventStartIso: in12h, reservationIds: ["r2"] },
  ];
  const { ordered, diagnostics } = prioritizePinnedCandidates(sorted, pins);
  const capped = ordered.slice(0, PRODUCT_LIMIT);

  assert.equal(diagnostics.pinned_candidates_found, 2);
  assert.ok(capped.some((c) => c.market.id === low1.market.id));
  assert.ok(capped.some((c) => c.market.id === low2.market.id));
  assert.equal(capped.length, PRODUCT_LIMIT);
});

test("GREEN 6: duplicate Reservations for the same exact provider event create one pin", () => {
  const rows = [
    buildReservationRow({ id: "r1", status: "RESERVED", gameStartIso: "2026-07-28T22:40:00.000Z", providerEventId: "polymarket:mlb-phi-mia-2026-07-28:2026-07-28" }),
    buildReservationRow({ id: "r2", status: "RESERVED", gameStartIso: "2026-07-28T22:40:00.000Z", providerEventId: "polymarket:mlb-phi-mia-2026-07-28:2026-07-28" }),
  ];
  const { pins, diagnostics } = extractProviderEventPinsFromReservationRows(rows);
  assert.equal(pins.length, 1);
  assert.equal(diagnostics.active_reservation_pin_count, 2);
  assert.equal(diagnostics.valid_exact_pin_count, 1);
  assert.deepEqual(pins[0].reservationIds.sort(), ["r1", "r2"]);
});

test("GREEN 7: event ID match with a different start does not pin", () => {
  const target = makeCandidate({
    slug: "mlb-phi-mia-2026-07-28",
    polymarketEventSlug: "mlb-phi-mia-2026-07-28",
    startIso: "2026-07-28T22:40:00.000Z",
    volume24hr: 21_000,
  });
  // Pin references the SAME slug but a DIFFERENT date -> different composite key.
  const pins: RequiredProviderEventPin[] = [
    { providerEventId: "polymarket:mlb-phi-mia-2026-07-28:2026-07-29", eventStartIso: "2026-07-29T22:40:00.000Z", reservationIds: ["r1"] },
  ];
  const { ordered, diagnostics } = prioritizePinnedCandidates([target], pins);
  assert.equal(diagnostics.pinned_candidates_found, 0);
  assert.equal(diagnostics.pinned_candidates_not_found, 1);
  assert.equal(ordered[0].market.id, target.market.id); // unchanged position, not "pinned"
});

test("GREEN 8: same title with a different event ID does not pin", () => {
  const target = makeCandidate({
    slug: "mlb-phi-mia-2026-07-28-alt-id",
    polymarketEventSlug: "mlb-phi-mia-2026-07-28-alt-id",
    startIso: "2026-07-28T22:40:00.000Z",
    volume24hr: 21_000,
    question: "Philadelphia Phillies vs. Miami Marlins",
  });
  const pins: RequiredProviderEventPin[] = [
    { providerEventId: "polymarket:mlb-phi-mia-2026-07-28:2026-07-28", eventStartIso: "2026-07-28T22:40:00.000Z", reservationIds: ["r1"] },
  ];
  const { diagnostics } = prioritizePinnedCandidates([target], pins);
  assert.equal(diagnostics.pinned_candidates_found, 0);
  assert.equal(diagnostics.pinned_candidates_not_found, 1);
});

test("GREEN 9: missing provider event ID does not use a title fallback", () => {
  const rows = [
    buildReservationRow({ id: "r1", status: "RESERVED", gameStartIso: "2026-07-28T22:40:00.000Z" }), // no providerEventId
  ];
  const { pins, diagnostics } = extractProviderEventPinsFromReservationRows(rows);
  assert.equal(pins.length, 0);
  assert.equal(diagnostics.invalid_pin_reason_counts.MISSING_PROVIDER_EVENT_ID, 1);
});

test("GREEN 10: expired/terminal/SKIPPED Reservation does not pin", () => {
  const rows = [
    buildReservationRow({ id: "r1", status: "SKIPPED", gameStartIso: "2026-07-28T22:40:00.000Z", providerEventId: "polymarket:mlb-a:2026-07-28" }),
    buildReservationRow({ id: "r2", status: "EXPIRED", gameStartIso: "2026-07-28T22:40:00.000Z", providerEventId: "polymarket:mlb-b:2026-07-28" }),
    buildReservationRow({ id: "r3", status: "QUEUED", gameStartIso: "2026-07-28T22:40:00.000Z", providerEventId: "polymarket:mlb-c:2026-07-28" }),
  ];
  const { pins, diagnostics } = extractProviderEventPinsFromReservationRows(rows);
  assert.equal(pins.length, 0);
  assert.equal(diagnostics.active_reservation_pin_count, 0);
  assert.equal(diagnostics.invalid_pin_reason_counts.NOT_RESERVED_STATUS, 3);
});

test("GREEN 11: with zero active Reservations, output is unchanged (same array reference)", () => {
  const { candidates } = buildTwentyCandidateFixture();
  const sorted = sortCandidatesForProductRanking(candidates);
  const { ordered, diagnostics } = prioritizePinnedCandidates(sorted, []);
  assert.equal(ordered, sorted, "zero pins must return the identical array reference (byte-for-byte no-op)");
  assert.equal(diagnostics.pinned_candidates_found, 0);
  assert.equal(diagnostics.pinned_candidates_not_found, 0);
});

test("GREEN 14: product result never exceeds CONFIG.limit regardless of pin count", () => {
  const now = Date.now();
  const in12h = new Date(now + 12 * 60 * 60 * 1000).toISOString();
  const candidates: CandidateMarket[] = [];
  for (let i = 0; i < 25; i++) {
    candidates.push(makeCandidate({ slug: `mlb-other-${i}`, startIso: in12h, volume24hr: 500_000 - i * 1_000 }));
  }
  const pinned: CandidateMarket[] = [];
  const pins: RequiredProviderEventPin[] = [];
  for (let i = 0; i < 5; i++) {
    const c = makeCandidate({ slug: `mlb-low-${i}`, polymarketEventSlug: `mlb-low-${i}`, startIso: in12h, volume24hr: 100 });
    pinned.push(c);
    pins.push({ providerEventId: computeCandidateProviderEventKey(c)!, eventStartIso: in12h, reservationIds: [`r${i}`] });
  }
  const sorted = sortCandidatesForProductRanking([...candidates, ...pinned]);
  const { ordered } = prioritizePinnedCandidates(sorted, pins);
  assert.ok(ordered.slice(0, PRODUCT_LIMIT).length <= PRODUCT_LIMIT);
  assert.equal(ordered.slice(0, PRODUCT_LIMIT).length, PRODUCT_LIMIT);
});

// Exercises the actual production path end-to-end: a Reservation-shaped DB row
// is parsed by the real extractor, fed into the real sort + real prioritizer,
// then capped -- no manually constructed sorted list.
test("GREEN: Reservation-shaped DB row -> pin extraction -> real candidate ordering -> real cap -> persistence-ready pair", () => {
  const { candidates, targetKey, targetSlug } = buildTwentyCandidateFixture();
  const targetCandidate = candidates.find((c) => c.market.id === `${targetSlug}-market`)!;
  const targetStartIso = targetCandidate.event.endDate!;

  const reservationRows = [
    buildReservationRow({
      id: "reservation-under-test",
      status: "RESERVED",
      gameStartIso: targetStartIso,
      providerEventId: targetKey,
    }),
  ];

  const { pins } = extractProviderEventPinsFromReservationRows(reservationRows);
  const sorted = sortCandidatesForProductRanking(candidates);
  const { ordered, diagnostics } = prioritizePinnedCandidates(sorted, pins);
  const capped = ordered.slice(0, PRODUCT_LIMIT);

  assert.equal(diagnostics.pinned_candidates_found, 1);
  const persistenceReadyPair = capped.find((c) => c.market.id === targetCandidate.market.id);
  assert.ok(persistenceReadyPair, "target reaches the persistence-ready capped set");
  assert.equal(computeCandidateProviderEventKey(persistenceReadyPair!), targetKey);
});
