# PolyProPicks / PREMVP
# WEATHER MODEL 1
## Day 1 Friendly LLM Tech-Lead Handoff
### WM1-0 Base/Re-use Inspection → Founder Gate → WM1-1A Contract Foundation

**Дата:** 2026-07-24
**Статус:** executable handoff for a friendly LLM with local repo access
**Главный архитектурный документ:** `WEATHER_MODEL_1_ARCHITECTURE_GUIDE_V1.1_2026-07-23.md`
**Repo:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`
**Production:** `https://polypropicks.com`
**Terminal:** Windows CMD
**Цель одного рабочего дня:** получить доказанный Git/reuse baseline и, только после Founder выбора base SHA, реализовать узкую contract foundation без DB/API/Liquidity changes.

---

# 0. Решение технического руководителя

## 0.1. Что реально делать за один день

Оптимальный scope:

```text
PHASE A — WM1-0
Git Base Reconciliation + Narrow Reuse Inventory
inspect-only, no edits, no commit

FOUNDER GATE
Founder chooses exact base SHA

PHASE B — WM1-1A
Weather Contract + Identity + Plan-Only Foundation
new files only + package.json scripts
TDD
separate branch
two atomic commits
no push/deploy
```

Это максимум, который можно выполнить за один день без нарушения source-of-truth и без premature DB/API work.

## 0.2. Что в этот день запрещено

```text
No Supabase migration.
No Gamma/CLOB HTTP integration.
No real Weather data collection.
No Railway cron.
No Liquidity source edits.
No extraction of Liquidity helpers.
No station DB table.
No dataset DB registry.
No model/scoring.
No live execution.
```

## 0.3. Почему не WM1-2/WM1-3

До DB и ingestion должны быть доказаны:

- exact base SHA;
- existing helper reuse;
- source contract;
- canonical identity;
- explicit dataset contract;
- test boundary;
- plan-only runner.

Попытка добавить migration/API в тот же день создаст широкий cross-layer task и снизит вероятность честного Gate 1.

---

# 1. Роль дружественного LLM

Ты — локальный технический руководитель и bounded executor направления `Weather Model 1`.

Ты обязан:

1. защищать production;
2. работать только из current source;
3. не полагаться на chat memory вместо Git;
4. применять TDD;
5. соблюдать DEV RULE 2;
6. держать scope;
7. писать точные tests;
8. создавать atomic commits только после PASS;
9. не push/deploy без Founder;
10. выдавать source-backed evidence, а не заверения.

Ты не являешься:

- product owner;
- live trader;
- automatic promoter;
- owner of Liquidity;
- autonomous production agent.

---

# 2. Environment and routing

```text
SERVER / ENVIRONMENT:
Local Windows workstation only.

REPO:
C:\WORK\KalshiProPulse\sipropicks-premvp1-1

BUSINESS / TECHNICAL VALUE:
Remove Git/source uncertainty, reuse proven patterns safely,
and establish the first reproducible Weather contracts.

CURRENT ROADMAP PHASE:
Weather Model 1 / WM1-0.

NEXT TWO STEPS:
1. Founder selects exact base SHA.
2. Execute WM1-1A on isolated feature branch.

MODEL ROUTING:
Phase A: Sol — Git/source uncertainty and architectural reuse.
Phase B: Terra — bounded TDD implementation after contracts are fixed.
Verification reviewer: Luna — read-only diff/test/evidence review.
```

---

# 3. Mandatory instruction layer

Before any command, read:

```text
CLAUDE.md
AGENTS.md
AUTOMATION_MODE_HANDOFF.md
OPERATOR_ACCEPTANCE_CHECKLIST.md
VERIFICATION_GATES.md
WINDSURF_WORKFLOW_RULES.md
TASK_ROUTING_MATRIX.md
CLAUDE_CODE_EXECUTION_PROTOCOL.md
README.md if setup is unclear
WEATHER_MODEL_1_ARCHITECTURE_GUIDE_V1.1_2026-07-23.md
```

If any mandatory instruction file is missing:

```text
STOP.
Report exact missing path.
No edits.
No branch creation.
No commit.
No push.
```

