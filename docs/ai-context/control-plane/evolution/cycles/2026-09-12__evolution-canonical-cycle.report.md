# Daily Evolution Review

Период: 2026-09-12T00:00:00Z — 2026-09-13T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): продвинулись.
По системе (переиспользуемые возможности): существующая возможность стала прочнее.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- A real live-production outage was found, root-caused and fixed within this period, and this Routine independently proved the fix holds -- the first time Axis A rests on evidence gathered live, not an executor's self-report. PR#308 diagnosed a fan-out-outgrown 508-row outbox cap causing total publish failure; PR#309 shipped a migration-free per-market-family sharded fix.
- PR#306 and PR#307 landed two small, source-level evidence-fidelity fixes on the same feed path (preserving both token identities through evidence; persisting the canonical provider game id through to serving diagnostics), each self-reporting focused tests, typecheck and build passing.

Какой следующий проверяемый факт в проде стал возможен: A read-only check of Reservation's next 10:00 Minsk anchor firing against the nearest job_runs completion time would prove or disprove PR#310's race diagnosis independently, and show whether a producer-freshness gate (H17) is the better fix.

Снятые блокеры:
- The live primary-evidence publication outage (zero rows served across at least 4 consecutive producer cycles, 05:00-06:37 UTC on 2026-09-12) was fixed by PR#309 and has not recurred across 44 subsequent cycles through this review's evidence cutoff -- independently confirmed via a direct, read-only job_runs query, not merely PR#309's own self-report.

Появившиеся блокеры:
- The same period's own compounding history (the 2026-09-11 multi-identity fan-out landing on top of a fixed 300/508-row outbox cap) produced a real, proven live outage: zero primary signals served for at least 4 producer cycles (~1.5 hours) on the morning of 2026-09-12, before same-day diagnosis and a same-day fix.
- A second, still-open symptom surfaced: PR#310 (open, unmerged) reports Reservation firing with source_rows=0, racing the producer's post-incident recovery cycle, and proposes a code-level anchor shim only because no registered capability exists to edit the production env var directly.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- PR#309 replaced a single-envelope, all-or-nothing publish call with per-market-family sharded publication, each family independently bounded under the existing 508-row cap. (остаётся в репозитории: tests/feed/migrationFreeBoundedPublicationSharding.test.ts)
- This Routine, for the first time, invoked production_observation.v1 against a real merge SHA (H13). Ancestry proved via git; the measurement stage's failure mode from claude_code_cloud is now characterized, not unexercised. (остаётся в репозитории: reports/observation/2026-09-12__pr309-migration-free-sharding.json)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A real live-production outage was found, root-caused and fixed within this period, and this Routine independently proved the fix holds -- the first time Axis A rests on evidence gathered live, not an executor's self-report. PR#308 diagnosed a fan-out-outgrown 508-row outbox cap causing total publish failure; PR#309 shipped a migration-free per-market-family sharded fix.
- PR#309 replaced a single-envelope, all-or-nothing publish call with per-market-family sharded publication, each family independently bounded under the existing 508-row cap. — 7 new tests plus 34/34 regressions self-reported passing; independently confirmed live via job_runs: 44/44 success, zero cap-failure recurrences since merge.
- This Routine, for the first time, invoked production_observation.v1 against a real merge SHA (H13). Ancestry proved via git; the measurement stage's failure mode from claude_code_cloud is now characterized, not unexercised. — Live run vs PR#309's SHA: ancestor proven, measurement timed out, verdict WAIT_INFRASTRUCTURE_RECOVERY -- the command's own fail-safe, not a fabricated pass.

## Что блокирует следующий шаг

