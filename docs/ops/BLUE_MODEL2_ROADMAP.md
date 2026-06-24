# Blue_model2 — Contur3 Producer Roadmap

_Last updated: 2026-06-24 (Contur3 reservation-underfill FIX staged — pending deploy)._

## 2026-06-24 — RESERVATION_UNDERFILL fix (staged, NOT deployed)

Full-pagination capacity audit confirmed `RESERVATION_UNDERFILL_CONFIRMED`:
18,746 rows / 1,228 football markets, **7** should-have-reservation physical matches,
only **2** future reservations, **5** Tier1 full-match gaps.

**Exact root cause (3 mismatches; A dominant):**
- **A. Row cap in the builder universe.** `buildFireModelCandidates` capped planning at
  `.limit(300)` (scored) + `.limit(300)` (shadow), then `nightEventReservations` sliced to
  `PLAN_POOL=200`. The capacity audit paginates the full corpus. The builder saw a
  recency-biased ≤200 slice, so most physical matches never reached grouping.
- **B. Weak single-team keys discarded.** `isWeakEventKey()` skipped
  `WEAK_SINGLE_TEAM_SPREAD:*` and `WEAK_SINGLE_TEAM_MATCH_WINNER:*` outright.
- **C. No canonical physical-match merge.** Raw `a vs b` slugs, `pair:` keys, order
  variants, and weak single-team keys were never collapsed to one physical match.

**Fix (allowed files only, no policy change):**
- `lib/executor/buildFireModelCandidates.ts` — planning mode now fetches the COMPLETE
  universe via `.range()` pagination bounded by a 72h `created_at` lookback (mirrors the
  audit corpus; the live `.limit(150)` path is unchanged).
- `lib/executor/nightEventReservations.ts` — `PLAN_POOL` raised to an uncapped ceiling; a
  canonical `physical_match_key` collapses every two-team shape (pair / raw `a vs b` /
  order-variant) to one representative; weak single-team SPREAD/MATCH_WINNER keys merge
  into their pair or stand alone (never discarded); forbidden anchors can never be the
  representative title; new invariant counters
  (`tier1PhysicalMatchesSeen/Planned/GapsAfterBuild`, `weakKeysMerged`,
  `representativeTitleReplaced`, `completeCandidateUniverseUsed`, `underfillInvariantPass`).

**Local read-only proof** (`tsx scripts/preview-night-event-reservations.ts`, no writes):
universe 334 → **7 unique Tier1 reservations** (5 WC + 2 MLB), `tier1ReservationGapsAfterBuild=0`,
`underfillInvariantPass=true`, P0 guard PASS (no market-level keys/titles, no duplicates).
The 5 audit gaps are all covered (3 pairs + bosnia spread → `pair:bosnia-herzegovina-vs-qatar`,
korea match-winner → `pair:south-africa-vs-korea-republic`).

**STATUS: code fix verified locally; NOT deployed.** The DB-writing producer runs in
production (`run-night-reservations.mjs` POSTs to polypropicks.com). DB closure of
`reservation_gaps_count → 0` and a green `blue2-battle-gate` require a founder deploy of
this patch followed by a night-reservations run. No commit/push/deploy performed.

---

_Prior entry (2026-06-24 — pre-fix investigation, now superseded by the above):_

## Current truth (measured, not assumed)

One command now replaces the 5-script ritual:

```bash
npm run contur3:blue2-battle-gate
```

It aggregates funnel-trace, reservation-admission, rebalance-window,
reservation-capacity, and producer-due-window-sim, then prints one CEO summary.
It never aborts when a sub-audit exits non-zero.

Measured on 2026-06-24 (two consecutive runs):

