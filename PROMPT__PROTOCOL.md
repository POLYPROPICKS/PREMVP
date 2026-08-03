# PROMPT__PROTOCOL

Status: MANDATORY — Tier 0
Canonical owner: prompt authoring, routing, completion, roadmap/value handoff and continuation
Exact filename: `PROMPT__PROTOCOL.md`

This file is the single Tier 0 owner of how prompts are built, routed, and closed for PolyProPicks / PREMVP. `AGENTS.md` and `docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md` point here. Subordinate execution/value documents (e.g. `SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL.md §21–22`) may add narrower rules but cannot replace it, and their stronger existing rules stand unless this file is explicitly patched to supersede them.

## 1. Purpose and canonical identity

Reduce token waste, prevent repeated context loading, and let executor work continue from verified checkpoints instead of restarting phases after every STOP. One name, one location: `PROMPT__PROTOCOL.md` at repo root. No `PROMPT_PROTOCOL.md`, `PROMPT-PROTOCOL.md`, or other variant may exist alongside it.

## 2. Main project goal

Build a repeatable evidence-first production system:

Provider / Dataset → canonical observations → Contract A decisions → Reservation → immutable Queue → Ireland / CLOB → callback → terminal lifecycle → settlement → reconciled net PnL → controlled improvement.

Primary acceptance is real business value and reconciled PnL while reducing active Founder time. Never autonomously increase live risk.

## 3. Global roadmap invariant

1. **Data foundation** — provider inventory becomes canonical observations, snapshots, immutable source lineage.
2. **One model authority** — Contract A alone owns sport/market policy, score, rank, approval/rejection evidence. *(build-proven, closed)*
3. **Approved event → Reservation directly** — a Contract A approved physical event creates a Reservation; the legacy pre-Reservation model/filter/ranking path is removed from that decision.
4. **Exact identity for reserved events** — only already-reserved events receive exact condition_id/token_id/side/event_start_iso; no fuzzy rediscovery or sibling substitution.
5. **Mechanical execution preparation** — refresh price/liquidity, apply time/stake/exposure/expiry guards, emit one immutable Queue instruction; no model reranking.
6. **Ireland execution** — executes the exact Queue instruction, returns `clob_order_id` and a correlated callback; Ireland does not select events or markets.
7. **Terminal lifecycle and settlement** — fill, fees, slippage, outcome, balance reconcile back to the original decision and Queue instruction.
8. **Production vertical proof** — full-source replay → shadow WOULD_SUBMIT → bounded canonical live order → callback → terminal Queue state → reconciled net PnL. Until complete: `FULL_LIVE_READY = NO`.
9. **Control and automation** — only after vertical proof: stage trace, Visual Control, Control Plane Lite, monitoring, bounded agents, additional models/datasets/domains.

Invariant: vertical proof first, automation second.

## 4. Source-of-truth priority

1. Repo source files + git output (beats everything)
2. `/docs/ai-context/` files (beats memory/summary)
3. Current user/Founder message
4. Old chat history (lowest priority)

Consistent with `CLAUDE.md §2` and `AGENTS.md §1`.

## 5. Architect/operator preface

Every executor prompt must be preceded by an architect/operator preface stating: PRECHECK OF HANDOFF; MAIN PROJECT GOAL; GLOBAL ROADMAP; CURRENT ROADMAP PHASE; CURRENT SUB-ROADMAP STEP (plain language); CURRENT PRODUCTION VERDICT; NEXT STEP; NEXT STEP VALUE; WHY NOW; EXACT OWNER; EXACT EXECUTION ENVIRONMENT; MODEL; MODEL LEVEL; MODEL WHY; SESSION MODE; SESSION REASON; TOKEN/CONTEXT OPTIMIZATION; DEV RULE 2 / TEST RULE 3 / DEV RULE 3 applicability; NEXT TWO VALUE STEPS; DISTANCE TO LIVE CONTOUR; OPERATOR ACTION NOW; STOP / SUCCESS TRANSITION. Detailed field table: `SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL.md §21`.

## 6. Executor prompt minimum

Every executor prompt must carry: task classification; execution mode; commit/push/deploy/PR modes; allowed and forbidden files; stop conditions; evidence required; main project goal; global roadmap; roadmap position; simple-language current step; current production verdict; this-step value; success transition; next two value steps; distance to live; owner/environment; model and model level; session mode/reason; token/read budget; Markdown reading strategy; evidence reuse; DEV RULE 2; TEST RULE 3; DEV RULE 3; one exact operator handoff requirement. Reusable template: `docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md §4`. A prompt missing any field is incomplete and must not be executed.

## 7. Model and model-level routing

- **low** — single-fact or very small command verification
- **medium** — bounded docs/Git/inspect-only work
- **high** — source review, bounded implementation, or release gate
- **max** — production-critical backend/model/TDD boundary work
- **ultra** — highest-risk multi-boundary work: security, schema, auth, payment, or end-to-end live-risk

