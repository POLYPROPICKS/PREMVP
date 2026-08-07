# DAILY_EVOLUTION_REVIEW

**Prompt id:** `premvp.prompt.daily_evolution_review.v1`
**Stage:** Stage 1 — Daily Evolution Routine MVP
**Risk class:** `R0_READ_ONLY` (evidence gathering) — the review reads and judges; it never patches product code.
**Repository:** `POLYPROPICKS/PREMVP` only.

This prompt is the reviewer contract for one Daily Evolution Review covering 1–2 days of real
engineering work. It is self-contained on purpose: a cold session in any registered execution
environment must be able to run it from Git with no prior conversation.

---

## 1. What you produce

Exactly two artifacts:

1. An **EVOLUTION_CYCLE** JSON document valid against
   `docs/ai-context/control-plane/evolution/schemas/EVOLUTION_CYCLE.schema.json`.
2. A **Founder report** in plain Russian, rendered from that cycle by
   `premvp.command.evolution_evaluate.v1`. You do not hand-write the report — you write the
   cycle, the command renders and validates the report.

Both are persisted under `docs/ai-context/control-plane/evolution/cycles/`.

## 2. Inputs you may use

- accepted completion envelopes from the period;
- confirmed changes: merge SHAs, PR numbers, tracked repository paths;
- the Evolution input bundle under `input-bundles/` (operator actions, declared coverage,
  any measured metric values);
- canonical control-plane artifacts for context (`CURRENT_STATE.yaml`, `CAPABILITY_MATRIX.yaml`,
  `AGENT_REGISTRY.yaml`, `ROUTING_AND_PIPELINES.yaml`).

You may not use chat memory, a summary of a previous session, or an executor's self-description
as evidence for anything material.

## 3. Axis A — launch, revenue, settlement, reconciled PnL

Axis A is the highest business priority. Answer, in plain language:

- what moved the project toward launch, revenue or PnL;
- what next verified production fact became possible;
- what blocker was removed or introduced;
- what remains NOT PROVEN;
- whether runtime or business evidence exists at all.

Verdict: `ADVANCED`, `NO_MEASURABLE_CHANGE`, `STALLED`, `REGRESSED`, `NOT_ENOUGH_EVIDENCE`.

**Reconciled PnL is never inferred.** You may claim it only with fills, fees and settlement
evidence, all three, each with an evidence reference. A claim without them is rejected by the
validator as `UNSUPPORTED_PNL_CLAIM` — it is not quietly downgraded.

`ADVANCED` requires `runtime_or_business_evidence_exists: true`. Work that merely landed in Git
without any runtime or business evidence is not, by itself, an advance.

## 4. Axis B — Manifest 2 capability

Axis B asks whether the period created or strengthened a **reusable** capability across:
Mission Contracts, verification/evidence, mission registry, declarative environments,
permission and tool policy, reusable functions/scripts/validators, portability across CloudCode
and Codex, recovery/checkpoints, automation economics, controlled improvement.

Verdict: `CAPABILITY_ADDED`, `CAPABILITY_STRENGTHENED`, `PRACTICED_NOT_YET_PROVEN`,
`NO_MEASURABLE_CHANGE`, `REGRESSED`.

**A capability is not proven because an LLM described it.** It must persist as a reusable
artifact at a tracked repository path AND have evidence of use or validation. Description
without a persisted artifact is at most `PRACTICED_NOT_YET_PROVEN`.

## 5. Axis separation

Axis A and Axis B are decided independently from evidence. Never:

- average them;
- let a strong Axis B rescue a weak Axis A;
- derive one verdict from the other;
- let a supporting metric set, raise or lower either verdict.

Supporting metrics are diagnostic only. **Founder/operator action count is not the main KPI** —
fewer manual messages during a period where Axis A did not advance is not success.

## 6. Supporting metrics

Report, where evidence exists: `time_to_verified_result`, `first_pass_pass_rate`,
`rework_count`, `cost_per_verified_result`, `reviewer_rejection_count`,
`runtime_evidence_count`, `reusable_artifacts_created`, `cloudcode_actions`, `codex_actions`,
`architect_corrections`, `intermediate_actions_per_mission`, `actions_per_verified_result`.

Anything not measured is the literal string `UNKNOWN` or `NOT_AVAILABLE`. Never estimate cost,
tokens or time.

## 7. Operator actions

One Founder message manually submitted to CloudCode or Codex equals one execution operator
action, typed `START`, `FOLLOW_UP`, `CORRECTION`, `RETRY`, `HANDOFF` or `APPROVAL`.

Architect corrections are recorded separately as `ARCHITECT_CORRECTION` and never join the
execution total. Executor-internal commands, tests, reviewers and automated routine steps are
not counted at all.

Run `premvp.command.evolution_collect.v1` on the input bundle — it deduplicates by `action_id`,
aggregates by type and surface, and resolves capture coverage to `COMPLETE`, `PARTIAL` or
`UNKNOWN`. Do not hand-count.

## 8. Automation hypotheses

Produce 5–8 hypotheses **when the evidence supports them**. Never invent one to reach five. If
fewer are supported, set `insufficient_supported_hypotheses: true` with an explicit reason.

Each hypothesis states, simply: the observed problem; why it matters; the Axis A effect; the
Axis B effect; the proposed automation; the persistent artifact that remains in Git; expected
value; implementation and verification cost where knowable; risk; success metric;
rollback/stop condition; timing.

Classification: `NOW`, `PRODUCT_FIRST`, `SYSTEM_LATER`, `REJECT`. `NOW` is a proposal for the
next architect step — it never authorizes execution inside this review.

## 9. Founder learning

Produce **exactly two** practices. For each: what skill is practiced; why it matters now; how it
applies to this project right now; what reusable Git artifact remains afterwards. Then compare
the two and recommend an order.

Produce **2–3** bounded experiments. Each must create or validate a persistent reusable artifact
and declare an observable promotion condition and an observable stop condition.

## 10. Founder report style

Rendered automatically, but you supply the substance. Keep it plain Russian, short paragraphs
and bullets, unavoidable technical terms explained in place, no schema dumps, no false
certainty, mobile-readable. Detailed machine evidence stays in the cycle JSON.

Required headings, in order:

```
# Daily Evolution Review
## Главный итог
## Ось A — запуск, выручка и PnL
## Ось B — Manifest 2
## Что доказано
## Что блокирует следующий шаг
## Варианты автоматизации
## Две практики Founder
## Следующие эксперименты
## Поддерживающие метрики
## Roadmap
## Что произойдёт дальше
```

## 11. Hard boundaries

This review never:

- changes `roadmap_phase`, `current_value_step`, C1/C2 meaning, PnL gates or live-money authority;
- accepts its own cycle (`accepted` is always `false`);
- accepts a `CURRENT_STATE.yaml` delta;
- touches product runtime, the database, deployment or Ireland;
- reads or prints secrets;
- invents roadmap stages beyond Stage 1, Stage 2 and Vision.

## 12. How to run it

```
npm run control-plane:evolution:collect -- --input docs/ai-context/control-plane/evolution/input-bundles/<bundle>.json --out <collection>.json
npm run control-plane:evolution:evaluate -- --cycle <cycle>.json --write
```

`--write` persists the cycle and its report under `cycles/`. Without `--write`, nothing is
written and the command is a pure validation pass.
