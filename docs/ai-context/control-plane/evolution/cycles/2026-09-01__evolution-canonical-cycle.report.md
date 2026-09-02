# Daily Evolution Review

Период: 2026-09-01T00:00:00Z — 2026-09-02T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): существующая возможность стала прочнее.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: пока никакой.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- GITHUB_PR_CREATE/GITHUB_PR_MERGE adapter selection is now explicit and fail-closed per executor (local_codex_windows to gh-CLI, claude_code_cloud to GitHub MCP), via one reusable module. (остаётся в репозитории: scripts/control-plane/lib/github-pr-adapter-binding.mjs)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- GITHUB_PR_CREATE/GITHUB_PR_MERGE adapter selection is now explicit and fail-closed per executor (local_codex_windows to gh-CLI, claude_code_cloud to GitHub MCP), via one reusable module. — PR#220: wired into evolution-canonicalize.mjs, which now requires --executor and fails closed instead of silently trying local gh; covered by new and extended tests.

## Что блокирует следующий шаг

- The only real engineering merge this period, PR#220 (585b6f750beb26ce35950f999651a62dbee5723e), is a control-plane orchestration fix (GitHub PR adapter binding) — it touches no product, runtime, database or money path, so it carries no launch/revenue/PnL evidence either way.
- docs/ai-context/control-plane/CURRENT_STATE.yaml is unchanged since 2026-08-28T21:00:54Z (state_version 17) — fifth consecutive cycle carrying the same staleness gap (hypothesis H1), neither worsened nor re-verified this period.
- CHAIN-PRIMARY-CAP-20260827 and CHAIN-RESERVATION-LOOKBACK-20260828 remain open onion chains with no new links and no new production observation this period (hypotheses H5, H6 continuity).
- No completion envelope was accepted this period.
- The binding formalizes the fail-closed contract but does not itself flip GITHUB_PR_CREATE/GITHUB_PR_MERGE to PROVEN for the local_codex_windows-scoped probe in CAPABILITY_MATRIX.yaml (still NOT_PROVEN, unchanged by this commit) — a separate claude_code_cloud-scoped entry has carried PROVEN since 2026-08-06 (PR#89,90) and is untouched here.
- It does not reduce the stranded Governor/Evolution draft-PR pile itself: the same family this reviewer has tracked as H7 grew from 5 to 6 PRs this period (#199, #205, #206, #212, #214, new #216) even after this fix landed — the fix documents/enforces correct dispatch, it does not run the canonicalization lifecycle against those branches.
- operator_action_events capture is still a lower bound with no primary per-message log (H4) — unchanged from prior cycles.

## Варианты автоматизации

- Unchanged from prior cycles: wire scripts/control-plane/lib/control-plane-reconcile.mjs as a CI gate or a separate read-only Routine that compares CURRENT_STATE.origin_main_sha against live origin/main on every merge or on a fixed schedule. — делать сейчас.
  Проблема: CURRENT_STATE.yaml still shows updated_at=2026-08-28T21:00:54Z (state_version 17) with no new reconciliation this period — the fifth consecutive cycle with the same staleness gap, unchanged because no scheduled or gated reconciliation runs on its own.
  Что останется в репозитории: scripts/control-plane/lib/control-plane-reconcile.mjs
  Когда остановиться: Stop if reconciliation requires production runtime or database access, or the Founder rejects the proposed delta.
- Same shared population-conservation check across funnel stages proposed in prior cycles, still buildable from the two already-existing test cases (primaryPopulationDecoupling, primaryCoverageDiagnosticOnly) without new product code. — система позже.
  Проблема: No new instance this period (the one product-adjacent merge, PR#220, was control-plane only) — the underlying gap remains: no shared population-conservation test helper for the primary feed funnel, despite 5-6 confirmed instances of the same silent-cap pattern across CHAIN-PRIMARY-CAP-20260827.
  Что останется в репозитории: tests/feed/lib/populationConservation.ts (still not created)
  Когда остановиться: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- Static check (lint rule or control-plane script) flagging bare numeric ceilings/thresholds in scoring and funnel-admission code without a named, justified constant. — система позже.
  Проблема: No new instance this period; the same design-error class (an undocumented numeric ceiling/threshold with no named, justified constant) remains unaddressed.
  Что останется в репозитории: new eslint rule or control-plane script (still not created)
  Когда остановиться: Stop if the rule false-positives too often on legitimate named numbers.
- Unchanged from prior cycles: a shared, append-only operator-action log that both executors write to at message-submission time, which evolution-collect.mjs reads directly. — делать сейчас.
  Проблема: This period again established only a lower bound of zero for operator_action_events — the one confirmed merge (PR#220) shows the executor itself acted, but this reviewer still has no primary operator-action log to check against, so PARTIAL/zero cannot be distinguished from 'no capture' with confidence. Sixth consecutive cycle with the same structural gap.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Когда остановиться: Stop if this would require changing how executors start sessions.
- Same bounded read-only audit proposed in prior cycles: every evidence/diagnostics write path on the money lane (Reservation, Rebalance, Queue) for NOT NULL or required fields that could go unfilled on an edge case, not only the Ireland legacy callback shapes already checked. — сначала продукт.
  Проблема: No new instance this period (the one merge was control-plane only), but the two prior confirmed instances of the same defect class — a money/execution evidence-write path silently losing data on an unhandled edge case (Horbury legacy callback, then Reservation error-evidence insert) — remain without the bounded read-only audit proposed repeatedly.
  Что останется в репозитории: new audit report under docs/ai-context/control-plane/reviews/ (still not created)
  Когда остановиться: Stop if the audit would require write access to production data rather than SELECT/schema read only.
- Unchanged: one bounded read-only run of the already-registered production_observation.v1, targeted at Contract A Planning decisions that passed the B2 gate. — делать сейчас.
  Проблема: B2 policy (PR#194) and the unified canonical population (PR#191) remain confirmed only at the code/test level for a fifth cycle running — still no read-only production observation, and no new engineering happened this period to change that.
  Что останется в репозитории: reports/observation/<observation_id>.json (existing command output contract)
  Когда остановиться: Stop if the observation returns an infrastructure-pending status twice in a row instead of a real result.
- Not a Routine A action (explicitly out of scope — no PR babysitting). Recorded as evidence for Routine B: the registered terminal_persistence_stage for the Governor routine should actually be invoked, with --executor claude_code_cloud, for these six branches, or they should be explicitly superseded/closed by whichever routine owns them. — сначала продукт.
  Проблема: The stranded Governor/Evolution draft-PR family grew from 5 to 6 this period: #199, #205, #206, #212, #214 (present at the prior cutoff) plus new #216 (opened 2026-09-01T02:16:01Z). PR#220 formalized the fail-closed executor-adapter contract the canonicalization lifecycle depends on, but did not run that lifecycle against any of these six branches.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed.

## Две практики Founder

- When a merged control-plane fix (PR#220) is adjacent to a tracked hypothesis (H7, the stranded draft-PR pile) without actually resolving it, credit the precise adjacent effect (a safer, more correctly specified dispatch contract) separately from the still-open outcome (the pile still grew) instead of either ignoring the fix or over-crediting it as a resolution.
  Зачем сейчас: Conflating 'a related mechanism got safer' with 'the tracked problem is fixed' would silently downgrade H7 to resolved while the observable count (5 to 6) shows it is not — the two facts must be reported side by side.
  Как ложится на проект: Every Daily Evolution Review should re-check each open hypothesis's own success metric literally (here: draft-PR count) against this period's evidence before crediting any adjacent merge as progress on it.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md
- Distinguish a growing pile of PRs that all belong to one already-tracked causal family (H7's Governor/Evolution branches) from newly-appeared PRs in a different, not-yet-established family (this period's three research-artifact-freeze PRs, #217/#218/#219) — record the latter as context rather than manufacturing a new defect entry on a single period's evidence.
  Зачем сейчас: Creating a new formal defect family from one period's worth of in-progress PRs would violate the 'do not create candidates to fill a quota' discipline and could misclassify ordinary in-progress work as a systemic gap before a repeat occurrence actually proves one.
  Как ложится на проект: Every cycle's open-PR review should sort new PRs by causal family first, and only promote a new family to a formal defect_occurrences entry once a second period shows the same pattern recurring.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/prompts/DAILY_EVOLUTION_REVIEW.md

Сравнение: P1 is a judgment discipline applied once per cycle to whatever hypothesis a period's merge happens to touch — narrow but immediately actionable. P2 is a broader triage habit that applies to every new PR seen in every future cycle, shaping which observations become tracked defect families at all.
Рекомендуемый порядок: сначала P2, затем P1.

## Следующие эксперименты

- The funnel population-conservation helper (H2) can still be prototyped from the two existing PR#201 test fixtures without new product code, unchanged from prior cycles.
  Границы: Prototype only, on the existing primaryPopulationDecoupling/primaryCoverageDiagnosticOnly fixtures; do not touch a new funnel stage.
  Что останется: tests/feed/lib/populationConservation.ts (new)
  Считаем удачей: A future cycle's fix on a different funnel stage reuses this helper instead of new one-off check code.
  Останавливаемся, если: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- The already-registered, read-only production_observation.v1 can independently confirm the restored 72h lookback actually stopped SQLSTATE 57014 in the nightly Reservation crane, with no new code.
  Границы: One read-only observation run targeted at the nightly Reservation crane after PR#203, in the next cycle that includes planning/funnel work.
  Что останется: reports/observation/<observation_id>.json (existing command output contract)
  Считаем удачей: The observation confirms an absence of 57014 timeouts in runs after merge_commit 2cb8d49.
  Останавливаемся, если: Stop if the observation returns an infrastructure-pending status twice in a row instead of a real result.
- PR#220's fail-closed --executor contract on evolution-canonicalize.mjs is the precondition this reviewer's own prior experiment (confirmed twice for Evolution-cycle artifacts, PR#211/#213) needs before the same GitHub-MCP-tool fallback can be safely attempted against a Governor-result branch — the untested case named at the last cycle.
  Границы: Observe only, no new mechanism: the next time any executor runs evolution-canonicalize.mjs --canonicalize --executor claude_code_cloud against a Governor-result branch (e.g. one of #199, #205, #206, #212, #214, #216), record whether it dispatches correctly via GitHub MCP or hits a gap specific to the Governor artifact class.
  Что останется: docs/ai-context/control-plane/evolution/roadmap-proposals/<result_id>.json (first one to canonicalize, once it exists)
  Считаем удачей: A Governor-result PR reaches canonical origin/main via the same fallback with zero Founder action, comparable latency to PR#211/#213.
  Останавливаемся, если: Stop and record PENDING_RESUMABLE if the branch, PR, or merge step is blocked by anything beyond the executor's available GitHub MCP tools — do not invent a workaround.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: неизвестно
- сколько раз получили доказательство из реального рантайма: 0
- создано переиспользуемых артефактов: 1
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

Persist this cycle via the GitHub-MCP-tool fallback confirmed twice before (PR#211, PR#213): commit, push, open and merge the PR via GitHub MCP tools (gh CLI unavailable here). Do not babysit the 6 stranded Governor/Evolution draft PRs or the 3 new research-artifact-freeze PRs beyond recording them for Routine B.
