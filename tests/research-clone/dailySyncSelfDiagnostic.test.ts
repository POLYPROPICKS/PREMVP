// MAKE_RESEARCH_CLONE_SYNC_SELF_DIAGNOSTIC_V1 regression coverage.
//
// Proves each required diagnostic classification (SOURCE_UNREACHABLE,
// CLONE_UNREACHABLE, CLONE_OUTBOX_MISSING, CLONE_OUTBOX_REACHABLE,
// SYNC_READ_FAILURE, SYNC_WRITE_FAILURE) without any live credentials, and
// that no probe ever reads/logs evidence_rows, URLs, JWTs, or keys.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCausalErrorClass,
  probeCloneOutbox,
  probeCloneReachable,
  probeSourceReachable,
} from "../../scripts/research-clone-daily-sync";

test("classifyCausalErrorClass: config-shaped codes", () => {
  assert.equal(classifyCausalErrorClass("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH"), "CONFIG_FAILURE");
  assert.equal(classifyCausalErrorClass("MISSING_SUPABASE_URL"), "CONFIG_FAILURE");
  assert.equal(classifyCausalErrorClass("REQUIRED_CLONE_WRITE_AUTHORIZATION_UNAVAILABLE"), "CONFIG_FAILURE");
});

test("classifyCausalErrorClass: write-shaped codes", () => {
  assert.equal(classifyCausalErrorClass("RESEARCH_CLONE_TARGET_WRITE_primary_evidence_outbox:23505"), "SYNC_WRITE_FAILURE");
  assert.equal(classifyCausalErrorClass("RESEARCH_CLONE_CHECKPOINT_WRITE_generated_signal_pairs:PGRST000"), "SYNC_WRITE_FAILURE");
});

test("classifyCausalErrorClass: read-shaped codes", () => {
  for (const code of [
    "RESEARCH_CLONE_SOURCE_READ_generated_signal_pairs:57014",
    "RESEARCH_CLONE_MAX_WATERMARK_night_event_reservations:PGRST000",
    "RESEARCH_CLONE_TARGET_READ_primary_evidence_outbox:PGRST000",
    "RESEARCH_CLONE_CHECKPOINT_READ_generated_signal_pairs:PGRST000",
    "RESEARCH_CLONE_DUPLICATE_SOURCE_ID_primary_evidence_outbox",
    "RESEARCH_CLONE_APPEND_ONLY_CONFLICT_generated_signal_research_snapshots",
    "RESEARCH_CLONE_INITIAL_WATERMARK_REQUIRED_night_event_reservations",
    "RESEARCH_CLONE_QUEUE_PARENT_MISSING_FROM_SOURCE:reservation-absent",
  ]) {
    assert.equal(classifyCausalErrorClass(code), "SYNC_READ_FAILURE", code);
  }
});

test("classifyCausalErrorClass: unrecognized code falls back to OTHER_FAILURE, never silently misclassified", () => {
  assert.equal(classifyCausalErrorClass("SOMETHING_UNEXPECTED"), "OTHER_FAILURE");
});

/** Minimal chainable fake mirroring exactly the calls the probes issue. */
function makeFakeClient(opts: {
  table: string;
  rows?: Record<string, unknown>[];
  count?: number | null;
  error?: { code?: string; message: string } | null;
}) {
  const { table, rows = [], count = null, error = null } = opts;
  return {
    from(calledTable: string) {
      assert.equal(calledTable, table, `expected only table "${table}" to be queried, got "${calledTable}"`);
      const chain = {
        select(_cols: string, selectOpts?: { count?: string; head?: boolean }) {
          if (selectOpts?.head) {
            return Promise.resolve({ data: null, error, count });
          }
          return chain;
        },
        order() {
          return chain;
        },
        limit(n: number) {
          return Promise.resolve({ data: error ? null : rows.slice(0, n), error });
        },
      };
      return chain;
    },
  } as any;
}

test("probeSourceReachable: reachable on a clean limit(1) read against generated_signal_pairs", async () => {
  const client = makeFakeClient({ table: "generated_signal_pairs", rows: [{ id: "x" }] });
  const result = await probeSourceReachable(client);
  assert.equal(result.reachable, true);
  assert.equal(result.errorMessageSafe, null);
});

