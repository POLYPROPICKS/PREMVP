@echo off
REM Phase 3D.2Oa operator runner: clipboard -> local export -> dedup comparison report.
REM
REM This script does NOT query Supabase, does NOT read any .env file, does
REM NOT write to any database, and does NOT compute ROI/PnL. It only reads
REM the Windows clipboard and writes local, git-ignored files under
REM modeling\local_exports\.
REM
REM Usage: double-click this file, or run it from a cmd prompt after
REM copying the generated_signal_pairs_export cell (or the whole Supabase
REM JSON wrapper) to the clipboard.

setlocal

REM cd to the repo root (two levels up from this script's directory:
REM scripts\modeling\strategies\ -> scripts\modeling\ -> scripts\ -> root).
cd /d "%~dp0..\..\.."

set "RAW_FILE=modeling\local_exports\supabase_clipboard_raw.txt"
set "EXPORT_FILE=modeling\local_exports\generated_signal_pairs_export.json"
set "REPORT_FILE=modeling\local_exports\3d2o_dedup_report.json"

if not exist "modeling\local_exports" mkdir "modeling\local_exports"

echo Reading clipboard...
powershell -NoProfile -Command "Get-Clipboard -Raw" > "%RAW_FILE%"
if errorlevel 1 (
  echo ERROR: failed to read the Windows clipboard.
  goto :fail
)

for %%F in ("%RAW_FILE%") do set "RAW_SIZE=%%~zF"
if "%RAW_SIZE%"=="0" (
  echo ERROR: clipboard was empty. Copy the generated_signal_pairs_export
  echo cell or the Supabase JSON result to the clipboard, then re-run this script.
  goto :fail
)

echo Materializing local export from clipboard content...
node --import tsx scripts\modeling\strategies\materialize-generated-signal-pairs-export.ts --input "%RAW_FILE%" --output "%EXPORT_FILE%"
if errorlevel 1 (
  echo ERROR: materializer failed. See the message above.
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
echo Phase 3D.2Oa run did not complete successfully.

:end
echo.
pause
endlocal
