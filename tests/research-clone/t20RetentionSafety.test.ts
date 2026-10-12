import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentParityConfirmedIds, SPECS } from "../../scripts/research-clone-daily-sync";
import { purgeConfirmedTelemetry, type PurgeTable, type TelemetryPurgeCursor, type TelemetryPurgeRow } from "../../lib/research-clone/dailySync";
import { MAX_RESEARCH_EVENTS_PER_DAY, MAX_RESEARCH_TOKEN_ROWS_PER_EVENT, PRODUCTION_RETENTION_DAYS } from "../../lib/executor/precontractT20Research";
import { PRODUCTION_RETENTION_HOURS } from "../../lib/research/inplayCorePath";

const T20 = "research_precontract_t20_observations" as const;
const INPLAY = "research_inplay_core_path_observations" as const;
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const script = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");

type Row = { id: string; observed_at: string; provider_start_source: string | null };

/** Same wiring as the sync script: stale page from Production, content-confirmed against the clone, then delete. */
function fakePorts(production: Row[], clone: Row[], opts: { cloneDown?: boolean } = {}) {
  const deleted: string[] = [];
  const cursor: { value: TelemetryPurgeCursor | null } = { value: null };
  const port = {
    async readCursor() { return cursor.value; },
    async fetchStalePage(_t: PurgeTable, cutoff: string, after: TelemetryPurgeCursor | null, limit: number): Promise<TelemetryPurgeRow[]> {
      return production.filter((r) => r.observed_at <= cutoff && (!after || r.observed_at > after.timestamp || (r.observed_at === after.timestamp && r.id > after.id)))
        .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id)).slice(0, limit).map((r) => ({ id: r.id, timestamp: r.observed_at }));
    },
    async exactCloneIds(_t: PurgeTable, ids: readonly string[]) {
      if (opts.cloneDown) throw new Error("TELEMETRY_PURGE_CLONE_CONFIRM_x:ECONNREFUSED");
      return contentParityConfirmedIds(clone.filter((r) => ids.includes(r.id)), production.filter((r) => ids.includes(r.id)));
    },
    async withoutProductionChildren(_t: PurgeTable, ids: readonly string[]) { return [...ids]; },
    async deleteProductionIds(_t: PurgeTable, ids: readonly string[]) { deleted.push(...ids); },
    async writeCursor(_t: PurgeTable, c: TelemetryPurgeCursor | null) { cursor.value = c; },
  };
  return { port, deleted };
}

test("content parity: identical rows confirm; missing, NULL-vs-populated and changed rows do not; key order is irrelevant", () => {
  const prod = [
    { id: "a", observed_at: "t", provider_start_source: "GAMMA" },
    { id: "b", observed_at: "t", provider_start_source: "GAMMA" },
    { id: "c", observed_at: "t", provider_start_source: "GAMMA" },
    { id: "d", observed_at: "t", provider_start_source: "GAMMA" },
  ];
  const clone = [
    { provider_start_source: "GAMMA", observed_at: "t", id: "a" },            // identical, different key order
    { id: "b", observed_at: "t", provider_start_source: null },               // copied before the column joined the projection
    { id: "c", observed_at: "t", provider_start_source: "OTHER" },            // changed
    // "d" absent from the clone
    { id: "z", observed_at: "t", provider_start_source: "GAMMA" },            // clone-only row: no Production counterpart
  ];
  assert.deepEqual(contentParityConfirmedIds(clone, prod), ["a"]);
  assert.deepEqual(contentParityConfirmedIds([], prod), []);
});

