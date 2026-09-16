# Daily Evolution Review

Период: 2026-09-15T00:00:00Z — 2026-09-16T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): измеримых изменений нет.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: Once the research clone actually receives 2026-09-01 through 2026-09-15 data through the restored evidence lineage, the next possible verified fact is a first live comparison between the new direct materializer's research_model_ready_rows output and the existing model-ready pipeline output for the same dates..

Снятые блокеры:
- The research-clone daily sync had silently reported success while writing zero new rows since around 2026-09-11, because a migration moved money-evidence publication off generated_signal_pairs onto primary_evidence_outbox; PR#318 adds that table as a fourth synced source and restores the lineage feeding research_model_ready_rows.
- The new direct model-ready materializer added this period could never run in production, because the Railway startCommand chained it after the legacy sync step with a hard AND, so any nonzero exit from that unrelated legacy step silently skipped it; PR#321 separates the steps so the direct materializer always attempts to run regardless of the legacy step's outcome.

Появившиеся блокеры:
- research-clone-daily-sync's read of primary_evidence_outbox is now unconditionally hard-stopped, because that keyset query has no index on observed_at and pulls the full evidence_rows JSONB payload unbounded; it stays offline pending an index and bounded window, or a Railway scoped-quiesce variable this executor cannot set.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- A thin, reusable direct model-ready materializer reads bounded date ranges from the research clone into research_model_ready_rows and research_model_ready_days, reusing the already-proven identity, point-in-time and settlement helpers unmodified. (остаётся в репозитории: scripts/modeling/materialize-research-model-ready.ts)
- research-clone-daily-sync now reports structured, secret-free causal diagnostics on every run -- sync stage, reachability, outbox presence and row count -- replacing an ambiguous success-with-zero-rows signal. (остаётся в репозитории: scripts/research-clone-daily-sync.ts)
- A scoped kill switch can quiesce exactly the sources named in EMERGENCY_QUIESCE_SCOPES, for example signal-cache generation and the research-clone sync, leaving the money path -- night reservations and event rebalance -- unaffected. (остаётся в репозитории: lib/ops/emergencyQuiesce.ts)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A thin, reusable direct model-ready materializer reads bounded date ranges from the research clone into research_model_ready_rows and research_model_ready_days, reusing the already-proven identity, point-in-time and settlement helpers unmodified. — 4 of 4 new unit tests pass; 96 of 96 pre-existing modeling and research-clone tests still pass, no regression.
- research-clone-daily-sync now reports structured, secret-free causal diagnostics on every run -- sync stage, reachability, outbox presence and row count -- replacing an ambiguous success-with-zero-rows signal. — 13 of 13 new unit tests cover every stage; no probe selects evidence_rows or a secret field; 51 of 51 pre-existing tests still pass.
- A scoped kill switch can quiesce exactly the sources named in EMERGENCY_QUIESCE_SCOPES, for example signal-cache generation and the research-clone sync, leaving the money path -- night reservations and event rebalance -- unaffected. — 7 of 7 new unit tests prove the scoped mode isolates only named sources; 38 of 38 pre-existing tests still pass, money-path sources untouched.

## Что блокирует следующий шаг

- research-clone-daily-sync's read of primary_evidence_outbox is now unconditionally hard-stopped, because that keyset query has no index on observed_at and pulls the full evidence_rows JSONB payload unbounded; it stays offline pending an index and bounded window, or a Railway scoped-quiesce variable this executor cannot set.
- No fills, fees, settlement or reconciled PnL evidence exists for this period.
- PR#318's restored evidence lineage has not been run against the real research-clone project; this environment holds no SUPABASE_CLONE_URL or SUPABASE_CLONE_SERVICE_ROLE_KEY credential.
- PR#320's direct materializer has never executed against real 2026-09-01 through 2026-09-15 data, for the same credential reason.
- PR#321's fix has not yet been confirmed by a second live research-clone-daily-sync run reaching a completed model-ready-direct stage; only the first, failing run and the code and unit-test fix are evidenced.
- The selective EMERGENCY_QUIESCE_SCOPES capability shipped in PR#322 has not been activated on any Railway service, so research-clone-daily-sync remains fully hard-stopped rather than safely scoped.
- None of the three capabilities added this period has been exercised against live production or clone data yet; every validation so far is unit or regression tests only.
- The automatic CURRENT_STATE reconciliation used earlier this period for PR#318 did not repeat for the five further merges that followed it the same day, so post-merge state reconciliation is still not reliably automatic.

