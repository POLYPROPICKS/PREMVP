# Contur Gate — Exact-SHA Review Packet

**Mission:** RELEASE_DECAP_AND_PRIMARY_BUDGET_GUARD — release eligibility of an
already-implemented candidate. No implementation, no redesign, no product-code edits.

**Reviewer identity (resolved live from control plane):**

| field | value | source |
|---|---|---|
| reviewer_id | `premvp.reviewer.contur_gate.v1` | `docs/ai-context/control-plane/reviewers/contur-gate-reviewer.yaml` |
| routing | `R4_CONTUR_PRODUCTION_BOUNDARY.required_agents` | `docs/ai-context/control-plane/ROUTING_AND_PIPELINES.yaml` |
| adapter (claude_code_cloud) | project-scoped Agent `.claude/agents/contur-gate-reviewer.md` | reviewer yaml `executor_adapters` |
| receipt schema | `COMPLETION_ENVELOPE.schema.json#/definitions/reviewer_receipt` | reviewer yaml `output_contract` |
| rule | receipt `reviewed_sha` MUST equal release `result_sha` | reviewer yaml + routing `reviewer_receipt_requirements` |

## Review target

- `CANDIDATE_SHA` = `31340683d2b91be755cad834baaeba8794fdbcb5`
- `EXPECTED_PARENT` = `7ebad82d50bbc1b3e5e5ed38c3d1b057e745ea52` — VERIFIED: `git rev-parse 31340683^` → `7ebad82…`
- required ancestor `002805749bdb5c80a6afa3345f908cd9e5f69c6d` — VERIFIED: `git merge-base --is-ancestor 002805749 31340683` → exit 0; `002805749` is the current `origin/main` tip.
- Candidate chain over `origin/main`: `7ebad82` (replace positional pre-scorer cap with proven scorer capacity) → `31340683` (wall-clock guard for the sequential primary candidate loop).

## Bounded diff — `git diff 002805749..31340683`

```
M  lib/feed/buildLandingCards.ts
M  lib/feed/types.ts
A  tests/feed/primaryLoopWallClockGuard.test.ts
A  tests/feed/primaryScorerPopulationCap.test.ts
```

`lib/feed/types.ts` adds only 4 optional telemetry fields to `ResearchFunnelCounters`
(`primaryLoopBudgetMs`, `primaryLoopElapsedMs`, `primaryLoopBudgetExhausted`,
`primaryLoopBudgetExcludedCandidates`).

## Acceptance criteria (all 7 required for PASS)

1. **reviewed_sha pinned** — detached worktree `git rev-parse HEAD` == `31340683…`. ✔
2. **exact parent / ancestry** — parent `7ebad82…`; required ancestor confirmed. ✔
3. **artificial 45-event pre-scorer cap removed**
   - `[...finalCandidates, ...fallback48hCandidates].slice(0, limit * 3)` (= 45 at live `limit = 15`) → `boundPrimaryScorerPopulation(discovery.finalCandidates, discovery.fallback48hCandidates)`.
   - discovery `targetCards: limit * 2` → `targetCards: PRIMARY_SCORER_PROVEN_CAPACITY`.
   - No residual limit-derived positional cap. ✔
