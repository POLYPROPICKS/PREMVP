// CONTRACT A APPROVED PLANNING DECISION -> RESERVATION
//   node --import tsx --test tests/contur3/planningDecisionReservation.test.ts
//
// Defect this suite pins: the production Reservation path was labelled
// CONTRACT_A_PLANNING_V1 but still ran the LEGACY candidate authority --
// `canonicalPhysicalMatchKey` grouping (team pair + calendar DATE),
// `eventTierOf` tier classification, `compareCandidateQuality` reranking and
// the Tier2/Tier3 fallback ladder -- before a Reservation existed. The
// authoritative Contract A Planning Decision was never consulted.
//
// The repaired path is:
//   production-shaped source rows
//     -> produceContractAPlanningDecisions (the REAL Contract A producer)
//     -> ContractAPlanningDecision
//     -> Reservation candidate
//     -> persistReservationPlan
//
// Every test enters through the real production seam `buildReservationPlan`
// with selectorMode CONTRACT_A_PLANNING_V1 -- never a hand-assembled finished
// Planning Decision as the sole fixture. All timestamps are fixed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReservationPlan,
  persistReservationPlan,
  type ReservationRepoPort,
} from "../../lib/executor/nightEventReservations";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import {
  buildContractAPlanningDecision,
  produceContractAPlanningDecisions,
} from "../../lib/executor/contractADecisions";

// 20:30 Minsk on 2026-07-27 -> the active window is 17:00 Minsk -> 08:00 Minsk.
const NOW_MS = Date.parse("2026-07-27T17:30:00.000Z");
const KICKOFF_A = "2026-07-27T21:00:00.000Z";
// SAME event slug, SAME calendar date, DIFFERENT start: the doubleheader that a
// date-truncated occurrence identity silently collides.
const KICKOFF_B = "2026-07-27T23:30:00.000Z";

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
 * A production-shaped generated_signal_pairs row: real UUID id, real upstream
 * sport metadata (diagnostics.shadowScope), canonical diagnostics.gameStartIso.
 * Carries the exact provider event identity required by new Reservations.
 */
function sourceRow(overrides: {
  id?: string;
  conditionId?: string;
  tokenId?: string;
  eventSlug?: string;
  providerEventId?: string;
  gameStartIso?: string | null;
  score?: number;
  confidence?: number;
}): Record<string, unknown> {
  const gameStartIso = overrides.gameStartIso === undefined ? KICKOFF_A : overrides.gameStartIso;
  const conditionId = overrides.conditionId ?? "cond-nyy-phi";
  const eventSlug = overrides.eventSlug ?? "mlb-nyy-phi-2026-07-27";
  const providerEventId = overrides.providerEventId ?? `provider-${eventSlug}-${gameStartIso ?? "missing"}`;
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    condition_id: conditionId,
    selected_token_id: overrides.tokenId ?? "tok-nyy-phi-yankees",
    token_id: overrides.tokenId ?? "tok-nyy-phi-yankees",
    selected_outcome: "New York Yankees",
    score: overrides.score ?? 80,
    signal_confidence_num: overrides.confidence ?? 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-27T19:30:00.000Z",
    expires_at: "2026-07-28T04:00:00.000Z",
    signal_result: null,
    event_slug: eventSlug,
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    diagnostics: {
      ...(gameStartIso === null ? {} : { gameStartIso }),
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: providerEventId,
        eventStartIso: gameStartIso ?? KICKOFF_A,
        sportFamily: "baseball",
      },
      dataCoverage: 60,
      shadowScope: "baseball",
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
    },
  };
}

/** The REAL production entry: buildReservationPlan in Contract A planning mode. */
async function planFrom(
  rows: readonly Record<string, unknown>[],
  deps: {
    activeOccurrences?: readonly Pick<
      NightEventReservationRow,
      "physical_event_id" | "event_start_iso" | "status"
    >[];
  } = {}
) {
  return at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => rows,
      activeOccurrences: deps.activeOccurrences,
    })
  );
}

