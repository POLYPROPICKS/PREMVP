# CHATGPT_PROJECT_SETUP.md — HISTORICAL / SUPERSEDED

> **STATUS: SUPERSEDED — HISTORICAL RECORD ONLY. NOT CURRENT POLICY.**
>
> This file records the original one-time Phase 2 project setup. It is **not** the current
> prompt policy, **not** current state, and **MUST NOT** be uploaded as an active ChatGPT
> Project Source.
>
> The current Project Sources and Project Instructions are generated deterministically from
> the canonical control plane into
> `docs/ai-context/control-plane/chatgpt-architect/project-package/`.
> Follow `project-package/REPLACE_PROJECT_SOURCES.md`; verify with
> `npm run control-plane:project-package:check`.
>
> The executor prompt contract below reflects the **retired** fixed-section model. The
> canonical contract is now the Mission Contract in `PROMPT__PROTOCOL.md` and
> `MISSION_CONTRACT.schema.json`. There is exactly one direction of generation: canonical
> control plane → generated package. This document never overrides canonical policy.

---

## Historical record — Phase 2 Founder Setup Package

Phone-first. Everything below can be done from the ChatGPT iOS app or a browser. No
terminal, no SQL, no secrets.

**Total Founder effort:** one bounded UI setup sequence (create project → paste
instructions → attach files or connect GitHub → open two chats).

---

## 1. What you are creating

| Setting | Exact value |
|---|---|
| Project name | `PolyProPicks — Architect Control Plane` |
| Mode | **Standard Chat** (not Work) |
| Memory | **Project-only** |

**Why a new project:** project-only memory cannot be applied retroactively to an existing
project. The project must be created fresh.

**Why Standard Chat:** Work is high cost and is *escalation-only* — used solely for an
explicitly scoped, Founder-authorized deep architecture escalation. It is never the
default architect runtime.

---

## 2. Account memory prerequisites

Before creating the project, in **Settings → Personalization**:

1. Confirm **Reference saved memories** and **Reference chat history** reflect what you
   want globally. The project will be set to project-only regardless, but a noisy global
   memory can still leak stale PREMVP assumptions into other chats.
2. Saved Memory is **not** project source of truth. If the architect ever cites a saved
   memory as authority, that is a defect — the source authority tree in
   `ARCHITECT_CONTROL_PLANE.yaml` ranks chat memory last.

---

## 3. Create the project

1. ChatGPT → **Projects** → **New project**.
2. Name it exactly: `PolyProPicks — Architect Control Plane`
3. Open project settings → **Memory** → set to **Project-only**.
4. Paste the Project Instructions from §4.
5. Add context using §5 (GitHub live read) or §6 (attached files).

---

## 4. Project Instructions (copy this block exactly)

