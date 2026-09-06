# Daily Evolution Review

Период: 2026-09-05T00:00:00Z — 2026-09-06T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): откатились назад.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: A bounded read-only production observation of producer decisions/run volume and Postgres load/autovacuum health after PR#247 + PR#248, to independently confirm the workload and stability actually returned to the pre-PR#245 baseline -- not yet observed this cycle..

Снятые блокеры:
- PR#247 removed the PR#245 soccer_exact_score/soccer_first_to_score market admission via an exact, clean 7-file inverse of PR#245's diff, restoring the pre-expansion Contract A discovery/planning-anchor behavior; 71/71 focused regression tests reported passing and git diff --check reported clean.

Появившиеся блокеры:
- PR#245 (merged the prior period) caused a production DB-load incident whose consequences fell inside this period: accepted evidence in PR#247's revert rationale shows decisions/run rising ~54 to ~250, repeated Postgres crash-recovery events, autovacuum start delays, and sustained statement timeouts. Root cause not claimed fully proven.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- A new fail-open kill switch (EMERGENCY_QUIESCE=1, off by default) stops the four recurring production-DB job entrypoints before any external call; customer-facing routes are untouched. (остаётся в репозитории: lib/ops/emergencyQuiesce.ts)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A new fail-open kill switch (EMERGENCY_QUIESCE=1, off by default) stops the four recurring production-DB job entrypoints before any external call; customer-facing routes are untouched. — 4/4 focused tests pass (tests/ops/emergencyQuiesce.test.ts); all four call sites check the switch first. Not yet exercised in a live incident.

## Что блокирует следующий шаг

