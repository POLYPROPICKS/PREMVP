# NEW_COUNTUR_1 — Graph Gate

<!-- TOKEN LOADING RULE: Tier 1. Load with the NEW_COUNTUR_1 package before Fable review. -->
<!-- STATUS: FAILED GATE / durable evidence. Not a runtime change. -->

Companion to [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md),
[`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md),
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md).

---

## 1. Status and source SHA

| Field | Value |
|---|---|
| Gate verdict | **`FAIL_GRAPH_GATE_WITH_EXACT_CONTRADICTION`** |
| Exact contradiction | `PREVIOUSLY_ACCEPTED_GRAPH_ASSETS_NOT_AVAILABLE_IN_CURRENT_ENVIRONMENT` |
| Date | 2026-08-02 |
| Production base SHA | `6e593a5d0e66e50941f130f7792f67e487dbb347` (`origin/main`) |
| Documentation package commit | `752fd87a582fadd68db6056180308801f0a045ec` — `docs: lock NEW_COUNTUR_1 architecture` |
| Environment | Claude Code Cloud checkout, `/home/user/PREMVP` |
| Change class | documentation only — zero runtime, test, schema, config, dependency, or graph-tool change |
| Cause of FAIL | environment capability gap, **not** an architectural contradiction in `NEW_COUNTUR_1` |

This gate did **not** find a defect in the `NEW_COUNTUR_1` package. It could not execute at all,
because the two mandated graph systems are absent from this environment and the task forbids
installing them.

---

## 2. Tool reuse proof

The strict-reuse rule requires reusing the previously accepted Graphify and CodeGraph
installations, indexes, and artifacts. Discovery result: **none exist in this environment.**

### 2.1 Tool availability

| Tool | Probe | Result |
|---|---|---|
| `graphify` | `command -v graphify` | **ABSENT** — not on `PATH` |
| `codegraph` | `command -v codegraph` | **ABSENT** — not on `PATH` |
| `code-graph`, `graphify-cli` | `command -v` | **ABSENT** |
| Global npm roots | `/usr/local/lib/node_modules`, `~/.npm-global/bin` | empty / no graph package |
| Project bins | `node_modules/.bin` | no graph binary (`node_modules` present, deps installed) |

No version string could be captured for either tool, because neither is installed.

### 2.2 Accepted artifact / index locations checked

| Path or search | Result |
|---|---|
| `find /home/user /root /opt -maxdepth 5 -type d -name 'graphify-out'` | none |
| `find /home/user /root /opt -maxdepth 5 -type d -name '.codegraph'` | none |
| `find / -maxdepth 7 -type d \( -name '.codegraph' -o -name 'graphify-out' \)` | none |
| `find /home/user /root -maxdepth 6 -type f -name 'graph.json'` | none |
| `find … -iname '*GRAPHIFY*' -o -iname '*CODEGRAPH*' -o -iname '*GRAPH*CROSSCHECK*'` | none |
| `ls -a /home/user/PREMVP` for graph dirs | none |
| `git ls-files` for graph assets | **NONE TRACKED** |
| `git log --all --diff-filter=A --name-only` for graph paths | **NEVER TRACKED IN ANY COMMIT** |
| `git log --all --grep='graphify\|codegraph\|graph gate'` | no commits |
| `git worktree list` | single worktree `/home/user/PREMVP`; **no prior audit worktree** |

No prior graph report, crosscheck matrix, version record, parse-error record, or
generated-artifact allowlist exists to reuse.

### 2.3 The accepted protocol exists — the assets do not

The graph protocol **is** tracked and active, which is why this task was correctly issued:

- `docs/ai-context/LIVE_CONTOUR_6.md` §7 "Graph Workflow" — §7.1 CodeGraph as the default daily
  tool with "incremental project-local indexing"; §7.2 Graphify as the architecture gate tool,
  triggered exactly by "identity ownership changes" and "two implementations appear to overlap";
  §7.3 "Graph output is navigation evidence, not final proof"; §7.4 no global automation before
  local proof.
- `docs/ai-context/CODE_AUDITOR_AGENT.md` — requires `CODEGRAPH_PATHS_REVIEWED` as a named
  review input and forbids "full Graphify rebuild for a bounded patch".
- `docs/ai-context/LIVE_CONTOUR_6.md:132` records as already-proved evidence that
  "the main code path is connected in Graphify and CodeGraph".

**Conclusion.** The prior graph work was performed against the canonical Windows working copy
(`C:\WORK\KalshiProPulse\sipropicks-premvp1-1`, per `AGENTS.md §4`), and its indexes and outputs
were never committed to the repository. This ephemeral Cloud container was cloned fresh from
`origin`, so it carries the *protocol* but none of the *assets*. The gap is environmental and
expected — not evidence that the prior graph work never happened.

---

## 3. Graph asset freshness

**Not applicable — no graph asset exists to age.**

The STALE INDEX RULE could not be evaluated: there is no index whose represented source SHA
could be compared against `6e593a5d…`, and therefore no incremental-refresh path to assess.
No refresh was attempted. No graph tool was installed, initialized, or configured.

**Generated-artifact allowlist:** declared empty before any graph operation, and no graph
operation ran. Working tree confirmed clean apart from this single report file — no unknown
generated file was produced.

---

## 4. Graphify architecture findings

**BLOCKED — `PREVIOUSLY_ACCEPTED_GRAPH_ASSETS_NOT_AVAILABLE_IN_CURRENT_ENVIRONMENT`.**

All twelve required Graphify investigations (current source path; every `Reservation → Rebalance →
Queue` path; callers of the model producer, `buildFireModelCandidates`, `buildReservationPlan`,
`runEventRebalance`, and Queue construction; production model/policy/ranking owners;
parallel/dead/legacy implementations; identity-field producers and consumers; DB writers and
readers; broad-sports inventory path; rejection-trace ownership; execution-window ownership;
callback correlation path; associated tests) are **unexecuted**.

No Graphify node/edge counts, graph paths, inferred-edge markings, parse errors, or skipped-file
records exist for this task.

---

## 5. CodeGraph targeted subgraph findings

**BLOCKED — same contradiction.**

All five required targeted subgraphs are **unexecuted**: A (model owner), B (Reservation),
C (Rebalance), D (identity), E (legacy cutoff). No direct callers, transitive production callers,
callees, route/cron/job bindings, DB writer/reader sets, affected tests, alternate writers, or
blast-radius sets were derived from CodeGraph.

---

## 6. Graph/source crosscheck matrix

**BLOCKED.** The matrix requires at least one graph-tool column to be populated. With both
Graphify and CodeGraph unavailable, every row would resolve to `NOT_VERIFIABLE` in both graph
columns, which is not a crosscheck — it is an empty table. It is therefore deliberately **not**
produced, rather than produced with fabricated or single-source rows.

**Critical scope note.** Re-deriving these answers from `rg` and direct source reads would *not*
satisfy this gate. That is precisely the method already used to produce the `NEW_COUNTUR_1`
package at commit `752fd87`. The purpose of the graph gate is **independent** structural
confirmation by two separate tools whose conclusions are not fed into each other. Substituting a
third pass of the same method would produce agreement by construction and would be worthless as
independent evidence. No such substitution was performed.

---

## 7. Current ownership matrix

**BLOCKED for gate purposes.** Not produced from graph evidence.

The source-proven current-ownership findings already committed in
[`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md` §5 and §20](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md)
remain the standing evidence. They are labelled `PROVED_CURRENT_SOURCE`, **not**
graph-verified, and this gate neither confirms nor weakens them.

## 8. Target ownership matrix

**BLOCKED for gate purposes.** The Founder-locked target ownership is stated in
[`NEW_COUNTUR_1.md` §4](./NEW_COUNTUR_1.md). Graph feasibility confirmation is unexecuted.

## 9. Exact identity matrix

**BLOCKED.** The eleven-field identity matrix (`physical_event_id`, observation/source ID,
decision/signal ID, `condition_id`, `token_id`, `side`, `event_start_iso`, `reservation_id`,
`queue_id`, `idempotency_key`, `venue_order_id`) requires producer/consumer edges per boundary.
Those edges are exactly what CodeGraph subgraph D was to supply. Unexecuted.

Lossy transformations, reconstructed values, fuzzy matching, sibling substitution, timestamp
mismatch risk, and occurrence reuse risk are therefore **unassessed by this gate**.

## 10. Callback correlation verdict

**`NOT_VERIFIABLE` by this gate.**

The special review required an independent determination of the callback correlation key. The
standing source-proven claim — carried from the docs package, **not** re-verified here and **not**
graph-verified — is that `lib/executor/executorCallbackContract.ts:14-20` documents correlation by
`idempotency_key` plus a mandatory `condition_id`/`token_id`/`side` cross-check, and records that
`executor_order_events.queue_id` does not exist in the live schema.

This gate could not discharge the required sub-questions (whether `queue_id` exists elsewhere,
whether the target needs a migration, whether exact-key correlation stays correct without a
callback-table `queue_id`) with independent structural evidence. The verdict remains open among
`CURRENT_IDEMPOTENCY_KEY_CORRELATION_IS_SUFFICIENT`, `QUEUE_ID_SCHEMA_CHANGE_REQUIRED`, and
`DOCS_REQUIRE_WORDING_QUALIFICATION`. No schema change was designed or implemented.

## 11. Broad-sports continuity verdict

**`NOT_VERIFIABLE` by this gate.** The `provider source rows → canonical observations → signal
pairs/snapshots → Contract A input` trace, the sport-metadata owner, any pre-Contract-A sport
filtering, and the distinction between explicit Contract A policy exclusions and accidental
upstream loss were all to be established from the graph. Unexecuted. No policy was changed.

## 12. Failure tree

The required failure tree evaluates **causes of the production defect**. This gate failed before
reaching that analysis, so the ten competing causes remain at their pre-gate status from the
committed package. Reproducing them here from the same source method would add no independent
evidence.

The failure tree that *is* in scope for this report is the one explaining the gate failure itself:

| Cause of gate failure | Evidence for | Evidence against | Status |
|---|---|---|---|
| Tools installed but not on `PATH` | — | exhaustive `find /` for index dirs also empty; no global npm package | **EXCLUDED** |
| Assets exist in a sibling audit worktree | — | `git worktree list` shows one worktree | **EXCLUDED** |
| Assets tracked in git but not checked out | — | `git ls-files` and `git log --all --diff-filter=A` both empty | **EXCLUDED** |
| Assets exist under a different name | — | probed `code-graph`, `graphify-cli`; repo-wide `rg` finds only doc references | **EXCLUDED** |
| Prior graph work was done on the canonical Windows copy and never committed | `AGENTS.md §4` names the Windows repo path; `LIVE_CONTOUR_6.md:132` asserts prior graph connection; nothing graph-related ever tracked | — | **CONFIRMED** |
| Ephemeral Cloud container cannot carry prior local state | container cloned fresh from `origin` at session start | — | **CONFIRMED** |

Affected future commits: **none**. This is an environment gap; Commits A/B/C are unaffected in
scope, only unverified by graph evidence.

## 13. Function disposition

**BLOCKED.** Disposition classification (`KEEP` / `ADAPT` / `RETIRE_FROM_AUTHORITY` /
`DELETE_AFTER_PARITY` / `NEEDS_IMPLEMENTATION_REVIEW`) requires the caller sets that CodeGraph
subgraph E was to enumerate. The provisional dispositions in
[`NEW_COUNTUR_1.md` §8-§9](./NEW_COUNTUR_1.md) stand as source-proven but **graph-unconfirmed**.

## 14-16. Commit A / B / C exact boundaries

**BLOCKED.** The committed package defines these boundaries at
[`NEW_COUNTUR_1.md` §13](./NEW_COUNTUR_1.md). This gate was to sharpen them into exact symbol-level
cut lines using graph caller sets. Unexecuted — the boundaries remain at package-level precision.

## 17. Tests required for A/B/C

**PARTIALLY AVAILABLE — no change from the package.** The 15-row future TDD matrix in
[`NEW_COUNTUR_1_ENGINEERING_GATES.md` §4](./NEW_COUNTUR_1_ENGINEERING_GATES.md) stands. The
graph-derived "affected tests per changed symbol" set, which was to confirm the matrix is
complete, is **unexecuted**. No tests were added in this task.

## 18. Legacy caller zero-proof requirements

**BLOCKED.** The zero-production-caller proof for retired selector/ranker paths requires an
authoritative caller enumeration. That is CodeGraph subgraph E. Unexecuted. The requirement
itself remains as specified in `NEW_COUNTUR_1_ENGINEERING_GATES.md` gate G14.

---

## 19. Contradictions against `NEW_COUNTUR_1`

**NONE FOUND.**

No statement in the committed `NEW_COUNTUR_1` package was contradicted by this task. No statement
was independently confirmed either. Every package claim retains exactly the status it had at
commit `752fd87`: source-proven where labelled `PROVED_CURRENT_SOURCE`, target-locked where
labelled `FOUNDER_LOCKED_TARGET`, and open where labelled `NOT_VERIFIABLE` or
`NEEDS_IMPLEMENTATION_REVIEW`.

The gate's FAIL verdict is about **this environment's capability**, not about the package's
correctness. These must not be conflated in any downstream report.

---

## 20. Fable input summary

Fable review is **not yet unblocked by this gate**, because none of the graph pass conditions
(1-7) could be met. What Fable would receive today:

- **Available:** the four committed `NEW_COUNTUR_1` artifacts; the 20-row source evidence ledger;
  the git-history divergence timeline with its explicit "not verifiable" tier; the 18 engineering
  gates; the 15-row TDD matrix.
- **Missing:** independent structural confirmation from two graph systems; the exact identity
  matrix; authoritative caller enumeration for the legacy cutoff; symbol-level Commit A/B/C cut
  lines; the callback correlation verdict.
- **Founder decision required:** whether Fable may proceed on source-only evidence, or whether the
  graph gate must be re-run in an environment that carries the accepted Graphify and CodeGraph
  assets.

Both are defensible. Source-only evidence already proved the dual authority to a high standard;
the graph gate's marginal value is independent confirmation and exact cut lines, which matter most
for Commit C's zero-caller proof — a later phase than Commit A.

---

## 21. Binary graph-gate verdict

```
FAIL_GRAPH_GATE_WITH_EXACT_CONTRADICTION
CONTRADICTION: PREVIOUSLY_ACCEPTED_GRAPH_ASSETS_NOT_AVAILABLE_IN_CURRENT_ENVIRONMENT
```

Pass conditions 1-7 FAIL (no Graphify reuse, no CodeGraph reuse, no index at or refreshable to
`6e593a5d…`, no architecture-level dual-authority path from Graphify, no targeted callers from
CodeGraph, no crosscheck). Condition 4 PASSES trivially and importantly: **no new graph system was
installed.** Conditions 8-17 are **unevaluated** — not failed.

---

## 22. One next action

**Founder decides one of two paths:**

**(A)** Re-run this exact graph gate on the canonical Windows working copy
`C:\WORK\KalshiProPulse\sipropicks-premvp1-1`, where the accepted Graphify and CodeGraph
installations and indexes already exist, at base SHA `6e593a5d…` with the docs package commit
`752fd87…` checked out. This prompt requires no modification to run there.

**(B)** Authorize Fable review on source-only evidence, explicitly accepting that graph
confirmation is deferred to the final Graphify gate (roadmap step 11) before the coherent deploy.

Under either path: **no runtime implementation before Fable `PASS`.**