test("T20 seven-day purge deletes only rows older than 7 days that are identical in DBClone", async () => {
  const production: Row[] = [
    { id: "old-ok", observed_at: iso(8 * DAY), provider_start_source: "GAMMA" },
    { id: "old-missing-in-clone", observed_at: iso(8 * DAY + 1000), provider_start_source: null },
    { id: "old-clone-stale", observed_at: iso(8 * DAY + 2000), provider_start_source: "GAMMA" },
    { id: "six-days", observed_at: iso(6 * DAY), provider_start_source: null },
    { id: "unsynced-current", observed_at: iso(60_000), provider_start_source: null },
  ];
  const clone: Row[] = [
    { ...production[0] },
    { ...production[2], provider_start_source: null },
    { ...production[3] },
  ];
  const { port, deleted } = fakePorts(production, clone);
  const out = await purgeConfirmedTelemetry(NOW, port, 200, 8, { tables: [T20], retentionDays: 7 });
  assert.deepEqual(deleted, ["old-ok"]);
  assert.deepEqual([out[T20].eligible_stale_n, out[T20].confirmed_in_clone_n, out[T20].deleted_n, out[T20].not_confirmed_n, out[T20].purge_pending], [3, 1, 1, 2, true]);
});

test("T20 purge fails closed on a clone outage: nothing is deleted and the error propagates", async () => {
  const production: Row[] = [{ id: "old", observed_at: iso(9 * DAY), provider_start_source: null }];
  const { port, deleted } = fakePorts(production, [{ ...production[0] }], { cloneDown: true });
  await assert.rejects(purgeConfirmedTelemetry(NOW, port, 200, 8, { tables: [T20], retentionDays: 7 }), /ECONNREFUSED/);
  assert.deepEqual(deleted, []);
});

test("T20 purge is bounded per run: at most 200 rows per page and 8 pages", async () => {
  const production: Row[] = Array.from({ length: 2000 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, observed_at: iso(10 * DAY - i * 1000), provider_start_source: null }));
  const { port, deleted } = fakePorts(production, production.map((r) => ({ ...r })));
  const out = await purgeConfirmedTelemetry(NOW, port, 200, 8, { tables: [T20], retentionDays: 7 });
  assert.equal(deleted.length, 1600);
  assert.equal(out[T20].purge_pending, true);
  await assert.rejects(purgeConfirmedTelemetry(NOW, port, 201, 8, { tables: [T20], retentionDays: 7 }), /TELEMETRY_PURGE_BUDGET_INVALID/);
});

test("capacity: one hourly run purges more than the maximum T20 daily row volume, so retention cannot fall behind", () => {
  const maxDailyRows = MAX_RESEARCH_EVENTS_PER_DAY * MAX_RESEARCH_TOKEN_ROWS_PER_EVENT;
  assert.match(script, /TELEMETRY_PAGE_SIZE = 200;/);
  assert.match(script, /TELEMETRY_MAX_PAGES = 8;/);
  assert.ok(200 * 8 * 24 > maxDailyRows, `${200 * 8 * 24} purge capacity/day vs ${maxDailyRows} max rows/day`);
});

test("wiring: T20 and in-play confirm by full projected content; delete is age-guarded; retention targets unchanged", () => {
  assert.equal(PRODUCTION_RETENTION_DAYS, 7);
  assert.equal(PRODUCTION_RETENTION_HOURS, 48);
  assert.match(script, /CONTENT_PARITY_PURGE_TABLES: readonly PurgeTable\[\] = \["research_precontract_t20_observations", "research_inplay_core_path_observations"\]/);
  assert.match(script, /\? \{ tables: \["research_precontract_t20_observations"\], retentionDays: 7 \}/);
  assert.match(script, /table === "research_precontract_t20_observations"\s*\? deletion\.lte\("observed_at", new Date\(nowMs - 7 \* 24 \* 60 \* 60 \* 1000\)\.toISOString\(\)\)/);
  for (const table of [T20, INPLAY]) assert.ok(SPECS.find((s) => s.table === table)?.projection, `${table} has a projection to compare`);
  // the full path purges T20 only when its clone table exists
  assert.match(script, /const t20Purge = !schemaPendingTables\.includes\("research_precontract_t20_observations"\)/);
});

test("the T20 collector has no delete capability of its own", () => {
  const collector = readFileSync("lib/executor/precontractT20Research.ts", "utf8");
  assert.doesNotMatch(collector, /\.from\([^)]*\)\s*\.delete\(|purgeExpired|RETENTION_DELETE_BATCH/);
});
