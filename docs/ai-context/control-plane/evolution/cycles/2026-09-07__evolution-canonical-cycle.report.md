# Daily Evolution Review

Период: 2026-09-07T00:00:00Z — 2026-09-08T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: A bounded read-only production observation of the next signal-generation run after PR#259/#260, confirming research/shadow writers stay gated behind SIGNAL_PRODUCER_MODE=research under real inventory -- not yet observed..

Снятые блокеры:
- PR#259 (reconciled by PR#260 as money-producer-isolation-v2-db7cc2d) isolates the live money-producer path from research writers: normal generation persists only the bounded primary money population and prunes Serving; research/shadow writers now require SIGNAL_PRODUCER_MODE=research. 6 tests, typecheck and build passed; recorded as an accepted completion.
- PR#257+PR#258 closed a two-layer defect (CHAIN-SPORTFAMILY-CARRIER-MISMATCH-20260907) in the research-clone model-ready pipeline: a providerSportFamily/sportFamily field mismatch made the frozen C1/C4 soccer branch unreachable. Fixed at the write boundary and with a historical-row read fallback; business-proof against real clone data reproduces the frozen PnL/ROI baseline exactly.
- PR#256 fixed clone rolling-economics membership to key on persisted model_date instead of decisionAt, and added bounded pagination so rolling reads no longer truncate at the page size. Contur gate reviewer PASS; 17/17 focused tests, typecheck, build and diff-check passed.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- Evolution/Governor terminal-persistence Stop-gate reaches canonical main for the first time (PR#255): a Stop hook blocks session end until a validated Evolution/Governor lineage is canonical. (остаётся в репозитории: .claude/hooks/evolution-governor-stop-gate.mjs (AGENT_REGISTRY.yaml hook entry))
- Governor's Founder-report renderer fixed to stay valid as canonical history grows: provenance now wraps across bounded per-line bullets instead of one long line. (остаётся в репозитории: scripts/control-plane/evolution-govern.mjs)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- Evolution/Governor terminal-persistence Stop-gate reaches canonical main for the first time (PR#255): a Stop hook blocks session end until a validated Evolution/Governor lineage is canonical. — 18/18 focused tests plus the full 328/328 suite pass (PR#255); no live end-to-end run recorded yet, so test-validated only.
- Governor's Founder-report renderer fixed to stay valid as canonical history grows: provenance now wraps across bounded per-line bullets instead of one long line. — Governor/Evolution/control-plane suites pass (58/58, 57/57, 310/310); real 11-cycle render PASS, max line 312 (PR#253).

## Что блокирует следующий шаг

