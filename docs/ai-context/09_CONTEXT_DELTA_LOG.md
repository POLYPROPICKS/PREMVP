# 09_CONTEXT_DELTA_LOG.md — PolyProPicks

> This file logs significant changes since the initial context snapshot.
> Add an entry after every significant commit, schema change, or decision.
> Newest entries at top.

---

## ✅ M3-C DIRECTIONAL TOKEN MATCH FIX — 2026-06-13

**Scope:** research-only shadow diagnostics. Public formula, scoring, ranking — не изменены.

**Root cause:** Polymarket Data API trades payload возвращает id токена в поле `asset` (decimal-string), а блок M3-C читал `t.tokenId` → все exact-token matches были 0.

**Fix (2 файла):**
- `lib/feed/types.ts` — добавлен `asset?: string` в `PolymarketTrade`
- `lib/feed/buildLandingCards.ts` — M3-C exact-match фильтры переключены на `String(t.asset ?? t.tokenId ?? "").trim()`

**Что НЕ изменено:**
- Legacy aggregate фильтры (`selectedTradeCount`, `totalTradeCount`, `recentTradeCash`, `maxTradeCash`)
- `formulaVersion: trusted-initial-formula-v1.1`
- DB-схема, миграции, публичный scoring-путь

**Старые строки** в research DB не backfill-ятся (fix работает только для свежих cron-прогонов).

**Требуется:** FRESH_CRON_RUNTIME_PROOF — убедиться что `directionalFlowCoverageRatio` > 0 и `directionalFlowTokenMatchedCount` > 0 в следующем снимке.

**Exit observer / trajectory SQL:** в backlog, отдельное решение фаундера.

---

## ✅ TOP PROOF ROLLOUT COMPLETE — 2026-05-28

**HEAD:** `fe5e0de` (main, clean)

### Recent commits captured
```
fe5e0de  Repo: ignore local portrait source artifacts (.gitignore hygiene)
cca288e  Landing: improve Shark Flow portrait diversity (source.id prefix inference)
a7c73b3  Landing: add Shark Flow portrait medallions (portrait assets + CSS + picker)
3426055  Landing: unify top proof cards (cyan color language, shark headline)
5341ce0  Landing: add weekly proof card to top carousel
870f0fb  Paywall: show seven-result proof strip
c65dfba  Resolver: process newest signals first
8f2000f  Resolver: allow larger fresh scan window
```

### Feature state now in production
- **Top carousel** (max 3 slots): Shark Flow evidence card × N + Weekly Resolved Proof card (always last). Market Momentum merged into shark secondary line, not standalone card.
- **Shark Flow portrait medallion:** circular, clamp(78–90px), cyan glow/border, deterministic picker using `hashString`, sport-specific pool + multi fallback.
- **Portrait picker:** source.id prefix inference (nhl-…→nhl, wnba-…→nba, mlb-…→multi); aliases: mlb→multi, wnba→nba, mls→soccer, ncaaf→nfl, ncaab→nba; pool de-duplicated via Set; seed extended with eventTitle.
- **Portrait assets:** 24 normalized 512×512 WebP in `public/market-source-portraits/normalized/` (esport×3, multi×6, nba×2, nfl×4, nhl×2, soccer×7). Rejected: nba-03, multi-02 in quarantine. manifest.json at `public/market-source-portraits/manifest.json`.
- **Portrait diversity result:** 5 unique faces across 8 production pairs (was 2–3 before fix).
- **Weekly proof card:** real resolved data from `/api/signals/resolved`, `SignalWeekResultsCard` `top-carousel` variant, cyan color family.
- **Cron services (Railway):** `signal-resolve-cron` every 6h UTC (`0 */6 * * *`), `signal-cache-cron` every ~30 min.
- **Resolver:** processes newest signals first, wider scan window (8f2000f).

