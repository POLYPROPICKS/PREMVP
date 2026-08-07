# Evolution Control Plane — Stage 1

This directory is the durable memory of how PolyProPicks learns from its own engineering work.

Every 1–2 days of real work can be turned into one **Evolution cycle**: a machine-readable
judgement plus a plain-Russian Founder report. Both live in Git, so the capability survives a
new chat, a new session, a new machine and a new executor.

## The two axes, and why they never merge

**Axis A — launch, revenue, settlement, reconciled PnL.** The highest business priority. Did
this period bring production launch and real money closer?

**Axis B — Manifest 2 capability.** Did this period create or strengthen a reusable capability
of the system itself?

They are decided independently and reported as two separate verdicts. A strong Axis B never
rescues a weak Axis A, and no supporting metric can move either one. Operator action count is a
diagnostic, not the KPI — cutting manual messages during a period that did not advance the
business is not success.

## Two rules that do the most work

- **Reconciled PnL is never inferred.** Fills, fees and settlement evidence, or the claim is
  rejected outright.
- **A capability is not proven because an LLM described it.** It needs a persisted artifact at a
  tracked path plus evidence of use or validation.

## Layout

| Path | What it holds |
| --- | --- |
| `EVOLUTION_POLICY.yaml` | The governing contract: axes, verdicts, evidence rules, report contract. |
| `AUTOMATION_ROADMAP.yaml` | The three approved Evolution levels — Stage 1, Stage 2, Vision. No others. |
| `FOUNDER_CAPABILITY_LADDER.yaml` | The seven-level Founder progression and its promotion rule. |
| `OPERATOR_ACTION_POLICY.yaml` | What counts as one operator action, and what deliberately does not. |
| `TOOL_AND_ENVIRONMENT_PORTABILITY.yaml` | What must stay true for another environment to resume this work. |
| `schemas/` | Focused JSON Schemas for cycles, hypotheses, corrections and operator actions. |
| `prompts/DAILY_EVOLUTION_REVIEW.md` | The self-contained reviewer contract. |
| `cycles/` | Persisted cycles and their rendered Founder reports. |
| `corrections/` | Persisted Founder and Architect corrections. |
| `input-bundles/` | Raw per-period inputs the collector reads. |
| `diagrams/` | Optional diagrams referenced by a cycle. |

`cycles/`, `corrections/` and `input-bundles/` ship empty on purpose — see *Boundaries*.

## Commands

```
npm run control-plane:evolution:collect -- --input <bundle.json> --out <collection.json>
npm run control-plane:evolution:evaluate -- --cycle <cycle.json> --write
npm run control-plane:evolution:test
```

Both commands are dependency-free Node ESM, offline, and read no clock — the same bundle
produces the same collection and the same report on Claude Code Cloud and on the local Windows
Codex host.

## Boundaries

Stage 1 builds the capability. It deliberately does **not**:

- implement the executable Automation Roadmap Governor (Stage 2);
- add scheduling (Stage 2);
- compare multiple cycles or emit a Roadmap Delta Proposal (Stage 2);
- run a real historical Daily Evolution cycle.

Nothing here can change the product phase, C1/C2 meaning, PnL gates or live-money authority. An
Evolution cycle is always `accepted: false` — it is evidence and proposal, never a decision.

## Resuming from a cold session

Read `EVOLUTION_POLICY.yaml`, then `prompts/DAILY_EVOLUTION_REVIEW.md`, then the schemas. With
an input bundle and the two npm commands above, a session with no prior context can produce and
validate a cycle.