- No live production observation exists confirming the money-producer isolation (PR#259/#260) actually holds under a real signal-generation run -- only unit tests, typecheck and a production build were exercised, none of them a runtime/business observation.
- Reconciled PnL is not claimed and cannot be: no fills, fees or settlement evidence exists for this period.
- All eight merges this period landed with zero CI checks (GitHub Checks API on PR#259 and PR#255 both return total_count=0), each opened-to-merged within seconds to minutes by one account with no reviewers -- the starkest BLK-002 instance yet: PR#259, the money-producer isolation itself, merged 3 seconds after opening.
- The sportFamily chain's business-proof (PnL/ROI table matching the frozen baseline) is a read-only clone/diagnostic measurement against historical data, not a live production/runtime observation and not reconciled PnL.
- CURRENT_STATE.yaml's four open blockers (BLK-001 C1 natural night-reservations run, BLK-002 non-deterministic reviewer invocation / no CI gate, BLK-003 Supabase write access from claude_code_cloud, BLK-004 Ireland runtime access) remain unresolved and unchanged this period.
- A new draft PR (#252, 'evidence(contur3): 2026-09-06 funnel-trace-audit -- Ireland order-submission stall', created 2026-09-07T02:14:33Z) appeared investigating a possible Ireland/C2 execution issue, but it is unmerged and its findings are not confirmed evidence for this cycle.
- The Stop-gate's live end-to-end enforcement (an actual session blocked at Stop, then successfully driven through canonicalization to a fresh canonical main) has not yet been observed and recorded in EVIDENCE_LEDGER.md.
- The money-producer isolation (PR#259/#260) and the sportFamily/rolling-window fixes (PR#256/257/258) are correctness fixes to existing product and modeling files, not new persisted Manifest 2 capability-domain artifacts; they are counted under Axis A, not Axis B.
- No Automation Roadmap Governor run itself executed or reached canonical persistence this period; the tracked Governor draft-PR family remains unmerged and unchanged in composition apart from the new #252 stray draft.

## Варианты автоматизации

- A scheduled, read-only CURRENT_STATE reconciliation check (premvp.command.control_plane_reconcile.v1 already exists) run after each canonicalized Evolution cycle regardless of whether a product completion was accepted, bounded to the existing state_bootstrap_allowlist. — делать сейчас.
  Проблема: CURRENT_STATE.yaml finally advanced this period (state_version 17 to 18, stale 10 cycles) -- but only as a side effect of PR#260 reconciling an accepted completion, not from any scheduled reconciliation independent of completion timing.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (already exists; proposal is scheduling, not new code)
  Когда остановиться: Stop if any proposed automatic reconciliation would touch a path outside state_bootstrap_allowlist -- that always requires an explicit bounded mission instead.
- Unchanged from prior cycles: a lint-style check flagging any new market-type/formula-version allowlist or numeric cap added or removed without an adjacent named justification comment or test. — система позже.
  Проблема: No new instance this period -- none of the eight confirmed merges touch a market-type/formula-version allowlist boundary.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/AUTOMATION_ROADMAP.yaml (candidate entry; not yet implemented)
  Когда остановиться: Stop if false-positive rate on existing intentional boundaries proves too high in a dry run
- Unchanged: instrument the executor surface(s) that produced this period's PRs to emit OPERATOR_ACTION_EVENT records consumable by premvp.command.evolution_collect.v1. — делать сейчас.
  Проблема: This period again established only a lower bound of zero operator-action events across eight real merges (PR#253/254/255/256/257/258/259/260), including the money-producer isolation itself -- the founder-action count stays a floor of zero, not a true count.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (already exists; proposal is emission, not schema work)
  Когда остановиться: Stop if instrumentation would require reading Founder chat content this executor does not already have access to
- Broadened in scope: the previously-proposed pre-merge capacity check on the three named files, plus premvp.ci_gate.reviewer_receipt_enforcement (already PLANNED in AGENT_REGISTRY.yaml) actually wired as a tracked CI gate instead of validator-only enforcement. — делать сейчас.
  Проблема: This period generalizes H6 sharply: all eight real merges, not just the three named files, were opened and merged within seconds to minutes by one account, no reviewers. GitHub Checks API on PR#259 and PR#255 confirms total_count=0 -- zero CI on either, including the money-producer isolation itself.
  Что останется в репозитории: scripts/control-plane/production-observation.mjs (already exists, reusable for the post-merge half); premvp.ci_gate.reviewer_receipt_enforcement (registered PLANNED, implementation_path null)
  Когда остановиться: Stop if wiring a CI gate would require credentials or CI infrastructure this executor does not hold -- escalate to a bounded architect decision instead of guessing one
- Not a Routine A action on any of these branches. Recorded for Routine B: run terminal_persistence_stage on the known families or explicitly classify/close them. — сначала продукт.
  Проблема: The tracked open-PR count grew from 28 to 29 at this cutoff (mcp__github__list_pull_requests state=open), with one new member: #252 ('evidence(contur3): 2026-09-06 funnel-trace-audit -- Ireland order-submission stall', draft, created 2026-09-07T02:14:33Z).
  Что останется в репозитории: docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml (already documents the intended terminal_persistence_stage for the Governor routine)
  Когда остановиться: Stop if closing or superseding these PRs would discard evidence a Founder has not yet reviewed
- Unchanged: reconcile any new rolling-corpus reader output against an independently known row-count denominator before trusting it. — система позже.
  Проблема: No new instance this period -- the D-1 research-corpus reader defect (chain CHAIN-D1-RESEARCH-CORPUS-READER-20260904) had no new confirmed recurrence or new layer exposed. This is the third consecutive period without one, at or past this hypothesis's own stated dormancy threshold.
  Что останется в репозитории: scripts/modeling/live-d1-research-corpus.ts (already exists)
  Когда остановиться: This hypothesis's own stop condition is now met: three consecutive periods without a new full-day reconciliation attempt. Recommend Routine B close this hypothesis as dormant next cycle unless a new instance appears first.
- No new automation proposed -- this hypothesis exists to track P1's own adoption evidence across cycles. — система позже.
  Проблема: No new instance this period -- none of the eight confirmed merges touch any of the three P1-named files (lib/feed/discoverSportsMarkets.ts, lib/feed/buildLandingCards.ts, lib/executor/planningAnchor.ts).
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-05__evolution-canonical-cycle.json#founder_practices.P1 (the practice itself; this hypothesis tracks its adoption, not its content)
  Когда остановиться: Stop tracking as a distinct hypothesis and fold back into H6 once one clear adoption or non-adoption instance on a widening change is observed
- A lightweight review checklist item (not new code): any change to a materializer or pipeline that renames or normalizes a field written to a persisted/accepted row must include, in the same PR, both a write-boundary test and a read-side backward-compatibility test against the pre-change row shape. — система позже.
  Проблема: PR#257 and PR#258 form a same-day two-layer onion chain: #257 fixed a materializer field-name mismatch at the write boundary; that fix immediately exposed that already-accepted historical rows still lacked the corrected field, needing a second same-day PR for a read-side fallback.
  Что останется в репозитории: docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md (candidate location for a new checklist line; not modified by this Routine)
  Когда остановиться: Stop if no qualifying field-rename/normalization change occurs in the next several cycles to test adoption against

## Две практики Founder

- State an explicit capacity/fanout estimate in the PR body for any change to the three H6-named files (lib/feed/discoverSportsMarkets.ts, lib/feed/buildLandingCards.ts, lib/executor/planningAnchor.ts), and treat any change touching the live money-producer/Contract A serving path as requiring at least one CI check or an explicit stated reason none ran.
  Зачем сейчас: This period's Checks-API confirmation that PR#259 (the money-producer isolation) merged with zero CI checks 3 seconds after opening is the starkest instance yet of the gap P1 was written to close.
  Как ложится на проект: Before merging any future change to the money-producer path or one of the three named files, state in the PR body what the change does to producer decisions/run or scorer fanout size, and either trigger at least one automated check or explicitly record why none exists yet.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-07__evolution-canonical-cycle.json (this cycle's H6 record)
- When a materializer or pipeline change renames or normalizes a field that is written to a persisted/accepted row, ship both a write-boundary test and a read-side backward-compatibility test for the pre-change row shape in the same PR.
  Зачем сейчас: PR#257 and PR#258 today are a concrete, same-day example of exactly the gap this practice closes: the first PR proved only the new-shape path, and the immutable old-shape rows needed a second PR hours later.
  Как ложится на проект: Any future change to scripts/modeling/clone-model-ready-pipeline.ts, lib/research-clone/modelReady.ts, or similar materializers should include a fixture built from the actual pre-change persisted row shape, not only the new shape.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-07__evolution-canonical-cycle.json (this cycle's H10 record)

Сравнение: P1 is higher priority: it protects the live money-producer/Contract A serving boundary and is now evidenced by the starkest zero-CI instance yet observed. P3 is lower-stakes but concrete and immediately actionable, protecting research/model correctness rather than the live money path.
Рекомендуемый порядок: сначала P1, затем P3.

## Следующие эксперименты

- A single bounded read-only production observation (premvp.command.production_observation.v1) of the next natural signal-generation run after PR#259/#260 deployed can confirm normal generation persists only the bounded primary money population and correctly gates research/shadow writers behind SIGNAL_PRODUCER_MODE=research under real inventory, not only the six focused unit tests in the PR.
  Границы: One read-only observation only; no write path, no forceCreate, no schema or code change.
  Что останется: reports/observation/<observation_id>.json (existing command output contract) plus a recorded entry in docs/ai-context/control-plane/EVIDENCE_LEDGER.md
  Считаем удачей: The observation confirms a natural run persisted only the bounded primary money population and that research-mode writers did not fire without the explicit flag.
  Останавливаемся, если: Stop if the observation would require a write-capable mode, a secret this executor does not already hold, or database access beyond the command's existing read-only contract.
- The Evolution/Governor terminal-persistence Stop-gate (PR#255) can complete one full live end-to-end cycle -- blocking Stop while a validated Evolution lineage is not yet canonical, then successfully driving canonicalization to a canonical main -- upgrading this hook's evidence rating from SUPPORTED to PROVEN_IN_RUNTIME.
  Границы: Observed passively as a byproduct of this cycle's own terminal persistence attempt; no separate mission, no manual triggering of a failure state.
  Что останется: docs/ai-context/control-plane/EVIDENCE_LEDGER.md (new entry recording a live block-then-canonicalize event, if one occurs)
  Считаем удачей: EVIDENCE_LEDGER.md records a live block-then-canonicalize event this cycle or a future one.
  Останавливаемся, если: Stop and record EXTERNAL_WAIT if this execution environment has no active Stop hook wired, rather than attempting to force one.
- This cycle's own terminal persistence can again reach canonical origin/main with zero intermediate Founder action, using the same GitHub-MCP-backed path already proven for prior cycles' lineages.
  Границы: One canonical Evolution cycle document plus its rendered report, persisted via the registered branch/PR/merge lifecycle; no product code path touched.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-07__evolution-canonical-cycle.json and its .report.md
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

Persist via the proven GitHub-MCP path: push this cycle's allowlisted files, create a PR against main, merge it, and verify origin/main ancestry. Then run experiment E1 (production observation of the money-producer isolation) as resources permit. Do not babysit the now-29-member draft-PR family beyond recording it for Routine B.
