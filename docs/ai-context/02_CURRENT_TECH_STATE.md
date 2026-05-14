# 02_CURRENT_TECH_STATE.md — PolyProPicks

> Last updated: 14.05.2026
> Update this file after every significant commit or state change.
> Git output beats this file — always verify with `git log --oneline -3 && git status --short`.

---

## Git state

```
Branch:         main
HEAD:           5264fd6 UI: constrain Mkt Return label width so Odds chip fits
Origin:         synced (5264fd6 = origin/main)
Working tree:   clean
```

## Recent commits (newest first)

```
5264fd6  UI: constrain Mkt Return label width so Odds chip fits
a2a661c  UI: shorten Market Return label to fit tile
9109138  UI: fix Market Return layout — correct structure under CSS absolute rules
568cc5d  Add MarketSourceCarousel inspect-only prompt for UI phase
0237661  Context sync: HEAD b3a5cb2, contour complete, UI phase logged
1a8d782  UI: replace Profit tile with Market Return in American odds format
b3a5cb2  Harden source inventory and architecture map
1b36f07  UI: add see on polymarket label to link icon
```

## Build state

```
npm run build:   PASS (inferred from commits — verify before next patch)
TypeScript:      no known errors
```

## Deployment

```
Platform:        Railway
Production URL:  https://polypropicks.com
Deploy trigger:  git push to main → auto-deploy on Railway
Last deploy:     triggered by push of af4ed5e (cron patch)
```

## Supabase state

```
Active table:    public.generated_signal_pairs
Columns added:   market_sources jsonb NULL  ← added 14.05.2026
Lead table:      public.lead_intents (unchanged)
Schema changes:  market_sources column added manually via SQL Editor
```

## Feed / cron state

```
Cron script:     scripts/generate-signals.ts
Generator:       buildLandingCards ✅ (switched from buildSportsLandingCards — af4ed5e)
Cache writer:    lib/feed/cacheGeneratedSignals.ts
marketSources:   persisted to market_sources column in generated_signal_pairs
Runtime verified: CONFIRMED ✅ — Supabase ~12:24 14.05.2026

Verified components:
  Fresh generation via buildLandingCards   ✅
  Sharp Flow in evidence stack             ✅
  Market Momentum in evidence stack        ✅
  League names (La Liga, Esports, NBA...)  ✅
  polymarketUrl in PremiumSignal           ✅
  marketSources[] in Supabase cache        ✅
  Cron on buildLandingCards                ✅
  Live matches — no futures/outrights      ✅

Sample verified pairs:
  La Liga | polymarket.com/event/lal-val-ray-2026-05-14
  La Liga | polymarket.com/event/lal-gir-rso-2026-05-14
  Esports | polymarket.com/event/lol-gx-sly-2026-05-14

Backend phase: CLOSED
Next phase:    MarketSourceCarousel evidence-stack UI
```

## API routes (known active)

```
/api/feed/landing-cards          ← production feed (cache-first)
/api/feed/debug-evidence-generation ← fresh generation bypass
/api/cron/generate-signals       ← cron trigger
```

## Enforcement contour state

```
CLAUDE.md:                           ✅ committed (39ab5aa) — repo root
AGENTS.md:                           ✅ committed (39ab5aa) — repo root
docs/ai-context/:
  TASK_ROUTING_MATRIX.md             ✅
  CLAUDE_CODE_EXECUTION_PROTOCOL.md  ✅
  VERIFICATION_GATES.md              ✅ (viewport sync 5101f64)
  OPERATOR_ACCEPTANCE_CHECKLIST.md   ✅ (5101f64)
  RULE_COMPLIANCE_MONITOR_AGENT.md   ✅ (hardened 3176a66)
  CONTEXT_HANDOFF_TEMPLATE.md        ✅ (hardened fd2f994)
  FAILURE_MODES_AND_STOP_CONDITIONS.md ✅ (hardened fd2f994)
  CHAT_STARTER_PROMPT.md             ✅ (hardened fd2f994)
  AUTOMATION_SCORECARD.md            ✅ (3176a66)
  DRIFT_MONITORING_LOG.md            ✅ (3176a66)
  03_CURRENT_SOURCE_ARCHITECTURE_MAP.md ✅ (hardened b3a5cb2)
  11_SOURCE_FILES_AND_REPO_INVENTORY.md ✅ (hardened b3a5cb2)
Phase: Phase 1 + 2 + 3 COMPLETE
```

## Known blockers / pending

```
- [x] Runtime fresh-generation verification — CONFIRMED ✅ (14.05.2026)
- [x] P0 hardening — DONE (fd2f994)
- [x] Enforcement contour backbone — DONE (39ab5aa+)
- [x] Source inventory + architecture map hardened — DONE (b3a5cb2)
- [ ] MarketSourceCarousel evidence-stack UI — next product phase
- [ ] buildSportsLandingCards.ts import graph — NOT VERIFIED (safe to delete?)
- [ ] AUTOMATION_SCORECARD first real scoring — after 3–5 tasks
```

## Environment / connectors

```
See 08_ENVIRONMENT_AND_CONNECTORS.md for full env var list.
.env.local:  present, not committed
.env:        gitignored
Railway env: set in Railway dashboard
```