| Signal | Value |
|--------|-------|
| Admitted candidates (admission audit) | 223 / executable anchors 204 |
| Future valid executable event groups | ~21 (volatile sample) |
| Actual future valid reservations | 2 |
| **Truly-missing valid TIER1 events (capacity audit, dedup by team signature)** | **0** |
| Capacity blocked-by-reason | dominated by `forbidden_anchor` (halftime) + `non_tier1` |
| Producer due-window sim | both future reservations WOULD become READY at T-69/T-30/T-4 |
| Missed rebalance windows (EXPIRED / MISSED_REBALANCE_WINDOW) | 6 |

## Exact bug verdict

**No exact, reproducible code bug in the producer files** (`nightEventReservations.ts`,
`eventExecutionQueue.ts`, cron routes). Evidence:

1. **Capacity audit: `truly_missing_valid_count = 0`** across runs. The 21 "valid
   executable event groups" reported by admission are NOT all reservable — once
   collapsed to canonical events and de-duplicated by team signature, every shortfall
   is explained by a **locked filter**, not a dropped TIER1 event:
   - `forbidden_anchor` — halftime/corners/props markets (correctly excluded).
   - `non_tier1` — events whose best executable anchor is TIER2/TIER3 (TIER1-only
     reservation policy is locked; expanding it is a PRODUCT decision, not a bug fix).
2. **Producer due-window sim** proves the existing reservations would correctly
   become READY at T-69/T-30/T-4. The T-70..T-3 window gate is correct.
3. The candidate universe is volatile run-to-run (expected count swung 5→0 in 90s),
   confirming the low reservation count tracks **live TIER1 supply**, not a code break.

The only operational defect signal is **6 `MISSED_REBALANCE_WINDOW` expiries** — a
**Railway scheduler gap**, not a code bug. The code-level window logic is correct.

### Verdict: `RESERVATION_UNDERFILLED_BY_FILTER` (policy-correct) + `REBALANCE_SCHEDULE_GAP` (Railway)

No producer code was patched. Patching would have loosened locked TIER1 / forbidden-anchor
policy or duplicated a Railway scheduler setting in code — both forbidden.

## Remaining gates

- [ ] **Railway (operator-only):** confirm `contur3-event-rebalance-cron` schedule is
      `* * * * *` (continuous 24/7). The 6 missed windows indicate a daypart gap or
      paused cron. Business entry window T-70..T-3 is enforced in code, never in cron.
- [ ] After fixing the cron, re-run `npm run contur3:blue2-battle-gate`; expect
      `MISSED_REBALANCE_WINDOWS = 0` going forward.
- [ ] Product decision (NOT this task): whether to expand reservations beyond TIER1.
      If yes, that is a deliberate policy change with its own authorization.

## Operator action count: **1**

1. Set/confirm Railway `contur3-event-rebalance-cron` = `* * * * *` (continuous).

That is the only manual step. Everything else (diagnosis) is one local command.

## Workflow rules

- **No Railway-console-first workflow.** Diagnosis runs locally via
  `npm run contur3:blue2-battle-gate`. The audits auto-load `.env.local`.
- **Local env configured once.** Required names in
  [`BLUE_MODEL_LOCAL_ENV_REQUIRED.md`](./BLUE_MODEL_LOCAL_ENV_REQUIRED.md);
  both present as of 2026-06-24.
- Railway console is reserved for the one cron-schedule setting above.

---

## Forensic conclusion — Next-18h raw market tier dump (2026-06-24T12:18Z)

Run: `npm run contur3:next18-market-tier-dump`
Artifacts: `modeling/fire_runs/contur3-blue-model/2026-06-24T12-18-06Z_next18_*`

The previous capacity audit used a 200-row corpus cap (`.limit(PLAN_POOL+100).slice(0,200)`).
The raw dump uses **full `.range()` pagination — 18,803 rows fetched, no cap.**

