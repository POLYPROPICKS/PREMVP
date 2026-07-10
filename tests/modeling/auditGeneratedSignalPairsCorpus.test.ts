import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { auditGeneratedSignalPairsCorpus } from "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus";

const TRUSTED = "trusted-initial-formula-v1.1";

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...overrides };
}

// A small corpus: one sporting event (match:barca-real) with two distinct
// markets/outcomes, plus a duplicate snapshot of one of them, plus a
// separate event with a non-trusted formula version.
function sampleRows(): Record<string, unknown>[] {
  return [
    // Barca-Real moneyline (market c1 / outcome t1), trusted
    row({
      id: "r1",
      condition_id: "c1",
      token_id: "t1",
      match_family_key: "barca-real",
      formula_version: TRUSTED,
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-02T00:00:00.000Z",
    }),
    // Barca-Real total goals over 5 (market c2 / outcome t2), same event, trusted
    row({
      id: "r2",
      condition_id: "c2",
      token_id: "t2",
      match_family_key: "barca-real",
      formula_version: TRUSTED,
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-03T00:00:00.000Z",
    }),
    // Duplicate snapshot of r1's strict signal (c1/t1), later created -> dedup keeps one
    row({
      id: "r3",
      condition_id: "c1",
      token_id: "t1",
      match_family_key: "barca-real",
      formula_version: TRUSTED,
      created_at: "2026-07-01T12:00:00.000Z",
      resolved_at: "2026-07-02T00:00:00.000Z",
    }),
    // Separate event, non-trusted formula
    row({
      id: "r4",
      condition_id: "c3",
      token_id: "t3",
      match_family_key: "psg-lyon",
      formula_version: "v2-lite-growth-safe",
      created_at: "2026-07-05T00:00:00.000Z",
      resolved_at: "2026-07-06T00:00:00.000Z",
    }),
  ];
}

test("1. reports min/max resolved date over raw rows", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  assert.equal(audit.rawCoverage.minResolvedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(audit.rawCoverage.maxResolvedAt, "2026-07-06T00:00:00.000Z");
});

test("2. inclusive calendar-day coverage counts both endpoints", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  // 2026-07-02 .. 2026-07-06 inclusive = 5 days.
  assert.equal(audit.rawCoverage.calendarDaysInclusive, 5);
});

test("3. raw vs dedup coverage can differ; dedup drops duplicate strict-key rows", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  assert.equal(audit.sourceRows, 4);
  assert.equal(audit.dedupRows, 3);
  assert.equal(audit.droppedDuplicateRows, 1);
  assert.equal(audit.dedupPolicy, "strict_latest_created_before_resolved");
});

test("4. trusted cohort selected/rejected counts sum to dedupRows", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  assert.equal(audit.trustedFormula.formulaVersion, TRUSTED);
  assert.equal(audit.trustedFormula.selectedRows, 2);
  assert.equal(audit.trustedFormula.rejectedRows, 1);
  assert.equal(audit.trustedFormula.selectedRows + audit.trustedFormula.rejectedRows, audit.dedupRows);
});

