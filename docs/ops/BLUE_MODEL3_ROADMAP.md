# Blue Model 3 Roadmap — Battle Contour Reliability

> Source-of-truth file for the Contur3 / Blue Model live-execution program.
> Supersedes the scope of `BLUE_MODEL2_ROADMAP.md` for reliability work.
> Last reconstructed: 2026-06-25 (post overnight Contur3 battle).

---

## 1. Executive verdict

- The Contur3 / Blue Model overnight battle **did NOT prove end-to-end live execution.**
  No order/ledger row has been confirmed for any match.
- The known **22:00 Minsk failure was `signals -> no reservations`** (the reservation
  builder / producer stage), **NOT Ireland.** Ireland had nothing to pull because no
  `executor_candidate_queue` row existed.
- The reservation-underfill patch (commit `78b192f`) **appears necessary and is partially
  proven** by production `reserved_count` rising 6 → 7 after deploy. It is **NOT fully
  proven**: there is still no queue → order/ledger trace.
- Blue Model 3 priority is **reliability gates and end-to-end proof**, not new model search.
  No model improvement work until Gates A–H (section 7) pass on a real window.

---

## 2. Overnight reconstructed timeline

| Time / order | Event | Evidence |
| --- | --- | --- |
| Pre-patch | Capped audits found invalid; full pagination reveals truth | ~18,746 rows fetched, 1,228 football markets, 7 should-have-reservation groups, 5 reservation gaps → `RESERVATION_UNDERFILL_CONFIRMED` |
| Pre-patch | Row-cap diagnosis: capped audit verdicts cannot be trusted | full-pagination diagnostic tooling added (`scripts/contur3/*`) |
| 2026-06-24 19:53 +0300 | Producer patch committed | `78b192f Contur3: fix reservation underfill canonical planning` — `lib/executor/buildFireModelCandidates.ts`, `lib/executor/nightEventReservations.ts`, `docs/ops/BLUE_MODEL2_ROADMAP.md` |
| Post-commit | Production deploy of `78b192f` verified successful at the time | founder confirmation; Railway PREMVP executor-candidates secret flag = PRESENT |
| Night | Production night reservations | `reserved_count=6` then `reserved_count=7` |
| Pre due window | Event rebalance | `due_count=0`, `queued_count=0`, `next_due_iso=2026-06-24T20:50:00Z` |
| 22:00 Minsk matches | The actual battle target | `generated_signal_pairs=256`, `night_event_reservations=0`, `executor_candidate_queue=0`, `order/ledger=0` → `SIGNALS_EXISTED_BUT_NO_RESERVATION_FOR_22_MATCHES` |
| Apparent readiness | Ireland looked ready | `PRE_FLIGHT_GO`, `trusted_puller_pid`, `live_loop_pid`, `CONFIRM_LIVE_ORDER=YES`, `live_enabled=YES`, `all_sports=YES` |
| 2026-06-25 00:01 +0300 | Later commit moved deploy on | `26a01a3 UI: add marquee matchup analytics SMS bridge` (the later UI/SMS commit Railway UI later showed as active) |
| Throughout | Daily ops visibility broken | `ops-report-email-cron` failed/crashed |
| End state | No live order proof | no confirmed CLAIMED/SENT queue row, no on-exchange order/ledger row |

---

## 3. Why the contour failed

Root cause chain for the 22:00 Minsk matches:

1. **Model/data layer — PASS.** `generated_signal_pairs = YES, 256 rows.`
2. **Reservation layer — FAIL.** `night_event_reservations = NO (0 rows)` for those matches.
3. **Rebalance layer — FAIL (no input).** `executor_candidate_queue = NO (0 rows)`;
   rebalance saw `due_count=0`, `queued_count=0`.
4. **Ireland layer — NOT THE CAUSE.** Ireland looked ready but had **nothing to pull**;
   no queue row ever existed.