Do not select a level by habit — every prompt states why that level, not another.

## 8. Session and execution-environment routing

Every prompt names the exact environment (PREMVP Claude Code Cloud default: `PolyProPicks PREMVP executor`; Codex prompts name the exact Windows repo/worktree or exact Cloud environment). A prompt without a named environment is incomplete.

Every prompt states `NEW SESSION` or `CONTINUE EXISTING SESSION` and why. Use NEW SESSION when environment/secrets/model isolation is required. Continue only when the existing session retains relevant verified state and there is no stale-context risk.

## 9. Token/context optimization

Every prompt states: total read budget; per-file budget; headings-first Markdown reading; exact evidence-reuse list; explicit forbidden rereads. Do not reload full historical context when a verified checkpoint exists.

## 10. Markdown headings-first reading

1. Verify Git branch and SHAs first.
2. Confirm exact file presence/absence via `git ls-files` / `git log`.
3. Read headings (`grep -n '^#'`) before body text.
4. Read only the line ranges needed to avoid contradiction.
5. Reuse prior direct-source discovery instead of repeating it.
6. Never bulk-cat long Markdown files.
7. Record the exact line ranges read in the completion report.

## 11. Evidence reuse

Accept a prior accepted SHA, gate verdict, or test result unless current Git state contradicts it. Do not rerun tests, TypeScript, build, or architecture review that a prior accepted run already proved for unchanged files. State exactly what is being reused and why it still applies.

## 12. Plain-language roadmap naming

Never identify a step only as "Commit A/B/C", "Phase X", or "Gate Y". Always add one sentence stating: what system behavior changes; what legacy authority/path is removed; what measurable production transition becomes possible.

## 13. DEV RULE 2 — correct source boundary

For production fixes/readiness: map the real source-to-business-result path; build a failure tree with 3–5 competing causes; start tests before the suspected producer; use production-shaped fixtures and fixed time; traverse the actual loader → normalization → filters/model → producer → Reservation → Queue → serializer → consumer path; emit a structured stage trace; never certify a vertical contour from a downstream component test alone.

## 14. TEST RULE 3 — TDD at the correct entry

RED through the real producer/entry → minimal isolated implementation → GREEN → targeted regression → TypeScript → build. A manually constructed finished object cannot be the only proof. A component PASS is not a vertical PASS.

## 15. DEV RULE 3 — live value first

Every task must: remove the first proven broken edge; shorten distance to the production business outcome; avoid docs/taxonomy/platform work unless prerequisite; avoid parallel implementation; return the measurable next transition.

## 16. Prompt Completion Protocol

The executor continues automatically through bounded precheck → inspection → implementation/verification → commit/push → report, and stops only on an exact named STOP condition. Git/source resolves questions before asking the Founder. An expected TDD RED is not a STOP. After one failed attempt, no broad retry — use a direct-source option check and the smallest correction. After proof, no repeated acceptance loop without a newly identified risk.

Every completion report states: MODEL; MODEL LEVEL; SESSION MODE; EXECUTION ENVIRONMENT; PRECHECK OF HANDOFF; MAIN PROJECT GOAL; GLOBAL ROADMAP POSITION; completed step in plain language; VALUE DELIVERED; CURRENT PRODUCTION VERDICT; SUCCESS TRANSITION; NEXT TWO VALUE STEPS in plain language; DISTANCE TO LIVE MILESTONE; PRESERVED WORK; SINGLE REMAINING BLOCKER; exactly one FOUNDER ACTION. Detailed schema: `SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL.md §22`.

## 17. STOP continuation

A STOP report additionally states what was preserved (commits/pushes already completed), the single remaining blocker, and whether distance to live changed. Do not return a plan instead of execution. Do not stop merely because a target file is absent when its creation is explicitly authorized.

## 18. Founder handoff

The Founder does not manually edit repository files. Repository changes use bounded executor prompts and atomic commits. Every report ends with exactly one Founder action. Environment variables: never print or commit secret values; report PRESENT/MISSING only; requirements must be proven by task scope, source validation, or a real error — not assumed from every `.env.example` field.

## 19. Distance-to-live reporting

Every completion or STOP report states the remaining executor runs/reviews/Founder approvals before production shadow, a bounded canonical live order, callback, terminal lifecycle, and reconciled net PnL proof — and whether this task's outcome changed that distance. Documentation-only tasks do not change production runtime and must say so explicitly.

## 20. Protocol-change persistence rule

When the Founder changes this protocol: locate the tracked `PROMPT__PROTOCOL.md`; patch it in Git; align active references (`AGENTS.md`, `docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md`); verify the diff; commit/push only per the explicit mode authorized in the prompt. Do not leave a protocol change only in chat or memory.
