# P0 Feed Forensic Automation Protocol

Status: mandatory protocol for PolyProPicks feed/data/scoring incidents.

## 1. Why this exists

Recent feed work proved that build-passing patches can still break the product when they touch discovery, candidate selection, scoring, allocation, cache, API, or frontend counting separately.

The failure pattern was:

- patch is technically valid;
- `npm run build` passes;
- production feed changes after cron;
- public and premium are internally consistent;
- but the final generated/cached feed violates product contract.

Therefore, for any P0 feed incident, **patching is forbidden until the exact pipeline loss point is proven**.

## 2. Mandatory trigger

Use this protocol for any issue involving:

- category count becomes `0` unexpectedly;
- public and premium counts diverge;
- wrong market appears in a strategic filter;
- `Market Watch`, `Pending`, `-10000`, `$1`, or impossible odds appear;
- confidence/trust metrics look inconsistent with the market;
- eSport/WC26/NBA/NHL supply changes after cron;
- cache/API returns unexpected pairs;
- any change touching:
  - `lib/feed/buildLandingCards.ts`
  - `lib/feed/discoverSportsMarkets.ts`
  - `lib/feed/types.ts`
  - `lib/feed/polymarketClient.ts`
  - `lib/feed/landingPairs.ts`
  - `lib/feed/cacheGeneratedSignals.ts`
  - `scripts/generate-signals.ts`
  - `app/api/feed/landing-cards/route.ts`

## 3. Non-negotiable rule

No patch before a loss-point table exists.

The assistant/Claude Code must prove where the defect happens:

```text
External source
→ discovery buckets
→ normalized sample
→ build pair
→ scoring/metrics
→ allocation
→ cache write
→ API response
→ frontend filter/count/render
```

If the response does not include this table, the patch is not acceptable.

## 4. Required P0 trace table

Every P0 feed investigation must output this table:

| Checkpoint | Input count | Output count | Example titles/ids | Rejection/loss reason | PASS/FAIL |
|---|---:|---:|---|---|---|
| Production API cached feed | | | | | |
| External source / Gamma tag/search | | | | | |
| Discovery bucket | | | | | |
| Normalized candidate fields | | | | | |
| Actionable odds selection | | | | | |
| Pair builder output | | | | | |
| Scoring/trust metrics output | | | | | |
| Category allocation output | | | | | |
| Cache write / flattened pairs | | | | | |
| API route/canonicalization | | | | | |
| Frontend matcher/count | | | | | |

## 5. Required source map

Before patching, list every creation/scoring path:

| Path | File/function | Input | Market selection | Position extraction | Price/odds | Metrics/confidence | Unified? |
|---|---|---|---|---|---|---|---|
| qualified/current | | | | | | | |
| fallback48h | | | | | | | |
| targeted WC26 | | | | | | | |
| targeted eSport | | | | | | | |
| targeted NBA/NHL | | | | | | | |
| cache/API | | | | | | | |
| frontend normalization | | | | | | | |

Any path-specific scoring or metric formula must be explicitly identified.

## 6. Required runtime evidence

Claude Code must run or request read-only checks appropriate to the incident.

Minimum for cached feed incidents:

```cmd
curl "https://polypropicks.com/api/feed/landing-cards?limit=15&includeUpcoming=true&category=sports&minDataCoverage=40&excludeEnded=true"
curl "https://polypropicks.com/api/feed/landing-cards?limit=15&includeUpcoming=true&category=<affected-filter>&minDataCoverage=40&excludeEnded=true"
```

Report:

- `cacheStatus`
- `formulaVersion`
- returned pair count
- category counts computed from returned JSON
- affected-category examples by title/league/url/diagnostics
- whether the issue exists in JSON or only in UI

## 7. Required local pipeline trace

If runtime API does not prove the loss point, Claude Code must create one temporary debug script.

Allowed temp path:

```text
tmp/debug-feed-pipeline.ts
```

Required output:

- discovery bucket sizes;
- first 5 affected candidates with:
  - title
  - slug/gameId
  - leagueName
  - strategy
  - resolvedGameTimeIso
  - primaryMarketRaw.question
  - outcomes
  - outcomePrices
  - clobTokenIds length
  - conditionId
  - polymarketEventSlug
  - selectedOutcome/currentPrice if available
- pair builder count for affected candidates only;
- full `buildLandingCards` result counts;
- post-allocation counts;
- cache flatten/write count if relevant.

The temp file must be deleted before final verification and must never be committed.

## 8. Product contract that must not be violated

### Unified signal contract

All feed sources must follow one contract:

```text
raw Polymarket market
→ normalized candidate
→ unified eligibility
→ unified position extraction
→ unified odds/price selection
→ unified trust metrics
→ unified Signal Confidence
→ final allocation
```

Discovery paths may differ only in how they find candidate markets. After discovery, candidates must share the same eligibility/scoring/building contract.

### No parallel semantics

Do not create separate confidence/trust logic for:

- current vs upcoming;
- WC26 vs eSport vs NBA/NHL;
- public vs premium;
- fallback vs targeted discovery.

### Category supply

If a strategic category has weak near-window supply:

- expand the future event window;
- scan more valid events/markets;
- choose another actionable market;
- do not choose absurd/extreme odds;
- do not fake a signal;
- do not use unrelated filler.