```
You are the PREMVP Architect for PolyProPicks. You produce plans and executor prompts.
You never edit the repository yourself.

CANONICAL SOURCES
All authority lives in docs/ai-context/control-plane/:
  ARCHITECT_CONTROL_PLANE.yaml   policy, boundaries, source authority
  CURRENT_STATE.yaml             the ONLY current operational state artifact
  CAPABILITY_MATRIX.yaml         execution targets, capabilities, environment paths
  ROUTING_AND_PIPELINES.yaml     risk classes, executor and reviewer selection
  AGENT_REGISTRY.yaml            agents, commands, hooks, policies
  PROMPT__PROTOCOL.md            the executor prompt contract
  COMPLETION_ENVELOPE.schema.json  the executor result contract
  EVIDENCE_LEDGER.md             history only — never authoritative for current state
If live repository access is unavailable, use the attached ARCHITECT_SNAPSHOT.md as the
compact stand-in for these files. Never substitute chat memory for them.

SOURCE AUTHORITY — two separate trees, never merged
Runtime and source facts:
  1 live git/command/runtime evidence  2 accepted CURRENT_STATE entry
  3 tracked documentation  4 executor self-report  5 chat memory
Product, roadmap and authority decisions:
  1 current Founder decision  2 control plane policy  3 locked product decisions
  4 historical checkpoint  5 chat memory
A Founder statement does not by itself prove a runtime PASS.

MANDATORY STAGES — run all eight, in order, every time
STATE LOAD -> SOURCE AUTHORITY CHECK -> TASK CLASSIFICATION -> RISK CLASSIFICATION ->
EXECUTOR ROUTING -> PROMPT COMPILATION -> PROMPT CONTRACT CHECK -> FINAL OUTPUT

EXECUTION TARGETS
claude_code_cloud    PREMVP; no host dependency; no Founder terminal; PROVEN: repo read,
                     npm ci, tsc, build, authenticated Supabase SELECT, production HTTPS,
                     feature-branch push. NOT PROVEN: Supabase write. No Codex reviewers.
local_codex_windows  PREMVP; host dependency true; reached by DESKTOP or by MOBILE_REMOTE
                     through Codex Remote. Holds the Weather and Contur reviewers.
                     Codex Remote is an ACCESS SURFACE to this target, not a separate runtime.
ireland_local        Protected boundary only. Not accessed, not implemented, no agents.

ROUTING — minimum agents, never all agents
R0_READ_ONLY                    claude_code_cloud or local_codex_windows; no reviewer
R1_BOUNDED_CODE                 claude_code_cloud only; no reviewer
R2_ARCHITECTURE_OR_ROADMAP      claude_code_cloud only; no mandatory reviewer
R3_WEATHER_MODEL_CHANGE         local_codex_windows; MANDATORY
                                codex.agent.weather_gate_reviewer.v0 + receipt
R4_CONTUR_PRODUCTION_BOUNDARY   local_codex_windows; MANDATORY
                                codex.agent.contur_gate_reviewer + receipt
R5_CROSS_REPO_OR_LIVE_MONEY     FAILS CLOSED — always BLOCKED

OUTPUT
Exactly one copyable execution block containing every mandatory section listed in the
PROMPT__PROTOCOL.md section-2 table. Use that table as the checklist — do not summarise,
reorder or drop sections, and do not rely on this instruction block to enumerate them.
Every executor result must be a completion envelope. A task requiring a reviewer cannot
return PASS without a matching receipt whose reviewed_sha equals result_sha.

FAIL CLOSED — return PROMPT_GATE_BLOCKED instead of guessing when:
a mandatory section cannot be filled with a concrete value; CURRENT_STATE's recorded
origin_main_sha (a verified baseline, not a permanent exact match) is NOT an ancestor of
live origin/main, or live origin/main is ahead of it and a changed path falls outside the
state-bootstrap allowlist (CURRENT_STATE.yaml, ARCHITECT_SNAPSHOT.md, EVIDENCE_LEDGER.md);
a required capability is not PROVEN; two canonical artifacts contradict each other; the
task would mix PREMVP and Ireland; the task is R5 without separate authorization; the task
would require a prohibited Founder action.
Format:
  PROMPT_GATE_BLOCKED
  Reason: <named stop condition>
  Missing: <exact missing section / capability / evidence>
  Narrowest safe next action: <one bounded read-only task>
  Founder action: <one action, or none>

OPERATOR MODE — MOBILE_REMOTE by default
Assume the Founder is on an iPhone. Normal flows must never require Windows CMD,
PowerShell, SQL, SSH, Supabase UI queries, locating a cwd, selecting a repository, or
copying secrets. Terminal work is allowed only as an explicitly labelled
BREAK_GLASS_OPERATOR_ACTION after proving no registered executor can do it.
Founder action budget: preferably zero, otherwise exactly one tap or one copy/paste.
Per milestone: at most one copy/paste down and one result up.

NEVER
- guess a SHA, path, permission, capability verdict or evidence claim
- mix PREMVP and Ireland in one implementation prompt
- invoke every agent for every task
- cite the untracked Local Windows docs/ai-context/PROMPT__PROTOCOL.md as authority
- let an implementation writer declare its own state delta accepted
- treat EVIDENCE_LEDGER.md as current state
```

---

## 5. Preferred: GitHub live read

If the ChatGPT GitHub connector is available on your plan and surface:

1. Project → **Add files / sources** → connect **GitHub**.
2. Grant access to `POLYPROPICKS/PREMVP` **only**.
3. Scope reading to `docs/ai-context/control-plane/`.
4. In the first chat, ask: *"Read CURRENT_STATE.yaml and confirm origin_main_sha."*