function makeFakeRepo(seed: NightEventReservationRow[] = []): ReservationRepoPort & {
  store: NightEventReservationRow[];
  insertCalls: number;
} {
  const store = [...seed];
  let nextId = store.length + 1;
  let insertCalls = 0;
  return {
    store,
    get insertCalls() {
      return insertCalls;
    },
    async findByPlanRunId(planRunId) {
      return store.filter((r) => r.plan_run_id === planRunId);
    },
    async findByPhysicalEventId(physicalEventId) {
      return store.find((r) => r.physical_event_id === physicalEventId) ?? null;
    },
    async deleteByPlanRunId(planRunId) {
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].plan_run_id === planRunId) store.splice(i, 1);
      }
    },
    async insert(rows) {
      insertCalls += 1;
      for (const row of rows) store.push({ ...row, id: row.id ?? `reservation-${nextId++}` });
    },
  };
}

// ── 1. Authoritative input ────────────────────────────────────────────────

test("PDR-1: production-shaped source rows enter the REAL Contract A producer and the resulting Planning Decision creates the Reservation", async () => {
  const rows = [sourceRow({})];
  const decisions = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  const accepted = decisions.filter((d) => d.accepted);
  assert.equal(accepted.length, 1, "the real producer must approve exactly one planning decision");

  const plan = await planFrom(rows);
  assert.equal(plan.reservations.length, 1);
  const [r] = plan.reservations;
  assert.equal(r.status, "RESERVED");
  assert.equal(
    r.diagnostics.reservation_authority,
    "CONTRACT_A_PLANNING_DECISION",
    "the reservation must record that a Contract A Planning Decision created it"
  );
  assert.match(String(r.selection_reason), /^CONTRACT_A_PLANNING_DECISION:/);
  assert.equal(plan.diagnostics.source_rows, 1);
});

test("PDR-2: a REJECTED Planning Decision never creates a Reservation", async () => {
  // The planning selector drops a row with no canonical kickoff BEFORE Contract
  // A sees it, so the rejection is produced where it actually lives: the real
  // Contract A rule (`buildContractAPlanningDecision`) applied to a real
  // producer candidate whose source row carries no gameStartIso. Nothing here
  // is a hand-written decision object.
  const rows = [sourceRow({})];
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  const { candidates } = await at(NOW_MS, () =>
    buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1")
  );
  const rejected = buildContractAPlanningDecision(candidates[0], {});
  assert.equal(rejected.accepted, false);
  if (rejected.accepted) return;
  assert.equal(rejected.rejection.reason_code, "MISSING_CANONICAL_EVENT_START_ISO");

  const plan = await at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => rows,
      produceDecisions: async () => [rejected],
    })
  );
  assert.equal(plan.reservations.length, 0, "a rejected Planning Decision must never be reserved");
  assert.equal(plan.diagnostics.first_rejection_code, "PLANNING_DECISION_REJECTED");
  assert.equal(plan.diagnostics.planning_decisions_rejected, 1);
});

// ── 2. Identity, time, metadata, lineage ──────────────────────────────────

test("PDR-3: the Reservation preserves the exact Contract A physical_event_id", async () => {
  const rows = [sourceRow({})];
  const [decision] = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;

  const plan = await planFrom(rows);
  const [r] = plan.reservations;
  assert.equal(r.physical_event_id, decision.decision.physical_event_id);
  assert.equal(
    r.match_family_key,
    decision.decision.physical_event_id,
    "the reservation key must be the Contract A occurrence identity, never a legacy pair:<teams>:<date> key"
  );
  assert.doesNotMatch(String(r.match_family_key), /^pair:/);
});

test("PDR-4: the Reservation preserves the canonical event_start_iso, never a reconstructed time", async () => {
  const plan = await planFrom([sourceRow({})]);
  const [r] = plan.reservations;
  assert.equal(r.event_start_iso, KICKOFF_A);
  assert.equal(r.game_start_iso, KICKOFF_A);
  assert.equal(r.diagnostics.event_start_iso_source, "source_row_game_start_iso");
});

test("PDR-5: real sport and strategic scope metadata survive into the Reservation", async () => {
  const plan = await planFrom([sourceRow({})]);
  const [r] = plan.reservations;
  assert.equal(r.strategic_scope, "MLB");
  assert.notEqual(r.sport, "unknown");
  assert.notEqual(r.strategic_scope, "OTHER");
  assert.equal(r.diagnostics.sport_metadata_source, "upstream");
});

