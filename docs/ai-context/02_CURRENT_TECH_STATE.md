# 02_CURRENT_TECH_STATE.md — PolyProPicks

> Last updated: 14.05.2026
> Update this file after every significant commit or state change.
> Git output beats this file — always verify with `git log --oneline -3 && git status --short`.

---

## Git state

```
Branch:         main
HEAD:           3d1028f Add chat starter prompt template
Origin:         synced (3d1028f = origin/main)
Working tree:   clean (after P0 hardening commit if applied)
```

## Recent commits (newest first)

```
3d1028f  Add chat starter prompt template
4e9308c  Add failure modes and stop conditions
5fc5d56  Add context handoff template
39ab5aa  Add enforcement contour backbone: CLAUDE.md, AGENTS.md, docs/ai-context artifacts
26fb50d  Add gitignore for debug/cache json artifacts
af4ed5e  Cron: switch to buildLandingCards, persist marketSources in cache
5423d79  Fix league: use slug prefix map as primary source
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
CLAUDE.md:                        committed (39ab5aa) — repo root
AGENTS.md:                        committed (39ab5aa) — repo root
docs/ai-context/:                 committed (39ab5aa)
  TASK_ROUTING_MATRIX.md          ✓
  CLAUDE_CODE_EXECUTION_PROTOCOL.md ✓
  VERIFICATION_GATES.md           ✓
  RULE_COMPLIANCE_MONITOR_AGENT.md ✓
  CONTEXT_HANDOFF_TEMPLATE.md     ✓
  FAILURE_MODES_AND_STOP_CONDITIONS.md ✓
  CHAT_STARTER_PROMPT.md          ✓
P0 hardening patches:             downloaded — commit pending
```

## Known blockers / pending

```
- [x] Runtime fresh-generation verification — CONFIRMED ✅ (14.05.2026)
- [ ] P0 hardening commit (CHAT_STARTER_PROMPT, CONTEXT_HANDOFF_TEMPLATE, FAILURE_MODES patches)
- [ ] MarketSourceCarousel evidence-stack UI — next product phase
- [ ] AUTOMATION_SCORECARD.md — not created yet (after 3–5 real tasks)
- [ ] DRIFT_MONITORING_LOG.md — not created yet
```

## Environment / connectors

```
See 08_ENVIRONMENT_AND_CONNECTORS.md for full env var list.
.env.local:  present, not committed
.env:        gitignored
Railway env: set in Railway dashboard
```
