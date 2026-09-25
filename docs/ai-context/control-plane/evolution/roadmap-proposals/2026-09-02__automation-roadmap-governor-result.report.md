# Automation Roadmap Review

Основано на циклах: 2026-08-25__evolution-canonical-cycle, 2026-08-26__evolution-canonical-cycle, 2026-08-28__evolution-canonical-cycle, 2026-08-30__evolution-canonical-cycle, 2026-08-31__evolution-canonical-cycle, 2026-09-01__evolution-canonical-cycle. Сформировано: 2026-09-02T02:08:29Z.

## Главный вывод

По системе (Manifest 2): существующая возможность стала прочнее.
По бизнесу: автоматизация отвлекло от запуска и PnL.

## Что улучшилось

- Across all six cycles the Evolution and Governor system itself matured steadily: cycle schema moved to 1.1 with operating telemetry, the terminal canonicalization command was built and proven end to end, and Governor tests stopped hard-coding the live cycle count. This is real, tested capability growth in the Evolution/Governor machinery, not yet in the wider product.

## Что реально помогло запуску и PnL

The three most recent review periods (2026-08-30, 2026-08-31, 2026-09-01) each merged exactly one PR, and every one of them was Evolution/Governor self-maintenance (PR#211, PR#213, PR#220) with zero direct product movement recorded. That is a real, evidenced stall on the production vertical coinciding with continued Evolution/Governor build-out, not a one-off quiet day.

Автоматизация никогда не оценивается сама по себе — только через то, приближает ли она запуск, выручку и сверенный PnL, или отвлекает от них.

## Что повторяется и требует автоматизации

- CURRENT_STATE.yaml keeps drifting behind live origin/main and the already-built reconciliation library is never run on a schedule or gate, only once by hand (встретилось 5 раз)
- B2 policy and the unified canonical signal population are confirmed only at code and test level, never by a live production_observation.v1 run (встретилось 5 раз)
- Operator-action coverage stays a branch-inferred lower bound, never a complete count, because no shared append-only log exists yet (встретилось 6 раз)
- Silent undocumented numeric caps in the event funnel repeatedly hide real candidates and are only found one at a time by hand (встретилось 2 раз)
- Unhandled legacy data shapes on the money/execution evidence path silently drop callback or job-run evidence (встретилось 2 раз)
- Stranded Governor/Evolution draft pull requests keep accumulating instead of being closed (встретилось 3 раз)

Решения по автоматизации:
- CURRENT_STATE.yaml reconciliation gate — продвинуть. The deterministic computation already exists and is already tested (PR#185), it was run by hand exactly once and drifted again within the same review period, and the same gap has now repeated across five straight review periods with no new code needed beyond wiring it in read-only.
- Funnel-boundary population-conservation test helper — отложить. Four confirmed instances of the same silent-cap defect class exist across two periods, but zero new instances in the four most recent periods and the reviewer itself classified this system-later. Building it now would be new tooling investment during a stretch this review already flags as light on direct product movement.
- Static lint rule for undocumented numeric ceilings — отложить. Same repeated design-error class as the funnel-boundary helper, also classified system-later by the reviewer, with no fresh instance in four consecutive periods. Lower near-term leverage than closing the state-drift gap.
- Shared operator-action append log for complete coverage — отложить. Operator-action count is designated diagnostic-only by policy, never an axis verdict. Six periods of partial coverage have not been shown to mislead any actual decision, so this stays lower leverage than the state-drift gate this period.
- Legacy-callback and economic-telemetry field coverage audit — отклонить. This is a bounded read-only product-verification task ahead of live money, not an infrastructure automation investment. It belongs to direct production-vertical work as an ordinary next step, not to a Governor roadmap delta.
- Live production_observation.v1 run against B2 and the unified population — отклонить. Running an already-registered, already-built read-only observation command is ordinary Axis A verification work, not a new automation investment. Recommended as the Founder's next direct step regardless of this Governor's disposition.
- Stranded Governor/Evolution draft pull request cleanup — отложить. This is a repository hygiene gap tied to GitHub tooling friction in this execution environment, not a case for building more automation. The right next action is a bounded closure pass on the stranded drafts, owned directly rather than through a roadmap delta.

## Какие навыки Founder закрепляются

- умение требовать доказательство, а не отчёт — повторено 8 раз(а)
- умение считать цену автоматизации — повторено 2 раз(а)
- умение заранее решать права и инструменты — повторено 3 раз(а)

## Что предлагается изменить в roadmap

Wire the already-built reconciliation library (control-plane-reconcile.mjs, PR#185) into one bounded, read-only check that counts how many origin/main merges CURRENT_STATE.yaml is behind, flags when that crosses a small threshold, and proposes a factual delta for sign-off. It never writes CURRENT_STATE.yaml directly.

Эффект на бизнес: Indirect support for Axis A: stops the next Architect planning session, and this Governor's own future runs, from silently building on a CURRENT_STATE.yaml that has already drifted from live origin/main for five straight review periods. No execution, callback, settlement or PnL code is touched.
Эффект на Manifest 2: Closes an operational gap already inside approved Stage 2 scope, which names factual metric updates from evidence as in-scope. It finally exercises a library that has sat built and tested for three review periods without a schedule or gate around it.
Чем платим за это изменение: This is the only automation investment promoted this pass. Six other recurring gaps are deferred or rejected instead, so direct production-vertical work and the open live-observation gaps get the Founder's and Architect's attention, not further Evolution or Governor tooling.
Отклонение от исходного roadmap: none: this sits inside already-approved Stage 2 scope and adds no new stage, capability or agent (оправдано: да).
Как поймём, что сработало: In the next Governor review period, CURRENT_STATE.yaml's recorded origin_main_sha is within a small configured merge count of live origin/main without a hand-typed one-off reconciliation, replacing the current pattern of one manual fix followed by immediate re-drift.
Когда откатываем: Stop and fall back to manual-only reconciliation if the gate ever needs write access to CURRENT_STATE.yaml, production runtime or the database, if it produces more than one false-positive drift alert against a period with no relevant merge, or if the Founder turns down the proposed delta pattern.

Это предложение, а не решение — изменение вступит в силу только после отдельного шага принятия (Promotion Gate).

## Что сохраняется без изменений

- The Axis A priority invariant: launch, revenue, settlement and reconciled PnL stay above Manifest 2 capability
- CURRENT_STATE.yaml as the sole current operational state artifact and its existing authority
- The existing manual Architect and Founder confirmation step before any CURRENT_STATE.yaml delta is applied
- The Governor's own evidence-only, self-declined proposal boundary

## Риск ухода в лишнюю автоматизацию

Есть признак, что автоматизация в этом периоде отвлекала от запуска и PnL — это явно зафиксировано выше, а не сглажено.

## Следующий разумный шаг

Have the Roadmap Operations Lead or Architect compile the promoted CURRENT_STATE.yaml reconciliation gate as one bounded task and wire it in, then return direct effort to the production vertical (execution, callback, terminal state, settlement, fees, reconciled PnL) rather than further Evolution or Governor tooling.
