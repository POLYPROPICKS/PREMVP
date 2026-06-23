@echo off
:: CONTUR3_WINDOWS_NO_JQ_STATUS.cmd
:: Contur3 PREMVP — Full Status Check (Windows, NO jq required)
:: Uses PowerShell ConvertFrom-Json. Built-in on Windows 10+.
:: 2026-06-23
::
:: Prints: queue source, candidate count, next_due_iso, reservation health,
::         bad_market_level_count, mark endpoint auth, night-plan diagnostic check,
::         M1-M7 artifact presence.
::
:: Final sentinel:
::   ALL_PASS_CONTUR3_M1_M7_READY_PRELIVE
::   DEGRADED — see failures above

setlocal EnableDelayedExpansion

set BASE=https://polypropicks.com
set PASS=0
set FAIL=0
set FAIL_MSG=

echo.
echo ══════════════════════════════════════════════
echo  Contur3 M1-M7 Windows Status (no-jq)
echo ══════════════════════════════════════════════
echo.

:: ─ Secret ────────────────────────────────────────
if defined PPP_SECRET (
  set SECRET=%PPP_SECRET%
) else (
  echo Enter EXECUTOR_SECRET:
  for /f "delims=" %%S in ('powershell -NoProfile -Command "$s=Read-Host -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set SECRET=%%S
)
if "!SECRET!"=="" ( echo ERROR: No secret. & exit /b 1 )

:: ─ 1. Auth gates (401 check) ─────────────────────
echo [1] Auth gates (expect 401 without secret)
for %%P in ("/api/executor/queue" "/api/executor/queue/mark" "/api/cron/night-event-reservations" "/api/cron/event-rebalance") do (
  for /f "delims=" %%C in ('powershell -NoProfile -Command "(Invoke-WebRequest -Uri '%BASE%%%P' -Headers @{'x-executor-secret'='BAD_KEY'} -UseBasicParsing -ErrorAction SilentlyContinue).StatusCode"') do set CODE=%%C
  if "!CODE!"=="401" (
    set /a PASS+=1 & echo   PASS  %%P =^> 401
  ) else (
    set /a FAIL+=1 & echo   FAIL  %%P =^> expected 401 got !CODE!
  )
)

:: ─ 2. Reservation status ─────────────────────────
echo.
echo [2] Reservation status
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/cron/night-event-reservations?mode=status' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "$h=$r.plan_health; " ^
  "Write-Host '  plan_run_id='$r.plan_run_id; " ^
  "Write-Host '  active_future='$h.active_future_count'  expired='$h.expired_count'  bad_market='$h.bad_market_level_count'  needs_rebuild='$h.needs_rebuild; " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_ACTIVE',$h.active_future_count,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_BAD',$h.bad_market_level_count,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_RES_OK',$r.ok,'Process')"
if "!PPP_RES_OK!"=="True" (
  set /a PASS+=1 & echo   PASS  reservation status ok
) else (
  set /a FAIL+=1 & echo   FAIL  reservation status returned ok=false
)
if defined PPP_BAD if not "!PPP_BAD!"=="0" (
  set /a FAIL+=1 & echo   FAIL  bad_market_level_count=!PPP_BAD! — rebuild needed
)

:: ─ 3. Rebalance dryRun ───────────────────────────
echo.
echo [3] Rebalance dryRun
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/cron/event-rebalance?dryRun=1' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host '  due='$r.due_count'  queued='$r.queued_count'  skipped='$r.skipped_count'  expired='$r.expired_count'  next_due='$r.next_due_iso; " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_REB_OK',$r.ok,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_NEXT_DUE',$r.next_due_iso,'Process')"
if "!PPP_REB_OK!"=="True" (
  set /a PASS+=1 & echo   PASS  rebalance dryRun ok
) else (
  set /a FAIL+=1 & echo   FAIL  rebalance dryRun returned ok=false
)

:: ─ 4. Queue source + contract ────────────────────
echo.
echo [4] Queue source and ireland_contract
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/executor/queue?includeUpcoming=1' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host '  source='$r.source'  candidates='$r.candidate_count'  max_stake='$r.max_stake_usd'  next_due='$r.next_due_iso; " ^
  "$ic=$r.ireland_contract; " ^
  "Write-Host '  do_not_rank='$ic.do_not_rank'  do_not_pull_broad='$ic.do_not_pull_broad_candidates'  do_not_tier2='$ic.do_not_apply_tier2_tier3; " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_SOURCE',$r.source,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_COUNT',$r.candidate_count,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_STAKE',$r.max_stake_usd,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_RANK',$ic.do_not_rank,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_BROAD',$ic.do_not_pull_broad_candidates,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_Q_TIER',$ic.do_not_apply_tier2_tier3,'Process')"
