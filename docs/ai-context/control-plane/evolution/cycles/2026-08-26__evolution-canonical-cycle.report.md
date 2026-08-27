# Daily Evolution Review

Период: 2026-08-26T00:00:00Z — 2026-08-27T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): существующая возможность стала прочнее.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- A production-shaped defect in legacy Ireland accepted_open callbacks (missing submitted_size) collapsed every retry into HTTP 500 and stranded execution in BLOCKED_CALLBACK before Queue polling; fixed by deriving requested_shares from stake_usd and submitted_price.
- PR#188 reports the observed production research-scorer funnel discarded 581 of 781 scorer-eligible events behind a fixed 200-row cap, with late losses unattributable; the cap was replaced by a wall-clock budget with full terminal attribution.

Какой следующий проверяемый факт в проде стал возможен: A live production_observation run after the next producer cycle can check whether removing the research-scorer cap increases real signal coverage without breaking attribution, and whether a live legacy Horbury retry now returns 200 instead of 500..

Снятые блокеры:
- Legacy-shaped Horbury accepted_open callbacks (no submitted_size) no longer 500 and no longer strand execution in BLOCKED_CALLBACK ahead of Queue polling.
- The 200-row research-scorer cap that discarded most scorer-eligible production events is removed; scoring is now wall-clock-bounded with full terminal attribution instead of silent truncation.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- The Evolution Cycle contract was extended to version 1.1: an evidence cutoff and a detailed operating-telemetry block, backward-compatible with existing 1.0 cycles. (остаётся в репозитории: docs/ai-context/control-plane/evolution/schemas/EVOLUTION_CYCLE.schema.json)
- The Automation Roadmap Governor now discovers and validates canonical persisted Evolution cycles directly, instead of only synthetic fixtures, while preserving accepted:false and all strategic guardrails. (остаётся в репозитории: scripts/control-plane/lib/evolution-governor.mjs)
- A new automated CURRENT_STATE reconciliation script stages candidate factual state deltas after an accepted release and fail-closes on a non-ancestor or non-terminal baseline. (остаётся в репозитории: scripts/control-plane/lib/control-plane-reconcile.mjs)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- The Evolution Cycle contract was extended to version 1.1: an evidence cutoff and a detailed operating-telemetry block, backward-compatible with existing 1.0 cycles. — 276 of 276 control-plane tests pass, including extended coverage for the new contract; this cycle itself is authored and validated against it.
- The Automation Roadmap Governor now discovers and validates canonical persisted Evolution cycles directly, instead of only synthetic fixtures, while preserving accepted:false and all strategic guardrails. — 52 Governor tests plus the full 276-test control-plane suite pass; a canonical one-cycle run correctly returns EVIDENCE_INSUFFICIENT with only one cycle on record.
- A new automated CURRENT_STATE reconciliation script stages candidate factual state deltas after an accepted release and fail-closes on a non-ancestor or non-terminal baseline. — 6 dedicated tests plus the full 276-test control-plane suite pass; not yet run against the real, currently stale state file.

## Что блокирует следующий шаг

- Neither fix was observed acting on live production traffic this period — no production_observation run was executed, so real-runtime behavior remains unconfirmed beyond unit tests and reviewer receipts.
- CURRENT_STATE.yaml is stale relative to live origin/main: product and control-plane paths outside its docs-only bootstrap allowlist changed since its recorded baseline, and the new reconcile capability landed this period has not yet been run to refresh it.
- Reconciled PnL: not claimed and not evidenced — no fills, fees or settlement evidence exists for this period.
- The new reconcile capability has synthetic test coverage only; it has not yet been run to resolve the real stale-state condition noted above.
- Persisting this cycle itself (a second real persisted cycle) broke 3 of the Governor's own tests, which hard-code the live evolution/cycles directory to contain exactly one entry; the Governor's discovery/eligibility logic itself behaved correctly (it now finds 2 cycles, still below the 3-cycle threshold), but its test suite is not isolated from real repository growth.

## Варианты автоматизации

- A shared, append-only operator-action log both executors write to at message time, read directly by the collector. — система позже.
  Проблема: For a second cycle in a row, operator-action capture is only a lower bound: all 5 actions this period are inferred from merged branches, with no session transcript or completion envelope proving any follow-up activity.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Когда остановиться: Stop if it would require either executor to change how it starts sessions, or could not stay dependency-free and offline.
- Run the control-plane reconcile command in read-only mode as the next bounded architect step, then have the Founder review and accept the proposed delta. — делать сейчас.
  Проблема: CURRENT_STATE.yaml is stale relative to live origin/main under its own staleness rule, even though this period landed an automated reconciliation script built for exactly this case.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs
  Когда остановиться: Stop if the proposed delta touches any field this routine is not authorized to change, such as roadmap phase or PnL gates.
- A CI workflow that runs the control-plane check and the changed-package test suites on every PR and publishes a GitHub check run. — система позже.
  Проблема: None of the 5 PRs merged this period carry any GitHub check-run status; all verification evidence lives only in PR-body self-report and this review's own re-run of local commands.
  Что останется в репозитории: .github/workflows/ (new)
  Когда остановиться: Stop if a CI workflow cannot be added without secrets or live database access.
