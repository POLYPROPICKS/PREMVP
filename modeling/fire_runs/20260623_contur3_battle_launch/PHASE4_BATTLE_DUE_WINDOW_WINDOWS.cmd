@echo off
:: PHASE4_BATTLE_DUE_WINDOW_WINDOWS.cmd
:: Contur3 Battle — Due-Window Status Check (Windows, runs from PREMVP)
:: 2026-06-23
::
:: Usage: double-click or run from CMD
:: Requires: curl (built-in Win10+), jq (install via winget install jqlang.jq)

setlocal EnableDelayedExpansion

set BASE=https://polypropicks.com

:: Ask for secret (hidden input not natively possible in CMD — use PowerShell trick)
echo.
echo ========================================
echo  Contur3 Battle Due-Window Status Check
echo ========================================
echo.
echo Enter EXECUTOR_SECRET (input hidden via PowerShell):
for /f "delims=" %%S in ('powershell -Command "$s=Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set SECRET=%%S

if "%SECRET%"=="" (
  echo ERROR: No secret provided.
  pause & exit /b 1
)

echo.
echo [1/3] Reservation status...
curl -s -H "x-executor-secret: %SECRET%" "%BASE%/api/cron/night-event-reservations?mode=status" > %TEMP%\ppp_res.json
for /f "delims=" %%V in ('jq -r ".plan_run_id // \"null\"" %TEMP%\ppp_res.json') do set PLAN_RUN_ID=%%V
for /f "delims=" %%V in ('jq -r ".plan_health.active_future_count // \"null\"" %TEMP%\ppp_res.json') do set ACTIVE_FUTURE=%%V
for /f "delims=" %%V in ('jq -r ".plan_health.expired_count // \"null\"" %TEMP%\ppp_res.json') do set EXPIRED=%%V
for /f "delims=" %%V in ('jq -r ".plan_health.needs_rebuild // \"null\"" %TEMP%\ppp_res.json') do set NEEDS_REBUILD=%%V
for /f "delims=" %%V in ('jq -r ".plan_health.bad_market_level_count // \"null\"" %TEMP%\ppp_res.json') do set BAD_MARKET=%%V

echo   plan_run_id=%PLAN_RUN_ID%
echo   active_future=%ACTIVE_FUTURE%  expired=%EXPIRED%  needs_rebuild=%NEEDS_REBUILD%  bad_market_level=%BAD_MARKET%

echo.
echo [2/3] Rebalance dryRun...
curl -s -H "x-executor-secret: %SECRET%" "%BASE%/api/cron/event-rebalance?dryRun=1" > %TEMP%\ppp_reb.json
for /f "delims=" %%V in ('jq -r ".due_count // \"null\"" %TEMP%\ppp_reb.json') do set DUE=%%V
for /f "delims=" %%V in ('jq -r ".queued_count // \"null\"" %TEMP%\ppp_reb.json') do set QUEUED=%%V
for /f "delims=" %%V in ('jq -r ".skipped_count // \"null\"" %TEMP%\ppp_reb.json') do set SKIPPED=%%V
for /f "delims=" %%V in ('jq -r ".expired_count // \"null\"" %TEMP%\ppp_reb.json') do set REB_EXPIRED=%%V
for /f "delims=" %%V in ('jq -r "(.outcomes // [] | length)" %TEMP%\ppp_reb.json') do set OUTCOMES=%%V

echo   rebalance: due=%DUE%  queued=%QUEUED%  skipped=%SKIPPED%  expired=%REB_EXPIRED%  outcomes=%OUTCOMES%

echo.
echo [3/3] Queue status...
curl -s -H "x-executor-secret: %SECRET%" "%BASE%/api/executor/queue?includeUpcoming=1" > %TEMP%\ppp_q.json
for /f "delims=" %%V in ('jq -r ".source // \"null\"" %TEMP%\ppp_q.json') do set Q_SOURCE=%%V
for /f "delims=" %%V in ('jq -r ".candidate_count // 0" %TEMP%\ppp_q.json') do set Q_COUNT=%%V
for /f "delims=" %%V in ('jq -r ".next_due_iso // \"null\"" %TEMP%\ppp_q.json') do set Q_NEXT=%%V
for /f "delims=" %%V in ('jq -r ".max_stake_usd // \"null\"" %TEMP%\ppp_q.json') do set Q_STAKE=%%V

echo   source=%Q_SOURCE%  candidate_count=%Q_COUNT%  next_due=%Q_NEXT%  max_stake_usd=%Q_STAKE%

echo.
echo [CANDIDATES]
jq -r ".candidates[] | \"  \(.match_family_key)  side=\(.side)  stake=\(.stake_usd)  cid=\(.condition_id[:12])...  entry_state=\(.entry_state)\"" %TEMP%\ppp_q.json 2>nul || echo   (no candidates)

echo.
echo ════════════ RESULT ════════════
if %Q_COUNT% GTR 0 (
  echo RESULT_GO_READY_FOR_CEO_UNLOCK
  echo   %Q_COUNT% candidate(s) ready. Validate above, then unlock Ireland with --remove-hard-stop=CEO_APPROVED
) else if not "%Q_NEXT%"=="null" (
  echo RESULT_WAIT_NEXT_DUE
  echo   No candidates yet. Next due: %Q_NEXT%
) else (
  if not "%SKIPPED%"=="0" (
    echo RESULT_STOP_REBALANCE_SKIPPED
    echo   Rebalance skipped candidates. Inspect event-rebalance response.
    jq ".skipped_reasons // []" %TEMP%\ppp_reb.json 2>nul
  ) else (
    echo RESULT_WAIT — no candidates and no upcoming due time
  )
)

echo.
echo Rollback:
echo   touch /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP  ^(Ireland terminal^)
echo   pkill -f "[c]ontur3_battle_queue_only_watcher.py" ^|^| true
echo.
pause
