// MODEL_READY_SYNC_COMPLETENESS_GATE_V1 — the direct materializer must never
// write MODEL_READY unless a successful COMPLETE full clone sync finished after
// the newest requested Minsk model day closed. Pure helper tests + narrow wiring
// assertions; no live clone connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FULL_SYNC_COMPLETE_SOURCE,
  buildFullSyncCompleteRow,
  isFullSyncComplete,
  writeFullSyncCompleteMarker,
} from "../../scripts/research-clone-daily-sync";
import {
  MODEL_READY_FULL_SYNC_NOT_PROVEN,
  assertFullSyncProvenForModelReady,
  evaluateFullSyncProof,
  minskDayCloseUtcMs,
} from "../../scripts/modeling/materialize-research-model-ready";

const DAY = "2026-10-06";
const CLOSE = "2026-10-06T21:00:00.000Z";
const complete = (finished_at: string, over: Record<string, unknown> = {}) => ({
  status: "success",
  finished_at,
  diagnostics: { complete: true, pending_tables: [], schema_pending_tables: [], ...over },
});

test("Minsk day close is 21:00Z of the same UTC date", () => {
  assert.equal(new Date(minskDayCloseUtcMs(DAY)).toISOString(), CLOSE);
});

test("gate rejects a missing marker", () => {
  const v = evaluateFullSyncProof(null, DAY);
  assert.deepEqual(v, { ok: false, reason: "NO_FULL_SYNC_MARKER" });
});

test("gate rejects a marker finished before the model day closed (stale)", () => {
  const v = evaluateFullSyncProof(complete("2026-10-06T20:59:59.000Z"), DAY);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /^MARKER_BEFORE_MODEL_DAY_CLOSE/);
});

test("gate rejects pending / schema-pending / incomplete / non-success markers", () => {
  const after = "2026-10-07T02:10:00.000Z";
  assert.equal(evaluateFullSyncProof(complete(after, { pending_tables: ["signals"] }), DAY).ok, false);
  assert.equal(evaluateFullSyncProof(complete(after, { schema_pending_tables: ["primary_evidence_outbox"] }), DAY).ok, false);
  assert.equal(evaluateFullSyncProof(complete(after, { complete: false }), DAY).ok, false);
  assert.equal(evaluateFullSyncProof({ ...complete(after), status: "failed" }, DAY).ok, false);
});

test("gate accepts a successful complete marker finished at/after day close", () => {
  assert.deepEqual(evaluateFullSyncProof(complete("2026-10-07T02:10:00.000Z"), DAY), { ok: true });
  assert.deepEqual(evaluateFullSyncProof(complete(CLOSE), DAY), { ok: true });
});

test("freshness is relative to the NEWEST requested date", async () => {
  const marker = complete("2026-10-06T22:00:00.000Z"); // fine for 10-06, stale for 10-07
  const db = (row: unknown) =>
    ({
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order"]) q[m] = () => q;
        q.limit = async () => ({ data: row ? [row] : [], error: null });
        return q;
      },
    }) as never;
  await assertFullSyncProvenForModelReady(db(marker), ["2026-10-05", "2026-10-06"]);
  await assert.rejects(
    assertFullSyncProvenForModelReady(db(marker), ["2026-10-06", "2026-10-07"]),
    new RegExp(MODEL_READY_FULL_SYNC_NOT_PROVEN),
  );
  await assert.rejects(assertFullSyncProvenForModelReady(db(null), [DAY]), new RegExp(MODEL_READY_FULL_SYNC_NOT_PROVEN));
});

test("full sync writes the marker only when complete", async () => {
  const inserts: Record<string, unknown>[] = [];
  const target = { from: (t: string) => ({ insert: async (r: Record<string, unknown>) => (t === "job_runs" && inserts.push(r), { error: null }) }) };
  const t0 = Date.parse("2026-10-07T02:00:00Z");
  const t1 = Date.parse("2026-10-07T02:05:00Z");
  const ok = { pendingTables: [], schemaPendingTables: [], researchEvidencePending: false };
  for (const bad of [
    { ...ok, pendingTables: ["signals"] },
    { ...ok, schemaPendingTables: ["primary_evidence_outbox"] },
    { ...ok, researchEvidencePending: true },
  ]) {
    assert.equal(isFullSyncComplete(bad), false);
    assert.equal(await writeFullSyncCompleteMarker(target, bad, t0, t1), false);
  }
  assert.equal(inserts.length, 0);
  assert.equal(await writeFullSyncCompleteMarker(target, ok, t0, t1), true);
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], buildFullSyncCompleteRow(t0, t1));
  assert.equal(inserts[0].source, FULL_SYNC_COMPLETE_SOURCE);
  assert.equal(inserts[0].status, "success");
  assert.equal(inserts[0].finished_at, "2026-10-07T02:05:00.000Z");
  assert.deepEqual(inserts[0].diagnostics, { complete: true, pending_tables: [], schema_pending_tables: [] });
});

test("wiring: telemetry-only never writes the marker; full path writes it after purge/pending; direct gate precedes materialization", () => {
  const sync = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
  const start = sync.indexOf('process.argv.includes("--telemetry-only")');
  const end = sync.indexOf("return;\n    }", start);
  assert.ok(start > 0 && end > start);
  const telemetryBlock = sync.slice(start, end);
  assert.ok(!telemetryBlock.includes("writeFullSyncCompleteMarker"));
  assert.ok(!telemetryBlock.includes("FULL_SYNC_COMPLETE_SOURCE"));
  const call = sync.indexOf("await writeFullSyncCompleteMarker(");
  assert.ok(call > end, "marker call is in the full path");
  assert.ok(call > sync.indexOf("await purgeTelemetry(target, source, Date.now())", end));
  assert.ok(call > sync.indexOf("pendingTables.push(CLONE_EVIDENCE_TABLE)", end));
  assert.ok(call < sync.indexOf("if (pendingTables.length > 0) process.exitCode = 75"));

  const mat = readFileSync("scripts/modeling/materialize-research-model-ready.ts", "utf8");
  const main = mat.slice(mat.indexOf("async function main()"));
  const gate = main.indexOf("await assertFullSyncProvenForModelReady(db, dates)");
  assert.ok(gate > 0);
  assert.ok(gate < main.indexOf("await materializeDayRows("));
  assert.ok(gate < main.indexOf("await writeDayRows("));
});
