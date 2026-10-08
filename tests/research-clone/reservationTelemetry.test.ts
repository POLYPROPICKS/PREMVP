import test from "node:test";
import assert from "node:assert/strict";
import { SPECS } from "../../scripts/research-clone-daily-sync";
import { purgeConfirmedTelemetry, runAppendSync, TELEMETRY_PURGE_ORDER, type PurgeTable, type TelemetryPurgeRow, type TelemetryPurgeCursor, type Watermark } from "../../lib/research-clone/dailySync";

test("all three telemetry datasets use narrow append-only keysets", () => {
  const expected = [
    ["reservation_market_capture_runs", "observed_at"],
    ["reservation_market_observations", "observed_at"],
    ["reservation_strategy_observations", "evaluated_at"],
  ];
  for (const [table, timestamp] of expected) {
    const spec = SPECS.find((entry) => entry.table === table);
    assert.ok(spec);
    assert.deepEqual(spec.fields, [timestamp, "id"]);
    assert.equal(spec.appendOnly, true);
    assert.equal(spec.telemetry, true);
    assert.match(spec.projection ?? "", /(^|,)id(,|$)/);
    assert.doesNotMatch(spec.projection ?? "", /\*|json|payload|book_levels/i);
  }
  const marketProjection = SPECS.find((entry) => entry.table === "reservation_market_observations")?.projection ?? "";
  for (const field of ["reference_entry_price", "execution_price_cap", "requested_stake_usd", "full_stake_executable_vwap"]) {
    assert.match(marketProjection, new RegExp(`(^|,)${field}(,|$)`));
  }
});

test("all three telemetry keysets are idempotent across repeated syncs", async () => {
  for (const spec of SPECS.filter((entry) => entry.telemetry)) {
    const time = spec.fields[0];
    const row = { id: "11111111-1111-4111-8111-111111111111", [time]: "2026-09-30T12:00:00.000Z" };
    const target = new Map<string, typeof row>();
    let checkpoint: Watermark | null = null;
    const sync = () => runAppendSync(spec.fields, 2, {
      async sourceMaxWatermark() { return { [time]: row[time], id: row.id }; },
      async targetMaxWatermark() { return target.size ? { [time]: row[time], id: row.id } : null; },
      async readCheckpoint() { return checkpoint; },
      async fetchSourcePage(after) { return !after || after[time] < row[time] ? [row] : []; },
      async upsertTargetRows(rows) { for (const item of rows) target.set(item.id, item); return { newRows: rows.length, updatedRows: 0, duplicateN: 0 }; },
      async writeCheckpoint(value) { checkpoint = value; },
    }, "2026-09-30T00:00:00.000Z");
    assert.equal((await sync()).newRows, 1, spec.table);
    assert.equal((await sync()).newRows, 0, spec.table);
    assert.equal(target.size, 1, spec.table);
  }
});

test("24h purge deletes only exact clone-confirmed old IDs and preserves recent or unconfirmed IDs", async () => {
  const now = Date.parse("2026-10-02T00:00:00.000Z");
  const old = "2026-09-30T12:00:00.000Z";
  const recent = "2026-10-01T12:00:00.000Z";
  const rows = Object.fromEntries(TELEMETRY_PURGE_ORDER.map((table) => [table, [
    { id: `${table}:confirmed`, timestamp: old },
    { id: `${table}:missing`, timestamp: old },
    { id: `${table}:recent`, timestamp: recent },
  ]])) as Record<PurgeTable, TelemetryPurgeRow[]>;
  const deleted: string[] = [];
  const cursor = {} as Record<PurgeTable, TelemetryPurgeCursor | null>;
  const results = await purgeConfirmedTelemetry(now, {
    async readCursor(table) { return cursor[table] ?? null; },
    async fetchStalePage(table, cutoff, after, limit) {
      return rows[table].filter((row) => row.timestamp <= cutoff && (!after || row.timestamp > after.timestamp || (row.timestamp === after.timestamp && row.id > after.id))).slice(0, limit);
    },
    async exactCloneIds(_table, ids) { return ids.filter((id) => id.endsWith(":confirmed")); },
    async withoutProductionChildren(_table, ids) { return ids; },
    async deleteProductionIds(table, ids) { deleted.push(...ids); rows[table] = rows[table].filter((row) => !ids.includes(row.id)); },
    async writeCursor(table, value) { cursor[table] = value; },
  });
  assert.equal(deleted.length, 3);
  for (const table of TELEMETRY_PURGE_ORDER) {
    assert.equal(results[table].deleted_n, 1);
    assert.equal(results[table].not_confirmed_n, 1);
    assert.equal(rows[table].some((row) => row.id.endsWith(":missing")), true);
    assert.equal(rows[table].some((row) => row.id.endsWith(":recent")), true);
  }
});