5. **Order layer — FAIL.** `orders/ledger = NO (0 rows)`.

**Failure stage = `SIGNALS_TO_RESERVATIONS` (reservation builder underfill / timing).**

- 22:00 Minsk matches had generated signals but no reservations.
- No queue rows existed → Ireland could not pull → no order could be placed.
- The later production `reserved_count=7` **does not retroactively save the missed matches.**
  `reserved_count` alone is **not** battle success.

This is fully consistent with founder evidence; no repo artifact contradicts it.

---

## 4. What was fixed / preserved

All of the following are **committed and in current HEAD ancestry** (verified):

- **Row-cap diagnosis** — capped audits proven invalid; full-pagination is the only valid mode.
- **Full-pagination diagnostic tooling** — `scripts/contur3/`:
  `funnel-trace-audit.mjs`, `why-no-bets-last-night.mjs`, `run-overnight-battle-audit.mjs`,
  `reservation-admission-audit.mjs`, `rebalance-window-audit.mjs`, `verify-live-market-guards.mjs`,
  `blue-model-status.mjs`, `run-night-reservations.mjs`, `run-event-rebalance.mjs`,
  `run-ops-report-email.mjs` (all registered as `contur3:*` npm scripts).
- **Producer reservation-underfill patch (`78b192f`)** in `lib/executor/nightEventReservations.ts`
  and `lib/executor/buildFireModelCandidates.ts`:
  - **Canonical physical-match key** — every market form (any key shape / team order) maps to
    one canonical representative `pair:a-vs-b:date` key.
  - **Weak single-team key merge** — single-team SPREAD/MATCH_WINNER keys merge into the
    opponent pair when it exists, otherwise stand alone (so the Tier1 invariant still reserves
    them). Pure condition-id keys with no canonical identity are the only forms that cannot
    reserve.
  - **Representative-title contamination guard** — a forbidden-anchor candidate is never
    allowed to become the representative title.
  - **Tier1 full-match underfill invariant** — `rankable.length - reservations.length === 0`
    enforced and counted (`underfillInvariantPass`).
- **Producer patch deployed and pushed** — confirmed; `reserved_count` rose 6 → 7 in production.
- **Committed diagnostic scripts** — all `contur3:*` scripts present in `package.json`.

---

## 5. What remains broken / unproven

- **No end-to-end order proof** — no queue → CLAIMED/SENT → order/ledger trace exists.
- **No automatic stage table every run** — stage funnel not printed per run by default.
- **No reliable one-command battle gate** — diagnostics are split across multiple scripts.
- **`ops-report-email-cron` failed/crashed** — daily ops visibility is broken.
- **Deployment identity missing from production health** — cannot confirm which commit is live
  from the app itself (Railway UI showed `26a01a3`, not `78b192f`, as active later).
- **Railway console heredoc / truncation risk** — long fragile heredocs unsafe for operators.
- **Runtime artifacts scattered** — battle outputs not collected into one curated location.
- **Ireland queue pull not linked to order proof in the report** — readiness ≠ execution.
- **Battle watcher reliability not formalized** — no enforced watcher with terminal state.

---

## 6. Permanent invariants

1. Every real upcoming football/WC physical match should have at least one Tier1 full-match
   candidate unless full-pagination raw DB proof says otherwise.
2. "No Tier1 for a real match" is a **P0** anomaly.
3. "Reservations fewer than physical Tier1 matches" is a **P0** anomaly.
4. Capped audit verdicts are **invalid**.
5. Fuzzy matching **cannot** prove a reservation exists.
6. A battle run is successful only with:
   `signals -> reservations -> queue -> Ireland CLAIMED/SENT -> order/ledger proof`.
7. `reserved_count` alone is **not** battle success.
8. `queue_count=0` means current live bet probability is **0**.
9. If there are signals but no reservations, the failure stage is the **producer/reservation
   builder**, not Ireland.
