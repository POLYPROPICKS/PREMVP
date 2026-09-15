// DIRECT_MODEL_READY_RESEARCH_PATH_V1 regression coverage.
//
// Proves the reusable materializer's pure/deterministic surfaces without a
// live clone connection: explicit date-range expansion (1D/7D/14D/30D-shape
// reuse), materializeDayRows end-to-end against a fully faked clone client
// (bounded keyset reads, Gamma settlement stub, frozen compact materializer),
// and that writeDayRows upserts on the exact economic-identity conflict key
// (never duplicating an identity on a rerun).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  datesInRange,
  latestClosedMinskDay,
  materializeDayRows,
  resolveMissingRecentDates,
  writeDayRows,
} from "../../scripts/modeling/materialize-research-model-ready";

test("datesInRange: expands an inclusive Minsk date range, smallest to largest", () => {
  assert.deepEqual(datesInRange("2026-09-01", "2026-09-01"), ["2026-09-01"]);
  assert.deepEqual(datesInRange("2026-09-01", "2026-09-03"), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
  ]);
  const fifteen = datesInRange("2026-09-01", "2026-09-15");
  assert.equal(fifteen.length, 15, "same path covers 1D through 15D without another implementation");
  assert.equal(fifteen[0], "2026-09-01");
  assert.equal(fifteen.at(-1), "2026-09-15");
});

test("datesInRange: rejects an inverted range", () => {
  assert.throws(() => datesInRange("2026-09-15", "2026-09-01"), /MATERIALIZE_RANGE_INVALID/);
});

/** Minimal chainable fake mirroring the exact call shapes the real reads/writes issue. */
function makeFakeClone(gspRows: Record<string, unknown>[], outboxRows: Record<string, unknown>[]) {
  const writes: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
  function readBuilder(table: string, rows: Record<string, unknown>[]) {
    const filters: Array<{ op: "eq" | "gt" | "in"; field: string; value: unknown }> = [];
    const orders: Array<{ field: string; ascending: boolean }> = [];
    const chain = {
      select() {
        return chain;
      },
      eq(field: string, value: unknown) {
        filters.push({ op: "eq", field, value });
        return chain;
      },
      gt(field: string, value: unknown) {
        filters.push({ op: "gt", field, value });
        return chain;
      },
      in(field: string, value: unknown[]) {
        filters.push({ op: "in", field, value });
        return chain;
      },
      order(field: string, opts?: { ascending?: boolean }) {
        orders.push({ field, ascending: opts?.ascending !== false });
        return chain;
      },
      limit(n: number) {
        let out = rows.filter((r) =>
          filters.every((f) => {
            const v = r[f.field];
            if (f.op === "eq") return v === f.value;
            if (f.op === "gt") return (v as string) > (f.value as string);
            if (f.op === "in") return (f.value as unknown[]).includes(v);
            return true;
          }),
        );
        out = [...out].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.field] as string;
            const bv = b[o.field] as string;
            if (av < bv) return o.ascending ? -1 : 1;
            if (av > bv) return o.ascending ? 1 : -1;
          }
          return 0;
        });
        return Promise.resolve({ data: out.slice(0, n), error: null });
      },
    };
    return chain;
  }
  function writeBuilder(table: string) {
    return {
      upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }) {
        writes.push({ table, rows, onConflict: opts?.onConflict });
        return Promise.resolve({ error: null });
      },
    };
  }
  const client = {
    from(table: string) {
      if (table === "generated_signal_pairs") return readBuilder(table, gspRows);
      if (table === "primary_evidence_outbox") return readBuilder(table, outboxRows);
      if (table === "generated_signal_research_snapshots") return readBuilder(table, []);
      return writeBuilder(table);
    },
  };
  return { client: client as any, writes };
}