When instructions conflict:

```text
1. Current source/Git.
2. Root instruction files.
3. Weather Architecture v1.1.
4. This handoff.
5. Chat memory.
```

---

# 4. First agent decision

## 4.1. Approved first agent

```text
WEATHER GATE REVIEWER V0
```

Role:

```text
read-only
independent from writer
fresh-context review
no edits
no commit
no push
no deploy
```

Checks:

- allowed files;
- hidden scope expansion;
- tests;
- TDD evidence;
- Liquidity regression;
- diff/check/build;
- stop conditions;
- acceptance status.

## 4.2. Why this agent, not a writer agent

A second writer would increase merge/conflict/operator cost before contracts are stable.

The first useful automation is verification because it:

- catches forbidden-file changes;
- reduces Founder log reading;
- is low-risk;
- does not alter runtime;
- can be repeated manually before becoming a permanent Skill.

## 4.3. Implementation rule

Do **not** add an agent framework or production agent code in WM1-1A.

If the executor environment supports isolated sub-agents, use a read-only review sub-agent after Phase B.

If it does not support sub-agents:

```text
Run a fresh inspect-only reviewer pass after implementation.
Do not pretend an agent was used.
```

After three successful repeated review cycles, Founder may approve converting this process into a reusable Codex Skill.

---

# 5. PHASE A — WM1-0 inspect-only

## 5.1. Classification

```text
TASK CLASSIFICATION:
inspect-only / git-reconciliation / source-reuse

EXECUTION MODE:
Sol / read-only

COMMIT: NO
PUSH: NO
DEPLOY: NO
PR: NO
```

## 5.2. Goal

Determine:

1. exact relationship between local `5805a3f` and `origin/main 4c5bdc5`;
2. exact commits/files unique to each side;
3. exact safe base options for Founder;
4. which existing Liquidity helpers are reusable;
5. which new Weather modules are needed;
6. whether WM1-1A can avoid all Liquidity edits.

## 5.3. Precheck

Run:

```cmd
cd /d C:\WORK\KalshiProPulse\sipropicks-premvp1-1
git branch --show-current
git status --short
git rev-parse HEAD
git rev-parse origin/main
git log --oneline --decorate -12
```

Expected known evidence, but do not assume it remains current:

```text
local historical lead: 5805a3f
origin historical lead: 4c5bdc5
previous working tree evidence: clean
```

## 5.4. Git reconciliation commands

Use read-only commands sufficient to classify:

```cmd
git merge-base 5805a3f 4c5bdc5
git rev-list --left-right --count 5805a3f...4c5bdc5
git log --oneline --decorate 4c5bdc5..5805a3f
git log --oneline --decorate 5805a3f..4c5bdc5
git diff --stat 4c5bdc5..5805a3f
git diff --stat 5805a3f..4c5bdc5
```

Do not run:

```text
git fetch
git checkout
git switch
git reset
git merge
git rebase
git cherry-pick
git clean
```

unless Founder explicitly changes scope.

## 5.5. Narrow allowed inspection

Inspect only:

```text
package.json

lib/liquidity/captureSchedule.ts
lib/liquidity/captureSuppression.ts
lib/liquidity/failureBuckets.ts
lib/liquidity/orderbookMath.ts
scripts/liquidity/run-liquidity-auto-capture.mjs

tests/liquidity/captureSchedule.test.ts
tests/liquidity/captureSuppression.test.ts
tests/liquidity/failureBuckets.test.ts
tests/liquidity/orderbookMath.test.ts

exact existing helpers referenced by these files
exact dataset/hash/manifest/completeness helpers found via precise references
current migration conventions
mandatory instruction files
```

No broad repository search after exact targets are found.

## 5.6. Reuse classification

For each helper:

```text
REUSE_UNCHANGED
EXTRACT_WITH_REGRESSION
WEATHER_NEW
REJECT_REUSE
UNKNOWN
```

Required dimensions:

```text
source path
export/function
dependencies
sports coupling
CLOB coupling
side effects
current tests
Weather relevance
whether reuse requires editing Liquidity
```

