// MISSION regression: runReservationCronWithEvidence's error path must write a
// schema-valid job_run.
//
// Before: the catch block in runReservationCronWithEvidence called
// jobEvidence.writeJobRun({ ..., errorMessage: ... }) WITHOUT a `diagnostics`
// key. lib/feed/cacheGeneratedSignals.ts writeJobRun inserts
// `diagnostics: input.diagnostics ?? null`, and job_runs.diagnostics is
// NOT NULL -- so the insert itself threw (SQLSTATE 23502), and
// createSupabaseSchedulerJobEvidencePort swallowed that secondary failure as
// non-fatal. Every failing Reservation run since 2026-08-27 was therefore
// forensically invisible: job_runs showed zero rows of ANY status.
//
// After: the error path always supplies a non-null `diagnostics` object
// carrying at minimum the sanitized failure message, and the original
// exception is still re-thrown unchanged.
//
// Run: node --import tsx --test tests/contur3/nightEventReservations.errorEvidenceDiagnostics.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { runReservationCronWithEvidence } from "../../lib/executor/nightEventReservations";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";

test("Reservation error path writes a schema-valid job_run with non-null diagnostics", async () => {
  const written: SchedulerJobRunInput[] = [];
  const fakeJobEvidence: SchedulerJobEvidencePort = {
    async writeJobRun(input) {
      written.push(input);
    },
  };

  const originalError = new Error(
    "planning_serving_scored_rows_fetch failed: canceling statement due to statement timeout",
  );

  await assert.rejects(
    () =>
      runReservationCronWithEvidence(
        Date.parse("2026-08-28T14:03:00.000Z"),
        { selectorMode: "CONTRACT_A_PLANNING_V1" },
        {
          jobEvidence: fakeJobEvidence,
          // buildContractAReservationPlan's fetchSourceRows seam -- forces the
          // exact production failure mode (serving statement timeout) without
          // touching any real DB.
          fetchSourceRows: async () => {
            throw originalError;
          },
        },
      ),
    (err: unknown) => {
      // Invariant 6: the original exception is preserved unchanged, not
      // replaced or wrapped by the evidence-writing fix.
      assert.strictEqual(err, originalError);
      return true;
    },
  );

  // Invariant 5: exactly one job_run was written, with status="error" and a
  // non-null diagnostics object schema-valid against job_runs.diagnostics NOT NULL.
  assert.equal(written.length, 1);
  const run = written[0];
  assert.equal(run.status, "error");
  assert.equal(run.generatedCount, 0);
  assert.equal(run.rejectedCount, 0);
  assert.ok(run.diagnostics !== null && run.diagnostics !== undefined, "diagnostics must be non-null");
  assert.equal(typeof run.diagnostics, "object");
  assert.equal(
    (run.diagnostics as Record<string, unknown>).error_message,
    originalError.message,
  );
  assert.equal(run.errorMessage, originalError.message);
});
