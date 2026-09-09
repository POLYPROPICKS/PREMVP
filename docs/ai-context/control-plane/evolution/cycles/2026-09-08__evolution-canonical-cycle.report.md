# Daily Evolution Review

Период: 2026-09-08T00:00:00Z — 2026-09-09T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: A bounded read-only observation of the next real Ireland executor callback carrying a JSON numeric-string stake_usd, submitted_price, or a clob_order_id under one of its alias keys, confirming it is now accepted and persisted instead of rejected as REJECTED_QUEUE_POLICY_MISMATCH / MISSING_STAKE_USD -- not yet observed..

Снятые блокеры:
- PR#271 fixed a defect in the Ireland executor callback path: the numeric-field mapper accepted stake_usd/submitted_size only when JSON-typed as a number, nulling Ireland's numeric-string values and causing 14 live executions to be rejected as MISSING_STAKE_USD (HTTP 409). Fixed via the existing numLike() helper; a focused test was added.
- PR#274 fixed the sibling submitted_price field in the same object literal PR#271 had just fixed, which carried the identical typeof-narrowing defect -- the second layer of a same-day chain in one file.
- PR#277 broadened clob_order_id resolution to Ireland's venue_order_id/order_id/order_hash aliases and added deriveOrderEventPersistenceFields(), wiring accepted callback facts into an actual persistence path (app/api/executor/order-events/route.ts) rather than classifying them in memory only -- the third layer of the same chain.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- The PREMVP migration-execution path gained two new permanent guards: a directory preflight that fails closed on non-migration SQL, and a Windows credential bridge restoring one-start recovery without ever printing secrets. (остаётся в репозитории: lib/migration-directory-preflight.mjs; lib/windows-user-env-bridge.mjs)
- The PREMVP migration adapter's extractCausalFailure() now returns the real failure cause (timeout, DNS, auth, CLI error) instead of letting a progress banner mask it, bounded to 3 lines of 200 chars each. (остаётся в репозитории: scripts/control-plane/lib/premvp-migration-adapter-connection.mjs)
- The Automation Roadmap Governor ran for the first time against real history -- 12 real Evolution cycles, 2026-08-25 through 2026-09-07 -- and reached canonical main via PR#262 with a real ONE_AUTOMATION_INVESTMENT decision. (остаётся в репозитории: docs/ai-context/control-plane/evolution/roadmap-proposals/2026-09-08__automation-roadmap-governor-result.json + .report.md)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- The PREMVP migration-execution path gained two new permanent guards: a directory preflight that fails closed on non-migration SQL, and a Windows credential bridge restoring one-start recovery without ever printing secrets. — 3 new focused test files pass (migrationDirectoryPreflight, windowsUserEnvBridge, oneStartMigrationRecoverySemantics); existing adapter tests unchanged and still pass.
- The PREMVP migration adapter's extractCausalFailure() now returns the real failure cause (timeout, DNS, auth, CLI error) instead of letting a progress banner mask it, bounded to 3 lines of 200 chars each. — Focused tests updated and passing; sanitizeDiagnosticText() still redacts connection strings and secrets on top of the extracted excerpt.
- The Automation Roadmap Governor ran for the first time against real history -- 12 real Evolution cycles, 2026-08-25 through 2026-09-07 -- and reached canonical main via PR#262 with a real ONE_AUTOMATION_INVESTMENT decision. — Cites all 12 cycle ids; reached canonical main, unlike its 8 prior draft-only attempts (#190, #199, #206, #212, #214, #216, #222, #241), all still open.

## Что блокирует следующий шаг