## 5.7. Hard stop

If safe reuse requires editing `lib/liquidity/**` or changing Liquidity behavior:

```text
STOP FOR FOUNDER.
Do not implement extraction.
Propose a separate future extraction milestone.
```

WM1-1A must remain new-file-only except `package.json`.

---

# 6. PHASE A required response

Return:

```text
TASK TYPE: inspect-only

PRECHECK:
- branch
- status
- HEAD
- origin/main

GIT BASE VERDICT:
- EQUAL / AHEAD / BEHIND / DIVERGED
- merge base
- unique commits left
- unique commits right

BASE OPTIONS FOR FOUNDER:
A. [SHA + implications]
B. [SHA + implications]
Do not choose silently.

FILES INSPECTED:
- exact paths

REUSE MATRIX:
- REUSE_UNCHANGED
- EXTRACT_WITH_REGRESSION
- WEATHER_NEW
- REJECT_REUSE
- UNKNOWN

WM1-1A SAFE SCOPE:
- exact new files
- package.json change
- exact tests

RISKS:
- source uncertainty
- Liquidity coupling
- test gaps

STOP CONDITIONS:
- encountered / none

NO FILES EDITED.
NO COMMIT.
NO PUSH.
```

Then stop and ask Founder for exactly one decision:

```text
Choose Weather base SHA:
A. [...]
B. [...]
```

Do not start Phase B before the Founder replies with an exact SHA.

---

# 7. FOUNDER GATE

Founder response format:

```text
APPROVE WEATHER BASE:
<full SHA>

APPROVE WM1-1A:
YES

COMMIT:
YES

PUSH:
NO

DEPLOY:
NO
```

If Founder does not provide exact SHA:

```text
STOP.
```

---

# 8. PHASE B — WM1-1A implementation

## 8.1. Classification

```text
TASK CLASSIFICATION:
TDD-implementation / function-programming / weather-contract-foundation

EXECUTION MODE:
Terra / bounded implementation

COMMIT: YES
PUSH: NO
DEPLOY: NO
PR: NO
```

## 8.2. Branch

From Founder-approved exact SHA:

```cmd
git switch --detach <APPROVED_SHA>
git switch -c codex/weather-model-1-wm1a-contract-foundation
```

If branch already exists:

```text
STOP.
Do not overwrite or reuse without inspection.
```

## 8.3. Goal

Create a compile-tested, deterministic Weather contract foundation that:

- does not call external APIs;
- does not write Supabase;
- does not touch Liquidity;
- does not contain scoring;
- emits a plan-only Weather summary;
- supports future explicit dataset versions.

## 8.4. Allowed files

New:

```text
lib/collector-kernel/safeLog.ts
lib/collector-kernel/payloadHash.ts
lib/collector-kernel/trace.ts
lib/collector-kernel/runLedger.ts
lib/collector-kernel/leaseLock.ts

lib/weather/types.ts
lib/weather/canonicalIdentity.ts
lib/weather/datasetContract.ts
lib/weather/datasetManifest.ts
lib/weather/source-contracts/polymarketGammaWeather.v1.ts
lib/weather/source-contracts/polymarketClobTopBook.v1.ts

config/weather/us-daily-max-stations.v1.json

scripts/weather/run-weather-auto-capture.mjs

tests/collector-kernel/safeLog.test.ts
tests/collector-kernel/payloadHash.test.ts
tests/collector-kernel/trace.test.ts
tests/collector-kernel/runLedger.test.ts
tests/collector-kernel/leaseLock.test.ts

tests/weather/canonicalIdentity.test.ts
tests/weather/datasetContract.test.ts
tests/weather/datasetManifest.test.ts
tests/weather/sourceContracts.test.ts
tests/weather/weatherPlanRunner.test.ts

reports/weather/.gitkeep
```

Edit:

```text
package.json
```

Optional only if existing conventions prove a different exact test file layout:

```text
adjust paths within tests/collector-kernel/** and tests/weather/**
```

## 8.5. Forbidden files

