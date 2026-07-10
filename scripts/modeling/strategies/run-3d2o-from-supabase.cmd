@echo off
REM Phase 3D.2Ob operator runner: automated read-only Supabase export ->
REM dedup comparison report. No clipboard, no manual file editing.
REM
REM This script does NOT write to the database, does NOT log secret env
REM values, and does NOT compute ROI/PnL. It only reads generated_signal_pairs
REM (read-only select) via the repo's existing Supabase env/config and writes
REM local, git-ignored files under modeling\local_exports\.
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
set "REPORT_FILE=modeling\local_exports\3d2o_dedup_report.json"

if not exist "modeling\local_exports" mkdir "modeling\local_exports"

echo Reading resolved generated_signal_pairs rows from Supabase (read-only)...
node --import tsx scripts\modeling\strategies\export-generated-signal-pairs-from-supabase.ts --output "%EXPORT_FILE%" --limit 5000
if errorlevel 1 (
  echo ERROR: Supabase export failed. See the message above.
  goto :fail
)

echo Running read-only dedup comparison...
node --import tsx scripts\modeling\strategies\run-readonly-comparison.ts --input "%EXPORT_FILE%" --required-only --input-format generated_signal_pairs --include-dqa-r4 --dedup-policy strict_latest_created_before_resolved > "%REPORT_FILE%"
if errorlevel 1 (
  echo ERROR: comparison run failed. See the message above.
  goto :fail
)

echo.
echo Export written to:  %EXPORT_FILE%
echo Report written to:  %REPORT_FILE%
echo.
type "%REPORT_FILE%"

goto :end

:fail
echo.
echo Phase 3D.2Ob run did not complete successfully.
echo If this is an env/config error, set SUPABASE_URL and
echo SUPABASE_SERVICE_ROLE_KEY (see scripts\modeling\strategies\README.md).

:end
echo.
pause
endlocal
