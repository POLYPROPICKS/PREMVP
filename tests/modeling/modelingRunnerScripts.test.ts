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

// ---- Phase 3E.2e: truthful fail-fast (Patch D) ----

test("13. run-3e2-roi-from-supabase.cmd deletes stale export, summary, and sentinel artifacts before invoking the exporter", () => {
  const exporterIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const before = roi.slice(0, exporterIdx);
  assert.match(before, /del \/q[^\n]*%EXPORT_FILE%/);
  assert.match(before, /del \/q[^\n]*%SUMMARY_FILE%/);
  assert.match(before, /del \/q[^\n]*%SENTINEL_FILE%/);
});

test("14. run-3e2-roi-from-supabase.cmd passes --sentinel-output to the exporter", () => {
  const exporterLineEnd = roi.indexOf("\n", roi.indexOf("export-generated-signal-pairs-from-supabase.ts"));
  const exporterLine = roi.slice(roi.lastIndexOf("node", exporterLineEnd), exporterLineEnd);
  assert.match(exporterLine, /--sentinel-output "%SENTINEL_FILE%"/);
});

test("15. run-3e2-roi-from-supabase.cmd requires export, summary, and sentinel to all exist before running comparison, independent of errorlevel wording", () => {
  const exporterIdx = roi.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = roi.indexOf("run-readonly-comparison.ts");
  const checkBlock = roi.slice(exporterIdx, comparisonIdx);
  assert.match(checkBlock, /if not exist "%EXPORT_FILE%"/);
  assert.match(checkBlock, /if not exist "%SUMMARY_FILE%"/);
  assert.match(checkBlock, /if not exist "%SENTINEL_FILE%"/);
});

test("16. run-3e2-roi-from-supabase.cmd does not claim exporter reported success based only on errorlevel", () => {
  assert.doesNotMatch(roi, /exporter reported success/i);
});

test("17. run-3e2-roi-from-supabase.cmd reports an incomplete-artifact-set error, not a false-success message", () => {
  assert.match(roi, /did not produce a complete success artifact set/i);
});

test("18. run-3d2o-from-supabase.cmd deletes stale export and sentinel artifacts before invoking the exporter", () => {
  const exporterIdx = dedup.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const before = dedup.slice(0, exporterIdx);
  assert.match(before, /del \/q[^\n]*%EXPORT_FILE%/);
  assert.match(before, /del \/q[^\n]*%SENTINEL_FILE%/);
});

test("19. run-3d2o-from-supabase.cmd passes --sentinel-output to the exporter", () => {
  const exporterLineEnd = dedup.indexOf("\n", dedup.indexOf("export-generated-signal-pairs-from-supabase.ts"));
  const exporterLine = dedup.slice(dedup.lastIndexOf("node", exporterLineEnd), exporterLineEnd);
  assert.match(exporterLine, /--sentinel-output "%SENTINEL_FILE%"/);
});

test("20. run-3d2o-from-supabase.cmd requires export and sentinel to both exist before running comparison", () => {
  const exporterIdx = dedup.indexOf("export-generated-signal-pairs-from-supabase.ts");
  const comparisonIdx = dedup.indexOf("run-readonly-comparison.ts");
  const checkBlock = dedup.slice(exporterIdx, comparisonIdx);
  assert.match(checkBlock, /if not exist "%EXPORT_FILE%"/);
  assert.match(checkBlock, /if not exist "%SENTINEL_FILE%"/);
});

test("21. run-3d2o-from-supabase.cmd does not claim exporter reported success based only on errorlevel", () => {
  assert.doesNotMatch(dedup, /exporter reported success/i);
});

test("22. run-3d2o-from-supabase.cmd reports an incomplete-artifact-set error, not a false-success message", () => {
  assert.match(dedup, /did not produce a complete success artifact set/i);
});

test("23. both runners still keep the errorlevel check as a first-line signal alongside file checks", () => {
  assert.match(roi, /if errorlevel 1/);
  assert.match(dedup, /if errorlevel 1/);
});