test("probeSourceReachable: unreachable surfaces a safe (non-secret) error message", async () => {
  const client = makeFakeClient({
    table: "generated_signal_pairs",
    error: { message: "fetch failed: ECONNREFUSED" },
  });
  const result = await probeSourceReachable(client);
  assert.equal(result.reachable, false);
  assert.ok(result.errorMessageSafe);
  assert.doesNotMatch(result.errorMessageSafe!, /apikey|service_role|Bearer|eyJ/i);
});

test("probeCloneReachable: reachable on a clean limit(1) read against job_runs", async () => {
  const client = makeFakeClient({ table: "job_runs", rows: [{ source: "x" }] });
  const result = await probeCloneReachable(client);
  assert.equal(result.reachable, true);
});

test("probeCloneReachable: unreachable classified with a safe message", async () => {
  const client = makeFakeClient({ table: "job_runs", error: { message: "AbortError: timeout" } });
  const result = await probeCloneReachable(client);
  assert.equal(result.reachable, false);
  assert.ok(result.errorMessageSafe);
});

test("probeCloneOutbox: CLONE_OUTBOX_MISSING when the clone-side table does not exist yet", async () => {
  const client = makeFakeClient({
    table: "primary_evidence_outbox",
    error: { code: "PGRST205", message: "Could not find the table 'public.primary_evidence_outbox'" },
  });
  const result = await probeCloneOutbox(client);
  assert.equal(result.tableExists, false);
  assert.equal(result.rowN, null);
  assert.equal(result.latestObservedAt, null);
  assert.equal(result.stage, "CLONE_OUTBOX_MISSING");
  assert.equal(result.errorMessageSafe, null, "a genuinely missing table is not reported as a causal error");
});

test("probeCloneOutbox: CLONE_OUTBOX_REACHABLE reports a bounded count and the latest observed_at only", async () => {
  const client = {
    from(table: string) {
      assert.equal(table, "primary_evidence_outbox");
      const chain = {
        select(_cols: string, selectOpts?: { count?: string; head?: boolean }) {
          if (selectOpts?.head) return Promise.resolve({ data: null, error: null, count: 464 });
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return Promise.resolve({ data: [{ observed_at: "2026-09-15T09:00:00.000Z" }], error: null });
        },
      };
      return chain;
    },
  } as any;
  const result = await probeCloneOutbox(client);
  assert.equal(result.tableExists, true);
  assert.equal(result.rowN, 464);
  assert.equal(result.latestObservedAt, "2026-09-15T09:00:00.000Z");
  assert.equal(result.stage, "CLONE_OUTBOX_REACHABLE");
});

test("probeCloneOutbox: table present but empty -> row_n 0, latest null, still reachable", async () => {
  const client = {
    from(table: string) {
      assert.equal(table, "primary_evidence_outbox");
      const chain = {
        select(_cols: string, selectOpts?: { count?: string; head?: boolean }) {
          if (selectOpts?.head) return Promise.resolve({ data: null, error: null, count: 0 });
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return Promise.resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  } as any;
  const result = await probeCloneOutbox(client);
  assert.equal(result.tableExists, true);
  assert.equal(result.rowN, 0);
  assert.equal(result.latestObservedAt, null);
  assert.equal(result.stage, "CLONE_OUTBOX_REACHABLE");
});

test("probeCloneOutbox: a non-missing-table error is classified, not silently swallowed as MISSING", async () => {
  const client = makeFakeClient({
    table: "primary_evidence_outbox",
    error: { message: "AbortError: timeout" },
  });
  const result = await probeCloneOutbox(client);
  assert.equal(result.tableExists, false);
  assert.notEqual(result.stage, "CLONE_OUTBOX_MISSING");
  assert.ok(result.errorMessageSafe);
});

test("no probe ever selects evidence_rows or any secret-shaped field", async () => {
  const selectedCols: string[] = [];
  const client = {
    from(_table: string) {
      const chain = {
        select(cols: string, selectOpts?: { head?: boolean }) {
          selectedCols.push(cols);
          if (selectOpts?.head) return Promise.resolve({ data: null, error: null, count: 1 });
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return Promise.resolve({ data: [{ observed_at: "2026-09-15T09:00:00.000Z" }], error: null });
        },
      };
      return chain;
    },
  } as any;
  await probeSourceReachable(client);
  await probeCloneReachable(client);
  await probeCloneOutbox(client);
  for (const cols of selectedCols) {
    assert.doesNotMatch(cols, /evidence_rows|service_role|apikey|Bearer/i);
  }
});