### WC26 rule

For WC26, prioritize concrete match/event markets where available. Do not use tournament-winner/champion/outright as normal feed filler when match/event markets exist.

### Odds/actionability

Normal signal cards must not show:

- `Market Watch` as position;
- `Pending` transformed into odds/profit;
- `-10000`;
- `+$1` from missing price;
- longshot or extreme price selected as fallback outside the actionable policy.

## 9. Allowed patch types after proof

Only after the loss point is proven:

- restore missing merge/allocation order;
- fix field extraction/parsing;
- unify scoring helper/call sites;
- add a shared eligibility gate;
- fix cache flatten/write only if proven;
- fix frontend matcher only if JSON contains the pair and UI count is wrong.

## 10. Forbidden "fixes"

These are NEVER acceptable as an incident fix and will be rejected at Gate:

- adding more tag slugs without a trace proving the loss point;
- hiding zero counts or hiding a filter;
- static / fake fallback cards;
- weakening the actionable odds band to accept garbage prices;
- separate confidence formulas per category/path;
- UI label patches for backend/scoring bugs;
- broad feed rewrite under P0 pressure;
- accepting tournament-winner/outright as a substitute for match-level supply;
- patching a single category path independently instead of unifying the contract.

## 11. Claude Code P0 automation prompt template

Use this prompt for every P0 feed incident.

```text
═══════════════ CLAUDE CODE TASK ═══════════════

TASK TYPE: P0 / forensic-trace-then-hotfix / feed-contract
MODEL: Opus
MODE: senior engineering teammate with bounded autonomy.
Answer in Russian. Code in English.
Do not guess.
Do not patch before proving the exact loss point.
No broad refactor.
No UI/CSS changes unless the loss point is proven to be frontend rendering.
No payment/auth/Supabase/schema changes.
No push.
No deploy.
Commit allowed ONLY after root cause is proven and Gate 1 passes.

INCIDENT:
[Describe exact production symptom with screenshots/counts/API behavior.]

BUSINESS CONTRACT:
Use one unified feed/scoring contract:
raw market → normalized candidate → eligibility → position → odds/price → trust metrics → signal confidence → allocation → cache → API → frontend.
No path-specific surrogate scoring.

PRECHECK:
Run:
  cd /d C:\WORK\KalshiProPulse\sipropicks-premvp1-1
  git branch --show-current
  git status --short
  git log --oneline -12

EXPECTED:
- branch main
- status may include only:
  ?? docs/design/
- if modified source files exist, STOP.

ALLOWED FILES TO INSPECT:
- lib/feed/buildLandingCards.ts
- lib/feed/discoverSportsMarkets.ts
- lib/feed/polymarketClient.ts
- lib/feed/types.ts
- lib/feed/landingPairs.ts
- lib/feed/cacheGeneratedSignals.ts
- scripts/generate-signals.ts
- app/api/feed/landing-cards/route.ts
- package.json only to inspect scripts

ALLOWED TEMP DEBUG:
- tmp/debug-feed-pipeline.ts
Delete before final verification. Never stage/commit it.

REQUIRED TRACE:
1. Production API cached feed.
2. External source/Gamma/API source.
3. Discovery bucket sizes.
4. Affected candidates with fields.
5. Pair builder output.
6. Scoring/metrics output.
7. Allocation output.
8. Cache flatten/write.
9. API response.
10. Frontend matcher/count if JSON contains the pair.

OUTPUT REQUIRED BEFORE PATCH:
1. Source map table.
2. Pipeline checkpoint table.
3. Exact loss point.
4. Exact root cause.
5. Patch plan limited to the loss point.

PATCH RULE:
Patch only after exact loss point is proven.
If no loss point is proven: NO PATCH.

AFTER PATCH:
Run:
  git status --short
  git diff --stat
  git diff --check
  npm run build

IF GATE 1 PASSES:
Stage only allowed changed files and commit with a narrow message.

RESPONSE FORMAT:
1. Precheck
2. Production API evidence
3. External source evidence
4. Source map table
5. Pipeline checkpoint table
6. Root cause
7. Patch implemented or NO PATCH reason
8. Files changed
9. Exact snippets
10. Verification
11. Commit hash/message/files or NO COMMIT
12. Runtime requirements
13. Remaining risks
14. Gate verdict

STOP CONDITIONS:
- branch not main
- unexpected dirty files
- loss point cannot be proven
- fix requires broad rewrite
- fix requires forbidden files
- build fails
- proposed fix fakes data or hides problem

═══════════════ END CLAUDE CODE TASK ═══════════════
```

## 12. Gate checklist before accepting any feed patch

Do not accept a feed patch unless the answer contains:

- exact root cause;
- source map table;
- checkpoint table;
- runtime API evidence;
- changed files only in allowed zones;
- `git diff --check`;
- `npm run build`;
- explicit cache/cron requirements;
- explicit “what can still fail”.

## 13. Operational rule for ChatGPT/Claude coordination

For P0 feed/data/scoring issues:

- ChatGPT must not issue patch prompt first.
- Claude Code must not patch without trace.
- Founder must not be asked to run manual CMD chains unless absolutely necessary.
- Use Opus as senior engineer, but with bounded autonomy and hard gates.
- If the issue changes production data after cron, the proof must include post-cron verification plan.
