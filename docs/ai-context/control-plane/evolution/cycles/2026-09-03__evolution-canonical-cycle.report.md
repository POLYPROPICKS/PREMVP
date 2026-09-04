# Daily Evolution Review

Период: 2026-09-03T00:00:00Z — 2026-09-04T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: PR#231 made the Reservation cron's window configurable (RESERVATION_TIMES_MINSK, default preserves the legacy 17:00 anchor). Next fact: a real post-merge Railway fire of the route, checked via ?mode=status, resolving exactly as the new unit tests predict -- not yet observed..

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- A rolling 7/14/30d research-corpus pipeline plus a deterministic scorecard evaluate the frozen C0/C1/C4/C5 predicates (PR#219) against real historical data -- the transition the prior cycle flagged as missing. (остаётся в репозитории: scripts/modeling/rolling-research-corpus.ts)
- A bounded, resumable daily sync mirrors three production Supabase tables row-for-row into a research-clone database on a Railway cron, with a finite page ceiling so a damaged source cannot become an unbounded run; hardened for reconciliation budget in the same period. (остаётся в репозитории: lib/research-clone/dailySync.ts)
- The live Reservation cron's anchor timing moved from one hardcoded 17:00 Minsk constant to a configurable, fail-closed RESERVATION_TIMES_MINSK anchor list, preserving legacy behavior when config is absent. (остаётся в репозитории: lib/executor/nightWindow.ts)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A rolling 7/14/30d research-corpus pipeline plus a deterministic scorecard evaluate the frozen C0/C1/C4/C5 predicates (PR#219) against real historical data -- the transition the prior cycle flagged as missing. — 4 completion envelopes PASS; new tests under tests/modeling/; SHA256 manifests under modeling/evidence/.
- A bounded, resumable daily sync mirrors three production Supabase tables row-for-row into a research-clone database on a Railway cron, with a finite page ceiling so a damaged source cannot become an unbounded run; hardened for reconciliation budget in the same period. — New tests: dailySync.test.ts, railwayConfig.test.ts, plus a same-period hardening PR (#232) adding reconciliation-budget tests.
- The live Reservation cron's anchor timing moved from one hardcoded 17:00 Minsk constant to a configurable, fail-closed RESERVATION_TIMES_MINSK anchor list, preserving legacy behavior when config is absent. — New tests (tests/contur3/reservationAnchors.test.ts): default fallback, multi-anchor, midnight rollover, bounded admission, fail-closed invalid input.

## Что блокирует следующий шаг

- PR#231 rewrites the live Reservation cron's anchor/window logic; merged directly by the POLYPROPICKS account in 4 seconds, 0 CI check runs (no .github/workflows exists repo-wide -- pre-existing, not new), no post-merge invocation recorded. Code/test-level only.
- The 7d/14d/30d research corpus and scorecard (PR#234/235/236/237/238/239) are explicitly backward-looking: FORWARD_VALIDATED=false, no winner chosen. The one positive cell (C0/C5, 30d +28.5% ROI) is, by the report's own text, one recent burst week, not a repeated effect.
- PR#230/#232 (research-clone daily sync) mirrors production tables into a research database; changes no product, serving or money path.
- CURRENT_STATE.yaml is unchanged since 2026-08-28T21:00:54Z (state_version 17) -- seventh consecutive cycle. This period newly proves the precise trigger: origin_main_sha is a proven ancestor of live origin/main, but the changed paths fall outside the state_bootstrap_allowlist, so it is STATE_REFRESH_REQUIRED, not merely aging.
- CHAIN-PRIMARY-CAP-20260827 and CHAIN-RESERVATION-LOOKBACK-20260828 remain open onion chains with no new links this period (H2/H5 continuity).
- No completion envelope was Architect-accepted this period. Four PASS-status envelopes exist in-repo for this period's modeling work but none reached CURRENT_STATE.yaml.accepted_completions.
- The scorecard is explicitly descriptive-only per its own FINDINGS document; it does not itself choose a model, and the declared next mission has not started.
- The research-clone daily sync has not been observed completing an unattended Railway-triggered run this period; runtime_evidence_count is 0.
- The Reservation anchor capability (PR#231) has zero CI check runs and no live cron-fire observation; SOURCE_OR_CONTROL_PROVEN only (H6).
- operator_action_events capture is still a lower bound with no primary per-message log (H4) -- unchanged from prior cycles.

## Варианты автоматизации

- Unchanged from prior cycles: wire scripts/control-plane/lib/control-plane-reconcile.mjs as a CI gate or a separate read-only Routine that compares CURRENT_STATE.origin_main_sha against live origin/main on every merge or on a fixed schedule. — делать сейчас.
  Проблема: CURRENT_STATE.yaml still shows updated_at=2026-08-28T21:00:54Z (state_version 17) -- seventh consecutive cycle unchanged. This period newly proves the exact classification: origin_main_sha is still an ancestor of live origin/main, but the changed paths fall outside the state_bootstrap_allowlist, so it is STATE_REFRESH_REQUIRED, not just aging.
  Что останется в репозитории: scripts/control-plane/lib/control-plane-reconcile.mjs
  Когда остановиться: Stop if reconciliation requires production runtime or database access, or the Founder rejects the proposed delta.
- Same shared population-conservation check across funnel stages proposed in prior cycles, still buildable from the two already-existing test cases (primaryPopulationDecoupling, primaryCoverageDiagnosticOnly) without new product code. — система позже.
  Проблема: No new instance this period (none of the nine confirmed PRs touch the primary feed funnel) -- the underlying gap remains: no shared population-conservation test helper for the primary feed funnel, despite 5-6 confirmed instances of the same silent-cap pattern across CHAIN-PRIMARY-CAP-20260827.
  Что останется в репозитории: tests/feed/lib/populationConservation.ts (still not created)
  Когда остановиться: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- Unchanged from prior cycles: a shared, append-only operator-action log that both executors write to at message-submission time, which evolution-collect.mjs reads directly. — делать сейчас.
  Проблема: This period again established only a lower bound of zero for operator_action_events -- several PRs were authored and merged directly by the POLYPROPICKS account within seconds with no visible review step, but this reviewer still has no primary operator-action log. Same structural gap, another cycle.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Когда остановиться: Stop if this would require changing how executors start sessions.
- Unchanged in mechanism, newly targeted: one bounded read-only GET of app/api/cron/night-event-reservations?mode=status after PR#231, to confirm resolveDueReservationAnchor/resolveNightWindow resolve against a real Railway wake-up exactly as the 44 unit tests predict. — делать сейчас.
  Проблема: B2 (PR#194) and the unified population (PR#191) remain code/test-confirmed only, still no production observation. This period adds a third instance of the same gap: PR#231's Reservation-anchor rewrite also has zero post-merge invocation evidence, alongside PR#225's still-unread diagnostics field.
  Что останется в репозитории: reports/observation/<observation_id>.json (existing command output contract)
  Когда остановиться: Stop if the observation returns an infrastructure-pending status twice in a row instead of a real result.
- Not a Routine A action on the other stranded branches. Recorded for Routine B: run terminal_persistence_stage on the 7-member family or supersede/close them; separately decide if the modeling-PR pile needs its own mechanism. This run persists its own lineage via GitHub MCP (E3) -- a normal step, not babysitting. — сначала продукт.
  Проблема: The tracked Governor/Evolution draft-PR family held steady at 7 members this period (#199/205/206/212/214/216/222, none closed or added). Separately, 5 new open/draft modeling PRs (#223/226/227/228/233) accumulated without terminal persistence -- same shape, different artifact class than PR#224 covers.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed.

Меньше пяти вариантов — намеренно: Only five hypotheses are supported this period. H3 and H5 remain valid families but had zero new evidence this period (PR#231's new constants are named and justified, not the bare-ceiling pattern H3 tracks; no money-lane evidence-write silent-loss instance appeared for H5); inventing a sixth/seventh to reach slack would violate the no-invention rule.

## Две практики Founder

- When a prior cycle's own axis_b.not_proven names a specific declared next transition (PR#219's 'CANONICAL_MODELING_DATASET_V1'), check a later period's new PRs against that exact name before treating them as an unrelated, brand-new capability -- this period's rolling-corpus/scorecard work is that exact transition, not a fresh, disconnected effort.
  Зачем сейчас: Six PRs of dense modeling work landed in one day; without checking the prior cycle's own declared next-step, it would have been easy to record this as a generic 'more modeling capability' entry instead of recognizing it closes a specifically tracked gap.
  Как ложится на проект: Every Daily Evolution Review should grep the prior 1-2 cycles' axis_b.not_proven and next_verified_production_fact_now_possible fields for named next-transition identifiers before writing this period's capability entries.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md
- Treat a zero-CI, seconds-long, single-account direct-merge PR that touches a money-adjacent production path (here: the Reservation cron's admission/anchor logic) as exactly the boundary case Axis A's source-vs-runtime proof-level split exists for -- credit it at most as code/test-confirmed, however large its own test suite, until a real post-merge invocation is independently observed.
  Зачем сейчас: PR#231 is the largest true production-runtime change of the period (not a research/docs artifact) and is also the one with the least external verification around it (no CI, no review, no completion envelope) -- exactly where overcrediting Axis A would do the most damage.
  Как ложится на проект: Whenever a merge touches app/api/cron/*, lib/executor/*, or another money/execution path with no CI check runs and no reviewer receipt, this review caps its Axis A credit at SOURCE_OR_CONTROL_PROVEN and records a targeted next observation (see H6) rather than letting the PR's own test count substitute for runtime proof.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/README.md

Сравнение: P2 is the higher-priority discipline: it guards Axis A, the highest-priority axis, against overcrediting exactly the kind of unreviewed money-adjacent change this period actually contains. P1 is a narrower evidence-linking habit that improves Axis B bookkeeping continuity but carries no direct business risk if skipped for one cycle.
Рекомендуемый порядок: сначала P2, затем P1.

## Следующие эксперименты

- A single bounded read-only GET of app/api/cron/night-event-reservations?mode=status, taken after PR#231's merge, can independently confirm the new configurable-anchor logic resolves identically to the 44 unit tests' predictions against a real production instant, with no new code.
  Границы: One read-only status call only (no forceCreate, no write path); record the response's window_start_iso, plan_run_id and configured_anchor_due alongside the expected values computed from the same nowMs.
  Что останется: docs/ai-context/control-plane/EVIDENCE_LEDGER.md
  Считаем удачей: The observed plan_run_id and window_start_iso match the deterministic values this reviewer can independently compute for the same instant under the default (unconfigured) anchor.
  Останавливаемся, если: Stop if the observation would require any write-capable mode, a secret this executor does not already hold, or forceCreate.
- The funnel population-conservation helper (H2) can still be prototyped from the two existing PR#201 test fixtures without new product code, unchanged from prior cycles.
  Границы: Prototype only, on the existing primaryPopulationDecoupling/primaryCoverageDiagnosticOnly fixtures; do not touch a new funnel stage.
  Что останется: tests/feed/lib/populationConservation.ts (new)
  Считаем удачей: A future cycle's fix on a different funnel stage reuses this helper instead of new one-off check code.
  Останавливаемся, если: Stop if funnel stages turn out to have incompatible terminal-reason shapes.
- This cycle's own terminal persistence can again reach canonical origin/main with zero Founder action, using the same GitHub-MCP-backed path already proven once for the prior cycle's own lineage (PR#229).
  Границы: One canonicalization attempt for this cycle's own lineage only (cycles/2026-09-03__evolution-canonical-cycle.json + its report + this input bundle); no new mechanism invented if it fails, and no action taken on any other stranded branch.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-03__evolution-canonical-cycle.json
  Считаем удачей: A PR containing exactly the three allowlisted Evolution-evidence files is created and merged via GitHub MCP tools, and git merge-base --is-ancestor confirms this cycle's commit is an ancestor of origin/main.
  Останавливаемся, если: Stop and record PENDING_RESUMABLE if the branch, PR, or merge step is blocked by anything beyond this executor's available GitHub MCP tools -- do not invent a workaround.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: неизвестно
- сколько раз получили доказательство из реального рантайма: 0
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

Persist via the proven GitHub-MCP path (already validated once for the prior cycle's own lineage via PR#229): push this cycle's three allowlisted files on this branch, create a PR against main, merge it, and verify origin/main ancestry. Do not babysit the 7-member Evolution/Governor draft-PR family or the newly observed modeling-PR pile beyond recording both for Routine B.
