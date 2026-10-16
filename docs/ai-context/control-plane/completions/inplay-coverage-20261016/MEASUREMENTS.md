# Founder Mission 1 — In-play coverage

Founder decision: current 2026-10-16 directive authorizes staged 100 → 200 → 300, reviewed migration, PR/review/merge/deployment, no intermediate Founder actions. PREMVP only. No synthetic runtime matches, LIVE, Ireland, strategies, prices, fees or T40/T20 changes.

## PROVEN_FACTS

Base main: `0939df5a2a8a3cc4dca13629c5bbcc685a14a81e`. Isolated branch: `codex/inplay-coverage-20261016`; initially clean. Root preserved.

Production function read 2026-10-16 ~07:09 UTC matches the original v1 body: 100 UTC-day matches / 20,000 rows; 1,000 bytes per composite row; 192 rows / 16 tokens per match; 176 non-final rows, final reserve; advisory transaction lock and duplicate guards. SECURITY INVOKER and fixed search_path. Table RLS enabled and ACL service_role only. Runtime function ACL additionally includes anon/authenticated; they have no table privileges, so invoker permissions still prevent writes. No privilege expansion is part of this change.

Aggregates at 07:10 UTC:

| UTC day | stage | matches (Production) | markets | observations | sports | source→DBClone matches | logical bytes (Production) | errors |
|---|---|---:|---:|---:|---:|---|---:|---|
| 2026-10-15 | 100 | 100 | 233 | 7127 | 5 | 100→100 | 4453484 | full-day errors not measured |
| 2026-10-16, partial | 100 | 29 | 82 | 4306 | 6 | 29→29 | 2641612 | sampled logs: budget rejection and start mismatch |
| pending | 200 | unverified | unverified | unverified | unverified | unverified | unverified | unverified |
| pending | 300 | unverified | unverified | unverified | unverified | unverified | unverified | unverified |

2026-10-15 both sides: 7127 rows, ID digest `e6b34348a8b6c070bd8e95798371a2b2`, full-row sorted content digest `c7baa713511775e601118bcdb071773e`. This proves persisted-row parity for that completed day, not completeness of the upstream source universe. Current-day DBClone was 4286 rows with max observed_at 07:02:17.027 UTC, while Production max was 07:09:47.036 UTC: an unclosed 20-row lag at separate sample times, not proof of permanent loss.

Production max rows/event 186, max tokens/event 16; clone 188 / 16. Zero events over 192 or 16 in either database.

Storage: Production database 17,735,191,699 bytes; in-play relation 20,463,616 bytes. Clone database 18,714,487,955 bytes; relation 58,351,616 bytes. Management API disk-util timestamp 2026-10-16T07:14:11Z: Production used 18,096,205,824 / available 10,400,702,464 / total 28,496,908,288 bytes; clone used 19,043,500,032 / available 24,249,466,880 / total 43,292,966,912 bytes. Both disks gp3, 3000 provisioned IOPS / 125 MiB/s throughput; this is provisioning, not measured database load or throughput.

Railway collector trailing 24h: CPU average 0.01172, max 0.06929 against 0.5 limit; RAM average 0.2050 GB, max 0.2390 against 0.5 GB limit. CPU/RAM have current headroom; future load is not proven by multiplying these values.

Live source 55-second read-only socket sample: 21 messages, 9 distinct live/final game IDs. Daily supply of 200/300 eligible distinct matches is NOT PROVEN. No matches inserted by the probe.

## SUPPORTED_INFERENCES

The 100-match cap binds persisted daily coverage: two completed clone UTC days each contain exactly 100. Source total supply beyond 100 needs independent natural observation. Existing 8 × 200 page telemetry allowance allows 38,400 rows/day at hourly cadence, below 40k/60k; only in-play receives 16 pages (76,800/day theoretical), retaining exact-ID/content-confirmed purge and 48h retention. Real transport speed and catch-up at the expanded budget remain runtime gates.

## UNVERIFIED_ASSUMPTIONS

Natural >100 and >200 match coverage, completeness of all eligible upstream matches, queue eviction incidence, steady-state DB load and writer latency at 200/300, actual sync throughput under expanded load. Existing 3-capture / 30-second scheduler remains unchanged; do not claim that raising queue capacity proves its timeliness. Stage 300 is prepared as budget constants only and MUST NOT activate before stage-200 proof and its own reviewed target-only migration.

