@echo off
REM VERIFY_COMMANDS_WINDOWS.cmd
REM Contur3 Phase 3 — Windows verification commands (no secrets)
REM Run from repo root.

echo === Build ===
call npm run build
if %ERRORLEVEL% neq 0 (
  echo BUILD FAILED
  exit /b 1
)

echo.
echo === Git status ===
git status --short

echo.
echo === Git diff stat ===
git diff --stat

echo.
echo === Changed files only ===
git diff --name-only

echo.
echo === Doctor shell syntax check (requires Git Bash) ===
bash -n scripts/contur3_premvp_doctor.sh && echo SYNTAX OK

echo.
echo === Done — no secrets used ===