### UI accepted state (do NOT redesign unless P0 regression)
- Shark portrait medallion layout: `.sharkSourceCard` CSS class, `position:relative` on card, avatar/copy absolute relative to full card, pills absolute top-right.
- Weekly proof: large `tcReturn` + `tcReturnLabel` row, cyan pill family, chips row. Do NOT change again without founder request.
- Card height stable at `clamp(106px, 27.1vw, 124px)`.

### Next operational priority
**Daily morning GMT+3 automated ops report** — see `.claude/commands/daily-ops-report-plan.md` for spec. NOT yet implemented. Must precede audience onboarding.

### Hygiene
- `.gitignore` now ignores: raw portraits, rejected normalized, preview docs, normalize script.
- `docs/design/` remains intentionally untracked (local design reference only).

---

## ✅ WORKFLOW DECISION — 2026-05-21

**Decision:** Claude-Code Autopilot Operator Mode adopted.
**Reason:** Reduce founder CMD burden and speed execution while preserving Gate 2 for UI/visual tasks.
**Rule:** Non-visual tasks (backend/data/docs) — Claude Code may patch + verify + commit when prompt includes explicit authorization and Gate 1 passes. UI/visual tasks still require founder Gate 2 acceptance before commit. Push always requires explicit founder authorization.
**Docs updated:** CLAUDE.md §10, TASK_ROUTING_MATRIX.md §7, CLAUDE_CODE_EXECUTION_PROTOCOL.md Autopilot section, VERIFICATION_GATES.md Gate 3, OPERATOR_ACCEPTANCE_CHECKLIST.md Founder role.

---

## ✅ CURRENT STATE OVERRIDE — 2026-05-15

```
Branch:         main
HEAD:           1d254cc Score: selectedOdds banded confidence and anchored trust metrics
Origin:         synced
Working tree:   clean
```

### Recent commits (newest first)
```
1d254cc  Score: selectedOdds banded confidence and anchored trust metrics
8cabbb6  Score: opp-odds confidence cap, min threshold 52, delta multiplier 0.03
a24fbc4  Feed: two-stage odds selection 1.7x-3x primary, 1.35x-5x fallback, 72h window
c87d03c  Score: Gamma-only direct formula 35+prob*0.65, full range 35-97
ab85fd2  Context sync: HEAD 5264fd6, drift lesson #1 logged, filterTags bug noted
5264fd6  UI: constrain Mkt Return label width so Odds chip fits
a2a661c  UI: shorten Market Return label to fit tile
9109138  UI: fix Market Return layout — correct structure under CSS absolute rules
```

### Product / roadmap state
- Active gate: Decision Card visual acceptance
- Signal Confidence scoring rebuild (banded selectedOdds formula) is on main ✅
- Market Return / American odds is on main but NOT visually accepted
- Current blocker: "Odds +160" chip/label visually collides inside the Market Return tile
- Next safe patch: `app/reconstruction/page.tsx` only — simplify/remove Odds chip inside profitCol
- After visual acceptance: inspect/fix filterTags / one-card-across-filters issue
- MarketSourceCarousel evidence-stack UI: ON HOLD until Decision Card + filter sanity accepted
- Whop readiness: ON HOLD until card/feed/evidence sanity accepted

---

## ✅ CURRENT TRUTH SUMMARY (14.05.2026 ~latest) — HISTORICAL / SUPERSEDED BY CURRENT STATE OVERRIDE ABOVE

```
Backend phase:       CLOSED ✅
UI phase:            IN PROGRESS — Market Return tile + Polymarket link shipped
Enforcement contour: COMPLETE — Phase 1+2+3 done
Git HEAD:            5264fd6
Origin:              synced
Working tree:        clean
Next:                filterTags bug (one card on all filters) + MarketSourceCarousel
```

---

## Delta entry — 14.05.2026 (Market Return UI + drift lesson #1)

### UI commits — Market Return tile
```
1a8d782  UI: replace Profit tile with Market Return in American odds format
9109138  UI: fix Market Return layout — correct structure under CSS absolute rules  ← regression fix
a2a661c  UI: shorten Market Return label to fit tile
5264fd6  UI: constrain Mkt Return label width so Odds chip fits
```