- PR#245 (merged the prior period) caused a production DB-load incident whose consequences fell inside this period: accepted evidence in PR#247's revert rationale shows decisions/run rising ~54 to ~250, repeated Postgres crash-recovery events, autovacuum start delays, and sustained statement timeouts. Root cause not claimed fully proven.
- Root cause of the DB overload is not claimed fully proven by PR#247's own body -- only the strongest causal trigger was removed; the underlying capacity/behavior mechanism remains unconfirmed.
- No independent post-revert production observation exists yet confirming producer decisions/run actually returned to ~54/run and that crash-recovery/autovacuum/timeout symptoms stopped.
- EMERGENCY_QUIESCE (PR#248) has never been activated in production; its containment value is code/test-confirmed only (4/4 focused tests per the PR body), not runtime-proven under a real incident.
- CURRENT_STATE.yaml is unchanged since 2026-08-28T21:00:54Z (state_version 17) -- a ninth consecutive cycle, 64 commits behind live origin/main; every changed path again falls outside the state_bootstrap_allowlist, so it stays STATE_REFRESH_REQUIRED.
- No completion envelope was Architect-accepted this period; completion_envelope_ids stays empty.
- The Evolution/Governor draft-PR family (H7, 13 members) and further previously-untracked stray Evolution/product draft PRs remain open and unmerged; none reached canonical persistence this period.
- The kill switch has not been activated during a real incident this period; its production containment value remains code/test-confirmed only (SOURCE_OR_CONTROL_PROVEN), not RUNTIME_PROVEN.
- PR#247 (the revert) restores prior business logic on the Contract A path and is not itself a new Manifest 2 capability-domain artifact.

## Варианты автоматизации

- A scheduled, read-only CURRENT_STATE reconciliation check (premvp.command.control_plane_reconcile.v1 already exists) run after each canonicalized Evolution cycle, bounded to the existing state_bootstrap_allowlist, so state-only advances happen automatically without waiting for a product-boundary mission. — делать сейчас.
  Проблема: CURRENT_STATE.yaml still shows updated_at=2026-08-28T21:00:54Z (state_version 17) -- a ninth consecutive cycle unchanged, now 64 commits behind live origin/main at this cutoff, including this period's own PR#247 revert and PR#248 kill switch.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (already exists; proposal is scheduling, not new code)
  Когда остановиться: Stop if any proposed automatic reconciliation would touch a path outside state_bootstrap_allowlist -- that always requires an explicit bounded mission instead.
- Unchanged from prior cycles: a lint-style check flagging any new market-type/formula-version allowlist or numeric cap added without an adjacent named justification comment or test asserting the boundary is intentional. — система позже.
  Проблема: No new instance this period (neither PR#247 nor PR#248 introduces an undocumented restrictive ceiling/allowlist) -- the design-error class tracked since earlier cycles (an undocumented restrictive boundary silently drops eligible data) had no new confirmed case this period.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/AUTOMATION_ROADMAP.yaml (candidate entry; not yet implemented)
  Когда остановиться: Stop if false-positive rate on existing intentional boundaries proves too high in a dry run
- Unchanged: instrument the executor surface(s) that produced PR#247/#248 to emit OPERATOR_ACTION_EVENT records consumable by premvp.command.evolution_collect.v1. — делать сейчас.
  Проблема: This period again established only a lower bound of zero operator-action events: PR#247 and PR#248 were authored and merged with no recorded action event, so the founder-action count stays a floor of zero, not a true count.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (already exists; proposal is emission, not schema work)
  Когда остановиться: Stop if instrumentation would require reading Founder chat content this executor does not already have access to
- A required pre-merge check on the three Contract A discovery/planning-anchor files that estimates the change's effect on producer decisions/run against a known-safe ceiling, plus a bounded post-merge observation via the existing premvp.command.production_observation.v1 command. — делать сейчас.
  Проблема: PR#245's zero-CI merge onto the live Contract A discovery path (a fourth confirmed instance of this gap, after PR#194, #225, #231) is no longer theoretical: it correlated with a real incident -- decisions/run ~54 to ~250, crash-recovery events, autovacuum delays, timeouts -- forcing a same-day revert (PR#247) plus a kill switch (PR#248).
  Что останется в репозитории: scripts/control-plane/production-observation.mjs (already exists and is reusable for the post-merge half of this check)
  Когда остановиться: Stop if a capacity ceiling cannot be defined without database access this executor does not hold -- escalate to a bounded architect decision instead of guessing one
- Not a Routine A action on any of these branches. Recorded for Routine B: run terminal_persistence_stage on the known families or explicitly classify/close them; separately decide whether the modeling-PR pile and the newly-surfaced stray drafts need their own mechanism or Founder review. — сначала продукт.
  Проблема: The tracked Evolution/Governor draft-PR family (7-core + 5-modeling-pile + #241) held steady at 13 members this period, none merged -- and this cutoff's open-PR listing surfaces further stray Evolution drafts (#190/189/174) and long-stranded non-Evolution drafts (#149 down to #1, oldest opened 2026-06-25).
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed
- Unchanged: reconcile any new rolling-corpus reader output against an independently known row-count denominator before trusting it, as already done once for 2026-09-03. — система позже.
  Проблема: No new instance this period -- the D-1 research-corpus reader defect fixed last period (PR#242/#243) had no new confirmed recurrence or new layer exposed this period.
  Что останется в репозитории: scripts/modeling/live-d1-research-corpus.ts (already exists)
  Когда остановиться: Stop if no new full-day reconciliation is attempted in the next several cycles -- close as dormant rather than re-asserting each period

## Две практики Founder

- Require an explicit pre-merge production-capacity check (not just a passing unit-test count) before merging any change to a money-adjacent, zero-CI path like Contract A's discovery/planning-anchor logic -- and treat this period's incident as proof the check is load-bearing, not precautionary.
  Зачем сейчас: This is the fourth tracked instance of the same gap (H6), and the first to cause measured production harm: a producer decisions/run spike, repeated Postgres crash-recovery events, autovacuum start delays and sustained statement timeouts, all requiring a same-day revert. The theoretical risk this Routine flagged three times before is no longer theoretical.
  Как ложится на проект: Before the next merge touching lib/feed/discoverSportsMarkets.ts, lib/feed/buildLandingCards.ts, or lib/executor/planningAnchor.ts, require a stated estimate of the change's effect on producer decisions/run against a known-safe ceiling, plus a scheduled post-merge production observation (premvp.command.production_observation.v1 already exists for the read-only half).
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-05__evolution-canonical-cycle.json (this cycle's H6 record) and scripts/control-plane/production-observation.mjs
- When a production incident is suspected, add a narrowly-scoped, fail-open kill switch for the exact affected job entrypoints (here: four background DB jobs) before or alongside a root-cause revert, explicitly leaving customer-facing paths and unrelated systems untouched.
  Зачем сейчас: PR#248 demonstrates this pattern worked cleanly same-day: a single env var, off by default, scoped to exactly the four job entrypoints implicated in the incident, with no changes to Contract A, Reservation, Rebalance, model logic, or customer-facing routes. This is now a persisted, reusable incident-response shape rather than a one-off fix.
  Как ложится на проект: The next suspected production incident on a background/cron job should default to this same shape -- a scoped, fail-open, off-by-default kill switch checked before any external call -- rather than inventing a new containment mechanism each time.
  Что останется в репозитории: lib/ops/emergencyQuiesce.ts

Сравнение: P1 is higher priority: it would have prevented this period's incident from reaching production at all, and directly protects the highest-priority axis (launch/revenue) on the highest-risk path in the repository. P2 is a proven incident-response pattern that reduces the cost and blast radius of a future incident but does not prevent one.
Рекомендуемый порядок: сначала P1, затем P2.

## Следующие эксперименты

- A single bounded read-only production observation, taken now that PR#247 and PR#248 are both merged, can independently confirm that producer decisions/run has returned to roughly its pre-PR#245 baseline (~54/run) and that no further crash-recovery/autovacuum/timeout symptoms are occurring, closing the loop this period's own evidence left open.
  Границы: One read-only observation only, using the existing premvp.command.production_observation.v1 command; no write path, no forceCreate, no schema or code change.
  Что останется: reports/observation/<observation_id>.json (existing command output contract) plus a recorded entry in docs/ai-context/control-plane/EVIDENCE_LEDGER.md
  Считаем удачей: The observation shows producer decisions/run back near the pre-PR#245 baseline and no new crash-recovery/autovacuum/timeout symptoms in the observed window.
  Останавливаемся, если: Stop if the observation would require a write-capable mode, a secret this executor does not already hold, or database access beyond the command's existing read-only contract.
- A lightweight, documented pre-merge producer-decisions-per-run estimate (even a manual back-of-envelope note in the PR body, not new code) for changes to the three Contract A discovery/planning-anchor files can be adopted immediately, ahead of any automated capacity-check tooling, and would have flagged PR#245 before merge.
  Границы: Prototype as a documented checklist addition only; no new script, no new CI gate (none exists in this repository), no change to the actual discovery/planning-anchor logic.
  Что останется: docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md (candidate location for a new checklist line; not modified by this Routine)
  Считаем удачей: A future PR touching one of the three named files includes a stated producer-decisions/run estimate in its body before merge.
  Останавливаемся, если: Stop if no PR touches these files in the next several cycles -- the practice cannot be validated without a real instance, so it stays a proposal rather than an enforced gate.
- This cycle's own terminal persistence can again reach canonical origin/main with zero intermediate Founder action, using the same GitHub-MCP-backed path already proven for the prior cycles' own lineages.
  Границы: One canonicalization attempt for this cycle's own lineage only (cycles/2026-09-05__evolution-canonical-cycle.json + its report + this input bundle); no new mechanism invented if it fails, and no action taken on any other stranded branch (see H7).
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-05__evolution-canonical-cycle.json
  Считаем удачей: A PR containing exactly the allowlisted Evolution-evidence files for this lineage is created and merged, and git merge-base --is-ancestor confirms this cycle's commit is an ancestor of origin/main.
  Останавливаемся, если: Stop and return the canonical resumable outcome if canonicalization cannot complete within this execution window -- do not create a second lineage or a private polling loop.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 0
- сколько раз получили доказательство из реального рантайма: 1
- создано переиспользуемых артефактов: 1
- ручных сообщений в CloudCode: неизвестно
- ручных сообщений в Codex: неизвестно
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

Persist via the proven GitHub-MCP path: push this cycle's allowlisted files, create a PR against main, merge it, and verify origin/main ancestry. Then run experiment E1 (production observation post-revert). Do not babysit the 13-member draft-PR family beyond recording it for Routine B.
