// B2: RESERVATION EXACT CANDIDATE MANIFEST
//   node --import tsx --test tests/contur3/reservationCandidateManifest.test.ts
//
// Business result under test: Reservation must own a durable, bounded,
// decision-time candidate manifest, so a later stage can rediscover the exact
// market rows a Reservation decided over WITHOUT re-querying mutable Serving.
//
// Every test enters through the real production seam `buildReservationPlan`
// (Contract A planning mode) with production-shaped Serving source rows —
// never a hand-assembled finished manifest.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReservationPlan,
  buildReservationCandidateManifestsByPhysicalEvent,
  type ReservationCandidateManifestEntry,
} from "../../lib/executor/nightEventReservations";

const NOW_MS = Date.parse("2026-07-27T17:30:00.000Z");
const KICKOFF_A = "2026-07-27T21:00:00.000Z";
const KICKOFF_B = "2026-07-28T00:00:00.000Z";

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

/** Production-shaped current_signal_pair_serving row (post-normalization: id
 * is already source_generated_signal_pair_id ?? observation_id). */
function servingRow(overrides: {
  id?: string;
  conditionId: string;
  tokenId: string;
  side?: string;
  eventSlug?: string;
  providerEventId?: string;
  gameStartIso?: string;
  score?: number;
  confidence?: number;
  marketSlug?: string;
}): Record<string, unknown> {
  const gameStartIso = overrides.gameStartIso ?? KICKOFF_A;
  const eventSlug = overrides.eventSlug ?? "mlb-nyy-phi-2026-07-27";
  const providerEventId = overrides.providerEventId ?? `provider-${eventSlug}`;
  return {
    id: overrides.id ?? `00000000-0000-4000-8000-${overrides.tokenId.padStart(12, "0").slice(-12)}`,
    condition_id: overrides.conditionId,
    selected_token_id: overrides.tokenId,
    token_id: overrides.tokenId,
    selected_outcome: overrides.side ?? "New York Yankees",
    score: overrides.score ?? 80,
    signal_confidence_num: overrides.confidence ?? 70,
    // 0.65: above CONTRACT_A_MIN_ENTRY_PRICE (0.50, RELEASE_CONTRACT_A_MIN_ENTRY_PRICE_050_V1)
    // and outside the pre-existing, unrelated BAD_BUCKET_COV_PRICE band (coverage
    // 50-74 AND price 0.44-0.58) — this fixture is not testing price boundaries.
    entry_price_num: 0.65,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-27T19:30:00.000Z",
    expires_at: "2026-07-28T04:00:00.000Z",
    signal_result: null,
    event_slug: eventSlug,
    market_slug: overrides.marketSlug ?? "New York Yankees vs. Philadelphia Phillies - Moneyline",
    diagnostics: {
      gameStartIso,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: providerEventId,
        eventStartIso: gameStartIso,
        sportFamily: "baseball",
      },
      dataCoverage: 60,
      shadowScope: "baseball",
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
    },
  };
}

async function planFrom(rows: readonly Record<string, unknown>[]) {
  return at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => rows,
    })
  );
}

function manifestEntries(diagnostics: Record<string, unknown>): ReservationCandidateManifestEntry[] {
  return diagnostics.candidate_manifest as ReservationCandidateManifestEntry[];
}

// ── 1. Ownership: the manifest is exact decision-time evidence ────────────

test("RCM-1: one physical event's multiple market rows all reach the ONE Reservation's manifest", async () => {
  const rows = [
    servingRow({ conditionId: "cond-moneyline", tokenId: "tok-yankees-ml", marketSlug: "Yankees ML" }),
    servingRow({ conditionId: "cond-spread", tokenId: "tok-yankees-spread", marketSlug: "Yankees -1.5" }),
    servingRow({ conditionId: "cond-total", tokenId: "tok-over", marketSlug: "Over 8.5" }),
  ];
  const plan = await planFrom(rows);

  // Requirement 4: multiple market rows for the SAME physical event must
  // remain distinct from the single economic Reservation authority.
  assert.equal(plan.reservations.length, 1, "exactly one Reservation for one physical event");
  const [r] = plan.reservations;
  const entries = manifestEntries(r.diagnostics);
  assert.equal(entries.length, 3, "all three market rows for this event are captured in the manifest");
  const conditionIds = new Set(entries.map((e) => e.condition_id));
  assert.deepEqual(
    conditionIds,
    new Set(["cond-moneyline", "cond-spread", "cond-total"]),
    "manifest carries the exact bounded set of market rows this Reservation decided over"
  );
});

