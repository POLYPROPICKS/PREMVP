import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function readRunner(name: string): string {
  return readFileSync(path.join(ROOT, "scripts/modeling/strategies", name), "utf8");
}

const roi = readRunner("run-3e2-roi-from-supabase.cmd");
const dedup = readRunner("run-3d2o-from-supabase.cmd");

test("1. run-3e2-roi-from-supabase.cmd checks exporter errorlevel before running ROI comparison", () => {
  const exporterIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const errorlevelIdx = roi.indexOf("if errorlevel 1", exporterIdx);
  assert.ok(exporterIdx >= 0, "expected exporter invocation in run-3e2-roi-from-supabase.cmd");
  assert.ok(comparisonIdx > exporterIdx, "expected comparison after exporter");
  assert.ok(
    errorlevelIdx >= 0 && errorlevelIdx < comparisonIdx,
    "expected an errorlevel check between exporter and comparison",
  );
});

test("2. run-3e2-roi-from-supabase.cmd verifies generated_signal_pairs_export.json exists before comparison", () => {
  // EXPORT_FILE is set to generated_signal_pairs_export.json, and the
  // fail-fast block checks %EXPORT_FILE% (not the literal path a second
  // time) before the comparison runs.
  assert.match(roi, /set "EXPORT_FILE=modeling\\local_exports\\generated_signal_pairs_export\.json"/);
  const exporterIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const checkBlock = roi.slice(exporterIdx, comparisonIdx);
  assert.match(checkBlock, /if not exist "%EXPORT_FILE%"/);
});

test("3. run-3e2-roi-from-supabase.cmd verifies generated_signal_pairs_export_summary.json exists before comparison", () => {
  assert.match(
    roi,
    /set "SUMMARY_FILE=modeling\\local_exports\\generated_signal_pairs_export_summary\.json"/,
  );
  const exporterIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const checkBlock = roi.slice(exporterIdx, comparisonIdx);
  assert.match(checkBlock, /if not exist "%SUMMARY_FILE%"/);
});

test("4. run-3e2-roi-from-supabase.cmd does not run comparison immediately after exporter without a fail-fast block", () => {
  const exporterLineIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const exporterLineEnd = roi.indexOf("\n", exporterLineIdx);
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const between = roi.slice(exporterLineEnd, comparisonIdx);
  // There must be meaningful gating logic (errorlevel + file existence
  // checks) between the exporter call and the comparison call, not just a
  // couple of echo lines.
  assert.match(between, /errorlevel/);
  assert.match(between, /if not exist/);
});

test("5. run-3d2o-from-supabase.cmd checks exporter errorlevel before running dedup comparison", () => {
  const exporterIdx = dedup.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = dedup.indexOf("run-readonly-comparison.ts");
  const errorlevelIdx = dedup.indexOf("if errorlevel 1", exporterIdx);
  assert.ok(exporterIdx >= 0);
  assert.ok(comparisonIdx > exporterIdx);
  assert.ok(errorlevelIdx >= 0 && errorlevelIdx < comparisonIdx);
});

test("6. run-3d2o-from-supabase.cmd verifies generated_signal_pairs_export.json exists before comparison", () => {
  assert.match(dedup, /set "EXPORT_FILE=modeling\\local_exports\\generated_signal_pairs_export\.json"/);
  const exporterIdx = dedup.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = dedup.indexOf("run-readonly-comparison.ts");
  const checkBlock = dedup.slice(exporterIdx, comparisonIdx);
  assert.match(checkBlock, /if not exist "%EXPORT_FILE%"/);
});

test("7. neither runner uses clipboard", () => {
  assert.doesNotMatch(roi, /Get-Clipboard/i);
  assert.doesNotMatch(dedup, /Get-Clipboard/i);
  assert.doesNotMatch(roi, /clipboard_raw/i);
  assert.doesNotMatch(dedup, /clipboard_raw/i);
});

test("8. neither runner passes --limit or --max-rows in the default path", () => {
  assert.doesNotMatch(roi, /--limit/);
  assert.doesNotMatch(roi, /--max-rows/);
  assert.doesNotMatch(dedup, /--limit/);
  assert.doesNotMatch(dedup, /--max-rows/);
});

test("9. both runners still use --page-size 1000", () => {
  assert.match(roi, /--page-size 1000/);
  assert.match(dedup, /--page-size 1000/);
});

test("10. run-3e2-roi-from-supabase.cmd clears any stale old ROI report before running comparison", () => {
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const before = roi.slice(0, comparisonIdx);
  assert.match(before, /del \/q/);
  assert.match(before, /3e2_roi_report\.json/);
});

test("11. run-3d2o-from-supabase.cmd clears any stale old dedup report before running comparison", () => {
  const comparisonIdx = dedup.indexOf("run-readonly-comparison.ts");
  const before = dedup.slice(0, comparisonIdx);
  assert.match(before, /del \/q/);
  assert.match(before, /3d2o_dedup_report\.json/);
});

test("12. both runners end with pause", () => {
  assert.match(roi.trim(), /pause\s*$/m);
  assert.match(dedup.trim(), /pause\s*$/m);
});
