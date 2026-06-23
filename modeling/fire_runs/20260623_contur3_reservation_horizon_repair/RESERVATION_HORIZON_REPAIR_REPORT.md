# Contur3 Reservation Horizon Repair Report

Generated: 2026-06-23. P0 launch blocker investigation.

---

## Root Cause

**Primary: F — Signal corpus data not available for later matches at freeze time.**

The `night_event_reservations` plan was frozen at ~17:00 Minsk (14:00 UTC) when the
`generated_signal_pairs` DB only contained data for the first two WC matches:

| Match | Start (Minsk) | Start (UTC) | In DB at 17:00 Minsk |
|---|---|---|---|
| Portugal vs Uzbekistan | 23 Jun 20:00 | 23 Jun 17:00 | ✅ |
| England vs Ghana | 23 Jun 23:00 | 23 Jun 20:00 | ✅ |
| Panama vs Croatia | 24 Jun 02:00 | 23 Jun 23:00 | ❌ not in corpus |
| Colombia vs DR Congo | 24 Jun 05:00 | 24 Jun 02:00 | ❌ not in corpus |

**Secondary: D — No code detection for thin WC plan.**

The `needs_rebuild` flag only triggered on `is_expired_only` or `bad_market_level_count > 0`.
It did NOT detect that `reserved_wc_or_soccer_count=2` was below a minimum battle floor.

**Secondary: Missing diagnostics in status response.**

The `mode=status` response was missing `horizon_end_iso`, `reserved_wc_or_soccer_count`,
`wc_floor_below_minimum`, and `latest_game_start_iso` — making it impossible for founder
or doctor to detect the thin-plan condition without re-running the planner.

**Not a bug: Horizon math.**

The `resolveNightWindow` horizon computation is correct. At 17:00 Minsk:
- `window_end_iso` = 2026-06-24T05:00Z (08:00 Minsk)
- `horizon_end_iso` = max(05:00Z Jun 24, 14:00Z Jun 23 + 18h) = 2026-06-24T08:00Z

All four WC matches are within `horizon_end_iso`. The horizon is not the problem.

**Not a bug: No per-sport cap.**

There is no hard cap limiting WC/soccer reservations to 2. The planner loop reserves ALL
Tier1 events within horizon. The 2-event result was pure data availability.

---

## Files Changed

| File | Change |
|---|---|
| `lib/executor/nightEventReservations.ts` | Add `PlanHealth` fields: `horizon_end_iso`, `window_end_iso`, `reserved_wc_or_soccer_count`, `eligible_wc_or_soccer_count`, `wc_floor_below_minimum`, `skipped_by_horizon_count`, `skipped_by_cap_count`. Update `needs_rebuild` to flag WC floor < `BATTLE_WC_MIN_FLOOR=2`. Add same fields to `ReservationPlan.diagnostics`. |
| `app/api/cron/night-event-reservations/route.ts` | Add `horizon_end_iso` to `mode=status` response. |
| `scripts/contur3_premvp_doctor.sh` | Add checks for WC floor, `wc_floor_below_minimum`, `horizon_end_iso`, `latest_game_start_iso`. Add env-gated strict WC floor check (`DOCTOR_WC_MIN_EXPECTED`). Update sentinel to `ALL_PASS_CONTUR3_RESERVATION_HORIZON_READY`. |

---

## Expected Correct Reservation Set After Rebuild

Once the signal corpus contains all four WC matches (typically appears 2-6h before kickoff):

| Rank | Event | Start (UTC) | Start (Minsk) | Sport | Expected Status |
|---|---|---|---|---|---|
| 1 | Portugal vs Uzbekistan | 17:00 Jun 23 | 20:00 Jun 23 | WC | QUEUED (already past T-60) |
| 2 | England vs Ghana | 20:00 Jun 23 | 23:00 Jun 23 | WC | RESERVED or REBALANCE_PENDING |
| 3 | Panama vs Croatia | 23:00 Jun 23 | 02:00 Jun 24 | WC | RESERVED |
| 4 | Colombia vs DR Congo | 02:00 Jun 24 | 05:00 Jun 24 | WC | RESERVED |

Post-rebuild expected status:
- `activeFuture >= 3` (Portugal may already be QUEUED by the time you rebuild)
- `reserved_wc_or_soccer_count >= 4`
- `wc_floor_below_minimum = false`
- `latest_game_start_iso` = 2026-06-24T02:00:00Z or later
- `needs_rebuild = false`

