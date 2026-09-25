# Automation Roadmap Review

Основано на циклах: 2026-08-25__evolution-canonical-cycle, 2026-08-26__evolution-canonical-cycle, 2026-08-28__evolution-canonical-cycle. Сформировано: 2026-08-30T02:07:24Z.

## Главный вывод

По системе (Manifest 2): существующая возможность стала прочнее.
По бизнесу: автоматизация доказательств пока недостаточно.

## Что улучшилось

- The Evolution/Governor control plane grew real machinery this window: Cycle schema 1.1 with defect/telemetry tracking (PR#184), Governor reading canonical persisted cycles directly (PR#186), and a terminal-persistence lifecycle (PR#209, 19/19 tests) built to remove the ~35h pending-PR latency the 2026-08-26 cycle suffered. All code- and test-proven; this is the first real exercise of most of it.

## Что реально помогло запуску и PnL

No automation hypothesis has a measured Axis A effect yet: production_observation.v1 was proposed for B2 three cycles running and never run; the one manual CURRENT_STATE.yaml fix (PR#204) decayed back to ~7 merges drift within a day. Real Axis A progress here (fixing the nightly Reservation HTTP 500, PR#203) came from direct product work, not automation.

Автоматизация никогда не оценивается сама по себе — только через то, приближает ли она запуск, выручку и сверенный PnL, или отвлекает от них.

## Что повторяется и требует автоматизации

- CURRENT_STATE.yaml (the sole current-state authority CLAUDE.md requires reading before any planning) goes stale within roughly a day of a manual fix, because the reconciliation library that could keep it current (control-plane-reconcile.mjs, PR#185) has never run on a schedule or gate — only once by hand. (встретилось 2 раз)
- An undocumented bare numeric cap or threshold (no named, justified constant) silently suppresses qualified candidates or scores somewhere in the primary/research feed funnel. (встретилось 5 раз)
- Operator-action capture coverage stays PARTIAL every single cycle because actions are inferred from git branches instead of recorded by either executor at message time. (встретилось 3 раз)
- A path that records evidence/diagnostics for a failed or legacy execution/reservation event silently drops or fails to write required data on an unhandled edge case (legacy Ireland callback missing submitted_size, then a NOT NULL diagnostics column on a failed Reservation run). (встретилось 2 раз)

Решения по автоматизации:
- Continuous/CI-gated invocation of the already-built control-plane-reconcile.mjs against CURRENT_STATE.yaml — продвинуть. Same-root repeat measured twice (11-merge drift, a manual fix via PR#204, then 7-merge drift again within ~36h) against a capability that already exists and is tested. Highest-leverage, lowest-cost candidate: wires an existing script, builds nothing new.
- Shared funnel population-conservation invariant helper (tests/feed/lib/populationConservation.ts) — отложить. Real, repeated pattern (5 confirmed occurrences across 2 cycles in chain CHAIN-PRIMARY-CAP-20260827) but both cycles that raised it classified it SYSTEM_LATER, not NOW, and only one automation investment is authorized this run. Revisit at the next Governor run once a prototype exists.
- Static lint rule against bare numeric caps/thresholds in scoring and funnel-admission code — отложить. Same underlying design-error class as the population-conservation gap (5 occurrences, 2 cycles), classified SYSTEM_LATER by both cycles that raised it. Deferred behind the single promoted investment this run.
- Shared, append-only operator-action log written by both executors at message time — отложить. Confirmed gap in all 3 cycles, classified NOW, but its footprint (both executors change how they record actions) is larger than the promoted candidate. Only one investment is authorized this run; revisit next Governor run.
- Read-only audit of evidence/diagnostics-recording paths on the money/execution track for other unhandled legacy-form gaps — отклонить. Both cycles that raised this (H5) already classified it PRODUCT_FIRST — a direct product-code audit on the execution/settlement path, not infrastructure automation. Routed to direct product work, not an automation decision.

## Какие навыки Founder закрепляются

- умение считать цену автоматизации — повторено 2 раз(а)
- умение заранее решать права и инструменты — повторено 2 раз(а)
- умение требовать доказательство, а не отчёт — повторено 1 раз(а)
- умение осознанно менять правила системы — повторено 1 раз(а)

## Что предлагается изменить в roadmap

Bind the already-built control-plane-reconcile.mjs into a recurring, read-only invocation (CI gate on merges to main, or a scheduled Routine) that compares CURRENT_STATE.yaml's origin_main_sha to live origin/main and opens a proposed delta PR past a small drift threshold (e.g. 3 merges) — replacing the one-off manual run (PR#204) that decayed within about a day.

Эффект на бизнес: None directly — no product, runtime or database change. Indirect support for Axis A: reduces the risk that a future Architect plan or patch task is built on a CURRENT_STATE.yaml that has silently drifted behind merged work, which CLAUDE.md requires reading first as the sole current-state authority before any implementation task.
Эффект на Manifest 2: Converts an already-built, already-tested reconciliation library (PR#185) that has been exercised exactly once by hand into a recurring, evidence-driven safeguard — closing the same-root-repeat state-drift defect confirmed in two consecutive cycles (2026-08-26 and 2026-08-28) with a deterministic script rather than a new agent.
Чем платим за это изменение: The bounded Founder/Architect time to wire a schedule or CI-gate invocation and to review the first few proposed deltas is spent here instead of on the population-conservation invariant helper or the shared operator-action log, both of which are real, evidenced gaps that stay deferred to a following Governor run because only one investment is authorized per run.
Отклонение от исходного roadmap: None — AUTOMATION_ROADMAP.yaml Stage 2 already lists factual metric updates from evidence as in-stage scope. This delta only sequences which already-in-scope Stage 2 capability gets a real trigger first; it does not add a new stage or new scope. (оправдано: да).
Как поймём, что сработало: At the next Governor run's evidence_cutoff, CURRENT_STATE.yaml's origin_main_sha is behind live origin/main by no more than a small bounded number of merges (for example <=3), instead of the 7-11 merges measured across the last two cycles.
Когда откатываем: Stop invoking the gate if it ever requires production runtime or database access beyond a read-only Git history comparison, or if the Founder rejects two consecutive proposed deltas as incorrect.

Это предложение, а не решение — изменение вступит в силу только после отдельного шага принятия (Promotion Gate).

## Что сохраняется без изменений

- Axis A priority over Axis B in every future Evolution cycle and Governor run
- CURRENT_STATE.yaml as the sole current operational state authority per CLAUDE.md
- Founder/Architect-only acceptance of any resulting state delta — the gate proposes, it never auto-accepts
- roadmap_phase, current_value_step, C1/C2 meaning, PnL gates and live-money authority, all untouched by this delta

## Риск ухода в лишнюю автоматизацию

Явного риска подмены бизнес-цели автоматизацией в этом периоде не зафиксировано. Проверка на это выполняется каждый раз заново.

## Следующий разумный шаг

Wire control-plane-reconcile.mjs into a CI gate or scheduled Routine per this delta, as a separate bounded task — this result only proposes it. Delivered via a pull request here since evolution_canonicalize.mjs needs the gh CLI, unavailable in this environment; the roadmap_delta still needs a separate Architect Promotion Gate before acceptance either way.
