// FIX_PREMVP_CALLBACK_NUMERIC_NORMALIZATION_V1 regressions.
//
// Live Ireland incident: durable callback payloads carry economic fields as
// JSON numeric STRINGS (stake_usd: "2.5"). The PREMVP callback submission
// mapper in handleOrderEventSubmission accepted stake_usd / the submitted_size
// stake fallback only when `typeof raw.<field> === "number"`, so a numeric
// string was coerced to null and the queue-policy validator rejected the
// callback as REJECTED_QUEUE_POLICY_MISMATCH / MISSING_STAKE_USD (HTTP 409) --
// even though the value was present, correctly named, and economically valid.
//
// These tests pin the boundary behaviour: a finite numeric string is accepted
// and normalised to its numeric value before validation, while invalid /
// empty / NaN / Infinity / non-numeric / zero / negative inputs still fail the
// UNCHANGED validator (MISSING_STAKE_USD / MISSING_SUBMITTED_SIZE).
//
//   node --import tsx --test tests/contur3/executorOrderEvents.numericStringNormalization.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleOrderEventSubmission,
  projectCanonicalOrderEventPayload,
  type OrderEventDbPort,
  type StoredOrderEvent,
  type InsertOrderEventFailure,
} from "../../lib/executor/executorCallbackContract";
import type { EventExecutionQueueRow } from "../../lib/executor/executorQueueTypes";

function baseQueueRow(overrides: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: "queue-1",
    reservation_id: "res-1",
    plan_run_id: "plan-1",
    rebalance_run_id: "rebalance-1",
    match_family_key: "argentina-vs-egypt",
    event_title: "Argentina vs Egypt",
    event_slug: "argentina-vs-egypt",
    sport: "soccer",
    league: null,
    game_start_iso: "2026-07-07T16:00:00.000Z",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    market_title: "argentina-vs-egypt-moneyline",
    market_family: "allowed_fullmatch_moneyline",
    score: 80,
    coverage: 60,
    tier: "TIER1",
    stake_usd: 2.5,
    preferred_entry_iso: "2026-07-07T14:50:00.000Z",
    latest_entry_iso: "2026-07-07T15:57:00.000Z",
    selection_rank: 1,
    selection_reason: null,
    status: "READY",
    order_key: "cond-1:token-1:Argentina",
    idempotency_key: "idem-1",
    diagnostics: { max_entry_price: 0.6 },
    ...overrides,
  };
}

// Mirrors the real durable Ireland callback shape: economic fields as strings.
function irelandCallbackRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queue_id: "queue-1",
    reservation_id: "res-1",
    token_id: "token-1",
    idempotency_key: "idem-1",
    condition_id: "cond-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    stake_usd: "2.5",
    submitted_size: "2.5",
    submitted_price: 0.5,
    clob_order_id: "clob-1",
    event_type: "ORDER_PLACED",
    source: "ireland_queue_only",
    ...overrides,
  };
}

function makeFakePort(
  queueRows: EventExecutionQueueRow[] = [baseQueueRow()],
): OrderEventDbPort & { eventsById: Map<string, StoredOrderEvent> } {
  const queueByIdemKey = new Map(queueRows.map((r) => [r.idempotency_key as string, r]));
  const eventsByIdemKey = new Map<string, StoredOrderEvent>();
  const eventsByClob = new Map<string, StoredOrderEvent>();
  const eventsById = new Map<string, StoredOrderEvent>();
  let nextId = 1;
  return {
    eventsById,
    async findQueueRowByIdempotencyKey(key) {
      return queueByIdemKey.get(key) ?? null;
    },
    async findOrderEventByIdempotencyKey(key) {
      return eventsByIdemKey.get(key) ?? null;
    },
    async findOrderEventByClobOrderId(clobOrderId) {
      return eventsByClob.get(clobOrderId) ?? null;
    },
    async updateQueueRowStatus(queueId, patch) {
      for (const row of queueByIdemKey.values()) {
        if (row.id === queueId) {
          row.status = patch.status;
          row.diagnostics = patch.diagnostics;
        }
      }
    },
    async insertOrderEvent(record, _queueRow): Promise<{ ok: true; row: StoredOrderEvent } | InsertOrderEventFailure> {
      const canonical = projectCanonicalOrderEventPayload(record);
      if (canonical.idempotency_key && eventsByIdemKey.has(canonical.idempotency_key)) {
        return { ok: false, code: "UNIQUE_VIOLATION_IDEMPOTENCY_KEY", message: "duplicate key" };
      }
      if (canonical.clob_order_id && eventsByClob.has(canonical.clob_order_id)) {
        return { ok: false, code: "UNIQUE_VIOLATION_CLOB_ORDER_ID", message: "duplicate key" };
      }
      const row: StoredOrderEvent = {
        id: `evt-${nextId++}`,
        created_at: new Date().toISOString(),
        idempotency_key: canonical.idempotency_key || null,
        condition_id: canonical.condition_id,
        token_id: canonical.token_id,
        side: canonical.side,
        selected_side: null,
        market_slug: typeof record.market_slug === "string" ? record.market_slug : null,
        submitted_size: canonical.submitted_size,
        submitted_price: canonical.submitted_price,
        clob_order_id: canonical.clob_order_id,
      };
      if (row.idempotency_key) eventsByIdemKey.set(row.idempotency_key, row);
      if (row.clob_order_id) eventsByClob.set(row.clob_order_id, row);
      eventsById.set(row.id, row);
      return { ok: true, row };
    },
  };
}

// 1. A numeric stake_usd (the already-working JS-number shape) still passes.
test("N1: stake_usd as a finite JS number 2.5 passes queue-policy validation", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ stake_usd: 2.5, submitted_size: 2.5 }));
  assert.equal(outcome.kind, "INSERTED");
});

