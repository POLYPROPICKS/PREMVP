@echo off
REM PRODUCTION_VERIFY_COMMANDS_WINDOWS.cmd
REM Contur3 Sleep-Safe Audit — Post-Deploy Verification
REM Run these after Railway deploys this commit.
REM Replace PREMVP_URL and EXECUTOR_CANDIDATES_SECRET with actual values.

SET PREMVP_URL=https://your-premvp.up.railway.app
SET SECRET=your-executor-secret-here

echo ============================================================
echo 1. CHECK RESERVATION STATUS (DB-backed statuses after fix)
echo ============================================================
curl -s -X GET "%PREMVP_URL%/api/cron/night-event-reservations" ^
  -H "x-executor-secret: %SECRET%" | python -m json.tool
echo.

echo ============================================================
echo 2. DRY-RUN REBALANCE — verify next_due_iso + expired_count
echo ============================================================
curl -s -X GET "%PREMVP_URL%/api/cron/event-rebalance?dryRun=1" ^
  -H "x-executor-secret: %SECRET%" | python -m json.tool
echo.

echo ============================================================
echo 3. QUEUE CHECK — verify next_due_iso + next_due_reservation
echo ============================================================
curl -s -X GET "%PREMVP_URL%/api/executor/queue?includeUpcoming=1" ^
  -H "x-executor-secret: %SECRET%" | python -m json.tool
echo.

echo ============================================================
echo 4. VERIFY: ireland_autostart_expected is false when 0 queued
echo    (should be false if no READY rows exist)
echo ============================================================
curl -s -X GET "%PREMVP_URL%/api/cron/event-rebalance?dryRun=1" ^
  -H "x-executor-secret: %SECRET%" | python -c "import sys,json; d=json.load(sys.stdin); print('ireland_autostart_expected =', d.get('ireland_autostart_expected')); print('queued_count =', d.get('queued_count')); print('next_due_iso =', d.get('next_due_iso'))"
echo.

echo ============================================================
echo 5. WRITE-MODE REBALANCE (only run when event IS due T-60..T-5)
echo    SKIP if no events due — dry-run above shows due_count
echo ============================================================
REM curl -s -X POST "%PREMVP_URL%/api/cron/event-rebalance" ^
REM   -H "x-executor-secret: %SECRET%" | python -m json.tool
echo (Commented out — run manually when due_count > 0 in dry-run above)
echo.

echo Done. Review output above for:
echo   - reserved_events with real status (QUEUED/SKIPPED/EXPIRED/RESERVED)
echo   - next_due_iso and next_check_after_seconds present
echo   - ireland_autostart_expected = false when no READY queue rows
echo   - expired_count field present in rebalance response
