@echo off
:: POST_DEPLOY_FORCE_REBUILD_WINDOWS.cmd
:: Contur3 — Force Rebuild After Deploy (Windows, NO jq required)
:: Run AFTER Railway PREMVP deploy succeeds for the horizon-repair commit.
:: 2026-06-23

setlocal EnableDelayedExpansion

set BASE=https://polypropicks.com

echo.
echo ======================================================
echo  Contur3 Post-Deploy Force Rebuild (no-jq)
echo  Run after Railway deploy completes.
echo ======================================================
echo.

:: Use PPP_SECRET env if set, otherwise prompt
if defined PPP_SECRET (
  set SECRET=%PPP_SECRET%
  echo Using PPP_SECRET from environment.
) else (
  echo Enter EXECUTOR_SECRET:
  for /f "delims=" %%S in ('powershell -NoProfile -Command "$s=Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set SECRET=%%S
)
if "!SECRET!"=="" ( echo ERROR: No secret. & pause & exit /b 1 )

:: ─ Step 1: Force Rebuild ─────────────────────────────────
echo.
echo [1/3] Force rebuilding reservations (CEO_APPROVED) ...
powershell -NoProfile -Command ^
  "$r = Invoke-RestMethod -Uri '%BASE%/api/cron/night-event-reservations?forceRebuild=CEO_APPROVED' -Method Post -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host ('  ok=' + $r.ok); " ^
  "Write-Host ('  written_count=' + $r.written_count + '  reserved_count=' + $r.reserved_count); " ^
  "Write-Host ('  deleted_queue=' + $r.deleted_queue_count + '  deleted_res=' + $r.deleted_reservation_count); " ^
  "$h = $r.plan_health; " ^
  "Write-Host ('  active_future=' + $h.active_future_count + '  reserved_wc_soccer=' + $h.reserved_wc_or_soccer_count); " ^
  "Write-Host ('  bad_market_level=' + $h.bad_market_level_count + '  needs_rebuild=' + $h.needs_rebuild); " ^
  "Write-Host ('  latest_game_start=' + $h.latest_game_start_iso); " ^
  "Write-Host ('  horizon_end=' + $h.horizon_end_iso); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_OK', $r.ok, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_WC', $h.reserved_wc_or_soccer_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_ACTIVE', $h.active_future_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_BAD', $h.bad_market_level_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_NEEDS', $h.needs_rebuild, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RB_LATEST', $h.latest_game_start_iso, 'Process')"
if errorlevel 1 (
  echo   ERROR: forceRebuild call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)
set RB_WC=%PPP_RB_WC%
set RB_ACTIVE=%PPP_RB_ACTIVE%

:: ─ Step 2: Status verification ───────────────────────────
echo.
echo [2/3] Verifying reservation status ...
powershell -NoProfile -Command ^
  "$r = Invoke-RestMethod -Uri '%BASE%/api/cron/night-event-reservations?mode=status' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host ('  plan_run_id=' + $r.plan_run_id); " ^
  "Write-Host ('  window_end=' + $r.window_end_iso + '  horizon_end=' + $r.horizon_end_iso); " ^
  "$h = $r.plan_health; " ^
  "Write-Host ('  active_future=' + $h.active_future_count + '  reserved_wc_soccer=' + $h.reserved_wc_or_soccer_count); " ^
  "Write-Host ('  wc_floor_below_minimum=' + $h.wc_floor_below_minimum + '  needs_rebuild=' + $h.needs_rebuild); " ^
  "Write-Host ('  latest_game_start=' + $h.latest_game_start_iso); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ST_WC', $h.reserved_wc_or_soccer_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ST_FLOOR', $h.wc_floor_below_minimum, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ST_ACTIVE', $h.active_future_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ST_LATEST', $h.latest_game_start_iso, 'Process')"
if errorlevel 1 (
  echo   ERROR: status call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)
set ST_WC=%PPP_ST_WC%
set ST_FLOOR=%PPP_ST_FLOOR%
set ST_ACTIVE=%PPP_ST_ACTIVE%

:: ─ Step 3: Queue check ───────────────────────────────────
echo.
echo [3/3] Checking queue ...
powershell -NoProfile -Command ^
  "$r = Invoke-RestMethod -Uri '%BASE%/api/executor/queue?includeUpcoming=1' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host ('  source=' + $r.source + '  candidates=' + $r.candidate_count + '  next_due=' + $r.next_due_iso); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_SRC', $r.source, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_NEXT', $r.next_due_iso, 'Process')"
if errorlevel 1 (
  echo   ERROR: queue call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)

:: ─ Determine result ──────────────────────────────────────
:: Contract check: source must be event_execution_queue
if not "!PPP_Q_SRC!"=="event_execution_queue" (
  echo.
  echo   CONTRACT BREACH: queue source=!PPP_Q_SRC!
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)

:: WC floor check
if "!ST_FLOOR!"=="True" (
  set RESULT=RESULT_RESERVATIONS_STILL_INSUFFICIENT
  goto :PRINT_RESULT
)

:: Active future check
set ACTIVE_OK=0
for /f "delims=" %%N in ('powershell -NoProfile -Command "if ([int]'!ST_ACTIVE!' -ge 3) { 'YES' } else { 'NO' }"') do set ACTIVE_OK=%%N
if "!ACTIVE_OK!"=="YES" (
  set RESULT=RESULT_RESERVATIONS_READY
) else (
  set RESULT=RESULT_RESERVATIONS_STILL_INSUFFICIENT
)

:PRINT_RESULT
echo.
echo ============================== RESULT ==============================
if "!RESULT!"=="RESULT_RESERVATIONS_READY" (
  echo RESULT_RESERVATIONS_READY
  echo   reserved_wc_soccer=!ST_WC!  active_future=!ST_ACTIVE!
  echo   wc_floor_below_minimum=!ST_FLOOR!
  echo   Queue source=event_execution_queue confirmed.
  echo   Next step: wait for T-60 rebalance windows, then run due-window check.
  goto :END
)
if "!RESULT!"=="RESULT_RESERVATIONS_STILL_INSUFFICIENT" (
  echo RESULT_RESERVATIONS_STILL_INSUFFICIENT
  echo   reserved_wc_soccer=!ST_WC!  active_future=!ST_ACTIVE!  wc_floor_below_minimum=!ST_FLOOR!
  echo   Signal corpus may not yet contain later WC matches.
  echo   Wait 30-60 min for signal refresh and re-run this script.
  goto :END
)
if "!RESULT!"=="RESULT_FAIL_CONTRACT" (
  echo RESULT_FAIL_CONTRACT
  echo   API call failed or queue contract broken. Do NOT proceed.
  goto :END
)
echo RESULT_UNKNOWN — manual review needed.

:END
echo.
echo Hard-stop remains ON. No live orders placed.
echo Rollback: POST forceRebuild again or check night-event-reservations status.
echo.
pause
