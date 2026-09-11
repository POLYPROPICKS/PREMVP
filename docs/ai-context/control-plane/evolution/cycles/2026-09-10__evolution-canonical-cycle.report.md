# Daily Evolution Review

Период: 2026-09-10T00:00:00Z — 2026-09-11T00:00:00Z.

## Главный итог

По бизнесу (запуск, выручка, PnL): недостаточно доказательств.
По системе (переиспользуемые возможности): появилась новая переиспользуемая возможность.

Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.

## Ось A — запуск, выручка и PnL

Что сдвинулось:
- PR#291 then PR#292 shipped a read-only exact-anchor evidence packet (nightFunnelAudit.ts) isolating one natural anchor's Reservation/Queue/downstream lineage by exact plan_run_id, rejecting foreign-anchor rows; PR#292 fixed eligibility to the anchor's exact scheduled instant instead of calendar-date, closing the last named path to a wrong current cohort.
- PR#290 added a --target-only mode to the PREMVP release pipeline (sha256-pinned single-migration apply, dry-run-gated to exactly-one-pending==target, fail-closed on legacy-push fallback/--include-all/authority mismatch) and restamped the wallet migration above the live ledger head; AGENT_REGISTRY.yaml was updated the same PR to describe the new mode.
- PR#289 canonicalized the 2026-09-10 Automation Roadmap Governor result (EVIDENCE_INSUFFICIENT) via the registered evolution_canonicalize.v1 terminal-persistence lifecycle with zero intermediate Founder action and no lingering draft PR: the PR was opened and merged inside one minute (created 02:06:12Z, merged 02:07:33Z).

Какой следующий проверяемый факт в проде стал возможен: A bounded read-only run of audit-night-funnel.ts against a real past anchor, exercising the PR#292 instant-based resolver outside its own tests -- not yet observed. E7 (production_observation.v1 against the B7 SHA) also remains unexecuted two cycles running..

Снятые блокеры:
- PR#292 removed the one remaining proven path to a wrong CURRENT cohort in the exact-anchor evidence packet: a same-day later natural anchor could previously be treated as already due by calendar-date match; it is now gated on its exact scheduled instant.

Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.

## Ось B — Manifest 2

Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.

Что появилось или окрепло:
- A read-only exact-anchor evidence packet isolates one anchor's Reservation/Queue/downstream lineage by exact plan_run_id and scheduled instant, rejecting foreign rows into an explicit count, with UNKNOWN/ABSENT semantics for non-exhaustive evidence. (остаётся в репозитории: lib/executor/nightFunnelAudit.ts)
- The release pipeline gained a --target-only mode: sha256-pinned single-migration apply, dry-run-gated, fail-closed on legacy db-push/--include-all/authority mismatch. AGENT_REGISTRY.yaml stayed in sync this PR, unlike CURRENT_STATE. (остаётся в репозитории: scripts/control-plane/lib/premvp-target-only-migration.mjs)
- evolution_canonicalize.v1 completed a full validate-PR-merge cycle for a Governor result with zero Founder action, no draft-PR accumulation, under two minutes -- evidence against the recurring draft-accumulation concern, though one clean run is not proof it's closed. (остаётся в репозитории: scripts/control-plane/evolution-canonicalize.mjs)

Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.

## Что доказано

- A read-only exact-anchor evidence packet isolates one anchor's Reservation/Queue/downstream lineage by exact plan_run_id and scheduled instant, rejecting foreign rows into an explicit count, with UNKNOWN/ABSENT semantics for non-exhaustive evidence. — 44/44 tests pass (35 from PR#291 + 9 new from PR#292); independently re-run at evidence_cutoff, confirmed 44/44.
- The release pipeline gained a --target-only mode: sha256-pinned single-migration apply, dry-run-gated, fail-closed on legacy db-push/--include-all/authority mismatch. AGENT_REGISTRY.yaml stayed in sync this PR, unlike CURRENT_STATE. — 13/13 tests pass; independently re-run at evidence_cutoff, confirmed 13/13. No live migration applied via this mode yet.
- evolution_canonicalize.v1 completed a full validate-PR-merge cycle for a Governor result with zero Founder action, no draft-PR accumulation, under two minutes -- evidence against the recurring draft-accumulation concern, though one clean run is not proof it's closed. — PR#289 timestamps (created 02:06:12Z, merged 02:07:33Z) read from the GitHub API.