- A bounded, read-only root-cause spike: run the 10 failing assertions in isolation with verbose diagnostics to classify the failure. — система позже.
  Проблема: The producer identity-conservation suite fails 10 of 22 tests; re-run this cycle it reproduces the exact split PR#188 reported on pristine main, and the file predates this and the prior review period.
  Что останется в репозитории: tests/feed/producerIdentityConservation.test.ts
  Когда остановиться: Stop the spike the moment it would require any product or database change beyond the test file itself.
- Add a permanent regression test asserting the funnel conservation invariant, independent of any capacity ceiling. — сначала продукт.
  Проблема: Removing the research-scorer cap exposed a second hidden defect — attribution gated on the same cap — caught only by reviewer inspection, not by any existing automated test.
  Что останется в репозитории: tests/feed/researchScorerCapacity.test.ts
  Когда остановиться: Stop if the invariant cannot be asserted without a live database or production traffic.
- Rewrite the 3 affected Governor tests to use an isolated temporary cycles directory, or to compute expected counts dynamically, instead of asserting a fixed historical count against the real repository. — делать сейчас.
  Проблема: Persisting this very cycle broke 3 of 276 control-plane tests: they hard-code the live cycles directory to contain exactly one entry, so the control-plane check gate is now red at current HEAD purely because a second real cycle was legitimately persisted.
  Что останется в репозитории: tests/control-plane/evolutionGovernor.test.mjs
  Когда остановиться: Stop if isolating these tests would require changing the Governor's own discovery or eligibility logic rather than only the test harness.

## Две практики Founder

- Independently reproducing a PR's own pre-existing-failure claim before accepting it as out of scope.
  Зачем сейчас: PR#188 claimed 10 test failures were pre-existing; re-running the same command this cycle reproduced the identical split independently, turning a claim into real evidence.
  Как ложится на проект: The same discipline applies to any future PR claiming a failure is pre-existing, environmental, or out of scope.
  Что останется в репозитории: tests/feed/producerIdentityConservation.test.ts
- Recognizing an onion-chain pattern and demanding a permanent invariant guard instead of accepting a one-off patch as sufficient.
  Зачем сейчас: The reviewer flagged the same gap as a non-blocking follow-up; treating it as a real automation hypothesis keeps the invariant from silently breaking again.
  Как ложится на проект: Any future finding where a limit was masking a real defect should be checked for the same implicit-dependency shape.
  Что останется в репозитории: lib/feed/buildLandingCards.ts

Сравнение: P1 is verification discipline applied to other executors' claims; P2 is a diagnosis pattern applied to defects found during the work. P1 protects what this review accepts as evidence; P2 protects the codebase from this period's actual failure mode.
Рекомендуемый порядок: сначала P1, затем P2.

## Следующие эксперименты

- A shared operator-action log written by both executors at message time would let coverage reach complete without inferring counts from branches.
  Границы: One period, read-only design spike carried forward from the prior cycle: sketch the log format only, no logging wired in yet.
  Что останется: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Считаем удачей: The sketch is reviewed and a following cycle collects a bundle from the shared log rather than a git-inferred one.
  Останавливаемся, если: Stop if a shared log would require either executor to change its session-start mechanism, or cannot stay dependency-free.
- Running the control-plane reconcile command in read-only mode against the real baseline would show what a refresh would change, without accepting it yet.
  Границы: One bounded, read-only dry run of the reconcile script; no state write, no product or database change.
  Что останется: scripts/control-plane/reconcile-control-plane.mjs
  Считаем удачей: The dry-run output is reviewed and, if correct, a following mission runs it for real to refresh the state file.
  Останавливаемся, если: Stop if the dry-run proposes any change outside the bounded factual fields this script may touch.
- The 10 failing producer-conservation assertions have a single identifiable root cause a bounded diagnostic pass can determine.
  Границы: Run the failing assertions in isolation with added diagnostics; no test or product code changed as part of the spike.
  Что останется: tests/feed/producerIdentityConservation.test.ts
  Считаем удачей: A following cycle reports an explicit, evidenced root-cause classification for all 10 failures.
  Останавливаемся, если: Stop the spike the moment fixing it would require a database or live-runtime change beyond the test file.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 1
- сколько раз получили доказательство из реального рантайма: 6
- создано переиспользуемых артефактов: 5
- ручных сообщений в CloudCode: 2
- ручных сообщений в Codex: 3
- правок от архитектора: 0
- промежуточных действий на одну миссию: неизвестно
- действий на один проверенный результат: неизвестно

Ручных сообщений Founder за период: 5 (полнота сбора — частичный).
Правок от архитектора: 0. Они считаются отдельно и в число ручных сообщений не входят.

Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.

## Roadmap

Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.
Сейчас: уровень 1 — ежедневный разбор.

Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.

## Что произойдёт дальше

Persist this cycle. control-plane:check is now red at HEAD (273/276) only because this cycle's own entry breaks 3 Governor tests hard-coded to one cycle (H6) — fix that isolation first, then run the reconcile command read-only to refresh the stale state file, then spike the 10 failing producer-conservation tests. No scheduling or automation follows from this cycle.
