# Blue_model / Contur3 Validation Log

---

## 2026-06-23 — V0 Supervised-Live Validation

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-23

### Repo State

| Field | Value |
|---|---|
| Repo | `C:\WORK\KalshiProPulse\sipropicks-premvp1-1` (PREMVP — correct repo) |
| Branch | `main` |
| HEAD | `7f60ea9ffaa4d21c4f72bd31c24f9e12f03e156f` |
| origin/main | `7f60ea9ffaa4d21c4f72bd31c24f9e12f03e156f` (in sync) |
| Key commits present | `7f60ea9` fix Blue_model status clean exit ✓ |
| | `deb13d6` add Blue_model deterministic Contur3 runners ✓ |
| | `32fade9` prevent halftime anchors blocking queue ✓ |
| | `6273711` fix Contur3 reservation funnel loss ✓ |
| | `dce2d18` persist Contur3 reservation diagnostics ✓ |

### Package Scripts

| Script | Status |
|---|---|
| `contur3:night-reservations` | ✓ present |
| `contur3:event-rebalance` | ✓ present |
| `contur3:blue-status` | ✓ present |
| `contur3:ops-report-email` | ✓ added this session |

### Blue-Status Code Validation

| Field | Value |
|---|---|
| Secret available locally | **NO** — `.env.local` has `PPP_SESSION_SECRET` but not `EXECUTOR_CANDIDATES_SECRET`/`EXECUTOR_SECRET`/`PPP_SECRET` |
| Secret in Railway | YES (runtime only) |
| libuv assertion | **ABSENT** — `process.exitCode` + `.unref()` timeout strategy used |
| `[object Object]` bug | **ABSENT** — `JSON.stringify(..., null, 2)` used for `next_due_reservation` and `ireland_contract` |
| ARMED_WAITING exit code | **0** (correct) |
| GO_READY exit code | **0** (correct) |
| NO_GO exit code | **1** (correct) |
| MISSING_SECRET exit code | **1** (correct) |
| Code-level verdict | **PASS** |

**Verdict: `BLUE_MODEL_V0_CODE_VALIDATED_SECRET_RUNTIME_PENDING`**

Runtime validation (with real secret) must be run from PREMVP repo on Railway or via Railway shell.

### Ireland Queue-Only Proof

From prior session evidence (grep on Ireland machine):

| Check | Result |
|---|---|
| Active path `/night-plan` | **ABSENT** |
| Active path `generated_signal` direct | **ABSENT** |
| Active path `choose_candidates`/`rank` | **ABSENT** |
| Active watcher reads | `/api/executor/queue?includeUpcoming=1` ✓ |
| Queue source expected | `event_execution_queue` |
| `do_not_rank=true` | enforced at queue-build layer |
| `do_not_pull_broad_candidates=true` | enforced at queue-build layer |

Ireland watcher: `contur3_battle_queue_only_watcher.py` — queue-only, no broad-pull, no rank, no night-plan call.

### Hard-Stop Status

Hard-stop files (`/tmp/PPP_LIVE_HARD_STOP`, `data/PPP_LIVE_HARD_STOP`) confirmed **ABSENT** — live armed mode is expected.

### Execution Contract (current)

- Tier 1 only — no Tier2/Tier3
- Full-match / game-level only
- No halftime, no first-half
- No corners, no props, no futures, no outrights
- Stake from queue only, cap $7/event
- `one_position_per_event=true`
- `do_not_rank=true`
- `do_not_pull_broad_candidates=true`

### Market Policy Notes

- **Portugal NO_GO** under current contract: only halftime Tier1 / corners side-market were strong; both are forbidden
- **WC side-market / corners policy** remains P2 backlog
- Do NOT enable Portugal/corners/side-market execution without explicit founder approval

### Ops Email Status

**2026-06-23 — pipeline sequence verified + executor secret gate removed (session 3)**

| Field | Value |
|---|---|
| Runner file | `scripts/contur3/run-ops-report-email.mjs` |
| Railway Start Command | `node scripts/contur3/run-ops-report-email.mjs` |
| Code syntax check | PASS |
| Build | PASS |
| Runtime verdict | `OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING` |
| Missing env locally | `RESEND_API_KEY`, `EMAIL_FROM`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

**Root cause of Railway cron failure (confirmed):**
Runner previously required `EXECUTOR_CANDIDATES_SECRET`/`EXECUTOR_SECRET`/`PPP_SECRET` as preflight gate.
This secret is NOT present in `ops-report-email-cron` Railway service (only in execution service).
Pipeline failed at preflight — before any DB query or artifact was written.

