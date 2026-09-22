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
      select() {
        // MONOTONIC_SETTLEMENT_GUARD_V1: writeDayRows reads existing terminal
        // rows for the date before upserting. No pre-existing rows in these
        // fixtures, so the guard is a no-op pass-through.
        return this;
      },
      eq() {
        return this;
      },
      in() {
        return Promise.resolve({ data: [], error: null });
      },
      upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }) {
        writes.push({ table, rows, onConflict: opts?.onConflict });
        return Promise.resolve({ error: null });
      },
    };
  }
  const client = {
    from(table: string) {
      if (table === "generated_signal_pairs") return readBuilder(table, gspRows);
      if (table === "research_evidence_page_rows") return readBuilder(table, outboxRows);
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

/** One narrow research_evidence_page_rows row (current canonical source shape). */
function narrowRow(n: number, observedAtMs: number, itemId: string, extra: Record<string, unknown> = {}) {
  return {
    observation_id: uuid(n),
    observed_at: iso(observedAtMs),
    item_observation_id: itemId,
    condition_id: "0xcond-a",
    selected_token_id: "token-a",
    formula_version: "v2-lite-growth-safe",
    entry_price_num: 0.55,
    signal_result: null,
    pre_event_score_num: 70,
    provider_event_id: "polymarket-event-a",
    provider_sport_code: "SOCCER",
    provider_sport_family: "soccer",
    market_family: "moneyline",
    market_type: "match_winner",
    game_start_iso: iso(T0 + 6 * 3600_000),
    volume_usd: 12345.5,
    volume_semantic: "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr",
    selected_outcome: "Draw",
    data_coverage: 0.75,
    ...extra,
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
  const { client } = makeFakeClone([], [narrowRow(1, T0, uuid(101))]);
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
  const { client } = makeFakeClone([], [narrowRow(1, T0, uuid(101))]);
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

// ── CURRENT canonical source: research_evidence_page_rows ────────────────────

import { readResearchEvidencePageRows } from "../../scripts/modeling/live-d1-research-corpus";

/** Wraps a fake clone so every read is recorded (table + select column list). */
function spyClient(inner: any) {
  const reads: Array<{ table: string; cols: unknown }> = [];
  return {
    reads,
    client: {
      from(table: string) {
        const b = inner.from(table);
        if (typeof b.select !== "function") return b;
        const orig = b.select.bind(b);
        b.select = (cols?: unknown) => {
          reads.push({ table, cols });
          return orig(cols);
        };
        return b;
      },
    } as any,
  };
}

test("current materializer consumes research_evidence_page_rows, never the raw clone primary_evidence_outbox; rich attributes verbatim", async () => {
  const restore = stubFetchUnreachable();
  const { client } = makeFakeClone([], [narrowRow(1, T0, uuid(101))]);
  const spy = spyClient(client);
  const { rows } = await materializeDayRows(spy.client, D).finally(restore);

  const tables = new Set(spy.reads.map((r) => r.table));
  assert.ok(tables.has("research_evidence_page_rows"), "reads the narrow canonical source");
  assert.equal(tables.has("primary_evidence_outbox"), false, "raw clone outbox is not required by the current path");
  assert.equal(rows.length, 1);
  const r = rows[0] as unknown as Record<string, unknown>;
  assert.equal(r.selectedOutcome, "Draw");
  assert.equal(r.marketTypeRaw, "match_winner");
  assert.equal(r.volumeUsd, 12345.5);
  assert.equal(r.volumeSemantic, "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr");
  assert.equal(r.dataCoverage, 0.75);
  assert.equal(r.providerEventId, "polymarket-event-a");
  assert.equal(r.entryPrice, 0.55);
});

test("readResearchEvidencePageRows: explicit columns only, three-field keyset resumes INSIDE one envelope, providerEventContext not fabricated", async () => {
  // 2500 items in ONE envelope (> the 1000-row page) plus one later envelope.
  const items = Array.from({ length: 2500 }, (_, i) =>
    narrowRow(1, T0, `20000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`),
  );
  const later = narrowRow(2, T0 + 60_000, "20000000-0000-0000-0000-999999999999");
  const { client } = makeFakeClone([], [...items, later]);
  const spy = spyClient(client);
  const { pairs } = await readResearchEvidencePageRows(spy.client, `${D}T00:00:00.000Z`, `${D}T23:59:59.999Z`);

  assert.equal(pairs.length, 2501, "no item skipped at the page boundaries inside the 2500-item envelope");
  assert.equal(new Set(pairs.map((p) => p._id)).size, 2501, "no item duplicated");
  assert.equal(pairs[0]._id, items[0].item_observation_id);
  assert.equal(pairs[999]._id, items[999].item_observation_id);
  assert.equal(pairs[1000]._id, items[1000].item_observation_id, "page 2 continues at the NEXT item of the same envelope");
  assert.equal(pairs.at(-1)!._id, later.item_observation_id, "later envelope remains reachable");
  for (const r of spy.reads) {
    assert.equal(r.table, "research_evidence_page_rows");
    assert.equal(typeof r.cols, "string");
    assert.notEqual((r.cols as string).trim(), "*", "never SELECT *");
    assert.match(r.cols as string, /item_observation_id/);
  }
  const p = pairs[0] as unknown as Record<string, unknown>;
  assert.equal("providerEventContext" in p, false, "providerEventContext is not fabricated");
  assert.equal(p.selectedOutcome, "Draw");
  assert.equal(p.dataCoverage, 0.75);
  assert.equal(p.marketTypeRaw, "match_winner");
  assert.equal(p.volumeSemantic, "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr");
});

test("null narrow attributes stay null (no fabrication) and the legacy GSP leg is still read", async () => {
  const { client } = makeFakeClone([], [
    narrowRow(1, T0, uuid(101), { selected_outcome: null, data_coverage: null, market_type: null, volume_usd: null, volume_semantic: null }),
  ]);
  const spy = spyClient(client);
  const { pairs } = await readResearchEvidencePageRows(spy.client, `${D}T00:00:00.000Z`, `${D}T23:59:59.999Z`);
  const p = pairs[0] as unknown as Record<string, unknown>;
  assert.equal(p.selectedOutcome, null);
  assert.equal(p.dataCoverage, null);
  assert.equal(p.marketTypeRaw, null);
  assert.equal(p.volumeUsd, null);
  assert.equal(p.volumeSemantic, undefined);

  const restore = stubFetchUnreachable();
  const gsp = makeFakeClone([], []);
  const spy2 = spyClient(gsp.client);
  await materializeDayRows(spy2.client, D).finally(restore);
  assert.ok(spy2.reads.some((r) => r.table === "generated_signal_pairs"), "legacy generated_signal_pairs support preserved");
});