const D = "2026-09-01";
const T0 = Date.parse(`${D}T12:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function outboxEnvelope(n: number, observedAtMs: number, itemId: string) {
  return {
    observation_id: uuid(n),
    observed_at: iso(observedAtMs),
    evidence_rows: [
      {
        observation_id: itemId,
        condition_id: "0xcond-a",
        selected_token_id: "token-a",
        formula_version: "v2-lite-growth-safe",
        entry_price_num: 0.55,
        signal_result: null,
        pre_event_score_num: 70,
        diagnostics: {
          providerEventId: "polymarket-event-a",
          gameStartIso: iso(T0 + 6 * 3600_000),
          marketType: "moneyline",
          marketFamily: "moneyline",
          providerSportCode: "SOCCER",
          providerSportFamily: "soccer",
          volumeUsd: 500,
        },
      },
    ],
    evidence_row_count: 1,
  };
}

/**
 * Settlement enrichment calls the real Gamma/CLOB public API via global
 * fetch. Unit coverage here stubs it deterministically (no network
 * dependency, no flakiness) — the resolver's own behavior is covered by its
 * dedicated suite; this suite only proves the materializer wires the
 * settlement layer in and buckets labels correctly.
 */
function stubFetchUnreachable(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("stubbed: no network in unit test"))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("materializeDayRows: bounded read -> frozen materializer -> counted rows, no production write", async () => {
  const restore = stubFetchUnreachable();
  const { client } = makeFakeClone([], [outboxEnvelope(1, T0, uuid(101))]);
  const { rows, counts } = await materializeDayRows(client, D).finally(restore);

  assert.equal(counts.date, D);
  assert.equal(counts.sourceEvidenceIdentityN, 1, "one distinct (condition_id, selected_token_id) identity");
  assert.equal(counts.modelReadyRowN, rows.length);
  assert.equal(counts.pitFutureLeakN, 0, "no future-dated eligible observation exists in this fixture");
  assert.equal(
    counts.terminalRowN + counts.openRowN + counts.noMatchN + counts.ambiguousN + counts.voidN,
    rows.length,
    "every row falls into exactly one settlement bucket",
  );
  for (const r of rows) {
    assert.equal(r.populationId !== undefined, true);
    assert.equal(r.labelAsOf, r.frozenLabel, "single-day slice: as-of label equals the frozen label");
  }
});

test("writeDayRows: upserts on the full economic-identity conflict key (idempotent, no duplicate identity)", async () => {
  const restore = stubFetchUnreachable();
  const { client } = makeFakeClone([], [outboxEnvelope(1, T0, uuid(101))]);
  const { rows } = await materializeDayRows(client, D).finally(restore);

  const recording = makeFakeClone([], []);
  await writeDayRows(recording.client, D, rows);

  const rowWrite = recording.writes.find((w) => w.table === "research_model_ready_rows");
  assert.ok(rowWrite, "writes to research_model_ready_rows");
  assert.equal(
    rowWrite!.onConflict,
    "model_date,population_id,condition_id,selected_token_id,decision_at",
    "upsert targets the exact economic-identity key — a rerun overwrites, never duplicates",
  );

  const dayWrite = recording.writes.find((w) => w.table === "research_model_ready_days");
  assert.ok(dayWrite, "writes exactly one research_model_ready_days marker");
  assert.equal((dayWrite!.rows as unknown as { model_date: string }).model_date, D);

  const economicsWrite = recording.writes.find((w) => w.table === "research_model_economics");
  assert.equal(economicsWrite, undefined, "this materializer never writes research_model_economics");
});

test("latestClosedMinskDay: is the calendar day strictly before the current Minsk day", () => {
  // Noon UTC on 2026-09-15 is 15:00 Minsk (UTC+3) on the same calendar day —
  // the latest CLOSED day is the day before.
  const now = new Date("2026-09-15T12:00:00.000Z");
  assert.equal(latestClosedMinskDay(now), "2026-09-14");
});

/** Fake clone client exposing only research_model_ready_days reads. */
function makeFakeDaysClient(dayRows: Array<{ model_date: string; status: string }>) {
  return {
    from(table: string) {
      if (table !== "research_model_ready_days") throw new Error(`unexpected table ${table}`);
      const filters: Array<{ op: "gte" | "lte"; field: string; value: string }> = [];
      const chain = {
        select() {
          return chain;
        },
        gte(field: string, value: string) {
          filters.push({ op: "gte", field, value });
          return chain;
        },
        lte(field: string, value: string) {
          filters.push({ op: "lte", field, value });
          return Promise.resolve({
            data: dayRows.filter((r) =>
              filters.concat([{ op: "lte", field, value }]).every((f) => {
                const v = r[f.field as "model_date"];
                return f.op === "gte" ? v >= f.value : v <= f.value;
              }),
            ),
            error: null,
          });
        },
      };
      return chain;
    },
  } as any;
}

test("resolveMissingRecentDates: bounded window, excludes already-accepted dates, never an unbounded backfill", async () => {
  const now = new Date("2026-09-15T12:00:00.000Z"); // latest closed Minsk day: 2026-09-14
  const db = makeFakeDaysClient([
    { model_date: "2026-09-12", status: "MODEL_READY" },
    { model_date: "2026-09-13", status: "DEGRADED_EXCLUDED" },
  ]);
  const missing = await resolveMissingRecentDates(db, 7, now);
  assert.equal(missing.length, 5, "7-day window minus the 2 already-accepted dates");
  assert.equal(missing.includes("2026-09-12"), false);
  assert.equal(missing.includes("2026-09-13"), false);
  assert.equal(missing.includes("2026-09-14"), true, "latest closed day is a candidate when unaccepted");
  assert.equal(missing[0], "2026-09-08", "window floor is exactly windowDays back from the latest closed day");
});
