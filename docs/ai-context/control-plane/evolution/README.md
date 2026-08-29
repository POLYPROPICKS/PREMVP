# Evolution Control Plane — Stage 1 + Stage 2

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
| `SCHEDULE_MANIFEST.yaml` | The two intended routines, their cadence, and the terminal persistence stage each one ends with. The schedule is only a trigger — see *Boundaries*. |
| `schemas/` | Focused JSON Schemas for cycles, hypotheses, corrections, operator actions, Governor results and roadmap deltas. |
| `prompts/DAILY_EVOLUTION_REVIEW.md` | The self-contained Stage 1 reviewer contract. |
| `prompts/AUTOMATION_ROADMAP_GOVERNOR.md` | The self-contained Stage 2 reviewer contract. |
| `cycles/` | Persisted cycles and their rendered Founder reports. |
| `corrections/` | Persisted Founder and Architect corrections. |
| `input-bundles/` | Raw per-period inputs the collector reads. |
| `diagrams/` | Optional diagrams referenced by a cycle. |
| `roadmap-proposals/` | Persisted Automation Roadmap Governor results and their rendered Founder reports. |

`cycles/`, `corrections/`, `input-bundles/` and `roadmap-proposals/` ship empty on purpose —
see *Boundaries*.

## Commands

```
npm run control-plane:evolution:collect -- --input <bundle.json> --out <collection.json>
npm run control-plane:evolution:evaluate -- --cycle <cycle.json> --write
npm run control-plane:evolution:govern -- --result <result.json> --write
npm run control-plane:evolution:canonicalize -- --canonicalize --branch <lineage-branch>
npm run control-plane:evolution:test
npm run control-plane:evolution:govern:test
npm run control-plane:evolution:canonicalize:test
```

`control-plane:evolution:canonicalize` is the **terminal persistence stage** for both routines
(`SCHEDULE_MANIFEST.yaml`). It admits an already validated, evidence-only Cycle or Governor
lineage — hard-allowlisted to `cycles/`, `roadmap-proposals/`, `input-bundles/` and
`diagrams/` evidence files — re-runs the Stage 1 / Stage 2 validators, preserves `accepted:false`
and one-period/one-lineage + Governor-result uniqueness, and then canonicalizes it to
`origin/main` through the shared GitHub PR create/merge commands with **zero intermediate
Founder actions**. It is not a second state or evidence authority, and it never lets a pending
branch or draft PR become evidence authority — the Governor still reads only canonical
`origin/main` history.

All commands are dependency-free Node ESM, offline, and read no clock — the same input
produces the same output on Claude Code Cloud and on the local Windows Codex host.

## Boundaries

**Stage 1** builds the daily-review capability: collection, cycle contracts, the reviewer
prompt, Git-persisted storage. It deliberately does not run a real historical Daily Evolution
cycle — `cycles/` ships empty.

**Stage 2** adds the Automation Roadmap Governor: comparison of multiple persisted cycles,
evidence-driven eligibility (three new validated cycles, or the configured weekly boundary),
and an optional Roadmap Delta Proposal. It deliberately does not run a real historical
Governor pass — `roadmap-proposals/` ships empty — and it deliberately does not add scheduling
transport of its own; see `SCHEDULE_MANIFEST.yaml` for the two routine definitions and their
cadence.

A Governor result can propose a roadmap delta but can never accept it, promote a Founder
capability ladder level, or mutate PnL priority, product-roadmap phase, live-money gates, risk
authority, strategic stage order or promotion rules — those stay Architect-owned behind a
separate Promotion Gate.

Nothing here can change the product phase, C1/C2 meaning, PnL gates or live-money authority. An
Evolution cycle and a Governor result are always `accepted: false` — evidence and proposal,
never a decision.

## Resuming from a cold session

For a Daily Evolution Review: read `EVOLUTION_POLICY.yaml`, then
`prompts/DAILY_EVOLUTION_REVIEW.md`, then the schemas. For an Automation Roadmap Governor run:
read `AUTOMATION_ROADMAP.yaml` and `FOUNDER_CAPABILITY_LADDER.yaml`, then
`prompts/AUTOMATION_ROADMAP_GOVERNOR.md`, then the persisted cycles under `cycles/`. With the
npm commands above, a session with no prior context can produce and validate either artifact.