if "!PPP_Q_SOURCE!"=="event_execution_queue" (
  set /a PASS+=1 & echo   PASS  source=event_execution_queue
) else (
  set /a FAIL+=1 & echo   FAIL  source=!PPP_Q_SOURCE! EXPECTED event_execution_queue
)
if "!PPP_Q_RANK!"=="True" if "!PPP_Q_BROAD!"=="True" if "!PPP_Q_TIER!"=="True" (
  set /a PASS+=1 & echo   PASS  ireland_contract intact
) else (
  set /a FAIL+=1 & echo   FAIL  ireland_contract broken
)

:: ─ 5. Night-plan diagnostic-only check ───────────────
echo.
echo [5] night-plan diagnostic-only safety
powershell -NoProfile -Command ^
  "$r=Invoke-RestMethod -Uri '%BASE%/api/executor/night-plan' -Headers @{'x-executor-secret'='!SECRET!'}; " ^
  "Write-Host '  diagnostic_only='$r.diagnostic_only'  candidates_count='$r.candidates.Count; " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_NP_DIAG',$r.diagnostic_only,'Process'); " ^
  "[System.Environment]::SetEnvironmentVariable('PPP_NP_CANDS',$r.candidates.Count,'Process')"
if "!PPP_NP_DIAG!"=="True" if "!PPP_NP_CANDS!"=="0" (
  set /a PASS+=1 & echo   PASS  night-plan diagnostic_only=true candidates=0
) else (
  set /a FAIL+=1 & echo   FAIL  night-plan may not be diagnostic-only: diag=!PPP_NP_DIAG! cands=!PPP_NP_CANDS!
)

:: ─ 6. Mark endpoint auth (must return 401 without secret) ─
echo.
echo [6] Mark endpoint auth
for /f "delims=" %%C in ('powershell -NoProfile -Command ^
  "try { (Invoke-WebRequest -Uri '%BASE%/api/executor/queue/mark' -Method Post -Headers @{'x-executor-secret'='BAD'} -Body '{}' -ContentType 'application/json' -UseBasicParsing -ErrorAction Stop).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }"') do set MARK_CODE=%%C
if "!MARK_CODE!"=="401" (
  set /a PASS+=1 & echo   PASS  mark endpoint =^> 401 as expected
) else (
  set /a FAIL+=1 & echo   FAIL  mark endpoint returned !MARK_CODE! expected 401
)

:: ─ 7. M1-M7 artifact checks ─────────────────────
echo.
echo [7] M1-M7 artifact presence
set M1DIR=modeling\fire_runs\20260623_contur3_m1_m7_completion

for %%F in (
  "M1_UNKNOWN_MARKETS_AUDIT.md"
  "M1_UNKNOWN_MARKETS_SQL.sql"
  "M2_ESPORTS_POLICY_AUDIT.md"
  "M2_ESPORTS_SQL.sql"
  "M3_MLB_OTHER_SPORTS_AUDIT.md"
  "M3_MLB_OTHER_SPORTS_SQL.sql"
  "M4_FOOTBALL_POLICY.md"
  "M4_FOOTBALL_POLICY_SQL.sql"
  "M5_TIMING_FRAMEWORK.md"
  "M5_TIMING_SQL.sql"
  "M6_FIREMODEL_LINKAGE_AUDIT.md"
  "M6_FIREMODEL_LINKAGE_SQL.sql"
  "M7_FOUNDER_REPORTS_SPEC.md"
  "M7_NIGHT_PLAN_EMAIL_CHECKLIST.md"
  "M7_MORNING_LIVE_PROOF_CHECKLIST.md"
  "P0_BATTLE_OPERATOR_STATE.md"
  "P0_TWO_COMMANDS_LEFT.md"
  "PHASE4_BATTLE_DUE_WINDOW_NO_JQ_WINDOWS.cmd"
  "IRELAND_FINAL_TWO_COMMANDS_AFTER_GO.md"
) do (
  if exist "!M1DIR!\%%~F" (
    set /a PASS+=1 & echo   PASS  %%~F
  ) else (
    set /a FAIL+=1 & echo   FAIL  %%~F MISSING
  )
)

:: ─ Summary ───────────────────────────────────────
echo.
echo ══════════════════════════════════════════════
set /a TOTAL=PASS+FAIL
if !FAIL! EQU 0 (
  echo ALL PASS  !PASS!/!TOTAL! checks passed
  echo ALL_PASS_CONTUR3_M1_M7_READY_PRELIVE
) else (
  echo DEGRADED  !PASS!/!TOTAL! passed  !FAIL! failed
  echo Contur3 M1-M7 status: DEGRADED — review failures above
)
echo.
pause
