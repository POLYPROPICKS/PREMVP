# 09_CONTEXT_DELTA_LOG.md — PolyProPicks

> This file logs significant changes since the initial context snapshot.
> Add an entry after every significant commit, schema change, or decision.
> Newest entries at top.

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
