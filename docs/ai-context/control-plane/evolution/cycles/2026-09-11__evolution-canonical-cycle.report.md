# Daily Evolution Review

Период: 2026-09-11T00:00:00Z — 2026-09-12T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- PR#296 added a Contract A loss-containment floor (min entry price 0.50, above the frozen 0.30 B2_PRICE_FLOOR), justified by terminal evidence that every measured loss sat below 0.50. PR#300 then landed the reviewed 24h pre-start timing window on the same policy owner.
- A three-PR chain (#298, #299, #301) replaced one-representative-per-event scoring with bounded multi-identity fan-out gated by a volume/odds floor; each PR self-reports scorePolymarket.ts and Contract A policy files unchanged (diff-clean).
- PR#302 proved and fixed a live root cause (a provider event's gameId was never copied onto its flattened market), which was fragmenting single physical matches into separate scored events. Measured live: group count 4,569 -> 1,897; one real match's true volume moved from a losing rank to a surviving one. The regression test was confirmed to fail pre-fix and pass post-fix via git stash.

Какой следующий проверяемый факт в проде стал возможен: A bounded premvp.command.production_observation.v1 run against PR#302's merged SHA (2999538c) could confirm deployed build identity and whether the grouping fix visibly changed served landing-card composition -- not yet observed..

Снятые блокеры:
- PR#302 removed a silent physical-event identity-fragmentation defect (proven live, not merely hypothesized) that was demonstrably costing volume-ranked visibility for merged provider-event fragments sharing one real-world match.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- PR#298 added sampleToCandidateMarkets, a new exported pure function fanning one discovery sample out to one CandidateMarket per identity; PR#299 layered a bounded volume/odds gate onto the same boundary, both leaving scoring/Contract A untouched. (остаётся в репозитории: lib/feed/buildLandingCards.ts, lib/feed/discoverSportsMarkets.ts)
- PR#302 persisted a fail-before/pass-after regression-proof method: the new test is stated to fail on pre-fix code and pass post-fix, confirmed via git stash rather than asserted from memory. (остаётся в репозитории: tests/feed/physicalEventGameIdGrouping.test.ts)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- PR#298 added sampleToCandidateMarkets, a new exported pure function fanning one discovery sample out to one CandidateMarket per identity; PR#299 layered a bounded volume/odds gate onto the same boundary, both leaving scoring/Contract A untouched. — 3 focused test files pass (self-reported); diff-clean against scoring/Contract A files.
- PR#302 persisted a fail-before/pass-after regression-proof method: the new test is stated to fail on pre-fix code and pass post-fix, confirmed via git stash rather than asserted from memory. — Self-reported: fails pre-fix (0 !== 1), passes post-fix; network-free via stubbed global.fetch restored in finally.

## Что блокирует следующий шаг

- No production deployment check and no runtime observation was performed this period for any of the 7 merges -- every claim above is SOURCE_LEVEL, never PROVEN_IN_RUNTIME. runtime_or_business_evidence_exists is false, a seventh+ consecutive cycle with this exact gap (see H13).
- Reconciled PnL is not claimed and cannot be: no fills, fees or settlement evidence exists for this period.
- PR#300 and PR#301 each claim 'Reviewer receipt: premvp.reviewer.contur_gate.v1' in body text -- get_reviews and get_check_runs both returned zero reviews and zero checks for each PR. Self-attested prose only, not a verifiable artifact (same gap as H6).
- PR#298's own body states 'Not merging -- leaving for Founder/human review', yet it was merged the same day anyway -- no evidence explains the discrepancy between stated intent and actual outcome.
- CURRENT_STATE.yaml (state_version 22, updated 2026-09-08) still describes zero of the last three periods' merges and still frames the roadmap step as BOUNDED_PRE_HOOK_SEED bootstrap -- per its own stale_when rule this is STATE_REFRESH_REQUIRED, not merely aging.
- The open (unmerged) PR pile stands at 30 at this cutoff, essentially unchanged across recent cutoffs; none of this period's 7 merges came from that pile.
- PR#297 (tennis fail-closed taxonomy fix) carries no body text beyond its commit message -- its verification evidence could not be independently characterized.
- Neither capability has been exercised by a real production run yet -- no post-deployment observation confirms sampleToCandidateMarkets' fan-out or the gameId grouping fix changed served feed composition in the live app.
- The R4_CONTUR_PRODUCTION_BOUNDARY reviewer-invocation capability (premvp.reviewer.contur_gate.v1) remains NOT_PROVEN as a deterministic, independently-evidenced mechanism: PR#300 and PR#301 both claim a Contur-gate receipt in body text with zero corroborating GitHub review or check run (BLK-002 unchanged, now with two additional unverifiable claims).

## Варианты автоматизации

- A post-merge step (reusing existing, PROVEN_IN_RUNTIME premvp.command.control_plane_reconcile.v1) after every merge touching lib/executor/**, lib/feed/**, or lib/modeling/**, appending a factual accepted_completions entry -- no roadmap/capability-verdict change, which stays Founder-authorized. — делать сейчас.
  Проблема: CURRENT_STATE.yaml (state_version 22, updated 2026-09-08T11:07:12Z) is now stale across three consecutive periods -- it reflects none of the 2026-09-09 GSP-independence chain, the 2026-09-10 exact-anchor fix, or this period's 7 merges (money-admission floor, multi-identity fan-out, physical-event grouping fix).
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (existing) plus a new invocation trigger, if adopted
  Когда остановиться: Stop and revert to manual reconciliation if the automation ever writes a roadmap_phase, current_value_step, capability verdict, or PnL-gate change without separate Founder authorization.
- Wire at least one real OPERATOR_ACTION_EVENT source so the next Evolution input bundle can carry real events instead of an empty array. — система позже.
  Проблема: This period again established only a lower bound of zero operator-action events across seven real merges -- no OPERATOR_ACTION_EVENT record has ever existed in this repository, only the schema file.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (exists); a new capture point would be the missing artifact
  Когда остановиться: Stop if the only available capture point requires a new mandatory manual step from the Founder.
- A required GitHub status check that fails a PR labeled/detected as R4_CONTUR_PRODUCTION_BOUNDARY unless a machine-readable reviewer receipt is attached to the PR, reusing the already-specified output_contract of premvp.reviewer.contur_gate.v1. — делать сейчас.
  Проблема: PR#300 and PR#301 each state in their body 'Reviewer receipt: premvp.reviewer.contur_gate.v1 for <sha>', yet get_reviews and get_check_runs found zero GitHub reviews and zero checks on either PR -- two new instances of a pattern first flagged in the 2026-09-09 cycle (PR#285/#286).
  Что останется в репозитории: premvp.ci_gate.reviewer_receipt_enforcement (AGENT_REGISTRY.yaml; currently PLANNED, implementation_path null)
  Когда остановиться: Stop and fall back to advisory (non-blocking) mode if the gate produces a false block on a legitimately reviewed PR.
- A periodic (not this Routine's) audit that classifies each open PR as SUPERSEDED / STILL_ACTIVE / ABANDONED against current origin/main and proposes closure only for provably superseded entries -- never an automatic close. — сначала продукт.
  Проблема: The tracked open-PR count stands at 30 at this cutoff (mcp__github__list_pull_requests, state=open), essentially unchanged across recent cutoffs; none of this period's 7 real merges came from that pile.
  Что останется в репозитории: No artifact proposed yet -- remains PRODUCT_FIRST until a Founder decision on disposition criteria exists.
  Когда остановиться: Stop if any classification would require inferring Founder intent rather than reading provable Git supersession.
- No action proposed this period; carry the chain forward dormant. — система позже.
  Проблема: No new instance this period -- the D-1 research-corpus reader defect chain (CHAIN-D1-RESEARCH-CORPUS-READER-20260904) had no confirmed recurrence; none of this period's seven merges touch that reader.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-04__evolution-canonical-cycle.json (original record)
  Когда остановиться: N/A
- After any merge touching lib/executor/**, lib/feed/**, or app/api/executor/**, automatically queue one bounded premvp.command.production_observation.v1 run against that merge's SHA and record its outcome in EVIDENCE_LEDGER.md regardless of result. — делать сейчас.
  Проблема: For a seventh+ consecutive cycle, real product merges (this period: 7, spanning the money-admission floor, timing window, and scoring/discovery fan-out) land with only SOURCE_LEVEL evidence, and no runtime/production observation step is ever scheduled to close the loop into PROVEN_IN_RUNTIME.
  Что останется в репозитории: scripts/control-plane/production-observation.mjs (existing, PROVEN_IN_RUNTIME) plus a new invocation trigger, if adopted
  Когда остановиться: Stop and revert to manual triggering if automatic queuing produces false PROMPT_GATE_BLOCKED escalations rather than clean WAIT_INFRASTRUCTURE_RECOVERY classifications.
- Extend the same proposed reviewer-receipt-enforcement gate (H6) to also block a merge when the PR body contains an explicit non-merge marker (e.g. 'Not merging', 'awaiting review') that has not been retracted, rather than treating it as prose with no operational effect. — делать сейчас.
  Проблема: PR#298's own body states 'Not merging -- leaving for Founder/human review and merge per repo protocol', but the PR was merged the same day (2026-09-11T10:36:29Z, ~6 minutes after its own creation) regardless -- no mechanism in the repository enforces a PR's stated merge-readiness intent.
  Что останется в репозитории: premvp.ci_gate.reviewer_receipt_enforcement (AGENT_REGISTRY.yaml; currently PLANNED, implementation_path null)
  Когда остановиться: Stop and fall back to advisory (non-blocking) mode if the gate produces a false block on a PR whose caveat was legitimately superseded.

## Две практики Founder

- Before trusting any PR body line that claims a reviewer or gate outcome (e.g. 'Reviewer receipt: premvp.reviewer.contur_gate.v1'), independently check get_reviews and get_check_runs on that exact PR rather than accepting the stated claim.
  Зачем сейчас: This period produced two more instances (PR#300, PR#301) of a claimed Contur-gate receipt with zero corroborating GitHub review or check run -- the same gap first observed in the 2026-09-09 cycle, now recurring on Contract A timing and scoring-path merges specifically.
  Как ложится на проект: Apply this check as a standing step in every future Daily Evolution Review before accepting any R3/R4-risk-class PR's self-reported gate outcome as SUPPORTED evidence.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-11__evolution-canonical-cycle.json (this cycle's H6 record)
- When fixing a suspected root cause, prove the new regression test actually catches the bug: confirm it fails on pre-fix code (via a local revert or git stash), then confirm it passes post-fix, rather than writing a test that could pass unconditionally.
  Зачем сейчас: PR#302 demonstrated this discipline explicitly (fails pre-fix with an AssertionError, passes post-fix, verified via git stash) for a real production-affecting identity-fragmentation bug -- a materially stronger verification standard than most of this period's other PRs, which report only post-fix passing counts.
  Как ложится на проект: Apply the same fail-before/pass-after discipline to every future root-cause fix on the feed/discovery/scoring path, not only when a forensic mission explicitly calls for it.
  Что останется в репозитории: tests/feed/physicalEventGameIdGrouping.test.ts

Сравнение: P10 is a cheap, immediate verification habit applicable to every future PR review; P11 is a heavier authoring discipline that only applies when writing a new regression test for a root-cause fix. P10 should be adopted first since it costs nothing beyond two extra tool calls per PR and directly protects the highest-risk merge class.
Рекомендуемый порядок: сначала P10, затем P11.

## Следующие эксперименты

- A single bounded, read-only premvp.command.production_observation.v1 run against PR#302's exact merged SHA (2999538c244896d78aad7fb2170affcce55924fc) can establish PROVEN_IN_RUNTIME deployment identity for the physical-event grouping fix, closing this cycle's largest Axis A NOT_PROVEN item.
  Границы: One observation run against the named SHA; read-only Git ancestry, HTTPS GET to the app build-identity surface, and PostgREST SELECT via the already-provisioned service-role key; no write, no producer trigger, no Ireland access.
  Что останется: reports/observation/<observation_id>.json (gitignored, non-secret checkpoint) and, on completion, a docs/ai-context/control-plane/EVIDENCE_LEDGER.md entry
  Считаем удачей: The observation reaches PRODUCER_PRODUCTION_EFFECT_PROVEN or at least DEPLOYMENT_IDENTITY_PROVEN for 2999538c244896d78aad7fb2170affcce55924fc.
  Останавливаемся, если: Stop and record WAIT_INFRASTRUCTURE_RECOVERY if the command's own database/PostgREST health check fails -- never force a synthetic result.
- A report-only (non-blocking) scan that flags any merged PR whose body claims 'Reviewer receipt: <reviewer_id>' but carries zero corresponding GitHub review or check run can be run once against this period's PR#300/#301 and the prior cycle's PR#285/#286 to establish a concrete pre-enforcement baseline before H6's blocking gate is built.
  Границы: One read-only pass over a fixed PR list using get_reviews/get_check_runs already proven safe by this Routine; no write action, no branch-protection change.
  Что останется: A findings note appended to this cycle or the next Governor input, listing exact PR numbers and the receipt-claim-vs-evidence mismatch
  Считаем удачей: The scan produces a concrete, reusable list of mismatched PRs that a future blocking gate (H6) can be validated against in report-only mode first.
  Останавливаемся, если: Stop if the scan cannot distinguish a genuine external reviewer artifact (a real GitHub review) from a self-attested claim using only API-visible fields.
- This cycle's own terminal persistence can again reach canonical origin/main with zero intermediate Founder action, using the same GitHub-MCP-backed path already proven for prior cycles' lineages.
  Границы: One canonical Evolution cycle document plus its rendered report, persisted via the registered branch/PR/merge lifecycle; no product code path touched.
  Что останется: docs/ai-context/control-plane/evolution/cycles/2026-09-11__evolution-canonical-cycle.json and its .report.md
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
- создано переиспользуемых артефактов: 5
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

Persist via the proven GitHub-MCP canonicalization path (zero Founder action). Then run E13 (bounded production observation of PR#302's SHA) as the highest-value next action, alongside the still-open E7 (2026-09-09, B7 SHA). Do not babysit the 30-member open-PR family beyond recording it for Routine B.