## CONTRADICTIONS

Function ACL differs from the original migration's intended role set; table permissions and SECURITY INVOKER preserve write isolation. It is recorded rather than broadened into a privilege migration. No invented source coverage or automatic threefold capacity assumption.

## FIRST_PROVEN_PROBLEM

Daily writer hard cap is 100. Collector queue also uses literal 100 and can evict pending items at that boundary. In-play transport theoretical hourly capacity is below the requested daily row budgets.

## SMALLEST_DEFENSIBLE_APPROACH

One target-only migration changes only 100→200 and 20000→40000 in the existing function. TypeScript/scorecard share pure stage constants, queue follows active stage, in-play-only transport allowance rises to 16 pages. Per-row size bounds imply ≤40 MB at stage 200. Stage 300 stays inactive; 60000×1000 bytes and 300×192 rows fit its prepared envelope.

## MATERIAL_ALTERNATIVE

Increase only SQL daily cap. Rejected: leaves inconsistent scorecard/queue/transport limits and cannot satisfy the requested acceptance.

## REGRESSION_AND_MAINTENANCE_RISK

Writer aggregate queries run under the unchanged advisory lock; higher traffic may increase latency. Observe naturally before proceeding. More sync pages increase bounded work per hourly run. No historical writes or cleanup. Existing RESERVED_EVENT_START_MISMATCH errors are deferred unless proven to block expanded coverage.

Challenge verdict: PROCEED_WITH_CORRECTION — stage-200 activation is distinct from natural acceptance; stage 300 requires another evidence-gated release. Final mission result remains PARTIAL until both natural gates close.

## Verification and release stop

Targeted tests: 65/65 PASS (inplayCorePath, inplayCoverageLimits, inplayDailyScorecard). Registered target-only migration tests: 14/14 PASS. `npm run build`: exit 0 outside the filesystem-restricted sandbox. `npm run control-plane:check`: exit 0; 425 passing, 16 skipped. `git diff --check`: exit 0. Gate 1 for the bounded patch: PASS; production release: BLOCKED, no runtime acceptance claimed.

Additional full `npx tsc --noEmit` exits 1: errors in unchanged contur3 test fixtures (fullMatchTotalCornersAdmission, marketAuthorityExactIdentity, precontractT20Research) and missing vitest types in football-denominator-reconciliation.test.ts. No unrelated test/source fixes are absorbed. The successful Next build does not make the additional full typecheck green.

The registered `apply-premvp-approved-migration.mjs --target-only` dry-run exited 1, FAIL_CLOSED: `TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY`. Exact missing Production-ledger versions: 20261010093458, 20261010174103, 20261010174205, 20261011121404, 20261011121730, 20261011121919, 20261011123157, 20261011173725, 20261012081351, 20261012091633. No apply, raw SQL fallback, ledger repair or protection weakening was attempted. The target SQL hash/declaration passed static validation. The new migration is NOT applied.

STOP CONDITION: registered migration lifecycle cannot construct its verified isolated view because these ledger-tracked files are absent from main. Unknown: exact reviewed source artifacts corresponding to those versions. Verification needed: recover and verify those exact migration artifacts through the normal migration reconciliation lifecycle, then repeat the pinned target-only dry-run. Safe next action: preserve this change as a draft PR; do not merge, deploy or activate 200/300 until the migration gate passes. No Founder command or secret handling required.

Old/new snippets: writer `v_events >= 100` → `v_events >= 200`; `v_rows >= 20000` → `v_rows >= 40000`. TypeScript `[100, 20000, 20]` → shared active `[200, 40000, 40]`. Queue literal `100` → active stage event cap. In-play sync maximum `8` → `16` pages; every other telemetry table stays at 8. Per-match 192/16 and Production 48h unchanged.

Remaining natural sequence after the technical gate: deploy the reviewed stage-200 revision and prove >100 distinct matches on a UTC day, unchanged guard behavior, zero frozen-cutoff ID/content mismatch, bounded lag and acceptable DB/collector load. Only then create/apply a separately reviewed stage-300 migration through the same registered lifecycle, update the active stage to 300, deploy, and prove >200 distinct natural matches plus parity. A subsequent natural day may be required. Until then the business outcome is PARTIAL, not PASS.