test("GSRS purge uses a seven-day ordered keyset, exact clone IDs, and a durable cursor", async () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const old = "2026-09-30T00:00:00.000Z";
  const recent = "2026-10-07T00:00:00.000Z";
  const rows = [
    { id: "a", timestamp: old },
    { id: "b", timestamp: old },
    { id: "c", timestamp: recent },
  ];
  let cursor: TelemetryPurgeCursor | null = null;
  const deleted: string[] = [];
  const seenCursors: TelemetryPurgeCursor[] = [];
  const port = {
    async readCursor() { return cursor; },
    async fetchStalePage(_table: string, cutoff: string, after: TelemetryPurgeCursor | null, limit: number) {
      assert.equal(limit, 1);
      assert.equal(cutoff, "2026-10-01T12:00:00.000Z");
      return rows.filter((row) => row.timestamp <= cutoff && (!after || row.timestamp > after.timestamp || (row.timestamp === after.timestamp && row.id > after.id))).slice(0, limit);
    },
    async exactCloneIds(_table: string, ids: readonly string[]) { return ids.filter((id) => id === "a"); },
    async withoutProductionChildren(_table: string, ids: readonly string[]) { return [...ids]; },
    async deleteProductionIds(_table: string, ids: readonly string[]) { deleted.push(...ids); },
    async writeCursor(_table: string, next: TelemetryPurgeCursor | null) { cursor = next; if (next) seenCursors.push(next); },
  };
  const options = { tables: ["generated_signal_research_snapshots"] as const, retentionDays: 7 };
  const result = await purgeConfirmedTelemetry(now, port, 1, 2, options);
  assert.deepEqual(deleted, ["a"]);
  assert.equal(result.generated_signal_research_snapshots.not_confirmed_n, 1);
  assert.deepEqual(seenCursors.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(cursor, { timestamp: old, id: "b" });
});

test("GSRS purge fails closed on clone failure, oversized or unordered pages, and duplicate IDs", async () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const old = "2026-09-30T00:00:00.000Z";
  const options = { tables: ["generated_signal_research_snapshots"] as const, retentionDays: 7 };
  let deletes = 0;
  const port = (sourceRows: Array<{ id: string; timestamp: string }>, cloneIds: () => Promise<string[]>) => ({
    async readCursor() { return null; },
    async fetchStalePage() { return sourceRows; },
    async exactCloneIds() { return cloneIds(); },
    async withoutProductionChildren(_table: string, ids: readonly string[]) { return [...ids]; },
    async deleteProductionIds() { deletes++; },
    async writeCursor() {},
  });
  await assert.rejects(purgeConfirmedTelemetry(now, port([{ id: "a", timestamp: old }], async () => { throw new Error("CLONE_UNAVAILABLE"); }), 1, 1, options), /CLONE_UNAVAILABLE/);
  await assert.rejects(purgeConfirmedTelemetry(now, port(Array.from({ length: 201 }, (_, i) => ({ id: String(i), timestamp: old })), async () => []), 200, 1, options), /SOURCE_BOUND_VIOLATION/);
  await assert.rejects(purgeConfirmedTelemetry(now, port([{ id: "b", timestamp: old }, { id: "a", timestamp: old }], async () => []), 2, 1, options), /SOURCE_ORDER_VIOLATION/);
  await assert.rejects(purgeConfirmedTelemetry(now, port([{ id: "a", timestamp: old }, { id: "a", timestamp: old }], async () => []), 2, 1, options), /DUPLICATE_SOURCE_ID|SOURCE_ORDER_VIOLATION/);
  await assert.rejects(purgeConfirmedTelemetry(now, port([{ id: "a", timestamp: old }], async () => ["a", "a"]), 1, 1, options), /DUPLICATE_CLONE_ID/);
  assert.equal(deletes, 0);
});