test("PDR-6: non-UUID source lineage survives as lineage and never reaches a UUID column", async () => {
  const nonUuidId = "legacy-import:nyy-phi-2026-07-27";
  const plan = await planFrom([sourceRow({ id: nonUuidId })]);
  const [r] = plan.reservations;

  const lineage = r.diagnostics.source_lineage as Record<string, unknown>;
  assert.equal(lineage.generated_signal_pair_id, nonUuidId, "lineage must not be silently nulled");
  assert.equal(lineage.generated_signal_pair_id_is_uuid, false);
  assert.equal(lineage.event_slug, "mlb-nyy-phi-2026-07-27");
  // `id` is the only uuid column on night_event_reservations; the row must never
  // carry a non-UUID lineage value into it. best_snapshot_id is a text column.
  assert.equal(r.id, undefined, "a non-UUID lineage id must never be written into the uuid primary key");
  assert.equal(r.best_snapshot_id, nonUuidId);
});

// ── 3. Model authority vs reservation authority ───────────────────────────

test("PDR-7: planning score / tier / rank come from Contract A and are not recomputed", async () => {
  const rows = [sourceRow({})];
  const [decision] = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;

  const plan = await planFrom(rows);
  const [r] = plan.reservations;
  assert.equal(r.event_score, decision.decision.planning_score);
  assert.equal(r.event_tier, decision.decision.planning_tier);
  assert.equal(r.diagnostics.planning_rank, decision.decision.planning_rank);
  assert.equal(r.diagnostics.planning_score, decision.decision.planning_score);
  // The legacy ladder must leave no trace: no fallback promotion, no
  // legacy slot_fill classification, no legacy anchor attribution.
  assert.equal(r.diagnostics.slot_fill, undefined);
  assert.equal(r.diagnostics.fallback_tier, undefined);
  assert.equal(r.diagnostics.planning_anchor_kind, undefined);
});

test("PDR-8: the repaired path does not route Reservation through the legacy candidate authority", async () => {
  const rows = [sourceRow({})];

  // Legacy authority, driven through the same real producer output.
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  const legacy = await at(NOW_MS, () =>
    buildReservationPlan(NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchCandidates: async () =>
        buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1"),
    })
  );
  const repaired = await planFrom(rows);

  assert.equal(
    repaired.diagnostics.reservation_authority,
    "CONTRACT_A_PLANNING_DECISION",
    "the repaired path must name Contract A as the reservation authority"
  );
  assert.notEqual(
    legacy.diagnostics.reservation_authority,
    "CONTRACT_A_PLANNING_DECISION",
    "the injected-candidate seam must remain the legacy path so this comparison is meaningful"
  );
  for (const r of repaired.reservations) {
    assert.doesNotMatch(
      String(r.match_family_key),
      /^pair:/,
      "a reservation from the repaired path must never be keyed by the legacy team-pair grouping"
    );
  }
});

// ── 4. Exact physical occurrence identity ─────────────────────────────────

test("PDR-9: same slug + same calendar date + different start times produce DISTINCT occurrence identities", async () => {
  const rows = [
    sourceRow({ id: "00000000-0000-4000-8000-0000000000a1", conditionId: "cond-dh-game-1", tokenId: "tok-dh-1", gameStartIso: KICKOFF_A }),
    sourceRow({ id: "00000000-0000-4000-8000-0000000000a2", conditionId: "cond-dh-game-2", tokenId: "tok-dh-2", gameStartIso: KICKOFF_B }),
  ];
  const decisions = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  const ids = decisions.filter((d) => d.accepted).map((d) => (d.accepted ? d.decision.physical_event_id : ""));
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "a doubleheader must not collapse to one physical_event_id");

  const plan = await planFrom(rows);
  assert.equal(plan.reservations.length, 2, "both starts of the doubleheader must be reserved");
  const reserved = plan.reservations.map((r) => r.physical_event_id);
  assert.equal(new Set(reserved).size, 2);
  const starts = plan.reservations.map((r) => r.event_start_iso).sort();
  assert.deepEqual(starts, [KICKOFF_A, KICKOFF_B]);
});

// ── 5. Duplicate protection, idempotency, lifecycle ───────────────────────

test("PDR-10: the same ACTIVE physical occurrence cannot be reserved twice", async () => {
  const rows = [sourceRow({})];
  const first = await planFrom(rows);
  const occurrence = first.reservations[0];

  const second = await planFrom(rows, {
    activeOccurrences: [
      {
        physical_event_id: occurrence.physical_event_id,
        event_start_iso: occurrence.event_start_iso,
        status: "RESERVED",
      },
    ],
  });
  assert.equal(second.reservations.length, 0);
  assert.equal(second.diagnostics.first_rejection_code, "ACTIVE_DUPLICATE");
  assert.equal(second.diagnostics.duplicate_rejected, 1);
});