```text
lib/liquidity/**
scripts/liquidity/**
tests/liquidity/**
supabase/**
app/**
components/**
styles/CSS
payment/auth/Whop
Contur3/Ireland/live execution
.env*
Railway config
package-lock.json
existing reports outside reports/weather/**
```

If implementation requires a forbidden file:

```text
STOP.
```

## 8.6. Explicit non-goals

```text
No cadence extraction.
No suppression extraction.
No failure bucket extraction.
No orderbook math extraction.
No database repository.
No migration.
No API client.
No real market fixture.
No raw storage.
No cron.
No dataset sealing.
No model.
```

Those are future milestones.

---

# 9. PHASE B TDD plan

## 9.1. Expected failing tests first

Before implementation, add tests proving RED for:

### Safe logging

```text
redacts:
SUPABASE_SERVICE_ROLE_KEY
Authorization
Bearer tokens
private key-like values
nested secret fields

preserves:
safe error bucket
safe status
safe counts
```

### Payload hash

```text
same canonical payload → same SHA-256
object key order does not change hash
array order remains significant
different payload → different hash
```

### Structured trace

```text
stage name required
input/output counts non-negative
first rejection reason typed
no secret/raw payload fields
target IDs represented without payload bodies
```

### Run ledger contract

Pure types/state reducer only:

```text
RUNNING → SUCCEEDED/PARTIAL/FAILED/STALE
terminal → RUNNING prohibited
SKIPPED_LOCKED is terminal
source contract ID/hash/Git SHA mandatory
```

No DB implementation.

### Lease lock contract

Pure claim-result types/validation:

```text
CLAIMED
LOCKED
STALE_RECLAIMED
INVALID
```

No RPC implementation.

### Canonical identity

```text
same fields → same ID
field order irrelevant after canonicalization
station/timezone/date/unit change → different ID
missing authority/station/date/window → reject
DST/local date represented explicitly
```

### Source contracts

```text
contract ID fixed
contract hash deterministic
semantic change changes hash
V1 cannot be mutated at runtime
Gamma and CLOB IDs distinct
```

### Dataset contract

```text
dataset version ID mandatory
unknown ID blocked
schema mismatch blocked
identity-contract mismatch blocked
no alias/latest/default accepted
```

### Dataset manifest

```text
canonical field order
stable numeric/null representation
same membership → same content/manifest hash
changed source contract/station catalog/code SHA changes manifest hash
```

### Plan-only runner

Command:

```cmd
npm run weather:auto-capture:plan -- --days 7
```

Must:

```text
perform zero network calls
perform zero DB writes
require no secrets
emit one WEATHER_CAPTURE_PLAN_SUMMARY line
include plan_only=true
include days=7
include source contract IDs/hashes
include station catalog hash
include dataset_selection=NOT_APPLICABLE
exit 0
```

## 9.2. RED evidence

Executor must report the first failing test names before implementation.

Do not fake RED by breaking existing code.

## 9.3. Minimal implementation

Implement only enough to pass these contracts.

No speculative framework.

---

# 10. Package scripts

Add only:

```json
{
  "weather:auto-capture": "tsx scripts/weather/run-weather-auto-capture.mjs",
  "weather:auto-capture:plan": "tsx scripts/weather/run-weather-auto-capture.mjs --plan",
  "test:weather": "node --import tsx --test tests/weather/*.test.ts",
  "test:collector-kernel": "node --import tsx --test tests/collector-kernel/*.test.ts"
}
```

Adapt extension/glob only if current repo test conventions require it.

Do not add dependencies.

Do not change `package-lock.json`.

---

# 11. Commit plan

## Commit A

```text
Weather: add deterministic source and dataset contracts
```

Contains:

```text
lib/weather/**
config/weather/**
tests/weather/**
```

Must pass targeted Weather tests.

## Commit B

```text
Weather: add plan-only collector control contracts
```

Contains:

```text
lib/collector-kernel/**
scripts/weather/**
tests/collector-kernel/**
package.json
reports/weather/.gitkeep
```

Before Commit B, run all verification gates.

Do not squash.

Do not push.

---

# 12. Verification commands

Before edits:

```cmd
git branch --show-current
git status --short
git log --oneline -5
npm run test:liquidity
npx tsc --noEmit
```

Targeted RED/GREEN:

```cmd
npm run test:weather
npm run test:collector-kernel
```

Plan proof:

```cmd
npm run weather:auto-capture:plan -- --days 7
```

Final Gate 1:

```cmd
npm run test:liquidity
npm run test:collector-kernel
npm run test:weather
npx tsc --noEmit
npm run build
git status --short
git diff --stat <APPROVED_SHA>..HEAD
git diff --check <APPROVED_SHA>..HEAD
git log --oneline --decorate -5
```

If build fails only from a known missing env:

```text
Report the first exact error.
Do not call PASS unless project rules explicitly allow env-only exception.
```

---

# 13. Acceptance criteria

## 13.1. Source and scope

- [ ] exact Founder-approved base SHA used;
- [ ] expected feature branch created;
- [ ] no pre-existing unexpected dirty files;
- [ ] mandatory instructions read;
- [ ] no forbidden files changed;
- [ ] no Liquidity files changed;
- [ ] no migration/API/network/DB code added.

## 13.2. TDD

- [ ] expected failing tests shown;
- [ ] all new functions covered;
- [ ] failure paths covered;
- [ ] no secret logging;
- [ ] deterministic hashes proven;
- [ ] explicit dataset ID fail-closed proven;
- [ ] plan-only no-network/no-DB proven.

## 13.3. Regression

- [ ] `npm run test:liquidity` PASS before and after;
- [ ] `npm run test:collector-kernel` PASS;
- [ ] `npm run test:weather` PASS;
- [ ] `npx tsc --noEmit` PASS;
- [ ] `npm run build` PASS or exact allowed env-only exception;
- [ ] `git diff --check` clean.

## 13.4. Git

- [ ] exactly two intended commits;
- [ ] clear commit messages;
- [ ] no package-lock;
- [ ] no unexpected files;
- [ ] no push;
- [ ] no deploy.

## 13.5. Plan output

Example shape, values source-derived:

```text
WEATHER_CAPTURE_PLAN_SUMMARY
plan_only=true
days=7
network_calls=0
db_writes=0
source_contracts=...
station_catalog_hash=...
gate=PASS
```

---

# 14. Weather Gate Reviewer V0

After writer commits, run an independent read-only review.

## Reviewer model

```text
Luna
```

## Reviewer allowed actions

```text
read Git diff
read changed files
run tests/build
read instruction files
produce verdict
```

## Reviewer forbidden actions

```text
no edits
no commit
no reset
no push
no deploy
```

## Reviewer questions

1. Were only allowed files changed?
2. Did the writer duplicate existing Liquidity logic?
3. Are contracts deterministic?
4. Does dataset selection fail closed?
5. Does plan-only truly avoid network/DB/secrets?
6. Are tests production-boundary relevant for this phase?
7. Are failure paths covered?
8. Are two commits atomic?
9. Did any hidden dependency/package change occur?
10. Is WM1-1A ready for Founder acceptance?

## Reviewer output

```text
WEATHER_GATE_REVIEW_V0:
base_sha:
branch:
commits:
allowed_files: PASS/FAIL
liquidity_untouched: PASS/FAIL
tests: PASS/FAIL
tsc: PASS/FAIL
build: PASS/FAIL
diff_check: PASS/FAIL
contract_determinism: PASS/FAIL
fail_closed_dataset: PASS/FAIL
plan_only_zero_io: PASS/FAIL
scope: PASS/FAIL
gate_1: PASS/FAIL/STOP
risks:
next_action:
```

The reviewer must remain `runtime_proven: NO`.

---

# 15. Required final executor report

The friendly LLM must return one consolidated report after Phase B:

```text
TASK CLASSIFICATION:
WM1-1A TDD implementation

PRECHECK:
- approved base
- branch
- initial status
- baseline tests

PHASE A EVIDENCE:
- git relationship
- reuse matrix
- Founder base decision

FILES CHANGED:
- each exact path
- allowed status

TDD:
- tests added
- expected RED
- GREEN result
- failure paths

OLD/NEW:
- exact relevant snippets per changed code file
- new files may show key contract blocks

COMMITS:
- hash + subject + file scope

VERIFICATION:
- test:liquidity
- test:collector-kernel
- test:weather
- tsc
- build
- diff stat
- diff check
- status

PLAN SUMMARY:
- exact WEATHER_CAPTURE_PLAN_SUMMARY

WEATHER GATE REVIEWER V0:
- complete verdict

ACCEPTANCE:
- each criterion met/failed/not verified

RISKS / ASSUMPTIONS:
- exact

STOP CONDITIONS:
- none / exact blocker

GATE 1:
PASS / FAIL / STOP

PUSH:
NOT PERFORMED

DEPLOY:
NOT PERFORMED

RUNTIME PROVEN:
NO

FOUNDER NEXT ACTION:
one exact action
```

---

# 16. Hard stop conditions

Stop immediately if:

```text
wrong or unresolved base
unexpected dirty files
mandatory instruction missing
feature branch already exists unexpectedly
Liquity file edit required
package-lock modification required
new dependency required
API/DB needed
test framework absent
test:liquidity baseline fails
TDD target cannot be created
plan runner needs secrets
network call detected
build first real error is code-related
forbidden file changed
more than two commits needed due scope growth
```

After one failed implementation attempt:

```text
DIRECT-SOURCE OPTION CHECK:
continue with Codex / inspect diff / request exact files / split scope
because [specific reason]
```

No second broad fix prompt.

---

# 17. Single command block for the friendly LLM

_______ НАЧАЛО КОМАНДЫ ДЛЯ ДРУЖЕСТВЕННОГО LLM / CLAUDE CODE _______

You are the local technical lead and bounded executor for PolyProPicks Weather Model 1.

Use the attached documents:

1. WEATHER_MODEL_1_ARCHITECTURE_GUIDE_V1.1_2026-07-23.md
2. WEATHER_MODEL_1_DAY1_FRIENDLY_LLM_TECH_LEAD_HANDOFF_2026-07-24.md

Repo:

C:\WORK\KalshiProPulse\sipropicks-premvp1-1

Follow the Day 1 handoff exactly.

First execute PHASE A / WM1-0 in inspect-only mode with model Sol.

Do not edit or commit.

Return the exact Git base options and reuse matrix, then STOP for Founder to select the exact base SHA.

After Founder provides:

APPROVE WEATHER BASE: <full SHA>
APPROVE WM1-1A: YES
COMMIT: YES
PUSH: NO
DEPLOY: NO

continue with PHASE B using model Terra:

- create `codex/weather-model-1-wm1a-contract-foundation`;
- implement only the allowed WM1-1A contract foundation;
- use RED/GREEN TDD;
- do not touch Liquidity;
- do not add DB/API/network code;
- create exactly two atomic commits;
- do not push/deploy;
- run the full verification matrix;
- invoke an independent read-only `Weather Gate Reviewer V0` with model Luna when supported;
- otherwise perform a fresh read-only reviewer pass and state that no sub-agent capability was used;
- return the required consolidated report.

The first agent is verification-only. Do not create an agent framework or a second writer.

If any stop condition is reached, STOP honestly and return source evidence.

_______ КОНЕЦ КОМАНДЫ ДЛЯ ДРУЖЕСТВЕННОГО LLM / CLAUDE CODE _______

---

# 18. Tech-lead final decision

```text
DAY_1_SCOPE:
WM1-0 + conditional WM1-1A

REALISTIC_IN_ONE_DAY:
YES, if Founder answers the base gate promptly and source matches the handoff.

COMMIT:
Phase A NO.
Phase B YES, exactly two commits.

PUSH:
NO.

DEPLOY:
NO.

FIRST AGENT:
Weather Gate Reviewer V0, read-only.

AGENT CODE:
NO.

DATABASE:
NO.

API:
NO.

LIQUIDITY CHANGES:
NO.

NEXT MILESTONE AFTER PASS:
WM1-2 Minimal DB + Gamma Inventory design/review.
```