- The same period's own compounding history (the 2026-09-11 multi-identity fan-out landing on top of a fixed 300/508-row outbox cap) produced a real, proven live outage: zero primary signals served for at least 4 producer cycles (~1.5 hours) on the morning of 2026-09-12, before same-day diagnosis and a same-day fix.
- A second, still-open symptom surfaced: PR#310 (open, unmerged) reports Reservation firing with source_rows=0, racing the producer's post-incident recovery cycle, and proposes a code-level anchor shim only because no registered capability exists to edit the production env var directly.
- Whether PR#310's diagnosis (Reservation racing the producer's recovery cycle) is itself independently confirmed is not proven this period -- PR#310 is unmerged, self-reported, and this review did not query Reservation's own run history to corroborate it (out of the bounded scope this review's own verification budget justified).
- This review's attempt to run premvp.command.production_observation.v1 against PR#309's SHA did not complete: ancestry was proven via git, but its measurement stage (a 5000-row count=exact scan) timed out here even though a lightweight targeted query succeeded in under a second -- see H13.
- Reconciled PnL is not claimed and cannot be: no fills, fees or settlement evidence exists for this period.
- PR#306 and PR#307 each claim a passing Contur R4 gate receipt in body text ('Contur R4 receipt PASS', 'Contur receipt PASS') -- get_reviews and get_check_runs both returned zero reviews and zero checks for each PR, the same unverifiable-claim pattern flagged in the 2026-09-09 and 2026-09-11 cycles (see H6).
- CURRENT_STATE.yaml (state_version 22, updated 2026-09-08) still reflects none of the last four periods' merges, including this period's proven live-outage-and-fix -- per its own stale_when rule this is STATE_REFRESH_REQUIRED for a fourth+ consecutive period.
- The open (unmerged) PR pile grew from 30 (2026-09-11 cutoff) to 34 at this cutoff, including two feed-path PRs (#303, draft; #310, ready) directly relevant to this period's own incident that remain unmerged.
- premvp.command.production_observation.v1's supported_executors claim for claude_code_cloud (AGENT_REGISTRY.yaml) is not yet proven end-to-end from this exact sandboxed session: its measurement stage's specific query shape (count=exact, 5000-row limit against generated_signal_pairs) times out here even though lighter, targeted Supabase reads from the same session succeed quickly.
- No OPERATOR_ACTION_EVENT record has ever existed in this repository -- the Founder-effort capture pipeline remains schema-only for an eighth+ consecutive cycle (see H4).

## Варианты автоматизации

- A post-merge step (reusing existing, PROVEN_IN_RUNTIME premvp.command.control_plane_reconcile.v1) after every merge touching lib/executor/**, lib/feed/**, or lib/modeling/**, appending a factual accepted_completions entry -- no roadmap/capability-verdict change, which stays Founder-authorized. — делать сейчас.
  Проблема: CURRENT_STATE.yaml (state_version 22, updated 2026-09-08T11:07:12Z) is now stale across a fourth+ consecutive period -- it reflects none of the 2026-09-09 GSP-independence chain, the 2026-09-10 exact-anchor fix, the 2026-09-11 money-admission/fan-out/grouping merges, or this period's proven live outage-and-fix.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (existing) plus a new invocation trigger, if adopted
  Когда остановиться: Stop and revert to manual reconciliation if the automation ever writes a roadmap_phase, current_value_step, capability verdict, or PnL-gate change without separate Founder authorization.
- Wire at least one real OPERATOR_ACTION_EVENT source so the next Evolution input bundle can carry real events instead of an empty array. — система позже.
  Проблема: This period again established only a lower bound of zero operator-action events -- no OPERATOR_ACTION_EVENT record has ever existed in this repository, only the schema file, now for an eighth+ consecutive cycle.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (exists); a new capture point would be the missing artifact
  Когда остановиться: Stop if the only available capture point requires a new mandatory manual step from the Founder.
- A required GitHub status check that fails a PR labeled/detected as R4_CONTUR_PRODUCTION_BOUNDARY unless a machine-readable reviewer receipt is attached to the PR, reusing the already-specified output_contract of premvp.reviewer.contur_gate.v1. — делать сейчас.
  Проблема: PR#306 ('Contur R4 receipt PASS') and PR#307 ('Contur receipt PASS') each claim a passing gate receipt in body text, yet get_reviews and get_check_runs found zero GitHub reviews and zero checks on either PR -- two more instances of a pattern first flagged in the 2026-09-09 cycle and repeated in 2026-09-11 (PR#300/#301).
  Что останется в репозитории: premvp.ci_gate.reviewer_receipt_enforcement (AGENT_REGISTRY.yaml; currently PLANNED, implementation_path null)
  Когда остановиться: Stop and fall back to advisory (non-blocking) mode if the gate produces a false block on a legitimately reviewed PR.
- A periodic (not this Routine's) audit that classifies each open PR as SUPERSEDED / STILL_ACTIVE / ABANDONED against current origin/main and proposes closure only for provably superseded entries -- never an automatic close. — сначала продукт.
  Проблема: The tracked open-PR count grew from 30 (2026-09-11 cutoff) to 34 at this cutoff (mcp__github__list_pull_requests, state=open) -- including PR#303 (a draft, superseded-in-substance by the merged #306-#309 chain) and PR#310 (the still-open follow-on hotfix for this period's own incident).
  Что останется в репозитории: No artifact proposed yet -- remains PRODUCT_FIRST until a Founder decision on disposition criteria exists.
  Когда остановиться: Stop if any classification would require inferring Founder intent rather than reading provable Git supersession.
- Change production-observation.mjs's measurement stage to query job_runs (status, error_message, generated_count, started_at/finished_at) for the producer-cycle-level production-effect check instead of a raw count=exact/5000-row scan of generated_signal_pairs -- reusing exactly the query shape this review used directly and confirmed fast and sufficient. — делать сейчас.
  Проблема: For the first time, this Routine invoked premvp.command.production_observation.v1 against a real merge SHA (PR#309) instead of only proposing it. Ancestry proved via git, but the measurement query timed out here, while a lightweight job_runs query completed in under a second and supplied this cycle's strongest evidence.
  Что останется в репозитории: scripts/control-plane/production-observation.mjs (existing, to be modified); reports/observation/2026-09-12__pr309-migration-free-sharding.json (this cycle's checkpoint evidence of the current failure mode)
  Когда остановиться: Stop and revert to the original query shape if a job_runs-only measurement is ever shown to miss a real publication failure that the raw-table scan would have caught.
- Before Reservation reads its planning source rows, check the most recent completed job_runs row and require it to postdate Reservation's own anchor time (within a bounded staleness window); if not, defer/retry as PRODUCER_NOT_YET_FRESH instead of silently reading a stale population. — делать сейчас.
  Проблема: PR#310 (open, unmerged) reports Reservation firing with source_rows=0 because its fixed 10:00 Minsk anchor now races the producer's post-incident recovery cadence, and proposes a hardcoded code-level remap of that one anchor (10:00 -> 11:00) as an 'emergency compatibility hotfix' rather than a structural fix.
  Что останется в репозитории: lib/executor/nightWindow.ts / lib/executor/contractAB2EventPolicy.ts (existing Reservation planning boundary, to be extended); a new test asserting Reservation defers when the nearest job_runs row predates its own anchor
  Когда остановиться: Stop and fall back to the fixed-anchor behavior if the freshness gate ever causes Reservation to skip a window where source_rows would in fact have been non-empty.
- A narrowly-scoped, read-first registered command that can read and (with explicit Founder authorization per change) write a named allowlist of non-secret hosting environment variables on the deployment platform already in CAPABILITY_MATRIX.yaml, with every write recorded as an EVIDENCE_LEDGER.md entry. — делать сейчас.
  Проблема: PR#310's own body states plainly: 'This session has no path to edit the production RESERVATION_TIMES_MINSK environment variable directly (no registered hosting-platform config tool/credential exists in this environment)' -- forcing a temporary code-level workaround for what is, in substance, a configuration change.
  Что останется в репозитории: No artifact exists yet -- would require a new AGENT_REGISTRY.yaml COMMAND entry plus its implementation script.
  Когда остановиться: Stop and do not build this until a Founder decision explicitly authorizes which environment variables, on which platform, may ever be written this way.
- A focused, advisory pre-merge check that, for any PR touching lib/feed/** or lib/executor/** and changing a fan-out/multiplier constant, greps the repo for fixed downstream capacity constants (DB CHECK/RPC/outbox caps) reachable from that path, and flags any whose derivation references a population size the PR would increase. — делать сейчас.
  Проблема: This period's incident traces to one generalizable pattern: a fixed downstream capacity constant (the 508-row outbox CHECK) was sized against the population at write-time, and a later, independently-reviewed fan-out change increased that population without anyone re-checking the constant it flows into.
  Что останется в репозитории: No artifact exists yet -- would be a new focused script under scripts/control-plane/, e.g. capacity-boundary-check.mjs
  Когда остановиться: Stop and keep it advisory-only if it ever produces a false flag rate high enough to be routinely ignored.

## Две практики Founder

- When a merged PR's body claims a production incident was found and fixed, independently verify the claim with one cheap, targeted, read-only query against the actual system of record (here: job_runs.status/error_message ordered by started_at) rather than accepting the self-report or the more expensive registered observation command's default query shape.
  Зачем сейчас: This period's Axis A verdict rests on exactly this practice: a direct job_runs query converted PR#308/#309's self-reported outage-and-fix into this Routine's first-ever PROVEN_IN_RUNTIME evidence, while the registered production_observation.v1 command's default query timed out on the same task.
  Как ложится на проект: Apply this as a standing step whenever a PR body claims a live production finding or fix on the feed/executor path: identify the one cheap table/column that would prove or disprove the claim before reaching for a heavier, general-purpose command.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-12__evolution-canonical-cycle.json (this cycle's Axis A record)
- When reviewing or authoring a change that adds a new fan-out or multiplier dimension to a data pipeline (more identities, more sides, more market families per unit of input), explicitly re-check every fixed downstream capacity constant reachable from that path against the new maximum population size, rather than assuming an existing cap remains valid.
  Зачем сейчас: This period's entire live outage traces to exactly this gap: the 2026-09-11 multi-identity fan-out increased the qualified-row population without anyone re-checking the 508-row outbox cap it would flow into, and the gap was not caught until it broke in production.
  Как ложится на проект: Apply this check to every future change on lib/feed/** or lib/executor/** that changes how many candidates, sides, or identities are produced per cycle, before merge rather than after a live failure.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-12__evolution-canonical-cycle.json (this cycle's H19 record)

Сравнение: P12 is a cheap habit this Routine can apply on every review with no code change. P13 is heavier and only applies to future fan-out-shaped changes, but would have prevented this period's whole outage. P12 first: it costs one query and is entirely this Routine's own control; P13 needs the next change's author to buy in.
Рекомендуемый порядок: сначала P12, затем P13.

## Следующие эксперименты

- Changing premvp.command.production_observation.v1's measurement stage to query job_runs (status/error_message/generated_count) instead of a count=exact/5000-row scan of generated_signal_pairs will let the command complete from claude_code_cloud within its existing timeout, closing H13.
  Границы: One code change to the measurement-stage query in scripts/control-plane/production-observation.mjs, re-run once against the same PR#309 SHA (8ac2f895) already ancestor-proven this cycle; read-only, no schema or policy change.
  Что останется: scripts/control-plane/production-observation.mjs (modified) and its updated test coverage
  Считаем удачей: The command reaches PRODUCER_PRODUCTION_EFFECT_PROVEN (or a clean, fast WAIT_INFRASTRUCTURE_RECOVERY distinct from a query-shape timeout) against the same SHA that timed out this cycle.
  Останавливаемся, если: Stop and revert to the original query if the job_runs-based measurement is shown to miss a real publication failure the raw-table scan would have caught.
- A single bounded, read-only comparison of Reservation's next 10:00 Minsk (07:00 UTC) anchor firing against the nearest job_runs completion timestamp can independently confirm or disconfirm PR#310's own diagnosis (Reservation racing the producer's recovery cycle) before any anchor-remap or freshness-gate code change is built.
  Границы: One read-only query pair (Reservation's own logged source_rows count for that anchor; the nearest preceding job_runs row) for the next occurrence of the 10:00 Minsk anchor, whether or not PR#310 has merged by then.
  Что останется: A findings note appended to the next Evolution cycle or Governor input, citing the exact anchor timestamp, job_runs row, and observed source_rows count
  Считаем удачей: The comparison produces a concrete, reusable confirmation (or disconfirmation) of the race hypothesis that H17's proposed producer-freshness gate can be scoped against.
  Останавливаемся, если: Stop if the next anchor occurrence happens outside this Routine's evidence_cutoff window and cannot be captured before the next cycle's own cutoff.
- This cycle's own terminal persistence can again reach canonical origin/main with zero intermediate Founder action, using the same GitHub-MCP-backed path already proven for prior cycles' lineages.
  Границы: One canonical Evolution cycle document plus its rendered report, persisted via the registered branch/PR/merge lifecycle; no product code path touched.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-12__evolution-canonical-cycle.json and its .report.md
  Считаем удачей: The cycle reaches canonical origin/main with a founder_action count of zero for this persistence step.
  Останавливаемся, если: Stop and return the canonical resumable outcome if the registered persistence lifecycle cannot complete within this execution window.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 0
- сколько раз получили доказательство из реального рантайма: 2
- создано переиспользуемых артефактов: 3
- ручных сообщений в CloudCode: 0
- ручных сообщений в Codex: 0
- правок от архитектора: 0
- промежуточных действий на одну миссию: неизвестно
- действий на один проверенный результат: неизвестно

Ручных сообщений Founder за период: 0 (полнота сбора — частичный).
Правок от архитектора: 0. Они считаются отдельно и в число ручных сообщений не входят.

Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.

## Roadmap

Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.
Сейчас: уровень 2 — управление автоматизацией.

Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.

## Что произойдёт дальше

Persist via the proven GitHub-MCP path (zero Founder action). Then run E16 (fix the production-observation query) and E17 (confirm PR#310's Reservation-race diagnosis) as the highest-value next actions. Do not babysit the 34-member open-PR family beyond recording it; PR#310 is a product-lane decision, not this Routine's to merge.
