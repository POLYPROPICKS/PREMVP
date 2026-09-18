// PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 — false MODEL_READY repair coverage.
//
// A zero-row day must never be recorded as complete just because the source was
// broken. Before this repair, writeDayRows unconditionally wrote
// `MODEL_READY, row_n = 0`, and resolveMissingRecentDates then treated that day
// as accepted and never revisited it — turning a recoverable gap into
// falsified history.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTED_DAY_STATUSES,
  UNPROVEN_ZERO_DAY_CODE,
  writeDayRows,
} from "../../scripts/modeling/materialize-research-model-ready";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

const D = "2026-09-14";

function recordingClient() {
  const writes: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
          writes.push({ table, rows: Array.isArray(rows) ? rows : [rows], onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as never, writes };
}

test("missing/unverified source cannot become MODEL_READY row_n=0", async () => {
  const { client, writes } = recordingClient();
  await assert.rejects(
    () => writeDayRows(client, D, [], { kind: "SOURCE_UNVERIFIED" }),
    /MATERIALIZE_SOURCE_UNVERIFIED_REFUSING_ZERO_DAY:2026-09-14/,
  );
  assert.equal(writes.length, 0, "nothing at all is written for an unproven zero day");
});

test("the unverified refusal is the default — an omitted proof is never permissive", async () => {
  const { client, writes } = recordingClient();
  await assert.rejects(() => writeDayRows(client, D, []), /REFUSING_ZERO_DAY/);
  assert.equal(writes.length, 0);
});

test("a genuinely, authoritatively empty source day remains representable as SOURCE_EMPTY", async () => {
  const { client, writes } = recordingClient();
  await writeDayRows(client, D, [], { kind: "SOURCE_PROVEN", sourceEnvelopeN: 0, sourceEvidenceRowN: 0 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, "research_model_ready_days");
  assert.equal(writes[0].rows[0].status, "SOURCE_EMPTY");
  assert.equal(writes[0].rows[0].row_n, 0);
  assert.notEqual(writes[0].rows[0].status, "MODEL_READY", "an empty day is never mislabelled MODEL_READY");
});

test("a non-empty source that materialized nothing is a loud failure, not an empty day", async () => {
  const { client, writes } = recordingClient();
  await assert.rejects(
    () => writeDayRows(client, D, [], { kind: "SOURCE_PROVEN", sourceEnvelopeN: 179, sourceEvidenceRowN: 26_515 }),
    /MATERIALIZE_SOURCE_NONEMPTY_BUT_ZERO_ROWS:2026-09-14/,
  );
  assert.equal(writes.length, 0);
});

test("a real day still writes MODEL_READY on the exact economic-identity conflict key", async () => {
  const { client, writes } = recordingClient();
  const rows = [
    {
      populationId: "p1",
      conditionId: "c1",
      selectedTokenId: "t1",
      decisionAt: "2026-09-14T01:00:00.000Z",
      labelAsOf: "WIN",
    },
  ] as unknown as ScorecardReadyRow[];

  await writeDayRows(client, D, rows, { kind: "SOURCE_PROVEN", sourceEnvelopeN: 179, sourceEvidenceRowN: 26_515 });

  const rowWrite = writes.find((w) => w.table === "research_model_ready_rows");
  const dayWrite = writes.find((w) => w.table === "research_model_ready_days");
  assert.ok(rowWrite, "rows are written");
  assert.equal(
    rowWrite!.onConflict,
    "model_date,population_id,condition_id,selected_token_id,decision_at",
    "replay of a real day upserts the same identity, never duplicating it",
  );
  assert.equal(dayWrite!.rows[0].status, "MODEL_READY");
  assert.equal(dayWrite!.rows[0].row_n, 1);
});

test("SOURCE_EMPTY counts as settled so the cron does not re-materialize a proven-empty day", () => {
  assert.deepEqual([...ACCEPTED_DAY_STATUSES], ["MODEL_READY", "DEGRADED_EXCLUDED", "SOURCE_EMPTY"]);
});

// The main() loop survives exactly one error class by matching this prefix. If the
// thrown message ever stopped starting with it, that catch would silently widen into
// swallowing real write failures — so the coupling is asserted, not assumed.
test("the survivable refusal is tagged with UNPROVEN_ZERO_DAY_CODE", async () => {
  const { client } = recordingClient();
  await assert.rejects(
    () => writeDayRows(client, D, [], { kind: "SOURCE_UNVERIFIED" }),
    (e: unknown) => e instanceof Error && e.message.startsWith(UNPROVEN_ZERO_DAY_CODE),
  );
  assert.equal(UNPROVEN_ZERO_DAY_CODE, "MATERIALIZE_SOURCE_UNVERIFIED_REFUSING_ZERO_DAY");
});