### Drift lesson #1 — CSS regression
```
Cause:   Patch 1a8d782 added flex-div as first child — conflicted with CSS :first-child absolute rule
Missed:  inspect-only before CSS structure change was skipped
Fixed:   9109138
Lesson:  CSS structure changes MUST inspect active :first-child / :last-child rules before patching
Log entry: see DRIFT_MONITORING_LOG.md
```

### Known open bug
```
filterTags not distinguishing signals — one card shown on all filters
Root cause: selection logic returns same pair regardless of filter
Status: deferred until after design/carousel phase
```

### Pending
```
- [ ] filterTags bug fix
- [ ] MarketSourceCarousel evidence-stack UI (inspect-only first)
- [ ] buildSportsLandingCards.ts import graph check
- [ ] AUTOMATION_SCORECARD first scoring run
```

---

### Enforcement contour — FULLY COMMITTED ✅

All backbone artifacts committed and pushed. Phase 1+2+3 complete:
```
AUTOMATION_SCORECARD.md              3176a66
DRIFT_MONITORING_LOG.md              3176a66
VERIFICATION_GATES.md (hardened)     5101f64
OPERATOR_ACCEPTANCE_CHECKLIST.md     5101f64
CHAT_STARTER_PROMPT.md (hardened)    fd2f994
CONTEXT_HANDOFF_TEMPLATE.md (hardened) fd2f994
FAILURE_MODES_AND_STOP_CONDITIONS.md fd2f994
03_CURRENT_SOURCE_ARCHITECTURE_MAP.md (hardened) b3a5cb2
11_SOURCE_FILES_AND_REPO_INVENTORY.md (hardened) b3a5cb2
```

### UI phase — IN PROGRESS

```
eb52988  UI: add subtle Polymarket link icon in signal confidence card
a7c444e  UI: improve Polymarket link icon — green tint, larger hit area
1b36f07  UI: add see on polymarket label to link icon
```

Files modified: `app/reconstruction/page.tsx`, `Reconstruction.module.css`
Backup files created: 4× `.tsx` + 4× `.css` in `app/reconstruction/`

### League fix
```
00c5cfa  Fix league: use leagueName from discovery sample, not hardcoded sports
```

### gitignore updates
```
Added: *.txt patterns (recon-css.txt, recon-full.txt debug dumps)
```

### Pending
```
- [ ] MarketSourceCarousel evidence-stack UI — next product phase (inspect-only first)
- [ ] buildSportsLandingCards.ts import graph — NOT VERIFIED
- [ ] AUTOMATION_SCORECARD first real scoring — after 3–5 tasks through contour
```

---

## Delta entry — 14.05.2026 (backend phase CLOSED)

### Runtime verification — CONFIRMED ✓

Fresh cron run verified in Supabase at ~12:24:

| Component | Status |
|---|---|
| Fresh generation via buildLandingCards | ✅ |
| Sharp Flow in evidence stack | ✅ |
| Market Momentum in evidence stack | ✅ |
| League names (La Liga, Esports, NBA...) | ✅ |
| polymarketUrl in PremiumSignal | ✅ |
| marketSources[] in Supabase cache | ✅ |
| Cron on buildLandingCards | ✅ |
| Live matches (no futures/outrights) | ✅ |

Sample verified pairs:
```
La Liga  | https://polymarket.com/event/lal-val-ray-2026-05-14
La Liga  | https://polymarket.com/event/lal-gir-rso-2026-05-14
Esports  | https://polymarket.com/event/lol-gx-sly-2026-05-14
```

### Backend phase status: CLOSED

Next phase: MarketSourceCarousel evidence-stack UI
(per AUTOMATION_MODE_HANDOFF.md — inspect-only first in new Windsurf/Claude Code session)

---

## Delta entry — 14.05.2026

### Git commits added