4. **finite advisory population ceiling 254** — `export const PRIMARY_SCORER_PROVEN_CAPACITY = 254;` `boundPrimaryScorerPopulation` returns `[...primary24h, ...fallback48h].slice(0, Math.max(1, capacity))` — finite, 24h-block-then-48h-fallback order preserved, only the tail beyond 254 dropped. ✔
5. **sequential primary loop wall-clock guard** — `PRIMARY_LOOP_DEFAULT_BUDGET_MS = RESEARCH_SCORER_DEFAULT_BUDGET_MS = 6 * 60_000` = **360000 ms**; `createPrimaryLoopBudgetGuard()` clamps `budgetMs` to `[1_000, 30 * 60_000]`; `isExhausted()` consulted **before** opening new candidate work; an event already started is never interrupted. ✔
6. **budget-exhausted tail classification** — `PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON = "PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET"`; on exhaustion: `primaryCandidatesEntered++; recordPrimaryTerminal(PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON); continue;` — distinct from `PRIMARY_ENRICHMENT_NULL`, `NOT_SCORED_*` and product-rejection codes; conservation invariant `sum(primaryTerminalReasonCounts) === primaryCandidatesEntered` preserved. ✔
7. **no product / model / downstream authority change** — diff limited to the 4 files above; no policy-constant reassignment (Signal Score formula, score/coverage/price thresholds, liquidity floor, 24h/48h timing, six-sport policy, `OFFICIAL_FULL_MATCH_MARKET_TYPES`, sibling recovery, candidate ordering, GSP/serving authority, Contract A/B2, Reservation/Rebalance/Queue, Ireland, DB/schema). The `targetCards` raise is the intended decap (discovery breadth), not a policy change. ✔

## Test evidence (run at reviewed_sha)

Detached worktree at `31340683…`, `node --import tsx --test tests/feed/primaryScorerPopulationCap.test.ts tests/feed/primaryLoopWallClockGuard.test.ts`:

```
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ duration_ms ~1047
```

Explicit assertions include: ">45 eligible candidates still admitted when the loop stays inside budget",
"a >45 population is NOT truncated to 45 by the retired limit*3 cap", "boundary is exactly at the
proven capacity", "budget-exhausted candidates get an explicit NOT_EVALUATED classification, not a
failure code", "guard becomes exhausted at the boundary", "budget is clamped to the same [1s, 30min]
window as researchScorerBudgetMs", "evaluated events are a contiguous input-order prefix".

## Reviewer output — `premvp.reviewer.contur_gate.v1`

```text
CONTUR_GATE_REVIEW_V1:
profile_version: CONTUR_GATE_REVIEWER_V1
CURRENT_SCOPE_VERDICT: PASS
NEXT_PHASE_READINESS: NOT_IN_SCOPE
weather_contract_loaded: NO
child_shell_used: NO
findings:
- All 7 exact-SHA acceptance criteria hold -> RELEASE_ELIGIBLE for exact-SHA acceptance purposes.
- Criterion 1..7 each individually confirmed against the packet evidence (parent/ancestry, 45-cap
  removal, finite 254 ceiling, 360000ms wall-clock guard with [1s,30min] clamp checked before opening
  new candidate work, distinct PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET terminal reason with
  conservation invariant preserved, diff limited to 4 files with no policy-constant reassignment).
- Test evidence: 13 tests / 13 pass / 0 fail at reviewed_sha.
- Packet internally consistent; targetCards change reconciled between criteria 3 and 7; no
  contradiction of any current-scope requirement found.
- NEXT_PHASE (premvp.release_pipeline.v1 integration via claude.command.github_pr_merge.v0) named but
  explicitly out of scope; its readiness not assessed.
- No parent product-code edits to obtain evidence (read-only git + scoped test run + detached
  worktree only); no source defect from missing evidence.
```

## Result

| field | value |
|---|---|
| REVIEWED_SHA | `31340683d2b91be755cad834baaeba8794fdbcb5` |
| PRODUCT_SEMANTIC_DELTA | NONE |
| RELEASE_ELIGIBLE | YES |
| FINAL_VERDICT | EXACT_SHA_REVIEW_PASS |
| outcome_class | TERMINAL_PASS |

The machine-readable receipt is `CONTUR_GATE_EXACT_SHA_REVIEW_RECEIPT.json` in this directory. The
registered release lifecycle (`premvp.release_pipeline.v1`, state `INVOKE_REVIEWER`) may reuse it: its
`reviewed_sha` equals the release candidate SHA and its `agent_id` matches the R4 required reviewer
`premvp.reviewer.contur_gate.v1`.