10. Every future battle report **must** print a stage table.

---

## 7. Required Blue Model 3 gates

| Gate | Stage | Pass condition | Failure verdict |
| ---- | ------------------------ | ------------------------------------------ | -------------------------------------------- |
| A | generated_signal_pairs | full-pagination rows for physical matches | NO_SIGNAL_ROWS |
| B | night_event_reservations | one reservation per Tier1 physical match | SIGNALS_BUT_NO_RESERVATION |
| C | event_rebalance | due reservations become queue rows | RESERVED_BUT_NOT_QUEUED |
| D | executor_candidate_queue | queue row has status/stake/token/condition | QUEUE_INCOMPLETE |
| E | Ireland puller | CLAIMED/PULLED row visible | QUEUED_BUT_NOT_PULLED |
| F | live sender | order attempt visible | PULLED_BUT_NOT_SENT |
| G | order/ledger | order id or ledger row recorded | LIVE_ORDER_SENT / ORDER_REJECTED_WITH_REASON |
| H | report artifact | one MD/JSON summary written | REPORT_MISSING |

---

## 8. Priority roadmap

### P0
- One-command battle gate (single entry running Gates A–H).
- Previous-match forensic (why-no-bets for an arbitrary past window).
- Stage table artifact written every run.
- Reservation invariant enforcement (Gate B as a hard gate).
- Queue/order ledger proof (Gate G).
- Cron health (detect failed crons).

### P1
- `ops-report-email-cron` fix.
- Production commit/version health endpoint.
- Ireland readiness proof command.
- Automatic postmortem collector.

### P2
- Dashboard.
- Daily email integration.
- Model improvement — only **after** reliability gates A–H pass.

---

## 9. Operator rules

- Max **1 command per decision** when possible.
- **No long fragile heredocs** in Railway.
- Use file-write scripts or checked-in scripts.
- Never rely on a Claude summary without table proof.
- Every output must say **whether a bet actually placed** (order/ledger), not just reserved_count.

---

## 10. Next patch tasks

| Suggested commit name | Scope |
| --- | --- |
| `Ops: add Contur3 one-command battle gate` | single command runs Gates A–H, prints stage table |
| `Ops: add previous-match battle forensic` | forensic for any past window, full pagination |
| `Ops: add Ireland queue/order proof checker` | link queue pull → CLAIMED/SENT → order/ledger |
| `Ops: add production commit health endpoint` | expose live deployed commit/version |
| `Ops: repair ops report email cron` | fix failed/crashed daily ops email cron |
| `Ops: write battle postmortem artifact after every run` | persist one MD/JSON summary per run |

**Do not claim success without order/ledger proof.**

---

## 11. Founder-visibility / cron decoupling (2026-06-25)

**Problem.** Two crons silently failed and the founder received no report:
- `signal-resolve-cron` → `DB select failed: canceling statement due to statement timeout`
  (unbounded `signal_result is null` backlog SELECT sorted by `created_at`).
- `ops-report-email-cron` → `morning:model-report` raised
  `DB_STRICT_CORPUS_RPC_MISSING: canceling statement due to statement timeout`,
  and the dispatcher threw on the first nonzero exit (`stdio: "inherit"`),
  so a single heavy-job timeout killed the whole founder email.

**New architecture (two modes).**

- **MODE A — producer/materializer** (`npm run ops:precompute-founder-status`,
  `scripts/build-founder-status-snapshot.ts`). Runs the bounded lightweight
  Contur3 probe ahead of delivery and writes
  `reports/morning/latest_founder_status_snapshot.{json,md}` (runtime artifacts,
  gitignored). Never sends email; never runs the heavy strict-corpus model.
