import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildR0PlanningTrace,
  validateR0PlanningTrace,
} from "../../lib/executor/r0PlanningTrace";
import {
  buildR0D0Aggregate,
  renderR0D0Html,
  renderR0D0Markdown,
  writeR0D0Report,
} from "../../scripts/contur3/r0-d0-report";

function measuredTrace() {
  return buildR0PlanningTrace({
    runId: "r0-d0-test",
    asOfIso: "2026-07-23T14:00:00.000Z",
    raw: {
      total_db_rows: 5,
      raw_allowed_fullmatch_rows: 4,
      raw_forbidden_rows: 1,
      fullmatch_admitted_count: 3,
      fullmatch_rejected_by_reason: { LOW_SCORE: 1 },
    },
    plan: {
      universe_size: 3,
      event_groups: 2,
      reserved_count: 1,
      skipped_outside_horizon: 1,
      skipped_non_tier1_event: 0,
      skipped_no_executable_anchor: 0,
      fallbackEligibleGroupsSeen: 0,
      fallbackSlotFillReservedCount: 0,
    },
    reservationsCreated: null,
  });
}

test("D0 Markdown and HTML share one deterministic aggregate and exactly one next action", () => {
  const trace = measuredTrace();
  const validation = validateR0PlanningTrace(trace);
  const aggregate = buildR0D0Aggregate({
    trace,
    validation,
    verificationGate: {
      run_id: trace.run_id,
      git_sha: "0fcbd0c",
      tests: "PASS",
      typecheck: "PASS",
      build: "PASS",
      gate_decision: "LOCAL_PASS_LIVE_BLOCKED",
    },
    generatedAtIso: "2026-07-23T14:01:00.000Z",
    freshness: "FRESH",
    finalContractARejections: { SCORE_BELOW_65: 1 },
    moneyAtRiskUsd: 0,
    nextAllowedAction: "RUN_DB_BACKED_READ_ONLY_PREVIEW_ON_RAILWAY",
  });
  const markdown = renderR0D0Markdown(aggregate);
  const html = renderR0D0Html(aggregate);

  assert.match(markdown, new RegExp(`aggregate_sha256: ${aggregate.aggregate_sha256}`));
  assert.match(html, new RegExp(aggregate.aggregate_sha256));
  assert.match(markdown, /first_failing_stage: reservations_created/);
  assert.match(html, /reservations_created/);
  assert.equal((markdown.match(/next_allowed_action:/g) ?? []).length, 1);
  assert.equal((html.match(/next_allowed_action:/g) ?? []).length, 1);
  assert.match(markdown, /SCORE_BELOW_65/);
  assert.match(html, /SCORE_BELOW_65/);
});

test("D0 marks stale input and surfaces validation contradictions without inventing measurements", () => {
  const trace = measuredTrace();
  const validation = validateR0PlanningTrace(trace, {
    OPPORTUNITY_DENOMINATOR_DEFINED: "PASS",
  });
  const aggregate = buildR0D0Aggregate({
    trace,
    validation,
    verificationGate: {
      run_id: trace.run_id,
      git_sha: "0fcbd0c",
      tests: "PASS",
      typecheck: "PASS",
      build: "PASS",
      gate_decision: "FAIL",
    },
    generatedAtIso: "2026-07-23T18:00:00.000Z",
    freshness: "STALE",
    finalContractARejections: {},
    moneyAtRiskUsd: 0,
    nextAllowedAction: "REGENERATE_TRACE",
  });
  assert.equal(aggregate.freshness, "STALE");
  assert.equal(aggregate.status, "RED");
  assert.ok(aggregate.validation_failures.includes("GATE_TRACE_CONTRADICTION"));
  assert.equal(aggregate.funnel.at(-1)?.output_count, null);
});

test("D0 writer reports the SHA-256 of exact file bytes", () => {
  const trace = measuredTrace();
  const aggregate = buildR0D0Aggregate({
    trace,
    validation: validateR0PlanningTrace(trace),
    verificationGate: {
      run_id: trace.run_id,
      git_sha: "0fcbd0c",
      tests: "PASS",
      typecheck: "PASS",
      build: "PASS",
      gate_decision: "LOCAL_PASS_LIVE_BLOCKED",
    },
    generatedAtIso: "2026-07-23T14:01:00.000Z",
    freshness: "FRESH",
    finalContractARejections: { SCORE_BELOW_65: 1 },
    moneyAtRiskUsd: 0,
    nextAllowedAction: "VERIFY_CRON",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "r0-d0-"));
  try {
    const written = writeR0D0Report(aggregate, dir);
    const fileHash = (filePath: string) =>
      createHash("sha256").update(readFileSync(filePath)).digest("hex");
    assert.equal(written.markdown_sha256, fileHash(written.markdown_path));
    assert.equal(written.html_sha256, fileHash(written.html_path));
    assert.equal(written.json_sha256, fileHash(written.json_path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
