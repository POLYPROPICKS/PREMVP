@echo off
REM Phase 3E.2 operator runner: automated read-only Supabase export ->
REM gated ROI comparison report. No clipboard, no manual file editing.
REM
REM This script does NOT write to the database, does NOT log secret env
REM values, and does NOT make any performance/profit claim. It reads
REM generated_signal_pairs (read-only select) via the repo's existing
REM Supabase env/config, writes local git-ignored files under
REM modeling\local_exports\, and computes ROI ONLY if every completeness /
REM dedup / DQA-R4 / selection gate passes.
REM
REM Requires local Supabase read env/config (SUPABASE_URL and
REM SUPABASE_SERVICE_ROLE_KEY, or the .env.local equivalents already used by
REM this repo) to be available to the process.
REM
REM Usage: double-click this file, or run it from a cmd prompt.

setlocal

REM cd to the repo root (two levels up from this script's directory:
REM scripts\modeling\strategies\ -> scripts\modeling\ -> scripts\ -> root).
cd /d "%~dp0..\..\.."

set "EXPORT_FILE=modeling\local_exports\generated_signal_pairs_export.json"
set "SUMMARY_FILE=modeling\local_exports\generated_signal_pairs_export_summary.json"
set "REPORT_FILE=modeling\local_exports\3e2_roi_report.json"

if not exist "modeling\local_exports" mkdir "modeling\local_exports"

echo Reading ALL resolved generated_signal_pairs rows from Supabase (read-only, paginated, no dataset cap)...
node --import tsx scripts\modeling\strategies\export-generated-signal-pairs-from-supabase.ts --output "%EXPORT_FILE%" --summary-output "%SUMMARY_FILE%" --page-size 1000
if errorlevel 1 (
  echo ERROR: Supabase export failed. See the message above.
  goto :fail
)

echo Running gated ROI comparison...
node --import tsx scripts\modeling\strategies\run-readonly-comparison.ts --input "%EXPORT_FILE%" --required-only --input-format generated_signal_pairs --include-dqa-r4 --dedup-policy strict_latest_created_before_resolved --include-roi --export-summary "%SUMMARY_FILE%" > "%REPORT_FILE%"
if errorlevel 1 (
  echo ERROR: gated ROI comparison run failed. See the message above.
  goto :fail
)

echo.
echo Export written to:   %EXPORT_FILE%
echo Summary written to:  %SUMMARY_FILE%
echo ROI report written to: %REPORT_FILE%
echo.
type "%REPORT_FILE%"

goto :end

:fail
echo.
echo Phase 3E.2 run did not complete successfully.
echo If this is an env/config error, set SUPABASE_URL and
echo SUPABASE_SERVICE_ROLE_KEY (see scripts\modeling\strategies\README.md).

:end
echo.
pause
endlocal