test("GSRS purge source transport selects only id and snapshot_at", async () => {
  const { readFileSync } = await import("node:fs");
  const script = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
  assert.match(script, /generated_signal_research_snapshots"\) return "snapshot_at"/);
  assert.match(script, /source\.from\(table\)\.select\(`id,\$\{field\}`\)\.lte\(field, cutoff\)/);
  assert.match(script, /\{ tables: \["generated_signal_research_snapshots"\], retentionDays: 7 \}/);
});

test("CLONE_PARITY_REPAIR_V1: capture projection carries discovery_audit_v1 and clone schema adds it", async () => {
  const spec = SPECS.find((entry) => entry.table === "reservation_market_capture_runs");
  assert.match(spec?.projection ?? "", /(^|,)discovery_audit_v1(,|$)/);
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync("ops/research-clone/reservation-telemetry-schema.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discovery_audit_v1 jsonb/);
});

test("CLONE_PARITY_REPAIR_V1: purge never confirms an audited row whose clone audit is NULL", async () => {
  const { auditParityConfirmedIds } = await import("../../scripts/research-clone-daily-sync");
  const confirmed = auditParityConfirmedIds(
    [
      { id: "a", discovery_audit_v1: { x: 1 } },
      { id: "b", discovery_audit_v1: null },
      { id: "c", discovery_audit_v1: null },
    ],
    new Set(["a", "b"]),
  );
  assert.deepEqual(confirmed, ["a", "c"]);
});

// T10_EXECUTABLE_SIBLING_TELEMETRY_V1 durability: production rows are purged once confirmed in the clone and the
// clone only holds the projected columns, so every new column must be projected AND exist in the clone schema.
const T10_NEW_TELEMETRY_COLUMNS = [
  "executable_telemetry_version", "executable_full_stake", "executable_full_stake_state", "full_stake_shares",
  "full_stake_worst_ask_price", "taker_fee_state", "taker_fee_reason", "taker_fee_rate", "taker_fee_usd",
  "taker_effective_cost_per_share", "taker_fee_formula_version",
];

test("T10_EXECUTABLE_SIBLING_TELEMETRY_V1: every telemetry column is projected, in the clone schema and in the production migration", async () => {
  const { readFileSync } = await import("node:fs");
  const { T10_EXECUTABLE_TELEMETRY_KEYS } = await import("../../lib/executor/reservationMarketBaseline");
  const projection = SPECS.find((entry) => entry.table === "reservation_market_observations")?.projection ?? "";
  const cloneSql = readFileSync("ops/research-clone/reservation-telemetry-schema.sql", "utf8");
  const migration = readFileSync("supabase/migrations/20261005090000_t10_executable_sibling_telemetry_v1.sql", "utf8");
  for (const column of T10_EXECUTABLE_TELEMETRY_KEYS) assert.match(projection, new RegExp(`(^|,)${column}(,|$)`), `projection: ${column}`);
  for (const column of T10_NEW_TELEMETRY_COLUMNS) {
    assert.ok((T10_EXECUTABLE_TELEMETRY_KEYS as readonly string[]).includes(column), `writer key: ${column}`);
    assert.match(cloneSql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `), `clone schema: ${column}`);
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} `), `production migration: ${column}`);
  }
  assert.equal(new Set(projection.split(",")).size, projection.split(",").length, "no duplicated projected column");
});

test("T10_EXECUTABLE_SIBLING_TELEMETRY_V1: purge never confirms a telemetered production row whose clone copy lacks telemetry", async () => {
  const { executableTelemetryParityConfirmedIds } = await import("../../scripts/research-clone-daily-sync");
  const confirmed = executableTelemetryParityConfirmedIds(
    [
      { id: "a", executable_telemetry_version: "T10_EXECUTABLE_SIBLING_TELEMETRY_V1" },
      { id: "b", executable_telemetry_version: null },
      { id: "c", executable_telemetry_version: null },
    ],
    new Set(["a", "b"]),
  );
  assert.deepEqual(confirmed, ["a", "c"], "b is telemetered in production but not in the clone -> stays unconfirmed; c has no telemetry anywhere");
});

// Minimal PostgREST-like builder over an in-memory table: select/lte/eq/gt/order/limit, awaitable.
function fakeSource(rows: Array<{ id: string; snapshot_at: string }>, selects: string[] = []) {
  return {
    from(_table: string) {
      const filters: Array<(row: { id: string; snapshot_at: string }) => boolean> = [];
      const orders: string[] = [];
      let max = Infinity;
      const builder: any = {
        select(columns: string) { selects.push(columns); return builder; },
        lte(column: string, value: string) { filters.push((row) => (row as any)[column] <= value); return builder; },
        eq(column: string, value: string) { filters.push((row) => (row as any)[column] === value); return builder; },
        gt(column: string, value: string) { filters.push((row) => (row as any)[column] > value); return builder; },
        order(column: string) { orders.push(column); return builder; },
        limit(n: number) { max = n; return builder; },
        then(resolve: (value: unknown) => unknown) {
          const data = rows.filter((row) => filters.every((f) => f(row)))
            .sort((a: any, b: any) => { for (const c of orders) { if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1; } return 0; })
            .slice(0, max);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

test("GSRS stale page crosses the timestamp boundary when the same-timestamp remainder is short", async () => {
  const { fetchStaleTelemetryPage } = await import("../../scripts/research-clone-daily-sync");
  const pad = (n: number) => String(n).padStart(4, "0");
  const tsA = "2026-09-01T00:00:00.000Z";
  const tsB = "2026-09-02T00:00:00.000Z";
  const rows = [
    ...Array.from({ length: 242 }, (_, i) => ({ id: `a${pad(i)}`, snapshot_at: tsA })),
    ...Array.from({ length: 300 }, (_, i) => ({ id: `b${pad(i)}`, snapshot_at: tsB })),
  ];
  const selects: string[] = [];
  const cutoff = "2026-10-01T00:00:00.000Z";
  // Cursor leaves a 42-row remainder inside timestamp A.
  const page = await fetchStaleTelemetryPage(fakeSource(rows, selects), "generated_signal_research_snapshots", cutoff, { timestamp: tsA, id: `a${pad(199)}` }, 200);
  assert.equal(page.length, 200);
  assert.equal(page.filter((row) => row.timestamp === tsA).length, 42);
  assert.equal(page.filter((row) => row.timestamp === tsB).length, 158);
  assert.deepEqual(page, [...page].sort((x, y) => (x.timestamp === y.timestamp ? (x.id < y.id ? -1 : 1) : x.timestamp < y.timestamp ? -1 : 1)));
  assert.equal(page[0].id, `a${pad(200)}`);
  assert.equal(page[199].id, `b${pad(157)}`);
  assert.ok(selects.every((columns) => columns === "id,snapshot_at"), "projection stays id,snapshot_at");
  // A full same-timestamp remainder returns without a second read; no cursor reads from the start.
  const full = await fetchStaleTelemetryPage(fakeSource(rows), "generated_signal_research_snapshots", cutoff, { timestamp: tsA, id: `a${pad(10)}` }, 200);
  assert.equal(full.length, 200);
  assert.ok(full.every((row) => row.timestamp === tsA));
  const first = await fetchStaleTelemetryPage(fakeSource(rows), "generated_signal_research_snapshots", cutoff, null, 200);
  assert.equal(first.length, 200);
  // Genuine end of backlog still returns a short page.
  const tail = await fetchStaleTelemetryPage(fakeSource(rows), "generated_signal_research_snapshots", cutoff, { timestamp: tsB, id: `b${pad(280)}` }, 200);
  assert.equal(tail.length, 19);
  // Fresh rows (after cutoff) are never returned.
  const fresh = await fetchStaleTelemetryPage(fakeSource([{ id: "z", snapshot_at: "2026-10-05T00:00:00.000Z" }]), "generated_signal_research_snapshots", cutoff, null, 200);
  assert.equal(fresh.length, 0);
});

test("GSRS backlog larger than 1600 consumes the full 8 x 200 budget in one run across timestamp ties", async () => {
  const { fetchStaleTelemetryPage } = await import("../../scripts/research-clone-daily-sync");
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const pad = (n: number) => String(n).padStart(5, "0");
  // 3000 stale rows in timestamp groups of 137 (never aligned with the 200-row page), plus fresh rows.
  const table: Array<{ id: string; snapshot_at: string }> = Array.from({ length: 3000 }, (_, i) => ({
    id: `r${pad(i)}`, snapshot_at: new Date(Date.parse("2026-09-01T00:00:00.000Z") + Math.floor(i / 137) * 60_000).toISOString(),
  }));
  const fresh = Array.from({ length: 50 }, (_, i) => ({ id: `f${pad(i)}`, snapshot_at: "2026-10-07T00:00:00.000Z" }));
  const all = [...table, ...fresh];
  const state = { rows: all.slice() };
  let cursor: TelemetryPurgeCursor | null = { timestamp: table[60].snapshot_at, id: table[60].id }; // starts mid-tie
  const confirmAll = async (_t: string, ids: readonly string[]) => [...ids];
  const makePort = (confirm: (t: string, ids: readonly string[]) => Promise<readonly string[]>) => ({
    async readCursor() { return cursor; },
    async fetchStalePage(t: string, cutoff: string, after: TelemetryPurgeCursor | null, limit: number) {
      return fetchStaleTelemetryPage(fakeSource(state.rows), t as PurgeTable, cutoff, after, limit);
    },
    exactCloneIds: confirm,
    async withoutProductionChildren(_t: string, ids: readonly string[]) { return [...ids]; },
    async deleteProductionIds(_t: string, ids: readonly string[]) { state.rows = state.rows.filter((row) => !ids.includes(row.id)); },
    async writeCursor(_t: string, next: TelemetryPurgeCursor | null) { cursor = next; },
  });
  const options = { tables: ["generated_signal_research_snapshots"] as const, retentionDays: 7 };
  const result = await purgeConfirmedTelemetry(now, makePort(confirmAll), 200, 8, options);
  const r = result.generated_signal_research_snapshots;
  assert.equal(r.eligible_stale_n, 1600);
  assert.equal(r.confirmed_in_clone_n, 1600);
  assert.equal(r.deleted_n, 1600);
  assert.equal(r.purge_pending, true);
  assert.equal(state.rows.length, all.length - 1600);
  assert.equal(state.rows.filter((row) => row.id.startsWith("f")).length, 50, "fresh rows never delete");
  // Rows before the starting cursor were never in scope; none of them was deleted.
  assert.equal(state.rows.filter((row) => row.id <= table[60].id && row.id.startsWith("r")).length, 61);
  // Unconfirmed IDs never delete even when the page is full.
  const before = state.rows.length;
  const none = await purgeConfirmedTelemetry(now, makePort(async () => []), 200, 8, options);
  assert.equal(none.generated_signal_research_snapshots.deleted_n, 0);
  assert.equal(state.rows.length, before);
});
