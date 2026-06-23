# M1–M7 Post-Battle Execution Roadmap

Generated: 2026-06-23. Status: pre-first-live-order.

---

## M1 — Unknown Market Classification

**Task:** Classify markets labelled UNKNOWN/WEAK or missing activity label. Build allow/block/needs-data matrix.

**Why:** Without classification, good markets are blocked and trash markets can slip through. Market identity is the foundation for all downstream policy.

**Owner:** Claude Code (automated analysis) + Operator review

**Data source:** `night_event_reservations`, `event_execution_queue`, signal corpus, `market_slug`/`market_family` columns

**Allowed files:**
- `lib/executor/buildFireModelCandidates.ts` (read-only analysis)
- `modeling/fire_runs/20260623_contur3_battle_launch/`

**Expected artifact:** `M1_UNKNOWN_MARKET_MATRIX.md` — table of market slugs/families with ALLOW/BLOCK/NEEDS_DATA verdict and reason

**Definition of PASS:** Every market that enters `event_execution_queue` has a non-UNKNOWN activity label OR is explicitly ALLOW-listed with rationale

**Pre/post live order:** Can run BEFORE first live order (analysis only)

---

## M2 — eSports Profitability

**Task:** Disaggregate eSports rows by market family. Produce allow/skip/stake recommendation per eSports subtype.

**Why:** Blanket banning eSports loses alpha if specific game categories are profitable. Blanket allowing is risky without table.

**Owner:** Claude Code analysis after ≥10 resolved eSports signals exist

**Data source:** Resolved signal corpus filtered by `sport='esports'` or similar label

**Allowed files:** `modeling/fire_runs/20260623_contur3_battle_launch/`

**Expected artifact:** `M2_ESPORTS_PROFITABILITY.md` — ROI proxy by eSports market family, recommendation per family

**Definition of PASS:** Decision table exists with per-family recommendation. No blanket ban or blanket allow without data.

**Pre/post live order:** AFTER first live order data available (needs resolved rows)

---

## M3 — MLB & Other Sports

**Task:** Profitability analysis by sport + market family + timing bucket. No blind MLB inclusion/exclusion.

**Why:** MLB markets behave differently by timing (pre-game vs in-game totals). Timing + market family interaction matters.

**Owner:** Claude Code analysis after resolved rows exist

**Data source:** Signal corpus, resolved `event_execution_queue` rows, `game_start_iso` vs execution timing

**Allowed files:** `modeling/fire_runs/20260623_contur3_battle_launch/`

**Expected artifact:** `M3_MLB_SPORTS_MATRIX.md` — sport × market_family × timing ROI proxy + recommendation

**Definition of PASS:** Each sport has an explicit policy row (ALLOW/BLOCK/CONDITIONAL) in the matrix

**Pre/post live order:** AFTER first live order (needs real execution data)

---

## M4 — Football Market Policy

**Task:** Define rules for spread/total/corners/moneyline for football. Which football markets are executable vs blocked.

**Why:** Football is the highest-volume sport. Without policy, both overexposure and missed alpha are risks.

**Owner:** Claude Code + Operator review

**Data source:** Resolved football signal corpus, market family labels

**Allowed files:** `modeling/fire_runs/20260623_contur3_battle_launch/`, `lib/executor/executorQueueTypes.ts` (read)

**Expected artifact:** `M4_FOOTBALL_MARKET_POLICY.md` — market_family → EXECUTABLE/BLOCKED/CONDITIONAL table

**Definition of PASS:** Every football market that enters the queue is covered by a policy row

**Pre/post live order:** Can start BEFORE live order (policy design), finalize after data

---

## M5 — Entry Timing Optimization

**Task:** Measure performance by entry timing bucket: T-60, T-45, T-30, T-5 relative to game start.

**Why:** Current policy is T-45 preferred, T-5 latest. If T-30 is better (tighter spreads, better odds), policy should shift.

**Owner:** Claude Code analysis after ≥20 resolved execution rows exist

**Data source:** `event_execution_queue.preferred_entry_iso`, `game_start_iso`, resolved outcome

**Allowed files:** `modeling/fire_runs/20260623_contur3_battle_launch/`

**Expected artifact:** `M5_ENTRY_TIMING_ANALYSIS.md` — win rate / ROI proxy by timing bucket, recommendation

**Definition of PASS:** Timing recommendation with confidence interval, not just raw counts

**Pre/post live order:** AFTER ≥20 live orders (needs real timing data)

---

## M6 — FireModel Linkage (Real Uplift)

**Task:** Link `model_id` / `run_id` / `queue_id` / `execution` / `outcome`. Prove FireModel provides real uplift vs random Tier1 baseline.

**Why:** Screenshots of backtest are not proof. Real uplift must come from live execution linked to model output.

**Owner:** Claude Code after live data accumulates

**Data source:** `event_execution_queue.plan_run_id`, `rebalance_run_id`, FireModel run artifacts, resolved outcomes

**Allowed files:** `modeling/fire_runs/`, read-only analysis scripts

**Expected artifact:** `M6_FIREMODEL_REAL_UPLIFT.md` — execution-linked ROI vs naive baseline, sample size, confidence

**Definition of PASS:** Uplift table exists with linked model_id → execution → outcome chain. Not screenshot, not simulated.

**Pre/post live order:** AFTER ≥30 live orders (needs statistically meaningful real data)

---

## M7 — Founder Reports (Night Plan + Morning Proof + PnL)

**Task:** Every battle night, founder receives: (1) Night plan email before battle; (2) Morning execution proof; (3) PnL summary by event.

**Why:** Without structured reports, founder cannot supervise execution or detect anomalies.

**Owner:** Claude Code (automation), Railway cron, morning report patch if needed

**Data source:** `night_event_reservations`, `event_execution_queue`, `executor_order_events`

**Allowed files:** `app/api/cron/night-plan-email/route.ts`, `app/api/cron/morning-report` (if exists)

**Expected artifact:** `M7_FOUNDER_REPORT_SPEC.md` — spec for all three report types + Railway schedule

**Definition of PASS:** All three reports are delivered automatically for every battle night without founder manual action

**Pre/post live order:** Night plan report works NOW. Morning proof report depends on first live order.

---

## Summary Table

| M  | Name                    | Pre-live? | Owner         | Blocks next M? |
|----|-------------------------|-----------|---------------|----------------|
| M1 | Unknown classification  | YES       | Claude Code   | M2, M3, M4    |
| M2 | eSports profitability   | NO        | Claude Code   | No             |
| M3 | MLB/other sports        | NO        | Claude Code   | No             |
| M4 | Football policy         | Partial   | Claude+Oper.  | No             |
| M5 | Entry timing            | NO        | Claude Code   | M6            |
| M6 | FireModel linkage       | NO        | Claude Code   | No             |
| M7 | Founder reports         | Partial   | Claude+Cron   | No             |
