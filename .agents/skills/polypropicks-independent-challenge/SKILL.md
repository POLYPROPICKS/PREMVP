---
name: polypropicks-independent-challenge
description: "Independently challenge the material premises behind a non-trivial or high-impact implementation, diagnosis, architecture, migration, production fix, control-plane change, expensive refactor, or technical decision before costly execution. Use when evidence is uncertain or contradictory, attempts have failed, scope is broad or irreversible, trust boundaries change, or materially different approaches exist. Do not use for trivial mechanical edits, formatting, typo fixes, routine regeneration, ordinary documentation, or already-proven narrow changes."
---

# PolyProPicks Independent Challenge

Challenge the mission without optimizing for agreement, then let execution continue with the
smallest evidence-backed approach. Do not turn this into a mandatory second review.
Invoke explicitly as `$polypropicks-independent-challenge` when requested.

## Run the challenge

1. Preserve the stated BUSINESS RESULT and HARD BOUNDARIES. Treat the proposed diagnosis,
   scope, and implementation as claims to test, not facts.
2. Verify material premises with the strongest authorized evidence available: current source
   and Git, canonical Control Plane, tests, execution receipts, runtime or database reads,
   Sentry, official documentation, or a bounded experiment. Prefer current `origin/main` and
   the recent execution frontier when branch state matters.
3. Attempt to falsify both the diagnosis and the proposed solution. Check for stale or
   contradictory premises, symptoms mistaken for causes, missing prerequisites, duplicated
   functionality, unnecessary infrastructure or scope, hidden trust-boundary changes, and a
   solution whose complexity exceeds the business problem.
4. Record the challenge under these exact headings:
   - `PROVEN_FACTS` — directly verified current evidence.
   - `SUPPORTED_INFERENCES` — conclusions supported by evidence but not directly proven.
   - `UNVERIFIED_ASSUMPTIONS` — material claims still lacking evidence.
   - `CONTRADICTIONS` — conflicts between sources, runtime, or premises.
   - `FIRST_PROVEN_PROBLEM` — the earliest verified defect or constraint.
   - `SMALLEST_DEFENSIBLE_APPROACH` — least scope that achieves the BUSINESS RESULT.
   - `MATERIAL_ALTERNATIVE` — a genuinely competitive bounded approach, or `NONE`.
   - `REGRESSION_AND_MAINTENANCE_RISK` — introduced behavior and ongoing cost.
5. Prefer the smallest defensible approach. Correct a materially inferior premise, but do not
   broaden scope for elegance or speculative redesign.

Do not trigger automatically for trivial mechanical edits, formatting, typo fixes,
already-proven narrow changes, ordinary documentation, or routine regeneration.

Use `PROVEN FACT`, `SUPPORTED INFERENCE`, and `UNVERIFIED ASSUMPTION` consistently when
discussing individual claims.

## Resolve uncertainty autonomously

Before escalating, attempt all applicable recoverable paths: repository inspection, canonical
state, tests, registered read-only commands, receipts, runtime reads, Sentry, official docs,
bounded experiments, an isolated worktree, and dependency/bootstrap recovery.

`INSUFFICIENT_EVIDENCE` is not automatically blocked and is not automatically a Founder stop.
Continue recoverable evidence work without a Founder intermediate action. Founder escalation
is allowed only for a genuinely non-recoverable product, authority, legal, live-money, secret,
or irreversible-risk decision. Dirty roots, missing dependencies, failed tests, Git lifecycle,
reviewer invocation, session length, and uncertain implementation details are recoverable.

## Emit exactly one verdict

- `PROCEED_AS_PROPOSED` — evidence supports the requested approach and no materially better
  bounded approach was found.
- `PROCEED_WITH_CORRECTION` — preserve the valid BUSINESS RESULT, but correct the diagnosis,
  scope, or implementation premise before execution.
- `INSUFFICIENT_EVIDENCE` — a critical premise is not established after applicable recovery;
  identify the next authorized evidence path and do not equate this verdict with `BLOCKED`.
- `GENUINE_DECISION_REQUIRED` — evidence cannot resolve a real product, authority, or risk
  choice. State the smallest exact decision needed.

End the challenge once material premises are sufficiently verified. After
`PROCEED_AS_PROPOSED` or `PROCEED_WITH_CORRECTION`, continue the authorized mission rather than
returning a plan. After `INSUFFICIENT_EVIDENCE`, continue the next recoverable evidence path.

## Preserve authority boundaries

This skill is workflow and reasoning guidance. It does not authorize database writes, deployment,
live-money actions, secrets access, or cross-repository work. Do not infer permissions or
capabilities from this skill, weaken `CAPABILITY_BY_DIRECT_ACTION_ONLY`, alter
risk-class reviewer requirements, or create an `INDEPENDENT_CHALLENGE` capability.