// 2. The live incident: stake_usd as the string "2.5" must pass and be
//    normalised to the number 2.5 (a raw string fails Number.isFinite and would
//    hit MISSING_STAKE_USD -- so INSERTED here proves numeric normalisation).
test("N2: stake_usd as the string \"2.5\" passes and is normalised to numeric 2.5", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ stake_usd: "2.5" }));
  assert.equal(outcome.kind, "INSERTED", "numeric-string stake_usd must no longer be rejected as MISSING_STAKE_USD");
});

// 2b. The normalised value is compared numerically against the queue cap:
//     "2.6" > queue stake_usd 2.5 -> STAKE_EXCEEDS_QUEUE_MAX, NOT MISSING_STAKE_USD.
//     This proves the string became a real number, not null and not a string.
test("N2b: a numeric-string stake_usd above the queue cap is STAKE_EXCEEDS_QUEUE_MAX (parsed & compared as a number)", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ stake_usd: "2.6", submitted_size: "1" }));
  assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
  if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "STAKE_EXCEEDS_QUEUE_MAX");
});

// 3. Invalid numeric strings remain rejected by the UNCHANGED validator.
for (const bad of ["", "   ", "abc", "2.5abc", "NaN", "Infinity", "-Infinity"]) {
  test(`N3: stake_usd as the invalid string ${JSON.stringify(bad)} is still rejected MISSING_STAKE_USD`, async () => {
    const port = makeFakePort();
    const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ stake_usd: bad }));
    assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
    if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "MISSING_STAKE_USD");
    assert.equal(port.eventsById.size, 0);
  });
}

// 4. The submitted_size stake fallback uses the same numeric-like normalisation:
//    submitted_size absent + stake_usd "2.5" -> submitted_size normalises to 2.5.
//    Proven via the notional guard: 1.1 (price) * 2.5 (size) = 2.75 > queue cap 2.5.
//    A null fallback would instead be MISSING_SUBMITTED_SIZE.
test("N4: submitted_size falls back from a numeric-string stake_usd and is normalised to numeric 2.5", async () => {
  const port = makeFakePort([baseQueueRow({ stake_usd: 2.5, diagnostics: { max_entry_price: 1.5 } })]);
  const outcome = await handleOrderEventSubmission(
    port,
    irelandCallbackRaw({ stake_usd: "2.5", submitted_size: undefined, submitted_price: 1.1 }),
  );
  assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
  if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "ORDER_NOTIONAL_EXCEEDS_QUEUE_MAX");
});

test("N4b: submitted_size fallback from a numeric-string stake_usd passes when within the notional cap", async () => {
  const port = makeFakePort([baseQueueRow({ stake_usd: 2.5, diagnostics: { max_entry_price: 1.5 } })]);
  const outcome = await handleOrderEventSubmission(
    port,
    irelandCallbackRaw({ stake_usd: "2.5", submitted_size: undefined, submitted_price: 0.4 }),
  );
  assert.equal(outcome.kind, "INSERTED");
});

test("N4c: live-shape numeric-string submitted_price reaches queue-policy validation with normalized stake fallback", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(
    port,
    irelandCallbackRaw({ stake_usd: "2.50", submitted_size: undefined, submitted_price: "0.43" }),
  );
  assert.equal(outcome.kind, "INSERTED");
});

for (const badPrice of [undefined, "", "abc", "Infinity", Number.NaN, Infinity, 0, "0", -0.01, "-0.01"]) {
  test(`N4d: invalid submitted_price ${JSON.stringify(badPrice)} remains rejected MISSING_SUBMITTED_PRICE`, async () => {
    const port = makeFakePort();
    const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ submitted_price: badPrice }));
    assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
    if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "MISSING_SUBMITTED_PRICE");
    assert.equal(port.eventsById.size, 0);
  });
}

// 5. The MISSING_STAKE_USD policy still rejects a truly missing / zero / negative stake.
for (const missing of [undefined, null, 0, "0", -1, "-2.5"]) {
  test(`N5: stake_usd ${JSON.stringify(missing)} is still rejected MISSING_STAKE_USD`, async () => {
    const port = makeFakePort();
    const outcome = await handleOrderEventSubmission(port, irelandCallbackRaw({ stake_usd: missing }));
    assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
    if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "MISSING_STAKE_USD");
  });
}

// 6. The MISSING_SUBMITTED_SIZE policy still rejects an explicitly invalid size
//    (zero / negative), even when a valid stake is present.
for (const badSize of [0, "0", -3, "-3"]) {
  test(`N6: submitted_size ${JSON.stringify(badSize)} with a valid stake is still rejected MISSING_SUBMITTED_SIZE`, async () => {
    const port = makeFakePort();
    const outcome = await handleOrderEventSubmission(
      port,
      irelandCallbackRaw({ stake_usd: 2.5, submitted_size: badSize }),
    );
    assert.equal(outcome.kind, "REJECTED_QUEUE_POLICY_MISMATCH");
    if (outcome.kind === "REJECTED_QUEUE_POLICY_MISMATCH") assert.equal(outcome.reason, "MISSING_SUBMITTED_SIZE");
  });
}

// 6b. An explicit numeric-string submitted_size is itself normalised (not only the fallback).
test("N6b: an explicit numeric-string submitted_size \"2\" is normalised and passes", async () => {
  const port = makeFakePort();
  const outcome = await handleOrderEventSubmission(
    port,
    irelandCallbackRaw({ stake_usd: "2.5", submitted_size: "2", submitted_price: 0.5 }),
  );
  assert.equal(outcome.kind, "INSERTED");
});
