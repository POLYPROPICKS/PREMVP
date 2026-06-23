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

**2026-06-23 — hardened runner patch applied (session 2)**

| Field | Value |
|---|---|
| Runner file | `scripts/contur3/run-ops-report-email.mjs` |
| Railway Start Command | `node scripts/contur3/run-ops-report-email.mjs` |
| Code syntax check | PASS |
| Build | PASS |
| Runtime verdict | `OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING` |
| Missing env locally | `RESEND_API_KEY`, `EMAIL_FROM`, `EXECUTOR_CANDIDATES_SECRET` |
| Missing env on Railway (must verify) | `RESEND_API_KEY`, `EMAIL_FROM` |

**Root cause of email failure:** `RESEND_API_KEY` and/or `EMAIL_FROM` likely not set in Railway ops-report-email-cron service variables.

**Runner improvements in this patch:**
- Changed `stdio: 'inherit'` → `encoding: 'utf8'` (pipe) so stdout/stderr are captured and saved to JSON report
- Added pre-flight env var check: exits with `OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING` if `RESEND_API_KEY` or `EMAIL_FROM` are absent
- `missing_env_names` array included in JSON report
- Secrets redacted in saved report

**Operator action required:**
1. In Railway → `ops-report-email-cron` service → Variables, verify `RESEND_API_KEY` and `EMAIL_FROM` are set
2. Change Start Command to: `node scripts/contur3/run-ops-report-email.mjs`
3. After next cron run, check `modeling/fire_runs/contur3-blue-model/<timestamp>_ops_report_email.json` for verdict

Email is a **monitoring rail**, not an execution gate. Ireland watcher is unaffected by email failures.

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