- **MODE B — email delivery** (`scripts/founder-email-dispatcher.ts`). Now:
  1. captures child output and classifies **DB-timeout** failures vs real bugs;
  2. treats resolver DB timeouts as **WARN**, not fatal;
  3. on `morning:model-report` timeout, builds a **DEGRADED** report from the
     lightweight probe + latest snapshot and still delivers it
     (`MORNING_MODEL_TIMEOUT_DEGRADED_REPORT`);
  4. supports `--use-latest-snapshot` to skip heavy jobs and deliver the
     precomputed snapshot — the target cron path
     (`npm run ops-report-email-cron:snapshot`).

  Fatal remains: missing recipient/provider on real send, non-timeout code
  exceptions, and "no snapshot AND lightweight probe also failed".

**Snapshot freshness rule.** ≤2h OK · 2–6h WARN (still send) · >6h
DEGRADED_STALE (still report) · missing → DEGRADED_NO_SNAPSHOT (run probe).

**Resolver bounded-scan mitigation.** `resolve-signals.ts` gained opt-in
`--max-age-days` / `--created-after`. `resolve:signals:cron` now passes
`--max-age-days=30` so the planner only sorts the recent unresolved window;
`resolve:signals:cron-deep` preserves the old unbounded sweep for backfill.

**Recommended Railway cron wiring.**
1. Schedule `ops:precompute-founder-status` ~15 min before each report.
2. Point `ops-report-email-cron` at `--use-latest-snapshot` for delivery.

### Remaining TODO
- `IS_MODEL_KPI_SOURCE_MISSING`: snapshot reports Fire KPI freshness from the
  latest `modeling/fire_runs` artifact timestamp only; no dedicated IS-model KPI
  source is wired into the snapshot yet.
- Root-cause the `generated_signal_pairs` index so the deep resolver sweep can
  run without a date window.

---

## 12. Curaçao reservation underfill — admission analysis (2026-06-25)

Production proof (capacity-audit + tier-probe) for the 6-fixture FIFA slate:
5/6 reserved; **Curaçao vs Côte d'Ivoire** missing despite 109 raw allowed
full-match signal rows.

**Code-traced mechanism (not a producer bug):**
- `buildFireModelCandidates.ts` emits a candidate per signal row only if
  `score≥50 & coverage≥25` (`computeTier`; guards `LOW_SCORE`<50, `LOW_COVERAGE`<25
  at lines 805-806). `score = signal_confidence_num`, `coverage = diagnostics.dataCoverage`
  — **per row**, not aggregated across the match family.
- The producer (`nightEventReservations.ts:355,370`) filters forbidden anchors
  (halftime/corners/props) then reserves a group only if its best non-forbidden
  candidate is **TIER1** (`score≥72 & cov≥50`).
- The prod tier-probe found Curaçao's only emitted candidates were 2 **halftime**
  TIER1 rows. Therefore **no full-match Curaçao row reached even Tier3** — else it
  would have been emitted, and any full-match TIER1 row would have been reserved.
- The producer is correctly refusing to anchor a live reservation on a halftime
  market. Reserving Curaçao from sub-Tier1 full-match rows would **weaken the live
  scoring policy** (forbidden).

**Open question (resolved by one prod run):** are the 109 full-match rows
genuinely sub-threshold (correct skip) or suppressed by a wrong guard
(`FOOTBALL_NO_SIDE`, `BAD_BUCKET_COV_PRICE`, etc.)? The enhanced
`contur3:reservation-tier-probe` LAYER B prints the per-row admission histogram +
best full-match score/coverage to decide:

- `WOULD_BE_TIER1 > 0` in LAYER B but absent in LAYER A → **real builder bug**, fix exact guard.
- all `LOW_SCORE` / `TIER_BELOW_THRESHOLD` → correct skip → **PRODUCER_PATCH_BLOCKED_NO_SAFE_ALLOWED_CANDIDATE**.
- `FOOTBALL_NO_SIDE` dominating → targeted side-mapping fix.

No producer/builder logic changed in this commit (read-only diagnostics only);
the 5 working reservations are untouched.
