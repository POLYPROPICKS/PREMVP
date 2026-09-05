# Daily Evolution Review

Период: 2026-09-04T00:00:00Z — 2026-09-05T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): существующая возможность стала прочнее.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: PR#245 admitted soccer_exact_score / soccer_first_to_score into the Contract A / Reservation-eligible market population. Next fact: a bounded read-only observation of a live GSP/Reservation cycle showing one of these two families actually reach current_signal_pair_serving or a Reservation slot -- not yet observed..

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- The D-1 research-corpus reader no longer silently truncates on a tie-drain page; it now distinguishes a short 'tie' page from a short 'advance' page, fixing a 97.2% silent undercount (46,776 rows vs. 1,304 read). (остаётся в репозитории: scripts/modeling/live-d1-research-corpus.ts)
- Wide multi-market/multi-outcome research scoring is restored: an undocumented market-type allowlist that silently narrowed the research-eligible universe is removed, and a new per-sport-family funnel-counter function makes that boundary explicit and inspectable. (остаётся в репозитории: lib/feed/buildLandingCards.ts)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- The D-1 research-corpus reader no longer silently truncates on a tie-drain page; it now distinguishes a short 'tie' page from a short 'advance' page, fixing a 97.2% silent undercount (46,776 rows vs. 1,304 read). — 7 new regressions reproduce the exact failing shape and pass only with the fix; a live railway smoke test confirms exactly 46,776 rows now read.
- Wide multi-market/multi-outcome research scoring is restored: an undocumented market-type allowlist that silently narrowed the research-eligible universe is removed, and a new per-sport-family funnel-counter function makes that boundary explicit and inspectable. — 27/27 focused tests, tsc --noEmit and npm run build reported green per the PR body; new counters are directly testable going forward.

## Что блокирует следующий шаг

- PR#245 rewrites discovery/recovery/planning-anchor logic on the live Contract A path; merged by the POLYPROPICKS account in 15 seconds, 0 CI runs, no post-merge invocation recorded. Code/test-confirmed only (90/90 tests per PR body) -- a fourth instance of the H6 production-observation gap (with PR#194, #225, #231).
- PR#244 (restore wide research market outcomes) reverses a market-type allowlist that had been silently narrowing research scoring since before commit b2de038; its own stated verification (27/27 tests, tsc, build) was reused as evidence and not independently re-run this cycle, and no post-merge production observation exists yet.
- PR#242/#243 (D-1 reader tie-drain fix + full corrected 2026-09-03 canonicalization) are explicitly backward-looking research/modeling work: no model/filter/threshold decision, no production or clone write, FORWARD_VALIDATED=false posture unchanged from prior cycles.
- CURRENT_STATE.yaml is unchanged since 2026-08-28T21:00:54Z (state_version 17) -- an eighth consecutive cycle. origin_main_sha remains a proven ancestor of live origin/main, but every changed path this period again falls outside the state_bootstrap_allowlist, so it remains STATE_REFRESH_REQUIRED, not merely aging (H1 continuity).
- No completion envelope was Architect-accepted this period; completion_envelope_ids stays empty.
- CHAIN-PRIMARY-CAP-20260827 and CHAIN-RESERVATION-LOOKBACK-20260828 (from prior cycles) show no new links this period.
- Neither strengthened capability has an independent post-merge production observation yet; both remain code/test-confirmed (SOURCE_OR_CONTROL_PROVEN), except the D-1 reader fix which additionally has one live Railway smoke-test read (RUNTIME_PROVEN for that one reconciliation fact only, not for any money/serving path).
- PR#245's market-family admission is a product/business-logic change, not a Manifest 2 capability-domain artifact, and is not counted toward Axis B.

## Варианты автоматизации

- Unchanged from prior cycles: wire scripts/control-plane/lib/control-plane-reconcile.mjs as a CI gate or a separate read-only Routine that compares CURRENT_STATE.origin_main_sha against live origin/main on every merge or on a fixed schedule. — делать сейчас.
  Проблема: CURRENT_STATE.yaml still shows updated_at=2026-08-28T21:00:54Z (state_version 17) -- an eighth consecutive cycle unchanged. origin_main_sha remains a proven ancestor of live origin/main, but every path that changed this period again falls outside the state_bootstrap_allowlist.
  Что останется в репозитории: scripts/control-plane/lib/control-plane-reconcile.mjs
  Когда остановиться: Stop if reconciliation requires production runtime or database access, or the Founder rejects the proposed delta.