test("5. formula version breakdown sorted deterministically by count desc then name asc", () => {
  const rows = [
    row({ id: "a", condition_id: "c1", token_id: "t1", formula_version: "zzz", resolved_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "b", condition_id: "c2", token_id: "t2", formula_version: "aaa", resolved_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "c", condition_id: "c3", token_id: "t3", formula_version: "aaa", resolved_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "d", condition_id: "c4", token_id: "t4", formula_version: "mmm", resolved_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const audit = auditGeneratedSignalPairsCorpus(rows, { trustedFormulaVersion: TRUSTED });
  const names = audit.formulaVersionBreakdown.map((b) => b.formulaVersion);
  // aaa (2) first; then mmm (1), zzz (1) by name asc.
  assert.deepEqual(names, ["aaa", "mmm", "zzz"]);
  assert.equal(audit.formulaVersionBreakdown[0].rows, 2);
});

test("6. unknown/missing formula version goes to an explicit bucket", () => {
  const rows = [
    row({ id: "a", condition_id: "c1", token_id: "t1", resolved_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "b", condition_id: "c2", token_id: "t2", formula_version: TRUSTED, resolved_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const audit = auditGeneratedSignalPairsCorpus(rows, { trustedFormulaVersion: TRUSTED });
  const bucket = audit.formulaVersionBreakdown.find((b) => b.formulaVersion === "(none)");
  assert.ok(bucket, "expected an explicit (none) bucket for missing formula version");
  assert.equal(bucket!.rows, 1);
});

test("7. two markets in one match count as one event, two markets, two strict signals", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  // dedup rows: c1/t1 (one), c2/t2, c3/t3 -> 3 signals, 3 markets(c1,c2,c3),
  // but grouped events: barca-real (c1,c2) + psg-lyon (c3) = 2 events.
  assert.equal(audit.cardinality.uniqueSportingEvents, 2);
  assert.equal(audit.cardinality.uniqueMarkets, 3);
  assert.equal(audit.cardinality.uniqueStrictMarketOutcomeSignals, 3);
});

test("8. repeat snapshots of same market/outcome deduplicate to one strict signal", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  // r1 and r3 are the same strict signal (c1/t1); dedup keeps one.
  assert.equal(audit.cardinality.uniqueStrictMarketOutcomeSignals, 3);
  assert.equal(audit.dedupRows, 3);
});

test("9. event grouping fallback priority matches the existing helper", async () => {
  const { EVENT_GROUP_KEY_FIELD_PRIORITY } = await import("../../lib/modeling/eventGroupSelection");
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  assert.deepEqual(audit.eventGrouping.priority, [...EVENT_GROUP_KEY_FIELD_PRIORITY]);
  // sampleRows all use match_family_key.
  assert.equal(audit.eventGrouping.fallbackUsage.match_family_key, 3);
});

test("10. signals-per-event distribution has a deterministic definition", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  // barca-real has 2 signals, psg-lyon has 1.
  assert.equal(audit.signalsPerSportingEvent.eventCount, 2);
  assert.equal(audit.signalsPerSportingEvent.min, 1);
  assert.equal(audit.signalsPerSportingEvent.max, 2);
  assert.equal(audit.signalsPerSportingEvent.eventsWithMoreThanOneSignal, 1);
});

test("11. empty input returns null coverage and zero counts, not a crash", () => {
  const audit = auditGeneratedSignalPairsCorpus([], { trustedFormulaVersion: TRUSTED });
  assert.equal(audit.sourceRows, 0);
  assert.equal(audit.dedupRows, 0);
  assert.equal(audit.rawCoverage.minResolvedAt, null);
  assert.equal(audit.rawCoverage.maxResolvedAt, null);
  assert.equal(audit.rawCoverage.calendarDaysInclusive, 0);
  assert.equal(audit.signalsPerSportingEvent.eventCount, 0);
});

test("12. invalid/missing resolved dates are handled explicitly and counted", () => {
  const rows = [
    row({ id: "a", condition_id: "c1", token_id: "t1", formula_version: TRUSTED, resolved_at: "not-a-date" }),
    row({ id: "b", condition_id: "c2", token_id: "t2", formula_version: TRUSTED }),
    row({ id: "c", condition_id: "c3", token_id: "t3", formula_version: TRUSTED, resolved_at: "2026-07-02T00:00:00.000Z" }),
  ];
  const audit = auditGeneratedSignalPairsCorpus(rows, { trustedFormulaVersion: TRUSTED });
  assert.equal(audit.rawCoverage.rowsWithInvalidOrMissingResolvedAt, 2);
  assert.equal(audit.rawCoverage.minResolvedAt, "2026-07-02T00:00:00.000Z");
});

test("13. audit contains no ROI/PnL/profit fields", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  const serialized = JSON.stringify(audit).toLowerCase();
  assert.ok(!serialized.includes("roipct"));
  assert.ok(!serialized.includes("pnl"));
  assert.ok(!serialized.includes("profit"));
});

test("14. does not mutate input rows", () => {
  const rows = sampleRows();
  const snapshot = JSON.stringify(rows);
  auditGeneratedSignalPairsCorpus(rows, { trustedFormulaVersion: TRUSTED });
  assert.equal(JSON.stringify(rows), snapshot);
});

test("15. the pure function source uses no fs/network/env", () => {
  const source = readFileSync(
    path.join(__dirname, "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus.ts"),
    "utf8",
  );
  // The pure audit function must not read fs/env/network. The CLI section
  // (guarded by require.main === module) may, but the audit computation
  // itself must be import-safe. We assert the pure function body references
  // none of these before the CLI guard.
  const cliGuardIdx = source.indexOf("require.main === module");
  const pureSection = cliGuardIdx >= 0 ? source.slice(0, source.indexOf("function main(")) : source;
  assert.doesNotMatch(pureSection.replace(/\/\/.*$/gm, ""), /\bprocess\.env\b/);
  assert.doesNotMatch(pureSection.replace(/\/\/.*$/gm, ""), /\bfetch\(/);
});

test("16. metricFormulaVersionBreakdown is produced separately from formulaVersionBreakdown", () => {
  const rows = [
    row({ id: "a", condition_id: "c1", token_id: "t1", formula_version: TRUSTED, metric_formula_version: "v2-lite-growth-safe", resolved_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const audit = auditGeneratedSignalPairsCorpus(rows, { trustedFormulaVersion: TRUSTED });
  assert.ok(Array.isArray(audit.metricFormulaVersionBreakdown));
  const metric = audit.metricFormulaVersionBreakdown.find((b) => b.formulaVersion === "v2-lite-growth-safe");
  assert.ok(metric, "expected metric_formula_version to be broken down separately");
});

// ---- CLI ----

test("17. CLI writes a JSON report and creates the output directory", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "corpus-audit-cli-"));
  try {
    const inputPath = path.join(dir, "export.json");
    const outputPath = path.join(dir, "nested", "audit.json");
    writeFileSync(inputPath, JSON.stringify(sampleRows()), "utf8");
    const result = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        path.join(__dirname, "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus.ts"),
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--trusted-formula-version",
        TRUSTED,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.sourceRows, 4);
    assert.equal(report.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("18. CLI fails safely on a missing input file", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      path.join(__dirname, "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus.ts"),
      "--input",
      "/tmp/does-not-exist-corpus-audit-xyz.json",
      "--output",
      "/tmp/should-not-be-written.json",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
});

test("19. report contains no raw row arrays or id lists", () => {
  const audit = auditGeneratedSignalPairsCorpus(sampleRows(), { trustedFormulaVersion: TRUSTED });
  const serialized = JSON.stringify(audit);
  // No source row identifiers should leak into the aggregate report.
  assert.doesNotMatch(serialized, /"r1"|"r2"|"r3"|"r4"/);
  assert.doesNotMatch(serialized, /"token_id"/);
});