Live read is preferred because `CURRENT_STATE.yaml` freshness can then be checked against
the real repository instead of a snapshot.

---

## 6. Fallback: attach files (works everywhere, including iOS Standard Chat)

If live GitHub read is unavailable, attach exactly these files to the project:

| Attach | Why |
|---|---|
| `docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md` | **Required.** The compact deterministic architect context. |
| `docs/ai-context/control-plane/PROMPT__PROTOCOL.md` | The prompt contract, in full. |
| `docs/ai-context/control-plane/COMPLETION_ENVELOPE.schema.json` | The result contract, in full. |

Do **not** attach: `EVIDENCE_LEDGER.md` (history), legacy `docs/ai-context/0*_*.md` state
documents, or any file containing environment values.

When running on the snapshot, the architect must state its assumption explicitly:

> Operating on ARCHITECT_SNAPSHOT.md dated `<updated_at>`. If live origin/main has moved,
> this is stale — request a bounded read-only refresh.

---

## 7. Chats: what to import, what to create

**Do not import old architecture chats in bulk.** They carry superseded environment
assumptions (Windows-only paths, prose completion reports, legacy state documents) that
project-only memory would then absorb as if current.

Create exactly **two** permanent chats inside the project:

| Chat name | Purpose |
|---|---|
| `00 — Architect` | Everything operational: load state, classify, route, compile the executor prompt, and take the completion envelope back for validation and the state-delta proposal. Start here every time. |
| `01 — Shadow Log` | Phase 3 scenario results and metrics only. Nothing operational. |

Two chats, not four. Splitting state, prompts and review across separate threads forced
the same context to be re-established three times per milestone and was the main source
of drift.

---

## 8. Mandatory post-merge state bootstrap

**Do this once after any control-plane PR merges to `main`, before the next Phase 3
scenario.** `CURRENT_STATE.yaml.main.origin_main_sha` is a **verified baseline**
(`LAST_VERIFIED_ORIGIN_MAIN_BASELINE`), not a permanent exact match — a bootstrap merge
always moves `origin/main` past whatever baseline it recorded, since the merge commit
cannot be embedded in its own parent. Freshness mode
`BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE` (defined in `ARCHITECT_CONTROL_PLANE.yaml`)
keeps state FRESH across that advance as long as every path changed since the baseline is
in the state-bootstrap allowlist (`CURRENT_STATE.yaml`, `ARCHITECT_SNAPSHOT.md`,
`EVIDENCE_LEDGER.md`). If a merge touched anything else — new source, new artifacts — the
architect correctly returns `STATE_REFRESH_REQUIRED` and this section is how you clear it.

One Founder action. In `00 — Architect`, send:

```
Bootstrap state after a control-plane merge. Produce one bounded R2_ARCHITECTURE_OR_ROADMAP
Claude Code Cloud prompt that: resolves live origin/main; sets CURRENT_STATE.yaml
main.origin_main_sha to that new baseline (keeping origin_main_sha_semantics
LAST_VERIFIED_ORIGIN_MAIN_BASELINE and freshness_check_mode
BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE); updates updated_at and increments
state_version by exactly 1; sets last_accepted_completion_id; appends one EVIDENCE_LEDGER
entry; regenerates ARCHITECT_SNAPSHOT.md; runs npm run control-plane:check; commits and
pushes. Allowed files: docs/ai-context/control-plane/CURRENT_STATE.yaml,
docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md,
docs/ai-context/control-plane/EVIDENCE_LEDGER.md only.
```

Then: one copy/paste down to Claude Code Cloud, one envelope back up.

Bootstrap is complete when all four hold:

- [ ] `CURRENT_STATE.yaml` `main.origin_main_sha` is an ancestor of live `origin/main`
      (need not be exactly equal)
- [ ] `state_version` incremented by exactly 1 and `updated_at` advanced
- [ ] `npm run control-plane:check` PASS, including `snapshot:check`
- [ ] if you are on attached files (§6), the project's `ARCHITECT_SNAPSHOT.md` has been
      replaced with the regenerated one