## Что блокирует следующий шаг

- No production deployment check and no runtime observation was performed this period for PR#289-#292: every claim above is SOURCE_LEVEL (build, typecheck, and this Routine's own independent re-run of the focused test files), never PROVEN_IN_RUNTIME. runtime_or_business_evidence_exists is false for this period.
- The wallet-observation migration (20260910120000_executor_wallet_observation_columns.sql) is explicitly NOT applied by PR#290 -- its own body states this. The target-only apply mode that would apply it has never been exercised for real, on any executor.
- The exact-anchor evidence packet (PR#291/#292) has never been invoked against a real natural anchor outside its own unit-test fixtures; audit-night-funnel.ts has not produced one real packet this period.
- CURRENT_STATE.yaml (state_version 22, updated_at 2026-09-08T11:07:12Z) is now three days stale and describes zero of the 13 merges landed since (9 from 2026-09-09 plus #289-#292 this period) -- still frames the roadmap step as BOUNDED_PRE_HOOK_SEED with no reference to the newer work.
- PR#290 self-declares risk class R4_CONTUR_PRODUCTION_BOUNDARY and states 'Contur gate reviewer receipt required before merge' -- but get_reviews and get_check_runs on PR#290 both returned zero entries. The claimed gate requirement has no verifiable receipt attached, a third instance of this exact pattern after PR#285 and PR#286 in the prior cycle.
- CURRENT_STATE.yaml's four open blockers (BLK-001 natural night-reservations run, BLK-002 no deterministic reviewer/CI gate, BLK-003 Supabase write access from claude_code_cloud, BLK-004 Ireland runtime access) remain unresolved and unchanged this period.
- The tracked open (unmerged) PR pile stands at 30 at this cutoff (list_pull_requests, state=open), essentially unchanged from 31 at the prior cutoff; one new PR (#293, an offline-modeling operator) was opened this period and remains open/unmerged, so it is not counted as confirmed evidence here.
- Reconciled PnL is not claimed and cannot be: no fills, fees or settlement evidence exists for this period.
- None of these three capabilities has been exercised against real production data this period: the exact-anchor packet has no real invocation, the target-only migration mode has applied nothing live, and one clean fast canonicalization is a sample of one, not a proven pattern across accumulation-prone conditions (e.g. a failing admission requiring rework).
- premvp.ci_gate.reviewer_receipt_enforcement (AGENT_REGISTRY.yaml) remains PLANNED/NOT_PROVEN: PR#290's self-declared R4_CONTUR_PRODUCTION_BOUNDARY / Contur-gate-required claim again has no corroborating GitHub review or check run (BLK-002 unchanged).

## Варианты автоматизации

- A post-merge step (reusing the existing PROVEN_IN_RUNTIME premvp.command.control_plane_reconcile.v1) appending a factual accepted_completions entry after any merge touching lib/executor/**, lib/feed/**, app/api/executor/**, or supabase/migrations/** -- no roadmap/capability-verdict change, which stays Founder-authorized. — делать сейчас.
  Проблема: CURRENT_STATE.yaml is now three days stale (updated_at 2026-09-08T11:07:12Z) and describes zero of the 13 merges landed since -- the 09-09 GSP-independence/wallet-state chain plus this period's target-only migration mode and exact-anchor evidence packet. The gap is now wider than when this hypothesis was first raised.
  Что останется в репозитории: scripts/control-plane/reconcile-control-plane.mjs (existing) plus a new invocation trigger, if adopted
  Когда остановиться: Stop and revert to manual reconciliation if the automation ever writes a roadmap_phase, current_value_step, capability verdict, or PnL-gate change without separate Founder authorization.
- Wire at least one real OPERATOR_ACTION_EVENT source (e.g. a lightweight capture at the point a Founder message starts a CloudCode/Codex session) so the next Evolution input bundle can carry real events instead of an empty array. — делать сейчас.
  Проблема: This period again established only a lower bound of zero operator-action events across four real merges: no OPERATOR_ACTION_EVENT record has ever existed in this repository, so founder_actions_proven stays 0 by construction for at least the sixth consecutive cycle.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/schemas/OPERATOR_ACTION_EVENT.schema.json (exists); a new capture point would be the missing artifact
  Когда остановиться: Stop if the only available capture point requires a new mandatory manual step from the Founder.
- A required GitHub status check that fails a PR labeled/detected as R4_CONTUR_PRODUCTION_BOUNDARY unless a machine-readable reviewer receipt is attached, reusing premvp.reviewer.contur_gate.v1's already-specified output_contract. — делать сейчас.
  Проблема: PR#290 self-declares risk class R4_CONTUR_PRODUCTION_BOUNDARY and states 'Contur gate reviewer receipt required before merge' -- a third instance of this exact pattern after PR#285 and PR#286 in the prior cycle. get_reviews and get_check_runs on PR#290 both returned zero entries.
  Что останется в репозитории: premvp.ci_gate.reviewer_receipt_enforcement (AGENT_REGISTRY.yaml; PLANNED, implementation_path null)
  Когда остановиться: Stop and fall back to advisory (non-blocking) mode if the gate produces a false block on a legitimately reviewed PR.
- A periodic (not this Routine's) audit that classifies each open PR as SUPERSEDED / STILL_ACTIVE / ABANDONED against current origin/main and proposes closure only for provably superseded entries -- never an automatic close. — сначала продукт.
  Проблема: The tracked open-PR count stands at 30 at this cutoff, essentially unchanged from 31 at the prior cutoff; one new PR (#293, an offline-modeling operator) was opened this period and remains open. None of this period's 4 real merges came from that open pile.
  Что останется в репозитории: No artifact proposed yet -- remains PRODUCT_FIRST until a Founder decision on disposition criteria exists.
  Когда остановиться: Stop if any classification would require inferring Founder intent rather than reading provable Git supersession.
- No action proposed this period; carry the chain forward dormant. — система позже.
  Проблема: No new instance this period -- the D-1 research-corpus reader defect chain (CHAIN-D1-RESEARCH-CORPUS-READER-20260904) had no new confirmed recurrence; none of this period's four merges touch that reader.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-04__evolution-canonical-cycle.json (original record)
  Когда остановиться: N/A
- After any merge touching lib/executor/**, lib/feed/**, or app/api/executor/**, automatically queue one bounded premvp.command.production_observation.v1 run against that merge's SHA and record its outcome in EVIDENCE_LEDGER.md regardless of result. — делать сейчас.
  Проблема: For at least a sixth consecutive cycle, real engineering merges land with only SOURCE_LEVEL evidence, and no runtime/production observation step closes the loop into PROVEN_IN_RUNTIME -- this period's PR#289-#292 included.
  Что останется в репозитории: scripts/control-plane/production-observation.mjs (existing, PROVEN_IN_RUNTIME) plus a new invocation trigger, if adopted
  Когда остановиться: Stop and revert to manual triggering if automatic queuing produces false PROMPT_GATE_BLOCKED escalations rather than clean WAIT_INFRASTRUCTURE_RECOVERY classifications.
- A short pre-merge checklist/test-template specific to any new 'latest/current as-of-instant' resolver: require an explicit exact-instant boundary test (at, just-before, just-after the cutoff) in the first PR, not only after a same-day correction. — система позже.
  Проблема: PR#291 shipped anchor resolution using calendar-date matching -- a wrong eligibility rule for a 'current as of instant X' resolver. Caught same-day, corrected in PR#292 to the exact scheduled instant, with 9 new boundary-condition tests.
  Что останется в репозитории: tests/contur3/nightFunnelAudit.test.ts (existing exemplar of the boundary tests that should be required up front)
  Когда остановиться: Stop if applying the checklist to unrelated resolver types produces false-positive review friction.

## Две практики Founder

- Before merging any PR that self-declares a production-boundary risk class (e.g. R4_CONTUR_PRODUCTION_BOUNDARY) and claims a reviewer-gate pass or requirement, check get_reviews/get_check_runs for a real receipt first -- not after the fact in the next Evolution review.
  Зачем сейчас: PR#290 is the third instance (after PR#285 and PR#286 in the prior cycle) of this exact self-attested-but-unverifiable pattern; the check itself takes one tool call and would catch the gap before merge instead of after.
  Как ложится на проект: Before merging any future PR naming R4_CONTUR_PRODUCTION_BOUNDARY, run get_reviews and get_check_runs first; if both are empty, either block the merge or correct the PR's own risk-class self-declaration.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-10__evolution-canonical-cycle.json (this cycle's H6/P9 record)
- Ship the exact boundary-instant test cases (at, just-before, just-after cutoff) in the same PR that introduces a new 'current/latest as of instant X' resolver, rather than only after a same-day correction surfaces the gap.
  Зачем сейчас: PR#291's calendar-date resolver needed a same-day PR#292 correction with 9 new boundary tests; those exact tests could have shipped with PR#291 if the boundary case had been enumerated up front.
  Как ложится на проект: Any future 'as-of-instant' resolver in this codebase (e.g. eligibility windows for CURRENT_OPERATIONAL_COVERAGE_PROOF) should enumerate at/just-before/just-after boundary tests before its first merge.
  Что останется в репозитории: docs/ai-context/control-plane/evolution/cycles/2026-09-10__evolution-canonical-cycle.json (this cycle's H14/P8 record)

Сравнение: P9 is the higher-priority pre-merge gate: it protects exactly the production-boundary risk class the control plane already flags as requiring the highest-reasoning reviewer, and closing it would make H6/BLK-002 evidence-based rather than repeatedly rediscovered. P8 is a narrower resolver-design habit whose cost was already paid (same-day, no production exposure) this period.
Рекомендуемый порядок: сначала P9, затем P8.

## Следующие эксперименты

- One bounded, read-only invocation of scripts/contur3/audit-night-funnel.ts against a real past natural anchor, using the corrected PR#292 instant-based resolver, can produce the first exact-anchor evidence packet exercised outside its own unit-test fixtures.
  Границы: One read-only script invocation against one already-past natural anchor; no DB writes, no producer trigger, no Ireland access.
  Что останется: A captured packet output plus a docs/ai-context/control-plane/EVIDENCE_LEDGER.md entry on completion
  Считаем удачей: The packet resolves a real plan_run_id with a resolved (non-UNKNOWN) status for at least one downstream stage.
  Останавливаемся, если: Stop and record WAIT_INFRASTRUCTURE_RECOVERY if the script's own database reachability check fails -- never force a synthetic result.
- Carried forward from the 2026-09-09 cycle, still unexecuted: a single bounded, read-only premvp.command.production_observation.v1 run against B7's exact reviewed result (05c9aad6bb621dfebd1f2d03f49be91c9a5b1400) can establish PROVEN_IN_RUNTIME deployment identity for the GSP-independence migration, the largest standing Axis A NOT_PROVEN item across two consecutive cycles now.
  Границы: One observation run against the named SHA; read-only Git ancestry, HTTPS GET to the app build-identity surface, and PostgREST SELECT via the already-provisioned service-role key; no write, no producer trigger, no Ireland access.
  Что останется: reports/observation/<observation_id>.json (gitignored, non-secret checkpoint) and, on completion, a docs/ai-context/control-plane/EVIDENCE_LEDGER.md entry
  Считаем удачей: The observation reaches PRODUCER_PRODUCTION_EFFECT_PROVEN or at least DEPLOYMENT_IDENTITY_PROVEN for 05c9aad6bb621dfebd1f2d03f49be91c9a5b1400.
  Останавливаемся, если: Stop and record WAIT_INFRASTRUCTURE_RECOVERY if the command's own database/PostgREST health check fails -- never force a synthetic result.
- The PR#290 --target-only migration mode can complete one real, Founder-authorized apply of the one pinned pending wallet migration, converting the wallet-state capability's SOURCE_LEVEL evidence into a first PROVEN_IN_RUNTIME migration application.
  Границы: One --target-only dry-run followed by one apply of exactly the pinned migration (20260910120000_executor_wallet_observation_columns.sql); fails closed on any ledger mismatch or more than one pending migration.
  Что останется: supabase/migrations/20260910120000_executor_wallet_observation_columns.sql (already committed) plus a docs/ai-context/control-plane/EVIDENCE_LEDGER.md entry on apply
  Считаем удачей: The dry-run confirms exactly-one-pending==target, then the apply completes with the pipeline's own PASS verdict.
  Останавливаемся, если: Stop and record BLOCKED if the dry-run finds more than one pending migration or any ledger/authority mismatch -- never force --include-all.

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

Persist via the proven GitHub-MCP canonicalization path (zero Founder action). Then run E10 (bounded read-only audit-night-funnel invocation against a real anchor) as the highest-value next action, alongside E7 (still open from 2026-09-09) against the B7 SHA. Do not babysit the 30-member open-PR family beyond recording it for Routine B.
