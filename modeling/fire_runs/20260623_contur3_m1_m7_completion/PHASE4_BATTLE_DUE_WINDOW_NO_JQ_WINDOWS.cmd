@echo off
:: PHASE4_BATTLE_DUE_WINDOW_NO_JQ_WINDOWS.cmd
:: Contur3 Battle — Due-Window Status Check (Windows, NO jq required)
:: Uses PowerShell ConvertFrom-Json for all JSON parsing.
:: 2026-06-23

setlocal EnableDelayedExpansion

set BASE=https://polypropicks.com

echo.
echo ========================================
echo  Contur3 Battle Due-Window Check (no-jq)
echo ========================================
echo.

:: Use PPP_SECRET env if set, otherwise prompt
if defined PPP_SECRET (
  set SECRET=%PPP_SECRET%
  echo Using PPP_SECRET from environment.
) else (
  echo Enter EXECUTOR_SECRET:
  for /f "delims=" %%S in ('powershell -NoProfile -Command "$s=Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set SECRET=%%S
)

if "!SECRET!"=="" (
  echo ERROR: No secret provided.
  pause & exit /b 1
)

echo.
echo [1/3] Reservation status ...
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/cron/night-event-reservations?mode=status' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "$h=$r.plan_health; " ^
  "Write-Host ('  plan_run_id=' + $r.plan_run_id); " ^
  "Write-Host ('  active_future=' + $h.active_future_count + '  expired=' + $h.expired_count + '  bad_market_level=' + $h.bad_market_level_count + '  needs_rebuild=' + $h.needs_rebuild); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ACTIVE_FUTURE', $h.active_future_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_BAD_MARKET', $h.bad_market_level_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_PLAN_RUN_ID', $r.plan_run_id, 'Process')"
if errorlevel 1 (
  echo   ERROR: reservation status call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)
set ACTIVE_FUTURE=%PPP_ACTIVE_FUTURE%
set BAD_MARKET=%PPP_BAD_MARKET%

echo.
echo [2/3] Rebalance dryRun ...
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/cron/event-rebalance?dryRun=1' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host ('  due=' + $r.due_count + '  queued=' + $r.queued_count + '  skipped=' + $r.skipped_count + '  expired=' + $r.expired_count); " ^
  "Write-Host ('  next_due_iso=' + $r.next_due_iso); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_DUE', $r.due_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_QUEUED', $r.queued_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_SKIPPED', $r.skipped_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_REB_NEXT', $r.next_due_iso, 'Process')"
if errorlevel 1 (
  echo   ERROR: rebalance dryRun call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)
set DUE=%PPP_DUE%
set SKIPPED=%PPP_SKIPPED%
set REB_NEXT=%PPP_REB_NEXT%

:: If due_count>0 and queue still empty, run safe manual rebalance write
if !DUE! GTR 0 (
  echo.
  echo   due_count=!DUE! detected. Running safe manual rebalance write ...
  powershell -NoProfile -Command ^
    "$r=Invoke-RestMethod -Uri '%BASE%/api/cron/event-rebalance?source=phase4_nojq_manual_write' -Method Post -Headers @{'x-executor-secret'='!SECRET!'}; " ^
    "Write-Host ('  [WRITE] queued=' + $r.queued_count + '  skipped=' + $r.skipped_count + '  expired=' + $r.expired_count)"
)

echo.
echo [3/3] Queue status ...
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/executor/queue?includeUpcoming=1' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host ('  source=' + $r.source + '  candidate_count=' + $r.candidate_count + '  max_stake_usd=' + $r.max_stake_usd); " ^
  "Write-Host ('  next_due_iso=' + $r.next_due_iso); " ^
  "if ($r.candidate_count -gt 0) { foreach ($c in $r.candidates) { Write-Host ('    candidate: ' + $c.match_family_key + '  side=' + $c.side + '  stake=' + $c.stake_usd + '  entry_state=' + $c.entry_state + '  tier=' + $c.tier) } }; " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_SOURCE', $r.source, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_COUNT', $r.candidate_count, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_NEXT', $r.next_due_iso, 'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_STAKE', $r.max_stake_usd, 'Process')"
if errorlevel 1 (
  echo   ERROR: queue call failed.
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)
set Q_SOURCE=%PPP_Q_SOURCE%
set Q_COUNT=%PPP_Q_COUNT%
set Q_NEXT=%PPP_Q_NEXT%
set Q_STAKE=%PPP_Q_STAKE%

:: Contract validation
if not "!Q_SOURCE!"=="event_execution_queue" (
  echo.
  echo   CONTRACT BREACH: source=!Q_SOURCE! (expected event_execution_queue)
  set RESULT=RESULT_FAIL_CONTRACT
  goto :PRINT_RESULT
)

:PRINT_RESULT
echo.
echo ============================== RESULT ==============================
if "!RESULT!"=="RESULT_FAIL_CONTRACT" (
  echo RESULT_FAIL_CONTRACT
  echo   Queue contract broken or API call failed. Do NOT unlock.
  goto :END
)

if !Q_COUNT! GTR 0 (
  set RESULT=RESULT_GO_READY_FOR_CEO_UNLOCK
  echo RESULT_GO_READY_FOR_CEO_UNLOCK
  echo   !Q_COUNT! candidate(s) in queue. source=!Q_SOURCE! stake=!Q_STAKE!
  echo   Validate candidates above, then run Ireland CEO unlock command.
  goto :END
)

if not "!Q_NEXT!"=="null" if not "!Q_NEXT!"=="" (
  set RESULT=RESULT_WAIT_NEXT_DUE
  echo RESULT_WAIT_NEXT_DUE
  echo   No candidates yet. Next rebalance due: !Q_NEXT!
  echo   Wait and re-run this script in 10-15 min.
  goto :END
)

if !SKIPPED! GTR 0 (
  set RESULT=RESULT_STOP_REBALANCE_SKIPPED
  echo RESULT_STOP_REBALANCE_SKIPPED
  echo   Rebalance skipped !SKIPPED! events. Inspect event-rebalance response before proceeding.
  goto :END
)

echo RESULT_WAIT_NEXT_DUE
echo   No candidates, no upcoming due time, no skipped. Waiting for reservations.

:END
echo.
echo Rollback (if needed):
echo   On Ireland terminal: touch /tmp/PPP_LIVE_HARD_STOP
echo   pkill -f "[c]ontur3_battle_queue_only_watcher.py" ^|^| true
echo.
pause
