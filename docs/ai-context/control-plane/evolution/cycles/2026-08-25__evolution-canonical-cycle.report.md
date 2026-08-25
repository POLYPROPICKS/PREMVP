# Daily Evolution Review

Период: 2026-08-25T00:00:00Z — 2026-08-26T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- Ничего измеримого.

Какой следующий проверяемый факт в проде стал возможен: пока никакой.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- Evolution Cycle persistence now enforces one canonical cycle per evaluation period: a retry resumes the same lineage, a competing cycle for that period is rejected. (остаётся в репозитории: scripts/control-plane/evolution-evaluate.mjs)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- Evolution Cycle persistence now enforces one canonical cycle per evaluation period: a retry resumes the same lineage, a competing cycle for that period is rejected. — 255/255 control-plane tests pass (incl. 6 new persistence tests); control-plane:check PASS; merged as d4baeb4 via PR#182; re-verified live in a fresh worktree just before this cycle.

## Что блокирует следующий шаг

- Business, revenue, launch or PnL impact of PR#182 and of the seven other PRs merged into origin/main the same calendar day (#175-#181) is not independently verified by this review.
- No production runtime evidence was collected this cycle.
- Behavior under genuinely concurrent writers (two processes persisting at once) is not tested — only sequential retries were verified.

## Варианты автоматизации

- A shared, append-only operator-action log both executors write to at message time, which evolution-collect.mjs reads directly instead of a manually authored bundle. — система позже.
  Проблема: This cycle only saw its own CloudCode session; Codex-side actions behind the other seven same-day PRs are invisible to it, so coverage is only partial.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Когда остановиться: Stop if it needs either executor to change how it starts sessions, or can't stay dependency-free and offline
- A read-only script that lists merge commits into origin/main within a given period and emits them as a confirmed_changes candidate list for the reviewer to accept or reject per item. — система позже.
  Проблема: confirmed_changes for this cycle was compiled by manually reading git log for merge commits on origin/main; the other seven merges the same day were identified but excluded from evidence because their business impact was not independently verified — correct, but slow and easy to under- or over-scope by hand.
  Что останется в репозитории: scripts/control-plane/evolution-collect.mjs
  Когда остановиться: Stop if the script's output is ever used to infer business impact rather than just list merge identity

Меньше пяти вариантов — намеренно: Only two automation gaps were directly observed and evidenced this cycle (partial cross-surface operator-action capture, manual confirmed-changes compilation); inventing three to six more to reach the 5-8 target would not be evidence-based.

## Две практики Founder

- Verifying an invariant's exact location and mechanism before patching it — reading the failing/blocking test itself, not just a description of it, before deciding what 'obsolete' means.
  Зачем сейчас: The prior mission depended entirely on finding the one test asserting cycles/ must stay empty; patching a plausible-sounding but wrong location would have shipped code with the real invariant still blocking every future cycle.
  Как ложится на проект: The same discipline applies to every other 'obsolete invariant' or 'stale gate' claim in this control plane — locate and read the exact enforcing code before trusting a description of what it does.
  Что останется в репозитории: tests/control-plane/evolutionDailyReview.test.mjs
- Treating executor-identity fields in persisted evidence as a correctness question, not a formatting detail — resolving which registered executor_id a session's runtime actually matches against CAPABILITY_MATRIX.yaml instead of guessing.
  Зачем сейчас: generated_by.executor is a permanent field in every future Evolution Cycle; a wrong identity here would misattribute capability evidence for as long as the history exists.
  Как ложится на проект: The same check applies anywhere a persisted record claims which executor did something — CURRENT_STATE.yaml, completion envelopes, reviewer receipts.
  Что останется в репозитории: docs/ai-context/control-plane/CAPABILITY_MATRIX.yaml

Сравнение: P1 is verification discipline before any patch lands; P2 is evidentiary correctness of self-identification inside the persisted record itself. P1 protects code correctness, P2 protects the durability and trustworthiness of the Evolution history.
Рекомендуемый порядок: сначала P1, затем P2.

## Следующие эксперименты

- A shared operator-action log written by both executors at message time would let coverage reach complete without manually authored events.
  Границы: One period, read-only design spike: sketch the log format and where each executor would append to it; no product or runtime change, no logging actually wired in yet.
  Что останется: docs/ai-context/control-plane/evolution/OPERATOR_ACTION_POLICY.yaml
  Считаем удачей: The sketch is reviewed and a following cycle collects a bundle from the shared log rather than a hand-authored one.
  Останавливаемся, если: Stop if a shared log would require either executor to change its session-start mechanism, or cannot stay dependency-free.
- A read-only merge-commit lister for a given period would make confirmed_changes deterministic instead of hand-compiled.
  Границы: One period, script prototype only: list merge commits into origin/main between two timestamps; the reviewer still decides which become confirmed_changes.
  Что останется: scripts/control-plane/evolution-collect.mjs
  Считаем удачей: A following cycle's confirmed_changes list is generated by the script and only reviewed, not hand-typed.
  Останавливаемся, если: Stop if the script's output is ever used to infer business impact rather than just list merge identity.

## Поддерживающие метрики

Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.

- время до проверенного результата: неизвестно
- доля задач, прошедших с первого раза: неизвестно
- количество переделок: неизвестно
- стоимость одного проверенного результата: неизвестно
- отказы ревьюера: неизвестно
- сколько раз получили доказательство из реального рантайма: 1
- создано переиспользуемых артефактов: 1
- ручных сообщений в CloudCode: 3
- ручных сообщений в Codex: 0
- правок от архитектора: 0
- промежуточных действий на одну миссию: 0.5
- действий на один проверенный результат: неизвестно

Ручных сообщений Founder за период: 3 (полнота сбора — частичный).
Правок от архитектора: 0. Они считаются отдельно и в число ручных сообщений не входят.

Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.

## Roadmap

Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.
Сейчас: уровень 1 — ежедневный разбор.

Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.

## Что произойдёт дальше

Persist this cycle to origin/main, then run a read-only Governor eligibility check to confirm the canonical history is consumable. No scheduling activation and no automation implementation follow from this cycle.