---

## Why Market-Level Candidates Are Deferred

Market-level rebalance (`event_execution_queue`) fires at T-60 per event.
The reservation plan is event-level only — it says WHICH events to watch, not which market to trade.

At T-60 before each event, `event-rebalance` selects the best Tier1 market
(moneyline/spread/total) from the signal corpus for that reserved event and writes it
to `event_execution_queue`. Ireland then reads only from that queue.

Even after forceRebuild, queue candidates for Panama and Colombia will NOT appear until:
- Panama: ~22:00 UTC Jun 23 (T-60 before 23:00 UTC)
- Colombia: ~01:00 UTC Jun 24 (T-60 before 02:00 UTC)

---

## Expected Cron Sequence Today

| Time (UTC) | Time (Minsk) | Event |
|---|---|---|
| ~14:00 | 17:00 | night-event-reservations cron fires → freezes plan |
| ~14:05 | 17:05 | night-plan-email sent (reflects frozen plan) |
| ~15:00 | 18:00 | POST DEPLOY — forceRebuild to pick up 4 WC events |
| ~16:00 | 19:00 | event-rebalance for Portugal: queues T-60 candidate |
| ~17:00 | 20:00 | Portugal vs Uzbekistan kickoff |
| ~19:00 | 22:00 | event-rebalance for England: queues T-60 candidate |
| ~20:00 | 23:00 | England vs Ghana kickoff |
| ~22:00 | 01:00 | event-rebalance for Panama: queues T-60 candidate |
| ~23:00 | 02:00 | Panama vs Croatia kickoff |
| ~01:00 | 04:00 | event-rebalance for Colombia: queues T-60 candidate |
| ~02:00 | 05:00 | Colombia vs DR Congo kickoff |

---

## Expected Founder Emails

1. **17:00 Minsk** — Night Plan email (reflects 2-event plan BEFORE rebuild)
2. **Post-rebuild** — No automatic re-email; founder should check status manually
3. **At each rebalance** — No email; check `/api/executor/queue?includeUpcoming=1`
4. **After each EXECUTED mark** — Live execution proof (when Ireland unlocked)

---

## Post-Deploy Operator Commands

### Step 1: Verify deploy succeeded
Wait for Railway PREMVP to show deployment successful for the new commit.

### Step 2: Force rebuild to pick up all 4 WC events
Run from Windows (no jq required):
```
POST_DEPLOY_FORCE_REBUILD_WINDOWS.cmd
```
(in `modeling/fire_runs/20260623_contur3_reservation_horizon_repair/`)

Or from Bash (with jq):
```bash
curl -s -X POST \
  -H "x-executor-secret: $PPP_SECRET" \
  "https://polypropicks.com/api/cron/night-event-reservations?forceRebuild=CEO_APPROVED&source=manual_horizon_repair" | \
  jq '{reserved_count: .reserved_count, reserved_wc: .plan_health.reserved_wc_or_soccer_count, needs_rebuild: .plan_health.needs_rebuild, latest_game_start: .plan_health.latest_game_start_iso}'
```

### Step 3: Verify status
```bash
curl -s -H "x-executor-secret: $PPP_SECRET" \
  "https://polypropicks.com/api/cron/night-event-reservations?mode=status" | \
  jq '{active_future: .plan_health.active_future_count, wc_count: .plan_health.reserved_wc_or_soccer_count, wc_floor_ok: (.plan_health.wc_floor_below_minimum == false), latest_start: .plan_health.latest_game_start_iso, horizon_end: .horizon_end_iso}'
```

---

## GO/NO-GO Table

| Check | Expected After Rebuild | Action if FAIL |
|---|---|---|
| `reserved_wc_or_soccer_count >= 4` | ✅ | Re-run forceRebuild in 30 min |
| `wc_floor_below_minimum = false` | ✅ | Signal corpus not refreshed yet — wait |
| `needs_rebuild = false` | ✅ | Re-run forceRebuild |
| `latest_game_start_iso >= 2026-06-24T01:00Z` | ✅ | Signal for Colombia missing — wait |
| `bad_market_level_count = 0` | ✅ | Rebuild contains market-level keys — investigate |
| `active_future_count >= 3` | ✅ | One event may have passed T-60 already |
| `horizon_end_iso >= 2026-06-24T05:00Z` | ✅ | Code bug — STOP |

---

## Hard-Stop Status

Hard-stop remains ON. No live orders placed. Ireland not touched. M1-M7 package intact.
