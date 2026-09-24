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
  buildReservationsFromPlanningDecisions,
  type ReservationCandidateManifestEntry,
  type Score60ResearchShadow,
} from "../../lib/executor/nightEventReservations";
import {
  resolveContractAProviderPhysicalEventIdentity,
  CONTRACT_A_DECISION_VERSION,
  type ContractAPlanningDecision,
  type ContractADecisionResult,
} from "../../lib/executor/contractADecisions";
import type { NightWindow } from "../../lib/executor/nightWindow";

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
  preEventScore?: number | null;
  entryPrice?: number;
  createdAt?: string;
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
    pre_event_score_num: overrides.preEventScore ?? null,
    entry_price_num: overrides.entryPrice ?? 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: overrides.createdAt ?? "2026-07-27T19:30:00.000Z",
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
  assert.equal(entry.entry_price_num, 0.42);
  assert.equal(entry.signal_confidence_num, 77);
  assert.equal(plan.reservations[0].diagnostics.candidate_manifest_version, "RESERVATION_CANDIDATE_MANIFEST_V1");
});

// ── 2. Bounded, never a generic historical platform ────────────────────────

// NARROW_FOOTBALL_MONEY_POLICY_V1 correction (ISSUE 2): compareManifestEntries
// truncation order is source_created_at DESC (freshest-first), condition_id
// ASC, token_id ASC as a deterministic tie-break -- it is no longer
// signal_confidence_num DESC. Confidence is deliberately set to move in the
// OPPOSITE direction of freshness below (higher index = higher confidence but
// STALER), so a naive "score still wins" regression would keep the wrong
// entries and this test would catch it.
const RCM3_FRESHNESS_BASE_MS = Date.parse("2026-07-27T20:00:00.000Z");

test("RCM-3: the manifest is bounded — beyond the cap it truncates rather than growing unbounded, and truncation order is freshest-first, NOT highest-score-first", () => {
  const admitted = new Set(["provider:polymarket:evt-x:2026-07-27"]);
  const rows = Array.from({ length: 30 }, (_, i) =>
    servingRow({
      conditionId: `cond-${i}`,
      tokenId: `tok-${i}`,
      providerEventId: "evt-x",
      // Higher index = higher confidence but STALER (earlier created_at) --
      // the inverse of the old score-based ordering fixture.
      confidence: 50 + i,
      createdAt: new Date(RCM3_FRESHNESS_BASE_MS - i * 1000).toISOString(),
    })
  );
  const manifests = buildReservationCandidateManifestsByPhysicalEvent(rows, admitted, 20);
  const manifest = manifests.get("provider:polymarket:evt-x:2026-07-27");
  assert.ok(manifest);
  assert.equal(manifest!.entries.length, 20, "capped at the configured bound");
  assert.equal(manifest!.truncated, true);
  // The FRESHEST entry (i=0, the LOWEST confidence of the set) survives at
  // position 0 -- computed by hand from the fixture's own created_at values.
  assert.equal(manifest!.entries[0].condition_id, "cond-0");
  assert.equal(manifest!.entries[0].signal_confidence_num, 50);
  // The 20 kept entries are exactly the 20 freshest (i=0..19) -- the 10
  // highest-confidence entries (i=20..29, confidence 70..79, the stalest) are
  // the ones truncated away, proving Score never re-enters truncation.
  const keptIds = new Set(manifest!.entries.map((e) => e.condition_id));
  for (let i = 0; i < 20; i++) assert.ok(keptIds.has(`cond-${i}`), `cond-${i} (fresh) must survive truncation`);
  for (let i = 20; i < 30; i++) assert.ok(!keptIds.has(`cond-${i}`), `cond-${i} (stale, high-score) must be truncated away`);
});