test("RCM-2: manifest entries carry enough immutable identity to rediscover the exact row without Serving", async () => {
  const rows = [
    servingRow({
      id: "11111111-2222-4333-8444-555555555555",
      conditionId: "cond-moneyline",
      tokenId: "tok-yankees-ml",
      side: "New York Yankees",
      confidence: 77,
    }),
  ];
  const plan = await planFrom(rows);
  const [entry] = manifestEntries(plan.reservations[0].diagnostics);
  assert.equal(entry.generated_signal_pair_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(entry.generated_signal_pair_id_is_uuid, true);
  assert.equal(entry.condition_id, "cond-moneyline");
  assert.equal(entry.token_id, "tok-yankees-ml");
  assert.equal(entry.side, "New York Yankees");
  assert.equal(entry.market_slug, "New York Yankees vs. Philadelphia Phillies - Moneyline");
  assert.equal(entry.metric_formula_version, "v2-lite-growth-safe");
  assert.equal(entry.entry_price_num, 0.65);
  assert.equal(entry.signal_confidence_num, 77);
  assert.equal(plan.reservations[0].diagnostics.candidate_manifest_version, "RESERVATION_CANDIDATE_MANIFEST_V1");
});

// ── 2. Bounded, never a generic historical platform ────────────────────────

test("RCM-3: the manifest is bounded — beyond the cap it truncates rather than growing unbounded", () => {
  const admitted = new Set(["provider:polymarket:evt-x:2026-07-27"]);
  const rows = Array.from({ length: 30 }, (_, i) =>
    servingRow({
      conditionId: `cond-${i}`,
      tokenId: `tok-${i}`,
      providerEventId: "evt-x",
      confidence: 50 + i,
    })
  );
  const manifests = buildReservationCandidateManifestsByPhysicalEvent(rows, admitted, 20);
  const manifest = manifests.get("provider:polymarket:evt-x:2026-07-27");
  assert.ok(manifest);
  assert.equal(manifest!.entries.length, 20, "capped at the configured bound");
  assert.equal(manifest!.truncated, true);
  // Highest-confidence entries survive the cap.
  assert.equal(manifest!.entries[0].condition_id, "cond-29");
});

// ── 3. Grouping never widens or leaks across physical events ──────────────

test("RCM-4: a second physical event's candidate rows never leak into this event's manifest", async () => {
  const rows = [
    servingRow({ conditionId: "cond-a-ml", tokenId: "tok-a-ml", eventSlug: "event-a", providerEventId: "evt-a", gameStartIso: KICKOFF_A }),
    servingRow({ conditionId: "cond-b-ml", tokenId: "tok-b-ml", eventSlug: "event-b", providerEventId: "evt-b", gameStartIso: KICKOFF_B }),
  ];
  const plan = await planFrom(rows);
  assert.equal(plan.reservations.length, 2);
  for (const r of plan.reservations) {
    const entries = manifestEntries(r.diagnostics);
    assert.equal(entries.length, 1, "each event's manifest holds only its own candidate row");
  }
  const byConditionId = new Map(
    plan.reservations.map((r) => [manifestEntries(r.diagnostics)[0].condition_id, r.physical_event_id])
  );
  assert.notEqual(byConditionId.get("cond-a-ml"), byConditionId.get("cond-b-ml"));
});

// ── 4. Additive: legacy call sites and legacy rows remain compatible ──────

test("RCM-5: omitting the candidate-manifest source rows (legacy call shape) still produces a valid Reservation with an empty manifest", async () => {
  const { buildReservationsFromPlanningDecisions } = await import("../../lib/executor/nightEventReservations");
  const { produceContractAPlanningDecisions } = await import("../../lib/executor/contractADecisions");
  const rows = [servingRow({ conditionId: "cond-moneyline", tokenId: "tok-yankees-ml" })];
  const results = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  const window = (await planFrom(rows)).window;
  const built = buildReservationsFromPlanningDecisions(
    results,
    { planRunId: "legacy-call-shape", window, nowMs: NOW_MS },
    []
    // no opts.sourceRowsForCandidateManifest — the pre-B2 call shape.
  );
  assert.equal(built.reservations.length, 1);
  assert.deepEqual(built.reservations[0].diagnostics.candidate_manifest, []);
  assert.equal(built.reservations[0].diagnostics.candidate_manifest_truncated, false);
  assert.equal(built.reservations[0].diagnostics.candidate_manifest_count, 0);
});

test("RCM-6: a legacy-shaped Reservation row missing candidate_manifest entirely is still a valid diagnostics object", () => {
  // Simulates a row persisted before B2: no candidate_manifest key at all.
  const legacyDiagnostics: Record<string, unknown> = {
    reservation_authority: "CONTRACT_A_PLANNING_DECISION",
    source_lineage: { generated_signal_pair_id: "legacy-id" },
  };
  assert.equal(legacyDiagnostics.candidate_manifest, undefined);
  // Downstream reads must treat this as "no manifest", never throw.
  const entries = (legacyDiagnostics.candidate_manifest as ReservationCandidateManifestEntry[] | undefined) ?? [];
  assert.deepEqual(entries, []);
});