## Варианты автоматизации

- Trigger the existing reconciliation command from the same post-merge point every relevant PR uses, instead of leaving each PR's own execution to decide whether to invoke it. — делать сейчас.
  Проблема: CURRENT_STATE.yaml moved from state_version 22 to 23 this period, but only for PR#318; the five further merges that followed in the same period, PR#320 through PR#325, are still not reflected in it at the evidence cutoff -- the reconciliation mechanism now exists and fired once, but did not fire again for the rest of the same day.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs
  Когда остановиться: Stop and revert to manual reconciliation if the automation ever writes a roadmap_phase, current_value_step, capability verdict or PnL-gate change without separate authorization.
- Wire at least one real event source, even a minimal one that logs a session id and a timestamp at the moment a Founder manually opens a Claude Code or Codex session against this repository, so the next input bundle can carry a real, non-empty operator_action_events array instead of relying on session-id correlation after the fact. — система позже.
  Проблема: This period again produced only a lower bound of manual Founder actions, established indirectly from distinct Claude Code session identifiers referenced inside merged PR bodies plus one explicitly described manual Railway action, rather than from any OPERATOR_ACTION_EVENT record -- still an eleventh consecutive period with zero such records.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json
  Когда остановиться: Stop if the only available capture point requires a new mandatory manual step from the Founder.
- When a recurring defect's diagnosed root cause changes between cycles, require the review to explicitly state whether the newly identified fix supersedes, coexists with, or is independent of any prior open PR proposing a fix for the same symptom. — делать сейчас.
  Проблема: PR#315 (merged 2026-09-14) proved the recurring 10:00 Minsk zero-eligible-events symptom, diagnosed by prior cycles as a producer-freshness race (PR#310), was actually a mis-scoped OUTSIDE_RESERVATION_HORIZON rejection unrelated to producer timing. This period produced no new evidence about PR#310's disposition.
  Что останется в репозитории: scripts/control-plane/evolution-evaluate.mjs
  Когда остановиться: Stop if this check ever blocks a review from persisting terminal evidence -- it is diagnostic guidance, not a gate.