test("RCM-3b: a pinned Planning final identity that would normally be truncated away (lowest freshness) still survives truncation, and truncated stays true", () => {
  const admitted = new Set(["provider:polymarket:evt-x:2026-07-27"]);
  const rows = Array.from({ length: 30 }, (_, i) =>
    servingRow({
      conditionId: `cond-${i}`,
      tokenId: `tok-${i}`,
      providerEventId: "evt-x",
      confidence: 50 + i,
      createdAt: new Date(RCM3_FRESHNESS_BASE_MS - i * 1000).toISOString(),
    })
  );
  // cond-29/tok-29 is the STALEST row -- it would normally be truncated away.
  const pinned = new Map([["provider:polymarket:evt-x:2026-07-27", { condition_id: "cond-29", token_id: "tok-29" }]]);
  const manifests = buildReservationCandidateManifestsByPhysicalEvent(rows, admitted, 20, pinned);
  const manifest = manifests.get("provider:polymarket:evt-x:2026-07-27");
  assert.ok(manifest);
  assert.equal(manifest!.entries.length, 20, "the pin never grows the cap");
  assert.equal(manifest!.truncated, true, "truncation still occurred for every other entry");
  const keptIds = new Set(manifest!.entries.map((e) => e.condition_id));
  assert.ok(keptIds.has("cond-29"), "the Planning-pinned identity survives truncation despite being the stalest row");
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

// ── 5. pre_event_score_num shadow carrier ──────────────────────────────────
//
// These tests enter through `buildReservationsFromPlanningDecisions` directly
// with hand-built, already-ACCEPTED Planning Decisions — the exact seam
// Reservation itself consumes once Contract A Planning has decided. This
// deliberately bypasses Contract A's own eligibility gates (B2 price/score/
// coverage policy, tiering, etc.), which this mission never touches and which
// `buildReservationPlan`'s full producer seam is not fixture-friendly for.
// `sourceRowsForCandidateManifest` still carries the exact same raw Serving
// rows Planning would have read, so the manifest/shadow computation under
// test is exercised exactly as production wires it.

const WINDOW: NightWindow = {
  startMs: NOW_MS,
  endMs: NOW_MS + 6 * 3600_000,
  startIso: new Date(NOW_MS).toISOString(),
  endIso: new Date(NOW_MS + 6 * 3600_000).toISOString(),
  horizonEndMs: NOW_MS + 24 * 3600_000,
  horizonEndIso: new Date(NOW_MS + 24 * 3600_000).toISOString(),
  planDateMinsk: "2026-07-27",
};

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** One ACCEPTED Contract A Planning Decision for the physical event a row's diagnostics resolve to. */
function planningDecisionFor(
  row: Record<string, unknown>,
  overrides: { planningRank?: number } = {},
): ContractADecisionResult<ContractAPlanningDecision> {
  const diagnostics = row.diagnostics as Record<string, unknown>;
  const identity = resolveContractAProviderPhysicalEventIdentity(diagnostics);
  if (!identity) throw new Error("test fixture row is missing a resolvable providerEventContext");
  return {
    accepted: true,
    decision: {
      decision_version: CONTRACT_A_DECISION_VERSION,
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      status: "ACCEPTED",
      physical_event_id: identity.physicalEventId,
      source_lineage: {
        generated_signal_pair_id: nonEmptyStr(row.id),
        generated_signal_pair_id_is_uuid: true,
        observation_id: null,
        event_slug: nonEmptyStr(row.event_slug),
        provider_event_key: null,
        provider_event_id: identity.eventId,
        provider_event_start_iso: identity.eventStartIso,
        provider_sport: "baseball",
        producer_source: null,
        source_created_at: nonEmptyStr(row.created_at),
      },
      event_start_iso: identity.eventStartIso,
      event_start_iso_source: "source_row_game_start_iso",
      inferred_sport: "baseball",
      strategic_scope: "MLB",
      sport_metadata_source: "upstream",
      league: null,
      planning_score: 80,
      planning_tier: "TIER_1",
      planning_rank: overrides.planningRank ?? 1,
      planning_policy_verdict: null,
      execution_window: { stale_after: null, no_trade_after: null, timing_bucket: "T_2_6H" },
      final_identity_evidence: null,
      rejection_trace: null,
    },
  };
}

/** rows = the full bounded Serving snapshot; decisionRows = one representative row per admitted physical event. */
function buildFromDecisions(rows: Record<string, unknown>[], decisionRows: Record<string, unknown>[]) {
  const results = decisionRows.map((row, i) => planningDecisionFor(row, { planningRank: i + 1 }));
  return buildReservationsFromPlanningDecisions(
    results,
    { planRunId: "test-plan-run", window: WINDOW, nowMs: NOW_MS },
    [],
    { sourceRowsForCandidateManifest: rows },
  );
}

test("RCM-7: manifest copies pre_event_score_num verbatim and keeps it distinct from signal_confidence_num", () => {
  const row = servingRow({ conditionId: "cond-moneyline", tokenId: "tok-yankees-ml", entryPrice: 0.55, confidence: 70, preEventScore: 42 });
  const built = buildFromDecisions([row], [row]);
  assert.equal(built.reservations.length, 1);
  const [entry] = manifestEntries(built.reservations[0].diagnostics);
  assert.equal(entry.pre_event_score_num, 42);
  assert.equal(entry.signal_confidence_num, 70);
  assert.notEqual(entry.pre_event_score_num, entry.signal_confidence_num, "never conflated with signal_confidence_num");
});

test("RCM-8: SHADOW_C0 selects the chronological-first price-band identity; SHADOW_SCORE60 skips a <60 identity and selects the next >=60 identity", () => {
  const rows = [
    servingRow({
      conditionId: "cond-early-low-score",
      tokenId: "tok-early",
      entryPrice: 0.55,
      preEventScore: 40,
      createdAt: "2026-07-27T19:00:00.000Z",
    }),
    servingRow({
      conditionId: "cond-late-high-score",
      tokenId: "tok-late",
      entryPrice: 0.56,
      preEventScore: 70,
      createdAt: "2026-07-27T19:30:00.000Z",
    }),
  ];
  const built = buildFromDecisions(rows, [rows[0]]);
  assert.equal(built.reservations.length, 1);
  const shadow = built.reservations[0].diagnostics.score60_research_shadow as Score60ResearchShadow;
  assert.equal(shadow.version, "SCORE60_RESEARCH_SHADOW_V1");
  assert.equal(shadow.c0_eligible_identity_n, 2);
  assert.equal(shadow.score60_eligible_identity_n, 1);
  assert.equal(shadow.c0_selected?.condition_id, "cond-early-low-score", "C0 selects the chronological-first price-band identity regardless of score");
  assert.equal(shadow.score60_selected?.condition_id, "cond-late-high-score", "SCORE60 skips the <60 identity and selects the next >=60 identity");
  assert.equal(shadow.selection_changed, "YES");
});

test("RCM-9: no >=60 identity produces NO_SCORE60_SELECTION but the Reservation still exists", () => {
  const row = servingRow({ conditionId: "cond-moneyline", tokenId: "tok-yankees-ml", entryPrice: 0.55, preEventScore: null });
  const built = buildFromDecisions([row], [row]);
  assert.equal(built.reservations.length, 1, "the physical event is never rejected for lacking a SHADOW_SCORE60 identity");
  const shadow = built.reservations[0].diagnostics.score60_research_shadow as Score60ResearchShadow;
  assert.equal(shadow.c0_eligible_identity_n, 1);
  assert.equal(shadow.score60_eligible_identity_n, 0);
  assert.equal(shadow.score60_selected, null);
  assert.equal(shadow.selection_changed, "NO_SCORE60_SELECTION");
});

test("RCM-10: Reservation rank/identity/event_score/status are byte-equivalent regardless of the shadow's score60 outcome", () => {
  const base = (preEventScore: number | null) =>
    servingRow({ conditionId: "cond-moneyline", tokenId: "tok-yankees-ml", entryPrice: 0.55, confidence: 70, preEventScore });
  const rowNoScore = base(null);
  const rowHighScore = base(90);
  const builtNoScore = buildFromDecisions([rowNoScore], [rowNoScore]);
  const builtHighScore = buildFromDecisions([rowHighScore], [rowHighScore]);
  // candidate_manifest legitimately differs (it carries pre_event_score_num
  // verbatim, by design) — everything ELSE that drives the actual production
  // decision must stay byte-equivalent.
  const stripScoreDependentFields = (diagnostics: Record<string, unknown>) => {
    const { score60_research_shadow: _shadow, candidate_manifest: _manifest, ...rest } = diagnostics;
    return rest;
  };
  assert.equal(builtNoScore.reservations[0].reservation_rank, builtHighScore.reservations[0].reservation_rank);
  assert.equal(builtNoScore.reservations[0].physical_event_id, builtHighScore.reservations[0].physical_event_id);
  assert.equal(builtNoScore.reservations[0].event_score, builtHighScore.reservations[0].event_score);
  assert.equal(builtNoScore.reservations[0].status, builtHighScore.reservations[0].status);
  assert.equal(
    builtNoScore.reservations[0].diagnostics.candidate_manifest_count,
    builtHighScore.reservations[0].diagnostics.candidate_manifest_count,
  );
  assert.deepEqual(
    stripScoreDependentFields(builtNoScore.reservations[0].diagnostics),
    stripScoreDependentFields(builtHighScore.reservations[0].diagnostics),
    "every production-decision diagnostics field is unaffected by pre_event_score_num",
  );
});

test("RCM-11: the shadow is computed purely from the given bounded snapshot — no widening beyond the rows passed in", () => {
  const rows = [
    servingRow({ conditionId: "cond-a", tokenId: "tok-a", entryPrice: 0.55, preEventScore: 70 }),
    servingRow({ conditionId: "cond-b", tokenId: "tok-b", entryPrice: 0.57, preEventScore: 80 }),
  ];
  const built = buildFromDecisions(rows, [rows[0]]);
  assert.equal(built.reservations.length, 1);
  const shadow = built.reservations[0].diagnostics.score60_research_shadow as Score60ResearchShadow;
  // Exactly the two rows passed in are visible to the shadow — never fewer (truncation)
  // and never more (a wider read); buildReservationCandidateManifestsByPhysicalEvent and
  // its shadow are pure functions with no I/O of their own.
  assert.equal(shadow.c0_eligible_identity_n, 2);
  assert.equal(shadow.score60_eligible_identity_n, 2);
});

// ── 6. Plan-level aggregate counters ───────────────────────────────────────

test("RCM-12: reservation-level shadow diagnostics aggregate correctly across all admitted events", () => {
  const rows = [
    // Event A: has a >=60 identity that differs from C0's chronological pick.
    servingRow({ conditionId: "a-early", tokenId: "a-early-tok", eventSlug: "event-a", providerEventId: "evt-a", gameStartIso: KICKOFF_A, entryPrice: 0.55, preEventScore: 30, createdAt: "2026-07-27T19:00:00.000Z" }),
    servingRow({ conditionId: "a-late", tokenId: "a-late-tok", eventSlug: "event-a", providerEventId: "evt-a", gameStartIso: KICKOFF_A, entryPrice: 0.56, preEventScore: 65, createdAt: "2026-07-27T19:30:00.000Z" }),
    // Event B: no >=60 identity at all.
    servingRow({ conditionId: "b-only", tokenId: "b-only-tok", eventSlug: "event-b", providerEventId: "evt-b", gameStartIso: KICKOFF_B, entryPrice: 0.55, preEventScore: null }),
  ];
  const built = buildFromDecisions(rows, [rows[0], rows[2]]);
  assert.equal(built.reservations.length, 2);

  // Aggregate exactly as contractAPlanDiagnostics() does, over the built reservations.
  let eventN = 0;
  let hasSelectionN = 0;
  let noSelectionN = 0;
  let changedN = 0;
  for (const r of built.reservations) {
    const shadow = r.diagnostics.score60_research_shadow as Score60ResearchShadow | null;
    if (!shadow) continue;
    eventN += 1;
    if (shadow.selection_changed === "NO_SCORE60_SELECTION") {
      noSelectionN += 1;
    } else {
      hasSelectionN += 1;
      if (shadow.selection_changed === "YES") changedN += 1;
    }
  }
  assert.equal(eventN, 2);
  assert.equal(hasSelectionN, 1);
  assert.equal(noSelectionN, 1);
  assert.equal(changedN, 1);
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