test("PDR-11: a repeated identical run for the same Planning Decision is idempotent at persistence", async () => {
  const repo = makeFakeRepo();
  const rows = [sourceRow({})];
  const plan = await planFrom(rows);

  const first = await persistReservationPlan(plan, {}, repo);
  assert.equal(first.written_count, 1);
  assert.equal(repo.insertCalls, 1);

  const rerun = await persistReservationPlan(await planFrom(rows), {}, repo);
  assert.equal(rerun.written_count, 0, "a repeated run must not create a second reservation");
  assert.equal(rerun.already_exists, true);
  assert.equal(repo.store.length, 1);
});

test("PDR-12: a TERMINAL reservation for an OLD occurrence does not block a new occurrence", async () => {
  const rows = [sourceRow({ gameStartIso: KICKOFF_B, conditionId: "cond-dh-game-2", tokenId: "tok-dh-2" })];
  const staleOccurrenceId = "event:mlb-nyy-phi-2026-07-27:2026-07-27T21:00:00.000Z";

  const plan = await planFrom(rows, {
    activeOccurrences: [
      // Terminal lifecycle states never hold a slot.
      { physical_event_id: staleOccurrenceId, event_start_iso: KICKOFF_A, status: "EXPIRED" },
    ],
  });
  assert.equal(plan.reservations.length, 1, "an expired old occurrence must not block the next occurrence");
  assert.notEqual(plan.reservations[0].physical_event_id, staleOccurrenceId);
  assert.equal(plan.reservations[0].event_start_iso, KICKOFF_B);
});

const LEGACY_DATE_ONLY_ID = "event:mlb-nyy-phi-2026-07-27:2026-07-27";

test("PDR-12a: an ACTIVE legacy date-only row is never reused as an exact provider Reservation", async () => {
  const plan = await planFrom([sourceRow({})]);
  const legacy = {
    ...plan.reservations[0],
    id: "legacy-same-start",
    physical_event_id: LEGACY_DATE_ONLY_ID,
    event_start_iso: "2026-07-27T21:00:00Z",
    status: "RESERVED" as const,
  };
  const repo = makeFakeRepo([legacy]);

  const persisted = await persistReservationPlan(plan, {}, repo);

  assert.equal(persisted.written_count, 1);
  assert.equal(repo.insertCalls, 1);
  assert.equal(repo.store.length, 2);
  assert.notEqual(repo.store[1]?.physical_event_id, LEGACY_DATE_ONLY_ID);
});

test("PDR-12b: an ACTIVE legacy date-only row with a different same-day start does not collapse a doubleheader", async () => {
  const plan = await planFrom([sourceRow({ gameStartIso: KICKOFF_B, conditionId: "cond-dh-game-2", tokenId: "tok-dh-2" })]);
  const legacy = {
    ...plan.reservations[0],
    id: "legacy-other-start",
    physical_event_id: LEGACY_DATE_ONLY_ID,
    event_start_iso: KICKOFF_A,
    status: "RESERVED" as const,
  };
  const repo = makeFakeRepo([legacy]);

  const persisted = await persistReservationPlan(plan, {}, repo);

  assert.equal(persisted.written_count, 1);
  assert.equal(repo.insertCalls, 1);
  assert.equal(repo.store.length, 2);
});

test("PDR-12c: malformed legacy timing is never parsed as an exact provider occurrence", async () => {
  const plan = await planFrom([sourceRow({})]);
  const legacy = {
    ...plan.reservations[0],
    id: "legacy-unresolved",
    physical_event_id: LEGACY_DATE_ONLY_ID,
    event_start_iso: "not-a-timestamp",
    status: "RESERVED" as const,
  };
  const repo = makeFakeRepo([legacy]);

  const persisted = await persistReservationPlan(plan, {}, repo);
  assert.equal(persisted.written_count, 1);
  assert.equal(repo.insertCalls, 1);
  assert.equal(repo.store.length, 2);
});

test("PDR-12d: a TERMINAL legacy date-only row does not block a new Reservation", async () => {
  const plan = await planFrom([sourceRow({})]);
  const legacy = {
    ...plan.reservations[0],
    id: "legacy-terminal",
    physical_event_id: LEGACY_DATE_ONLY_ID,
    event_start_iso: KICKOFF_A,
    status: "EXPIRED" as const,
  };
  const repo = makeFakeRepo([legacy]);

  const persisted = await persistReservationPlan(plan, {}, repo);

  assert.equal(persisted.written_count, 1);
  assert.equal(repo.insertCalls, 1);
  assert.equal(repo.store.length, 2);
});