- The same narrowly-scoped, read-first, Founder-authorized-write command proposed on 2026-09-14, now with a concrete first allowlist candidate ready to hand: EMERGENCY_QUIESCE_SCOPES on the research-clone-daily-sync and signal-cache-cron Railway services only. — делать сейчас.
  Проблема: This period produced a second and third confirmation of the same gap first logged on 2026-09-12 (PR#310): PR#322 built a selective Railway kill switch and PR#324 explicitly could not activate it, because this executor still has no path to read or write a Railway environment variable, and shipped an unconditional code-level hard stop as a stand-in for that one configuration change.
  Что останется в репозитории: docs/ai-context/control-plane/AGENT_REGISTRY.yaml
  Когда остановиться: Stop and do not build this until the Founder explicitly authorizes which variables, on which services, may ever be written this way.
- A short, mandatory pre-merge checklist for any change that adds or edits a production or research-clone read or write path, covering exactly two questions: is every new query backed by an index or an explicit bound, and does this step's exit code affect any other step chained after it. — делать сейчас.
  Проблема: Within one research-clone hardening effort, two independent latent defects surfaced only once each step was exercised: PR#320's materializer was unreachable in production due to an unrelated startCommand chaining rule, fixed in PR#321; PR#318's new outbox read ran an unindexed, unbounded query, hard-stopped in PR#324. Neither was caught by unit tests or a clean build.
  Что останется в репозитории: docs/ai-context/RESEARCH_CLONE_PRODUCTION_READ_SAFETY_CHECKLIST.md
  Когда остановиться: Stop if the checklist is ever used to block a merge rather than to inform review -- it is guidance, not a gate.

## Две практики Founder

- Reading a self-diagnostic run's stage and causal-error output before handing off the next fix.
  Зачем сейчас: research-clone-daily-sync now reports its own sync stage and causal error class on every run; reading that output directly lets the Founder scope the next mission to the actual failing stage instead of the whole script.
  Как ложится на проект: The next time research-clone-daily-sync or its model-ready steps misbehave, check the new SYNC_STAGE and CAUSAL_ERROR_CLASS log lines first, and hand that exact stage to the next mission rather than a general re-diagnose-everything request.
  Что останется в репозитории: scripts/research-clone-daily-sync.ts
- Writing one bounded, explicit scope decision for a hosting-platform write capability.
  Зачем сейчас: The same missing capability, a scoped way to read and write named Railway environment variables, has now caused three separate temporary code workarounds in four days, most recently a full hard stop of the research-clone sync.
  Как ложится на проект: Decide and write down, once, the exact variable names and exact Railway services this capability may ever touch, starting with EMERGENCY_QUIESCE_SCOPES on research-clone-daily-sync and signal-cache-cron, so the next mission can build the bounded command instead of another code-level shim.
  Что останется в репозитории: docs/ai-context/control-plane/EVIDENCE_LEDGER.md

Сравнение: Practice FP1 is small and immediate: it only changes how the Founder reads an existing log line, and pays off on the very next research-clone incident. Practice FP2 is a one-time, higher-stakes decision that unblocks a structural capability gap repeated three times so far, but needs more thought since it is a real production write-access boundary.
Рекомендуемый порядок: сначала FP1, затем FP2.

## Следующие эксперименты

- A single narrow, Founder-authorized command that can read and write exactly the EMERGENCY_QUIESCE_SCOPES variable on exactly the research-clone-daily-sync and signal-cache-cron Railway services would let a scoped-quiesce incident like this period's close the same day instead of falling back to a full hard stop.
  Границы: Exactly one variable name, exactly two named services, read-first with every write requiring explicit per-change Founder authorization; nothing else in Railway or any other hosting surface is touched.
  Что останется: docs/ai-context/control-plane/AGENT_REGISTRY.yaml
  Считаем удачей: The Founder authorizes the exact variable and service allowlist in writing, the command is built, and it is used at least once to close a real incident without a manual dashboard action.
  Останавливаемся, если: Stop if the Founder does not authorize a bounded allowlist, or if building it would require any broader write scope than the two named services.
- Naming an explicit query bound and startCommand chaining position for every new production or research-clone read path, before merge, would have caught both of this period's latent defects at review time.
  Границы: Applies only to the next research-clone PR that adds or edits a production or clone read or write path; a checklist reference in the PR description, not a CI gate.
  Что останется: docs/ai-context/RESEARCH_CLONE_PRODUCTION_READ_SAFETY_CHECKLIST.md
  Считаем удачей: The next such PR cites the checklist and states its query bound and chaining position, and no latent-layer defect is found on that path afterward.
  Останавливаемся, если: Stop if two consecutive research-clone PRs show the checklist adds review overhead with no defect prevented.
- Extracting distinct Claude Code session identifiers referenced in merged PR bodies can serve as a temporary secondary lower bound for manual Founder actions until a real OPERATOR_ACTION_EVENT source exists.
  Границы: For the next three Evolution cycles, continue deriving a founder-actions lower bound this way from PR bodies merged in the period, without building any new capture pipeline.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-15__evolution-canonical-cycle.json
  Считаем удачей: Three consecutive cycles derive a non-zero lower bound this way with no later evidence contradicting the one-session-equals-one-start assumption.
  Останавливаемся, если: Stop if a session id is ever found to span two different Founder-launched missions.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: 0
- сколько раз получили доказательство из реального рантайма: 1
- создано переиспользуемых артефактов: 2
- ручных сообщений в CloudCode: 0
- ручных сообщений в Codex: 0
- правок от архитектора: 0
- промежуточных действий на одну миссию: неизвестно
- действий на один проверенный результат: неизвестно
- founder_actions_lower_bound_secondary: 3

Ручных сообщений Founder за период: 0 (полнота сбора — частичный).
Правок от архитектора: 0. Они считаются отдельно и в число ручных сообщений не входят.

Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.

## Roadmap

Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.
Сейчас: уровень 1 — ежедневный разбор.

Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.

## Что произойдёт дальше

Founder: trigger one more research-clone-daily-sync run to confirm PR#321 reaches a completed model-ready-direct stage; decide the exact Railway variable and service allowlist so PR#322's scoped quiesce can replace PR#324's hard stop; and, when convenient, apply the outbox schema SQL and share clone credentials to validate PR#318 and PR#320 live.
