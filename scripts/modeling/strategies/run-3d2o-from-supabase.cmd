@echo off
REM Phase 3D.2Ob operator runner: automated read-only Supabase export ->
REM dedup comparison report. No clipboard, no manual file editing.
REM
REM This script does NOT write to the database, does NOT log secret env
REM values, and does NOT compute ROI/PnL. It only reads generated_signal_pairs
REM (read-only select) via the repo's existing Supabase env/config and writes
REM local, git-ignored files under modeling\local_exports\.
REM
REM Phase 3E.2a hardening: this runner fails fast -- it will not run the
REM dedup comparison step if the exporter failed, or if the export file it
REM depends on is missing. It also clears any stale prior report before
REM running the comparison, so a failed run can never leave behind a report
REM file that looks like a fresh success.
REM
REM Phase 3E.2e hardening: a real Windows run showed that %ERRORLEVEL% is
REM NOT reliable after the exporter process exits -- a native libuv
REM teardown assertion has been observed to interfere with exit-code
REM propagation on Windows, even though the exporter itself correctly
REM detected and reported its own failure. This runner therefore does NOT
REM treat a clean errorlevel as proof of success. Success requires both the
REM export file and a success sentinel the exporter writes only after the
REM export finishes writing. Stale copies of both are deleted before the
REM exporter runs, so a failed run can never be mistaken for success by
REM reusing a leftover file from a previous successful run.
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
set "SENTINEL_FILE=modeling\local_exports\generated_signal_pairs_export_sentinel.json"
set "REPORT_FILE=modeling\local_exports\3d2o_dedup_report.json"

if not exist "modeling\local_exports" mkdir "modeling\local_exports"

REM Clear any stale prior artifacts before this run, so a failure below can
REM never be mistaken for success by reusing a leftover file from an
REM earlier run.
del /q "%EXPORT_FILE%" 2>nul
del /q "%SENTINEL_FILE%" 2>nul
del /q "%REPORT_FILE%" 2>nul

echo Reading ALL resolved generated_signal_pairs rows from Supabase (read-only, paginated, no dataset cap)...
node --import tsx scripts\modeling\strategies\export-generated-signal-pairs-from-supabase.ts --output "%EXPORT_FILE%" --sentinel-output "%SENTINEL_FILE%" --page-size 1000
if errorlevel 1 (
  echo ERROR: Supabase export failed. See the message above.
  goto :fail
)

if not exist "%EXPORT_FILE%" (
  echo ERROR: exporter did not produce a complete success artifact set -- %EXPORT_FILE% is missing.
  goto :fail
)

if not exist "%SENTINEL_FILE%" (
  echo ERROR: exporter did not produce a complete success artifact set -- %SENTINEL_FILE% is missing.
  goto :fail
)

echo Running read-only dedup comparison...
node --import tsx scripts\modeling\strategies\run-readonly-comparison.ts --input "%EXPORT_FILE%" --required-only --input-format generated_signal_pairs --include-dqa-r4 --dedup-policy strict_latest_created_before_resolved > "%REPORT_FILE%"
if errorlevel 1 (
  echo ERROR: comparison run failed. See the message above.
  del /q "%REPORT_FILE%" 2>nul
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