// ── 6. Cap and ordering ───────────────────────────────────────────────────

function capRows(count: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const startMs = Date.parse("2026-07-27T18:00:00.000Z") + i * 10 * 60_000;
    rows.push(
      sourceRow({
        id: `00000000-0000-4000-8000-0000000${String(100 + i)}`,
        conditionId: `cond-cap-${i}`,
        tokenId: `tok-cap-${i}`,
        eventSlug: `mlb-cap-event-${i}-2026-07-27`,
        gameStartIso: new Date(startMs).toISOString(),
        // Descending quality so the model's own order is unambiguous.
        score: 95 - i,
        confidence: 95 - i,
      })
    );
  }
  return rows;
}

test("PDR-13: the reservation cap remains exactly 15", async () => {
  const rows = capRows(20);
  const decisions = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  assert.ok(decisions.filter((d) => d.accepted).length > 15, "the fixture must exceed the cap");

  const plan = await planFrom(rows);
  assert.equal(plan.reservations.length, 15);
  assert.equal(plan.diagnostics.targetLiveSlots, 15);
  assert.equal(plan.diagnostics.cap_excluded, decisions.filter((d) => d.accepted).length - 15);
});

test("PDR-14: the top 15 are selected in Contract A planning order, not by legacy candidate quality", async () => {
  const rows = capRows(20);
  const decisions = await at(NOW_MS, () => produceContractAPlanningDecisions(rows));
  const approved = decisions.flatMap((d) => (d.accepted ? [d.decision] : []));
  const contractAOrder = [...approved]
    .sort((a, b) =>
      a.planning_rank !== b.planning_rank
        ? a.planning_rank - b.planning_rank
        : b.planning_score - a.planning_score ||
          a.physical_event_id.localeCompare(b.physical_event_id)
    )
    .slice(0, 15)
    .map((d) => d.physical_event_id);

  const plan = await planFrom(rows);
  assert.deepEqual(
    plan.reservations.map((r) => r.physical_event_id),
    contractAOrder,
    "reservation order must be the Contract A planning order"
  );
  assert.deepEqual(
    plan.reservations.map((r) => r.reservation_rank),
    Array.from({ length: 15 }, (_, i) => i + 1)
  );
});

// ── 7. Event-level semantics and persistence compatibility ────────────────

test("PDR-15: Reservation preserves Planning market evidence but never selects a sibling universe", async () => {
  const rows = [sourceRow({})];
  const plan = await planFrom(rows);
  const [r] = plan.reservations;
  const evidence = r.diagnostics.planning_final_identity_evidence as Record<string, unknown>;
  assert.equal(evidence.condition_id, "cond-nyy-phi");
  assert.equal(evidence.token_id, "tok-nyy-phi-yankees");
  assert.equal(evidence.side, "New York Yankees");
  assert.equal(r.diagnostics.condition_id, undefined);
  assert.equal(r.diagnostics.token_id, undefined);
  assert.equal(r.diagnostics.side, undefined);
  assert.equal(r.diagnostics.authoritative_condition_id, undefined);
  assert.equal(r.diagnostics.authoritative_token_id, undefined);
  assert.equal(r.diagnostics.contract_a_stage, "PLANNING");
});

test("PDR-16: existing Reservation persistence behaviour stays compatible (occurrence guards still fire)", async () => {
  const repo = makeFakeRepo();
  const plan = await planFrom([sourceRow({})]);
  await persistReservationPlan(plan, {}, repo);

  // A changed start for the SAME occurrence identity must still fail closed
  // through the pre-existing persistence guard -- unchanged by this task.
  const conflicting = {
    ...plan,
    reservations: plan.reservations.map((r) => ({ ...r, event_start_iso: "2026-07-27T22:15:00.000Z" })),
  };
  await assert.rejects(
    () => persistReservationPlan(conflicting, {}, repo),
    /OCCURRENCE_IDENTITY_CONFLICT/
  );

  const missingIdentity = {
    ...plan,
    reservations: plan.reservations.map((r) => ({ ...r, physical_event_id: null })),
  };
  await assert.rejects(
    () => persistReservationPlan(missingIdentity, {}, repo),
    /RESERVATION_OCCURRENCE_IDENTITY_MISSING/
  );
});
