@echo off
REM ═══════════════════════════════════════════════════════════════════════════════
REM  Contur3 PREMVP — Phase 4 Due-Window One-Command Proof (Windows PowerShell)
REM  Date: 2026-06-23
REM  Run this when the due window is approaching (≤60 min before first game start).
REM
REM  Does NOT send any order. Does NOT remove hard-stop. Does NOT call Ireland.
REM  Exit 0 = GO (queue healthy). Exit 1 = STOP (review failures above).
REM ═══════════════════════════════════════════════════════════════════════════════

REM Launch PowerShell inline — keeps the double-click experience for Windows founder.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { ^
    $BASE = 'https://polypropicks.com'; ^
    $secureSecret = Read-Host -Prompt 'EXECUTOR_SECRET' -AsSecureString; ^
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret); ^
    $SECRET = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr); ^
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); ^
    ^
    $headers = @{ 'x-executor-secret' = $SECRET }; ^
    $exitCode = 0; ^
    ^
    Write-Host ''; ^
    Write-Host '═══ Contur3 Phase 4 Due-Window Proof ═══'; ^
    Write-Host ('DATE_UTC: ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')); ^
    Write-Host ''; ^
    ^
    # ── 1. Reservation status ────────────────────────────────────────────────── ^
    Write-Host '── 1. Reservation status'; ^
    try { ^
      $resUrl = $BASE + '/api/cron/night-event-reservations?mode=status&source=phase4_due_window_one_command'; ^
      $res = Invoke-RestMethod -Uri $resUrl -Headers $headers -Method GET; ^
      Write-Host ('  plan_run_id      : ' + $res.plan_run_id); ^
      Write-Host ('  activeFuture     : ' + $res.plan_health.active_future_count); ^
      Write-Host ('  expiredOnly      : ' + $res.plan_health.is_expired_only); ^
      Write-Host ('  needsRebuild     : ' + $res.plan_health.needs_rebuild); ^
      Write-Host ('  bad_market_level : ' + $res.plan_health.bad_market_level_count); ^
      Write-Host ('  in_creation_win  : ' + $res.in_creation_window); ^
      if ($res.plan_health.is_expired_only -eq $true) { ^
        Write-Host '  [FAIL] plan is EXPIRED_ONLY — run forceRebuild or wait for 17:00 cron'; ^
        $exitCode = 1; ^
      } ^
      if ($res.plan_health.bad_market_level_count -gt 0) { ^
        Write-Host ('  [FAIL] bad_market_level_count=' + $res.plan_health.bad_market_level_count + ' — needs rebuild'); ^
        $exitCode = 1; ^
      } ^
    } catch { ^
      Write-Host ('  [FAIL] reservation status error: ' + $_.Exception.Message); ^
      $exitCode = 1; ^
    }; ^
    Write-Host ''; ^
    ^
    # ── 2. Rebalance dryRun ──────────────────────────────────────────────────── ^
    Write-Host '── 2. Rebalance dryRun'; ^
    try { ^
      $rebUrl = $BASE + '/api/cron/event-rebalance?dryRun=1&source=phase4_due_window_one_command'; ^
      $reb = Invoke-RestMethod -Uri $rebUrl -Headers $headers -Method GET; ^
      Write-Host ('  rebalance_run_id : ' + $reb.rebalance_run_id); ^
      Write-Host ('  due_count        : ' + $reb.due_count); ^
      Write-Host ('  queued_count     : ' + $reb.queued_count); ^
      Write-Host ('  skipped_count    : ' + $reb.skipped_count); ^
      Write-Host ('  expired_count    : ' + $reb.expired_count); ^
      Write-Host ('  next_due_iso     : ' + $reb.next_due_iso); ^
      if ($reb.outcomes) { ^
        foreach ($o in $reb.outcomes) { ^
          $line = '  outcome: ' + $o.match_family_key + ' → ' + $o.result; ^
          if ($o.reason) { $line += ' (' + $o.reason + ')' }; ^
          Write-Host $line; ^
          if ($o.blocked_candidates -and $o.blocked_candidates.Count -gt 0) { ^
            Write-Host ('    blocked_candidates: ' + ($o.blocked_candidates | ConvertTo-Json -Compress)); ^
          }; ^
        }; ^
      }; ^
    } catch { ^
      Write-Host ('  [FAIL] rebalance dryRun error: ' + $_.Exception.Message); ^
      $exitCode = 1; ^
    }; ^
    Write-Host ''; ^
    ^
    # ── 3. Queue ─────────────────────────────────────────────────────────────── ^
    Write-Host '── 3. Execution queue'; ^
    try { ^
      $qUrl = $BASE + '/api/executor/queue?includeUpcoming=1'; ^
      $q = Invoke-RestMethod -Uri $qUrl -Headers $headers -Method GET; ^
      Write-Host ('  queue_source         : ' + $q.source); ^
      Write-Host ('  candidate_count      : ' + $q.candidate_count); ^
      Write-Host ('  next_due_iso         : ' + $q.next_due_iso); ^
      Write-Host ('  next_check_after_sec : ' + $q.next_check_after_seconds); ^
      if ($q.next_due_reservation) { ^
        Write-Host ('  next_due_match       : ' + $q.next_due_reservation.event_title + ' @ ' + $q.next_due_reservation.game_start_iso); ^
      }; ^
      if ($q.source -ne 'event_execution_queue') { ^
        Write-Host ('  [FAIL] queue source=' + $q.source + ' (expected event_execution_queue) — SPLIT BRAIN'); ^
        $exitCode = 1; ^
      }; ^
      if ($q.candidates -and $q.candidates.Count -gt 0) { ^
        Write-Host ('  --- Queued candidates (' + $q.candidates.Count + ') ---'); ^
        foreach ($c in $q.candidates) { ^
          Write-Host ('  [' + $c.entry_state + '] ' + $c.match_family_key); ^
          Write-Host ('    condition_id : ' + $c.condition_id); ^
          Write-Host ('    token_id     : ' + $c.token_id); ^
          Write-Host ('    side         : ' + $c.side); ^
          Write-Host ('    stake_usd    : ' + $c.stake_usd); ^
          Write-Host ('    tier         : ' + $c.tier); ^
          Write-Host ('    market_slug  : ' + $c.market_slug); ^
          Write-Host ('    preferred    : ' + $c.preferred_entry_iso); ^
          Write-Host ('    latest       : ' + $c.latest_entry_iso); ^
          if (-not $c.condition_id -or -not $c.token_id -or -not $c.side -or $c.stake_usd -le 0) { ^
            Write-Host '    [FAIL] candidate missing required fields'; ^
            $exitCode = 1; ^
          }; ^
        }; ^
      } else { ^
        if ($q.next_due_iso) { ^
          Write-Host ('  [OK] queue empty — next due at ' + $q.next_due_iso + ' (expected before due window)'); ^
        } else { ^
          Write-Host '  [WARN] queue empty and next_due_iso=null — verify reservations exist'; ^
        }; ^
      }; ^
    } catch { ^
      Write-Host ('  [FAIL] queue error: ' + $_.Exception.Message); ^
      $exitCode = 1; ^
    }; ^
    Write-Host ''; ^
    Write-Host '═══════════════════════════════════════════════════'; ^
    if ($exitCode -eq 0) { ^
      Write-Host 'RESULT: GO — queue source correct, no bad market rows, plan not expired-only'; ^
    } else { ^
      Write-Host 'RESULT: STOP — review failures above before unlocking Ireland'; ^
    }; ^
    exit $exitCode; ^
  }"
