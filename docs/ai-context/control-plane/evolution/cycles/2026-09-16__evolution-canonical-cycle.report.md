# Daily Evolution Review

Период: 2026-09-16T00:00:00Z — 2026-09-17T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): измеримых изменений нет.
По системе (переиспользуемые возможности): попрактиковались, но доказательства ещё нет.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: None. No commit merged to origin/main in this period touches the Contract A / Planning / Reservation / Queue path or any of the four open blockers (BLK-001 through BLK-004); the next possible verified fact is unchanged from the prior cycle: a natural night-reservations run proving Planning -> Reservation -> Final Identity -> immutable Queue..

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- A bounded, server-side narrow research-evidence projection RPC plus an I/O-free client cursor/dedupe contract, aimed at replacing full-envelope transport for the research clone. (остаётся в репозитории: PR#328 branch only (supabase/migrations/20260916140000_research_evidence_page.sql, lib/research-clone/researchEvidenceExport.ts) -- not yet on origin/main)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A bounded, server-side narrow research-evidence projection RPC plus an I/O-free client cursor/dedupe contract, aimed at replacing full-envelope transport for the research clone. — 56/56 research-clone tests and 12/12 materializer tests pass on the PR branch; tsc and build exit 0 there. Not canonical evidence -- the branch is unmerged.

## Что блокирует следующий шаг

- No fills, fees, settlement or reconciled PnL evidence exists for this period.
- The research-clone-daily-sync hard stop introduced in PR#324 (prior period) remains fully in place; nothing merged this period changes it.
- PR#328 (opened 2026-09-16, still draft/unmerged at evidence cutoff) prepares a narrow server-side research-evidence projection and a bootstrap-watermark repair for the research clone, but applies no production migration and touches no money-path code; it cannot be counted as movement because it is not merged to origin/main.
- BLK-001 (C1 natural-run proof), BLK-002 (Codex reviewer determinism), BLK-003 (Supabase write access from claude_code_cloud) and BLK-004 (Ireland runtime access) all remain exactly as recorded in CURRENT_STATE.yaml; no evidence this period touches any of them.
- No new capability persisted to origin/main this period; the only candidate (PR#328) remains an open draft with no production migration applied and no research-clone credential available to this executor to validate live.
- The two evolution-infrastructure merges that did land this period (PR#326 persisting the 2026-09-15 cycle, PR#327 persisting the 2026-09-16 Governor result) exercise an already-proven capability (the canonicalize terminal-persistence lifecycle); they are not a new or strengthened capability this period.

## Варианты автоматизации

- Unchanged from the 2026-09-15 cycle: a narrowly-scoped, read-first, Founder-authorized-write command for exactly EMERGENCY_QUIESCE_SCOPES on research-clone-daily-sync and signal-cache-cron. — делать сейчас.
  Проблема: This period again produced no new evidence that a bounded, Founder-authorized hosting-configuration write path exists. The research-clone-daily-sync hard stop from PR#324 remains fully in place because the safer, already-built scoped quiesce (PR#322) still cannot be activated without writing a Railway environment variable.
  Что останется в репозитории: docs/ai-context/control-plane/AGENT_REGISTRY.yaml
  Когда остановиться: Stop and do not build this until the Founder explicitly authorizes which variables, on which services, may ever be written this way.
- Unchanged from the 2026-09-15 cycle's H19 proposal: a short, mandatory pre-merge checklist covering query bound and startCommand/deploy-chaining position for any new production or research-clone read/write path. — делать сейчас.
  Проблема: PR#328 continues the same research-clone hardening path as PR#318/#320/#321/#324: it discovered, via a bounded read-only measurement, that full-envelope transport for one day (2026-09-14 Minsk) already costs roughly 140 MB against 18 fields research actually consumes, and prepared -- but has not merged or applied -- a narrow server-side projection to fix it.
  Что останется в репозитории: docs/ai-context/RESEARCH_CLONE_PRODUCTION_READ_SAFETY_CHECKLIST.md
  Когда остановиться: Stop if the checklist is ever used to block a merge rather than to inform review -- it is guidance, not a gate.
- Extend the Evolution input bundle with an optional, Founder-supplied free-text 'period_context' field (for example 'blocked on credentials', 'deliberate pause', 'travel') that this Routine may quote verbatim but never infer or fabricate. — система позже.
  Проблема: A full calendar day (2026-09-16) produced zero merges to origin/main other than the routine's own two evidence-only persistence commits (PR#326, PR#327); the only real engineering effort evidenced is one draft PR (#328) that remained unmerged at evidence cutoff, with no completion envelope and no OPERATOR_ACTION_EVENT record explaining why.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/EVOLUTION_CYCLE.schema.json
  Когда остановиться: Stop if the field is ever used to justify skipping the cycle itself rather than to add context to it.

Меньше пяти вариантов — намеренно: This period merged zero product commits to origin/main and produced only one in-flight draft PR; the evidence supports continuing two already-open hypotheses (H18, H19) and one newly observed measurement gap (H20), but does not support inventing five to eight distinct automation candidates from a single quiet day.

## Две практики Founder

- Measuring a suspected cost problem with real numbers before building the fix.
  Зачем сейчас: PR#328's case for a narrow research-evidence projection rests on a concrete bounded measurement (179 envelopes, 26,515 rows, ~140 MB for one day) rather than an assumption that full-envelope transport is slow.
  Как ложится на проект: Before authorizing the next research-clone or feed-path change, ask for the same kind of bounded read-only measurement (row count, payload size, wall time) the next mission already knows how to produce, rather than approving a fix based on description alone.
  Что останется в репозитории: POLYPROPICKS/PREMVP#328
- Recognizing when a quiet day needs an explicit reason instead of a guess.
  Зачем сейчас: Today's cycle had to record 'no measurable change' from a single unmerged draft PR and no other evidence, without knowing whether that reflects a deliberate pause or a blocked mission.
  Как ложится на проект: When a day is intentionally light (rest, travel, waiting on an external credential), a one-line note in the next Evolution input bundle removes the ambiguity for this Routine and for Routine B's cross-cycle comparison.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/input-bundles/2026-09-16__evolution-canonical-cycle.json

Сравнение: FP1 is the higher-leverage habit: it directly shapes whether the next research-clone fix is scoped correctly before code is written. FP2 is lower-stakes and mostly protects the quality of this Routine's own evidence rather than the product itself.
Рекомендуемый порядок: сначала FP1, затем FP2.

## Следующие эксперименты

- A single narrow, Founder-authorized command that can read and write exactly the EMERGENCY_QUIESCE_SCOPES variable on exactly the research-clone-daily-sync and signal-cache-cron Railway services would let a scoped-quiesce incident close the same day instead of falling back to a full hard stop.
  Границы: Exactly one variable name, exactly two named services, read-first with every write requiring explicit per-change Founder authorization; nothing else in Railway or any other hosting surface is touched.
  Что останется: docs/ai-context/control-plane/AGENT_REGISTRY.yaml
  Считаем удачей: The Founder authorizes the exact variable and service allowlist in writing, the command is built, and it is used at least once to close a real incident without a manual dashboard action.
  Останавливаемся, если: Stop if the Founder does not authorize a bounded allowlist, or if building it would require any broader write scope than the two named services.
- Naming an explicit query bound and payload-size estimate for every new production or research-clone read path, before merge, would catch a transport-cost problem like PR#328's at review time instead of after a separate measurement PR.
  Границы: Applies only to the next research-clone PR that adds or edits a production or clone read or write path; a checklist reference in the PR description, not a CI gate.
  Что останется: docs/ai-context/RESEARCH_CLONE_PRODUCTION_READ_SAFETY_CHECKLIST.md
  Считаем удачей: The next such PR cites the checklist and states its query bound and payload size, and no latent-layer defect is found on that path afterward.
  Останавливаемся, если: Stop if two consecutive research-clone PRs show the checklist adds review overhead with no defect prevented.
- Extracting the distinct Claude Code session identifier referenced in an open, unmerged PR's body (not only merged PRs) is a valid secondary lower bound for a manual Founder START action in the period it was opened.
  Границы: For the next three Evolution cycles, continue deriving a founder-actions lower bound this way from PR bodies (merged or open) created within the period, without building any new capture pipeline.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-16__evolution-canonical-cycle.json
  Считаем удачей: Three consecutive cycles derive a non-zero lower bound this way with no later evidence contradicting the one-session-equals-one-start assumption.
  Останавливаемся, если: Stop if a session id is ever found to span two different Founder-launched missions.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 0
- сколько раз получили доказательство из реального рантайма: 0
- создано переиспользуемых артефактов: 0
- ручных сообщений в CloudCode: 0
- ручных сообщений в Codex: 0
- правок от архитектора: 0
- промежуточных действий на одну миссию: неизвестно
- действий на один проверенный результат: неизвестно
- founder_actions_lower_bound_secondary: 1

Ручных сообщений Founder за период: 0 (полнота сбора — частичный).
Правок от архитектора: 0. Они считаются отдельно и в число ручных сообщений не входят.

Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.

## Roadmap

Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.
Сейчас: уровень 1 — ежедневный разбор.

Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.

## Что произойдёт дальше

Founder: decide the exact Railway variable and service allowlist so PR#322's scoped quiesce can replace PR#324's hard stop; when convenient, review and merge PR#328 (no production migration is applied by the merge itself) and share research-clone credentials so its narrow projection and bootstrap repair can be validated live.