Repeat this bootstrap after **every** merge to `main` that touches
`docs/ai-context/control-plane/`. Skipping it is the single most likely cause of an
architect confidently planning against a stale SHA.

---

## 9. Normal interaction pattern

1. You (phone): *"Next step on C1."*
2. Architect: runs the eight stages, returns **one** copyable execution block.
3. You: one copy/paste into Claude Code Cloud, or one tap in Codex Remote.
4. Executor: returns a completion envelope.
5. You: one paste back into `00 — Architect`.
6. Architect: validates the envelope and proposes a `CURRENT_STATE` delta.

That is **one copy/paste down and one result up** per milestone. Anything more is a
routing defect worth logging in `01 — Shadow Log`.

If the architect returns `PROMPT_GATE_BLOCKED`, do **not** argue it into producing a
prompt. It is telling you evidence is missing. Its `Narrowest safe next action` is a
bounded read-only task — run that first, paste the result back, then re-ask.

---

## 10. Refreshing `ARCHITECT_SNAPSHOT.md` after an accepted milestone

The snapshot is generated, never hand-edited. After a milestone is accepted:

1. Ask the architect for a bounded R2 Claude Code Cloud prompt to update
   `CURRENT_STATE.yaml` from the accepted completion envelope.
2. That executor runs `npm run control-plane:snapshot` and
   `npm run control-plane:check`, then commits both the state and the regenerated
   snapshot.
3. If you are on attached files (§6), replace the project's attached
   `ARCHITECT_SNAPSHOT.md` with the new one. One tap: remove, re-attach.
4. If you are on live GitHub read (§5), nothing to do.

`npm run control-plane:snapshot:check` fails if the committed snapshot ever drifts from
the canonical files, so a stale snapshot cannot be merged silently.

---

## 11. Phase 3 — mobile shadow test plan

Run these five from the phone, in `01 — Shadow Log`. **No Ireland execution, no UAS
work.**

| # | Scenario | Success looks like |
|---|---|---|
| 1 | Architect produces a **read-only Claude Cloud evidence prompt**. | `R0_READ_ONLY` routing, executor `claude_code_cloud`, no reviewer invoked, zero Founder shell commands, every PROMPT__PROTOCOL §2 section present. |
| 2 | Architect produces a **bounded PREMVP Cloud implementation prompt**. | `R1_BOUNDED_CODE` routing, explicit `ALLOWED FILES` / `FORBIDDEN FILES`, build + typecheck in `EVIDENCE REQUIRED`, completion envelope required. |
| 3 | Architect routes a **Contur exact-SHA review to Local Windows Codex via mobile Remote** and requires the Contur reviewer receipt. | `R4_CONTUR_PRODUCTION_BOUNDARY` routing, executor `local_codex_windows`, access surface `MOBILE_REMOTE`, `codex.agent.contur_gate_reviewer` mandatory, receipt fields enumerated, no Founder CMD. |
| 4 | Architect hits **stale or missing evidence**. | Returns `PROMPT_GATE_BLOCKED` with a named reason and one bounded read-only next action. Does **not** guess a SHA. |
| 5 | A **completion envelope proposes a state delta**. | Envelope validates; `state_delta_proposal.accepted` is `false`; the architect — not the writer — proposes acceptance. |

### Acceptance metrics (record per scenario in `01 — Shadow Log`)

- zero wrong-repository prompts
- zero PREMVP/Ireland mixed prompts
- zero Founder CMD, PowerShell, SQL or SSH
- zero missing mandatory prompt sections
- zero missed required Contur reviewer invocations
- valid reviewer receipt present where mandatory
- no more than one copy/paste down and one result up per milestone
- zero unclassified state changes
- `CURRENT_STATE` lag no greater than one accepted completion
- recorded: token overhead, and any unnecessary-agent invocations

### Starting Phase 3 from the phone

Open `00 — Architect` and send:

```
Shadow scenario 1. Produce a read-only Claude Code Cloud evidence prompt that re-proves
origin/main and confirms CURRENT_STATE freshness. Operator mode MOBILE_REMOTE.
```

Then work down the table. Log every correction you have to make — the corrections, not
the successes, are the Phase 3 signal.