Raw DB truth for the next 18h:
- football_markets_count = **1229** across **20** market-family groups (~6 physical WC matches).
- events_with_tier1_executable_fullmatch = **7**; events_should_have_reservation = **7**.
- **future_reservations_in_table = 2** (Brazil–Scotland, Morocco–Haiti, both RESERVED/TIER1).
- reservation_gaps_count = **5**, of which the gap events have **exact=NO AND fuzzy=NO**
  (genuinely unreserved by any key): Switzerland–Canada O/U 2.5 (19:00),
  Czechia–Mexico O/U 2.5 (01:00), Mexico Match Winner (01:00),
  South Africa–Korea Republic O/U 2.5 (01:00), Bosnia (-1.5) spread (19:00).

**Disproven:** the "no football markets" reading of `0/2`. Football markets clearly exist
(1229 in-horizon); the producer is **underfilling reservations** — at least 3 distinct physical
matches carry TIER1 executable full-match O/U / moneyline candidates yet have zero reservation.

**Tool verdict: `RAW_DB_INCONCLUSIVE_KEY_MATCH`** (conservative): the *reserved* side
(Brazil/Morocco) matched only via fuzzy team signature for some alt-key groups
(`actual_future_reservations_matched=7` inflated against just 2 real reservations).
The *gap* side does NOT depend on fuzzy matching. Next step is to confirm the canonical
reservation join key in `nightEventReservations.ts` so the gap events can be promoted from
INCONCLUSIVE to a clean UNDERFILL proof. Most per-event noise is policy-blocked corners/halftime
(84–192 blocked markets per event), which is correct and not the cause of the shortfall.

---

## Permanent fix — capacity audit row-cap bug (2026-06-24, full-pagination mandate)

### Capped audits are INVALID
Every earlier `reservation-capacity-audit` verdict (including the
`RESERVATION_UNDERFILLED_BY_FILTER (policy-correct)` / `truly_missing_valid_count = 0`
conclusion recorded above) was produced from a **capped corpus** and must be treated as
statistically void. Do not cite the "0 truly missing / policy-correct" result.

### Exact bug
`reservation-capacity-audit used a capped corpus (.limit(PLAN_POOL + 100) then
.slice(0, PLAN_POOL), PLAN_POOL=200), so the final corpus was only ~200 of ~18,800
matching rows; full pagination is now mandatory.`

The script was rewritten to fetch the **entire** matching corpus via Supabase `.range()`
pagination (page size 1000, no final-corpus cap) and now mirrors the exact pagination +
classification used by `next18-market-tier-dump.mjs` so the two scripts cannot disagree.

A hard self-check (`assertNoRowCapPatterns`) scans the audit's own source on every run and
aborts with `FATAL_ROW_CAP_PATTERN_PRESENT` if any forbidden final-corpus cap
(`.slice(0,200/300/500)`, `.limit(PLAN_POOL…`, `.limit(300)`) is reintroduced. Only
`.range()` pagination is permitted. This prevents the bug from silently returning.

The audit now emits three full, football-first tables (also written as CSV + MD artifacts):
`EVENT_SUMMARY_NEXT_18H_FOOTBALL_FIRST`, `RESERVATION_GAPS_TABLE`,
`ALL_FOOTBALL_MARKETS_NEXT_18H`. `blue2-battle-gate` consumes the new fields and, when
`reservation_gaps_count > 0`, sets `BUG_STAGE = RESERVATION_UNDERFILL_CONFIRMED` (never CAP_OK).

### Current suspected business bug (NOT yet fixed)
`reservation builder underfills when Tier1 football candidates exist but no reservation is
created` — i.e. physical matches carry a Tier1 full-match executable candidate (O/U /
moneyline) inside the 18h horizon yet have no active future reservation by exact OR fuzzy key.

This is a **diagnosis only**. The reservation-builder producer code
(`lib/contur3` `nightEventReservations` / `buildReservationPlan`) has **NOT** been patched in
this task. Do not claim the reservation-builder is fixed until that producer code is patched
under its own authorized task. No live policy, stake, or market allowlist was changed here.