```
3d1028f  Add chat starter prompt template
4e9308c  Add failure modes and stop conditions
5fc5d56  Add context handoff template
39ab5aa  Add enforcement contour backbone
26fb50d  Add gitignore for debug/cache json artifacts
af4ed5e  Cron: switch to buildLandingCards, persist marketSources in cache
5423d79  Fix league: use slug prefix map as primary source
8ba44a4  Fix league detection, add esports, add eventImage from Gamma API
```

### Enforcement contour — ADDED

New backbone artifacts committed to repo:

| File | Location | Purpose |
|---|---|---|
| `CLAUDE.md` | repo root | Primary agent entrypoint — always read first |
| `AGENTS.md` | repo root | Full agent constitution — roles, forbidden behaviors, product rules |
| `TASK_ROUTING_MATRIX.md` | docs/ai-context/ | Executor routing — CMD / Claude Code / Founder |
| `CLAUDE_CODE_EXECUTION_PROTOCOL.md` | docs/ai-context/ | Execution template + required response format |
| `VERIFICATION_GATES.md` | docs/ai-context/ | Binary gates: Gate 0–4 + Gate D + Gate 1A |
| `RULE_COMPLIANCE_MONITOR_AGENT.md` | docs/ai-context/ | Compliance audit prompt + scoring |
| `CONTEXT_HANDOFF_TEMPLATE.md` | docs/ai-context/ | Chat-to-chat state transfer template |
| `FAILURE_MODES_AND_STOP_CONDITIONS.md` | docs/ai-context/ | 25 stop conditions + recovery paths |
| `CHAT_STARTER_PROMPT.md` | docs/ai-context/ | Activation prompt for every new Claude session |

### Feed / cron changes

- `scripts/generate-signals.ts` — switched from `buildSportsLandingCards` to `buildLandingCards`
- `lib/feed/cacheGeneratedSignals.ts` — added `marketSources` field to `WritePairsInput` and insert
- Supabase: `market_sources jsonb NULL` column added to `public.generated_signal_pairs`

### Gitignore updated

Added patterns: `*.json`, `normalize-dump.txt` — covers debug/cache artifacts in repo root.

### Pending as of 14.05.2026

```
- [ ] Runtime verification: fresh generation via buildLandingCards not yet confirmed
- [ ] P0 hardening patches pending commit (CHAT_STARTER_PROMPT, CONTEXT_HANDOFF_TEMPLATE, FAILURE_MODES)
- [ ] AUTOMATION_SCORECARD.md — deferred until 3–5 real tasks completed
- [ ] DRIFT_MONITORING_LOG.md — deferred
- [ ] MarketSourceCarousel evidence-stack UI — next product task (per AUTOMATION_MODE_HANDOFF.md)
```

---

## Delta entry — 13.05.2026

### Files added to docs/ai-context/

Initial context file set committed:
`01` through `12` — project context, tech state, architecture map, product decisions,
workflow rules, lessons, migration context, environment, delta log, design system,
source inventory, startup protocol.

### Enforcement contour

Not yet created at this date. `WINDSURF_WORKFLOW_RULES.md` was the active workflow doc.
Superseded by backbone artifacts added 14.05.2026.

---

## Delta entry — 10.05.2026 (baseline snapshot)

```
Branch:   main
HEAD:     (pre-league-fix commits)
Build:    PASS
Deploy:   Railway production live at https://polypropicks.com
Feed:     buildSportsLandingCards (now superseded)
Supabase: public.generated_signal_pairs — no market_sources column yet
```

Context files created: 01–09 initial versions.

---

## How to add a new entry

When something significant changes, prepend:

```
## Delta entry — [DATE]

### [Category]
[what changed — be specific: commit hash, file, decision, schema]

### Pending
- [ ] [what is not yet verified or complete]
```

## Delta entry - 2026-06-22

### Contur2 preservation
Preserved the Contur2 producer deployment and Ireland V4 audit state in docs:
`10a2013 Executor: add night plan contract v1 envelope` deployed and runtime-verified, consumer rejector audited as present, hard-stop and no-live checks confirmed, live remains blocked pending CEO approval.

### Pending
- [ ] CEO one-order pilot checklist only