- No live post-fix production observation exists confirming that a new Ireland callback carrying a numeric-string stake_usd/price or an aliased order id now succeeds and persists correctly -- only focused unit tests were exercised, not a runtime/business observation of the fix's own effect.
- Reconciled PnL is not claimed and cannot be: no fills, fees or settlement evidence exists for this period.
- The zero-CI-gate-on-merge pattern established in the 2026-09-07 cycle continues unchanged: PR#277, this period's last merge, returns total_count=0 on the GitHub Checks API, the same as every prior period.
- docs/ai-context/control-plane/CURRENT_STATE.yaml advanced twice this period (state_version 18 to 22) as a side effect of accepted completions, but went stale again within the same day: PR#271/272/274/275/276/277 (all merged after the 2026-09-08T11:07:12Z refresh) are not yet reflected in its accepted_completions or origin_main_sha.
- CURRENT_STATE.yaml's four open blockers (BLK-001 C1 natural night-reservations run, BLK-002 non-deterministic reviewer invocation / no CI gate, BLK-003 Supabase write access from claude_code_cloud, BLK-004 Ireland runtime access) remain unresolved and unchanged this period.
- The Automation Roadmap Governor's 2026-09-08 recommendation (extend premvp.ci_gate.reviewer_receipt_enforcement to money-adjacent files) is a proposal only; no Promotion Gate acceptance or implementation has occurred.
- The open (unmerged) draft/non-draft PR pile grew again this period, from 29 to 32 members at this cutoff (mcp__github__list_pull_requests, state=open), including a new non-draft member (#278, 'forward-port B1 GSP-independent migration') and two new drafts (#268, #273); none are confirmed evidence for this cycle.
- The PREMVP release/migration pipeline's six same-day proven-failure-class fixes (PR#264/266/269/272/275/276) demonstrate it is only now being exercised for real on local_codex_windows; no equivalent real end-to-end run has yet been observed on claude_code_cloud, and no production database migration has yet been applied through this hardened path.
- The Governor's recommended CI-gate extension is a proposal only (accepted:false); no Promotion Gate acceptance or implementation has occurred.
- The migration adapter's new guards (PR#275/#276) are test-validated only; no real production database migration has yet been executed through this hardened path to prove they hold under a genuine production failure.
- The executor callback field-normalization fixes (PR#271/#274/#277) are correctness fixes to an existing product file on the money-adjacent execution boundary, not new Manifest-2 capability-domain artifacts; they are counted under Axis A, not Axis B.
- The now six-round-deep release-pipeline chain shows the pipeline is only now being exercised for real on local_codex_windows; equivalent proof on claude_code_cloud remains absent.

## Варианты автоматизации

- A scheduled, read-only CURRENT_STATE reconciliation check (premvp.command.control_plane_reconcile.v1 already exists) run after each canonicalized Evolution cycle and after each accepted product completion, regardless of order, bounded to the existing state_bootstrap_allowlist. — делать сейчас.
  Проблема: CURRENT_STATE.yaml advanced twice this period (state_version 18 to 22) as a side effect of four accepted migration-release completions, then went stale again within the same day once PR#271/272/274/275/276/277 merged after the last refresh.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (already exists; proposal is scheduling, not new code)
  Когда остановиться: Stop if any proposed automatic reconciliation would touch a path outside state_bootstrap_allowlist -- that always requires an explicit bounded mission instead.
- Unchanged: instrument the executor surface(s) that produced this period's PRs to emit OPERATOR_ACTION_EVENT records consumable by premvp.command.evolution_collect.v1. — делать сейчас.
  Проблема: This period again established only a lower bound of zero operator-action events across fourteen real merges, including three that fixed a live-execution-boundary defect confirmed to have rejected 14 real Ireland executions.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (already exists; proposal is emission, not schema work)
  Когда остановиться: Stop if instrumentation would require reading Founder chat content this executor does not already have access to
- Unchanged in substance, now Governor-endorsed: wire premvp.ci_gate.reviewer_receipt_enforcement (registered PLANNED) as a tracked CI gate covering the money-producer isolation path, Contract A files, and the executor callback contract, per the 2026-09-08 Governor recommendation. — делать сейчас.
  Проблема: PR#277, this period's last merge, again returns total_count=0 on the GitHub Checks API -- the zero-CI-gate-on-merge pattern is unchanged from 2026-09-07, even in a period where the Automation Roadmap Governor's own canonical decision (PR#262) recommended extending premvp.ci_gate.reviewer_receipt_enforcement to money-adjacent files.
  Что останется в репозитории: premvp.ci_gate.reviewer_receipt_enforcement (registered PLANNED, implementation_path null); docs/ai-context/control-plane/evolution/roadmap-proposals/2026-09-08__automation-roadmap-governor-result.json (the accepted-pending Governor recommendation)
  Когда остановиться: Stop if wiring a CI gate would require credentials or CI infrastructure this executor does not hold -- escalate to a bounded architect decision instead of guessing one
- Not a Routine A action on any of these branches. Recorded for Routine B: run terminal_persistence_stage on the known families or explicitly classify/close them. — сначала продукт.
  Проблема: The tracked open-PR count grew from 29 to 32 at this cutoff, with three new members: #268 (draft), #273 (draft), and #278 (NOT draft -- 'forward-port B1 GSP-independent migration').
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed
- Unchanged: reconcile any new rolling-corpus reader output against an independently known row-count denominator before trusting it. — система позже.
  Проблема: No new instance this period -- the D-1 research-corpus reader defect chain (CHAIN-D1-RESEARCH-CORPUS-READER-20260904) had no new confirmed recurrence or new layer exposed. This is now the fourth consecutive period without one, past this hypothesis's own stated dormancy threshold of three.
  Что останется в репозитории: scripts/modeling/live-d1-research-corpus.ts (already exists)
  Когда остановиться: Already met as of the 2026-09-07 cycle (three consecutive periods without a new instance); recommend Routine B close this hypothesis as dormant now unless a new instance appears first.
- A focused test (or lint rule) over lib/executor/executorCallbackContract.ts asserting every raw.<field> read in the submission-normalization block is routed through numLike()/deriveOrderEventPersistenceFields() rather than a bare typeof or direct property read, so a future sibling-field gap fails CI instead of requiring a third live-rejection incident to surface. — делать сейчас.
  Проблема: Within lib/executor/executorCallbackContract.ts, three sequential same-day PRs (#271, #274, #277) each fixed one more field-normalization gap in the same submission-mapping function -- stake_usd/submitted_size, then submitted_price, then clob_order_id aliasing -- each discovered only after the previous fix landed, rather than in one pass.
  Что останется в репозитории: tests/contur3/executorOrderEvents.numericStringNormalization.test.ts (already exists; proposal extends its scope to a structural assertion over the whole mapping function)
  Когда остановиться: Stop if a structural assertion over the mapping function produces false positives on fields that are deliberately not numeric/identity-typed
- Require a recorded real (not only unit-tested) end-to-end dry run per supported executor, cited in the registry's proof references, before a control-plane pipeline command's status can be advanced past SUPPORTED to PROVEN_IN_RUNTIME; validate-command-bindings.mjs is the natural place to check the reference exists. — делать сейчас.
  Проблема: The PREMVP release pipeline (ENABLED since 2026-08-06, proof level SUPPORTED) hit six same-day proven failure classes the first time it ran for real on local_codex_windows (PR#264 Windows path, #266 unsafe upsert, #269 worktree assumption, #272 history drift, #275 directory/one-start, #276 causal-failure masking).
  Что останется в репозитории: scripts/control-plane/validate-command-bindings.mjs (already exists; proposal adds one check, not a new script)
  Когда остановиться: Stop if this check would block a promotion that already has equivalent real evidence recorded elsewhere (e.g. EVIDENCE_LEDGER.md) -- broaden the accepted evidence location instead of the requirement

## Две практики Founder

- When fixing a field-mapping or type-coercion defect in a shared normalization function, audit every sibling field in the same function for the identical pattern in the same pass, instead of fixing only the field a live incident happened to name.
  Зачем сейчас: PR#271, #274 and #277 today are a concrete, same-day, three-layer example of exactly the gap this practice closes: the first PR fixed only the field named in the 14-rejection incident, and two more same-day PRs were needed to close sibling gaps in the identical object literal.
  Как ложится на проект: Before merging a fix to lib/executor/executorCallbackContract.ts or any similar external-contract mapper, list every field read from the raw payload in the same function and confirm each one that should be numeric/identity-normalized actually is, in the same PR.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-08__evolution-canonical-cycle.json (this cycle's H11 record)
- Before marking a control-plane pipeline command ENABLED or PROVEN_PRESENT in AGENT_REGISTRY.yaml, run it for real end-to-end on the executor environment it will actually run in, not only against unit-test fixtures.
  Зачем сейчас: The PREMVP release pipeline was registered ENABLED on 2026-08-06 but had apparently never been exercised for real on local_codex_windows until this period, which then surfaced six sequential proven failure classes in one day.
  Как ложится на проект: Before the next control-plane pipeline command is promoted past SUPPORTED, run and record one real per-executor dry run (or live run) and cite it in the registry's proof references, per hypothesis H12.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-08__evolution-canonical-cycle.json (this cycle's H12 record)

Сравнение: P4 is higher priority: it protects a live execution boundary with a real, counted incident (14 rejected Ireland executions) and is immediately actionable. P5 is a broader process discipline with systemic but less immediate payoff.
Рекомендуемый порядок: сначала P4, затем P5.

## Следующие эксперименты

- A single bounded read-only observation of the next real Ireland executor callback carrying a JSON numeric-string stake_usd, submitted_price, or an aliased order-id field can confirm it is now accepted and persisted, not only the focused unit tests in PR#271/#274/#277.
  Границы: One read-only observation of the next naturally-occurring qualifying callback; no synthetic callback injection, no write path beyond what the existing route already performs.
  Что останется: docs/ai-context/control-plane/EVIDENCE_LEDGER.md (new entry recording the observed callback outcome, if one occurs)
  Считаем удачей: A real Ireland callback with a numeric-string economic field or an aliased order id is observed accepted and persisted rather than rejected.
  Останавливаемся, если: Stop if confirming this would require injecting a synthetic callback, reading Ireland-side logs this executor does not have access to, or any write beyond the existing route's normal behavior.
- The PREMVP release pipeline can complete one full real end-to-end run on claude_code_cloud (not only local_codex_windows) with zero new proven failure classes, closing the per-executor evidence gap named in hypothesis H12.
  Границы: One dry-run or validate-mode invocation of premvp.command.release_pipeline.v1 on claude_code_cloud against a real (not synthetic) migration candidate; no live database mutation unless the pipeline's own gates pass.
  Что останется: docs/ai-context/control-plane/AGENT_REGISTRY.yaml#premvp.command.release_pipeline.v1 (proof references updated with the run outcome) plus an EVIDENCE_LEDGER.md entry
  Считаем удачей: The run completes with a PASS or an explicit WAIT/BLOCKED verdict and zero new proven failure classes beyond the six already fixed this period.
  Останавливаемся, если: Stop and record EXTERNAL_WAIT if claude_code_cloud lacks a credential or environment binding this command already requires, rather than attempting to force one.
- This cycle's own terminal persistence can again reach canonical origin/main with zero intermediate Founder action, using the same GitHub-MCP-backed path already proven for prior cycles' lineages.
  Границы: One canonical Evolution cycle document plus its rendered report, persisted via the registered branch/PR/merge lifecycle; no product code path touched.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-08__evolution-canonical-cycle.json and its .report.md
  Считаем удачей: The cycle reaches canonical origin/main with a founder_action count of zero for this persistence step.
  Останавливаемся, если: Stop and return the canonical resumable outcome if the registered persistence lifecycle cannot complete within this execution window.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 0
- сколько раз получили доказательство из реального рантайма: 0
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

Persist via the proven GitHub-MCP path: push this cycle's allowlisted files, create a PR against main, merge it, and verify origin/main ancestry. Then run experiment E4 (observe the next real Ireland callback) and E5 (a claude_code_cloud release-pipeline dry run) as resources permit. Do not babysit the now-32-member open-PR family beyond recording it for Routine B.