**Pipeline sequence (verified filesystem-first):**
The `founder-email-dispatcher.ts --mode=morning` sequence is:
1. `resolve:signals:live-priority` → Supabase write (generated_signal_pairs)
2. `resolve:signals:cron` → Supabase write (expire/resolve signals)
3. `verify:resolver-pipeline` → read-only validation
4. `morning:model-report --send-test` → fetch DB → write CSV/MD/XLSX to `modeling/morning_model_report/<date>/` → send email via Resend

Email is always last. Artifacts are verified to be non-empty before send (dataset staleness check throws if rows ≤ baseline).

**Fix applied (session 3):**
- Removed `getSecret()` / executor secret gate from runner (wrong gate for email-only pipeline)
- Pre-flight checks now: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`
- `phase` field added to JSON report: `preflight_failed` / `pipeline_failed` / `complete`
- stdout/stderr captured and saved in JSON report

**Operator action required:**
1. In Railway → `ops-report-email-cron` → Variables: confirm `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` are set (no executor secret needed)
2. Start Command must be: `node scripts/contur3/run-ops-report-email.mjs`
3. After next run, check `modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json` for verdict and stdout/stderr

Email is a **monitoring rail**, not an execution gate. Ireland watcher is unaffected by email failures.

---

## 2026-06-23 — Live-priority ledger: Supabase source fix (session 4)

**Validated by:** Claude Code (Sonnet 4.6), session 2026-06-23

### Bug Found and Fixed

| Field | Value |
|---|---|
| Broken script | `scripts/resolve-signals.ts` — `--priority-live-ledger` path |
| Old wrong behavior | Read `modeling/morning_model_report/20260618_0600UTC/tables/night_execution_detail.csv` — a hardcoded old report OUTPUT used as INPUT |
| Failure on Railway | `LIVE_PRIORITY_LEDGER_ARTIFACT_MISSING` — Railway filesystem is ephemeral, old CSV never exists |
| New correct behavior | Query `executor_order_events` Supabase table, last 24h, `dry_run=false`, `live_confirm=true OR success=true` |

### Source of Truth

| Table | Purpose |
|---|---|
| `executor_order_events` | All order events from Ireland watcher. Live bets have `dry_run=false` and `live_confirm=true` or `success=true`. Columns: `token_id`, `order_status`, `market_slug`, `selected_side`, `candidate_snapshot_json` (has `condition_id`, `event_slug`). |

### Resolver Behavior After Fix

| Case | Log | Exit |
|---|---|---|
| Live bets found in last 24h | `LIVE_PRIORITY_LEDGER_SUPABASE_ROWS_LOADED count=<n>` | 0 |
| No live bets last 24h (ARMED_WAITING) | `LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H` | 0 |
| Supabase query failed | `LIVE_PRIORITY_LEDGER_SUPABASE_QUERY_FAILED: <msg>` | 1 |

### Bounded Test Result

```
npx tsx scripts/resolve-signals.ts --priority-live-ledger --dedupe-strict --limit=5 --max-updates=5
→ LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H  (ARMED_WAITING, no live bets yet)
→ EXIT 0
```
No `ARTIFACT_MISSING`. No old CSV reference.

### Fresh Artifact Generation (morning-model-report)

Confirmed: `morning-model-report.ts` fetches Supabase data (`fetchAllResolvedRows`), writes fresh CSV/MD/XLSX to `modeling/morning_model_report/<current_run>/`, then sends email. Email is always last. Old CSV is never an input.

### Build/Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `git diff --check` | PASS (LF/CRLF warnings only) |
| `node -c run-ops-report-email.mjs` | SYNTAX_OK |
| Bounded resolver test | EXIT 0 — correct Supabase path |

### Commit

`Ops: source email live priority from Supabase bets ledger`

### Next Railway Action

Deploy latest `main` → Railway `ops-report-email-cron` → **Run now** → inspect JSON report at `modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json`.

### Final Verdict

```
BLUE_MODEL_V0_CODE_VALIDATED_SECRET_RUNTIME_PENDING
```

Meaning:
- Code is correct and safe for supervised daily live mode
- Runtime validation with real secret requires Railway environment
- NOT yet unattended/institutional-grade (P1/P2 backlog remains)

---

## Remaining Backlog

### P1

- [ ] Runtime validation of `contur3:blue-status` with real secret (Railway shell)
- [ ] Diagnose and fix `ops-report-email-cron` Railway failure (check RESEND_API_KEY, EMAIL_FROM env vars)
- [ ] `trace_id`/`run_id` chain for end-to-end audit
- [ ] Tighten 6273711 side-mapping (unknown block logging)

### P2

- [ ] WC side-market / corners policy (when to enable)
- [ ] Ice/Fire/Wise staking/vault integration
- [ ] Supabase durable audit tables for contur3 run history
- [ ] `contur3:night-reservations` dryRun support (endpoint pending)
- [ ] Richer queue diagnostics (market liquidity, time-to-close)