- Same shared population-conservation check across funnel stages proposed in prior cycles, still buildable from the two already-existing test cases (primaryPopulationDecoupling, primaryCoverageDiagnosticOnly) without new product code. — система позже.
  Проблема: No new instance this period (none of the four confirmed PRs touch the primary feed funnel's own capping mechanism) -- the underlying gap remains: no shared population-conservation test helper for the primary feed funnel, despite prior confirmed instances of the same silent-cap pattern across CHAIN-PRIMARY-CAP-20260827.
  Что останется в репозитории: tests/feed/lib/populationConservation.ts (still not created)
  Когда остановиться: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- A lint-style or test-suite check that enumerates fixed Set/array allowlists and numeric limits in lib/feed/**, lib/executor/** and scripts/modeling/** and requires each to carry an adjacent comment naming why it is bounded plus a completeness test proving nothing eligible is silently excluded. — делать сейчас.
  Проблема: PR#244 confirms a sixth case of this hypothesis's design-error class: an undocumented restrictive boundary silently drops eligible data without being named as an intentional bound. This time it was a market-type allowlist, not a numeric ceiling -- and it predates and outlived the commit that fixed the '200 research-scorer cap' instance in the same function.
  Что останется в репозитории: tests/lib/undocumentedCeilingAudit.ts (new)
  Когда остановиться: Stop if the audit produces unmanageable false positives against intentionally-bounded constants (e.g. the Reservation 15-slot cap, which is a named, justified bound, not this defect class).
- Unchanged from prior cycles: a shared, append-only operator-action log that both executors write to at message-submission time, which evolution-collect.mjs reads directly. — делать сейчас.
  Проблема: This period again established only a lower bound of zero for operator_action_events -- four PRs were authored and merged directly by the POLYPROPICKS account within seconds each, with no visible review step, but this reviewer still has no primary operator-action log. Same structural gap, another cycle.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Когда остановиться: Stop if this would require changing how executors start sessions.
- Unchanged: one bounded read-only sweep of the evidence/telemetry write call sites for unhandled legacy-shape branches, reusing the two confirmed instances as the seed pattern. — система позже.
  Проблема: No new instance this period -- the two prior confirmed instances of the same defect class (a money/execution evidence-write path silently losing data on an unhandled edge case: Horbury legacy callback PR#187, Reservation error-evidence insert PR#203) remain without the bounded read-only audit proposed repeatedly.
  Что останется в репозитории: reports/observation/<observation_id>.json (existing command output contract)
  Когда остановиться: Stop if the sweep would require production database access this executor does not hold.
- Unchanged in mechanism, newly targeted: one bounded read-only observation (a live feed/discovery sample or a GSP snapshot) taken after PR#245's merge, checking whether a soccer_exact_score or soccer_first_to_score market appears in the admitted population exactly as the 90 unit tests predict. — делать сейчас.
  Проблема: PR#245 adds a fourth instance of the same gap: a zero-CI, single-account, seconds-long merge that rewrites discovery/recovery/planning-anchor logic on the live Contract A path, with 90/90 tests reported in the PR body but zero post-merge invocation evidence -- following PR#194, PR#225 and PR#231.
  Что останется в репозитории: reports/observation/<observation_id>.json (existing command output contract)
  Когда остановиться: Stop if the observation would require a write-capable mode or a secret this executor does not already hold.
- Not a Routine A action on any of these branches. Recorded for Routine B: run terminal_persistence_stage on the 7-member family and on PR#241 itself, or supersede/close them; separately decide if the modeling-PR pile needs its own mechanism. — сначала продукт.
  Проблема: The originally tracked Governor/Evolution draft-PR family held steady at 7 members this period (#199/205/206/212/214/216/222, unchanged), and the five modeling-PR pile (#223/226/227/228/233) also held steady -- but a new member of the same generalized pattern appeared: PR#241, Routine B's own first real Automation Roadmap Governor run, opened this period and not yet merged.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed.
- A short, named verification-budget checklist item (not a new script) requiring that any new or materially modified bounded-pagination reader be validated once against an independent COUNT(*) or equivalent ground-truth denominator before its output is trusted as a canonicalized artifact. — система позже.
  Проблема: A reader built in the prior cycle (PR#234-239) silently undercounted 2026-09-03 by 97.2% (1,304 of 46,776 rows) until running it at full-day scale exposed the tie-drain bug (PR#242); it was only caught because PR#243's canonicalization step reconciled the output against a known-good COUNT(*) denominator.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md
  Когда остановиться: Stop if a future case shows the checklist item is not generalizable across pipeline shapes.

## Две практики Founder

- Treat a zero-CI, seconds-long, single-account merge touching a money-adjacent path (here PR#245, Contract A discovery/planning-anchor logic) as the boundary case for Axis A's source-vs-runtime split -- cap credit at SOURCE_OR_CONTROL_PROVEN until an independent post-merge observation exists.
  Зачем сейчас: This is the fourth consecutive cycle where the single largest true production-path change of the period (not a research/docs artifact) is also the one with the least external verification -- exactly where overcrediting Axis A would do the most damage, and exactly the pattern H6 now tracks four times over.
  Как ложится на проект: Whenever a merge touches lib/feed/discoverSportsMarkets.ts, lib/executor/planningAnchor.ts, app/api/cron/*, or another money/execution path with no CI check runs and no reviewer receipt, this review caps its Axis A credit at SOURCE_OR_CONTROL_PROVEN and records a targeted next observation (see H6) rather than letting the PR's own test count substitute for runtime proof.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md
- Before crediting any new or rewritten reader/aggregation pipeline as a working capability, check whether its output was reconciled against an independent known-good denominator -- a green test suite alone did not catch this period's own 97.2% silent undercount; only that reconciliation step did.
  Зачем сейчас: This period is the first direct proof, in this repository, that a fully test-covered pipeline can still silently drop the overwhelming majority of its data; the practice that actually caught it (reconciling against a known denominator) was incidental, not a required step.
  Как ложится на проект: Every Daily Evolution Review should ask, for any reader/pipeline change, 'what independent count was this reconciled against, and is that reconciliation itself evidenced' -- not just whether unit tests pass -- before crediting the change as CAPABILITY_ADDED or CAPABILITY_STRENGTHENED.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md

Сравнение: P1 is higher priority: it guards Axis A against overcrediting the unreviewed money-adjacent change this period again contains (a fourth confirmed instance). P2 is a data-integrity habit proven on a research-only pipeline with no direct business risk yet, but it generalizes to any future production-path reader.
Рекомендуемый порядок: сначала P1, затем P2.

## Следующие эксперименты

- A single bounded read-only observation of a live feed/discovery sample or GSP snapshot, taken after PR#245's merge, can independently confirm that at least one of soccer_exact_score or soccer_first_to_score reaches the admitted population exactly as the 90 unit tests predict, with no new code.
  Границы: One read-only observation only (no write path, no forceCreate); record the observed market family/identity fields alongside the expected values from PR#245's own test fixtures.
  Что останется: docs/ai-context/control-plane/EVIDENCE_LEDGER.md
  Считаем удачей: The observed sample shows at least one admitted market of either new family with the exact structured-identity shape PR#245's tests predict.
  Останавливаемся, если: Stop if the observation would require any write-capable mode, a secret this executor does not already hold, or forceCreate.
- The funnel population-conservation helper (H2) can still be prototyped from the two existing PR#201 test fixtures without new product code, unchanged from prior cycles.
  Границы: Prototype only, on the existing primaryPopulationDecoupling/primaryCoverageDiagnosticOnly fixtures; do not touch a new funnel stage.
  Что останется: tests/feed/lib/populationConservation.ts (new)
  Считаем удачей: A future cycle's fix on a different funnel stage reuses this helper instead of new one-off check code.
  Останавливаемся, если: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- This cycle's own terminal persistence can again reach canonical origin/main with zero Founder action, using the same GitHub-MCP-backed path already proven for the two prior cycles' own lineages.
  Границы: One canonicalization attempt for this cycle's own lineage only (cycles/2026-09-04__evolution-canonical-cycle.json + its report + this input bundle); no new mechanism invented if it fails, and no action taken on any other stranded branch.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-04__evolution-canonical-cycle.json
  Считаем удачей: A PR containing exactly the three allowlisted Evolution-evidence files is created and merged via GitHub MCP tools, and git merge-base --is-ancestor confirms this cycle's commit is an ancestor of origin/main.
  Останавливаемся, если: Stop and record PENDING_RESUMABLE if the branch, PR, or merge step is blocked by anything beyond this executor's available GitHub MCP tools -- do not invent a workaround.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: неизвестно
- сколько раз получили доказательство из реального рантайма: 1
- создано переиспользуемых артефактов: 2
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

Persist via the proven GitHub-MCP path (already validated for the two prior cycles' own lineages): push this cycle's three allowlisted files on this branch, create a PR against main, merge it, and verify origin/main ancestry. Do not babysit the 7-member Evolution/Governor draft-PR family, the modeling-PR pile, or PR#241 beyond recording all three for Routine B.
