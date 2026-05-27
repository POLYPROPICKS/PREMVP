# /daily-ops-report-plan — PolyProPicks Daily GMT+3 Ops Report

## Status
**PLANNED — NOT YET IMPLEMENTED**
Date planned: 2026-05-28
Priority: Must be implemented before audience onboarding begins.

## Purpose
Automated daily morning report (target: 08:00 GMT+3) that gives the founder a clear operational health snapshot without requiring manual CMD investigation.

## Delivery target
- **Phase 1 (minimal):** Script run manually or via Railway cron, output saved as markdown artifact or logged to console
- **Phase 2:** Email via Resend API to founder@polypropicks.com
- **Phase 3:** Slack/Discord webhook or admin dashboard widget

## Report scope

### A. Production deploy check
| Field | Source |
|-------|--------|
| Latest deployed commit | Railway PREMVP deploy log or git tag |
| Deploy timestamp | Railway API or webhook log |
| Build status | Railway service status |

### B. Cron health
| Field | Source |
|-------|--------|
| `signal-cache-cron` last run | Supabase `cron_log` table or Railway log |
| `signal-resolve-cron` last run | Same |
| Both crons ran within expected window? | Yes/No + last timestamp |

### C. Feed freshness
| Field | Source |
|-------|--------|
| Feed `generatedAt` timestamp | `/api/feed/landing-cards` response |
| Feed `cacheStatus` | Same |
| Total pair count | Same |
| Pairs per filter (live/nba/nhl/esport/wc2026) | Computed from pairs |
| Shark Flow cards in feed | Count of type=sharp-flow sources |

### D. Resolved predictions — last 24h / 48h / 72h
| Field | Source |
|-------|--------|
| Total resolved | `/api/signals/resolved` or Supabase direct |
| Won / Lost / Push / Refund | Split by outcome |
| Win rate % | won / (won+lost) |
| Confidence ≥70 subset: Won / Lost / Win rate | Filter by confidence field |
| Avg confidence of resolved set | Mean(confidence) |

### E. Sport/filter split (if data available)
| Sport | Resolved | Won | Win% |
|-------|----------|-----|------|
| MLB | | | |
| NHL | | | |
| NBA/WNBA | | | |
| Soccer/WC26 | | | |
| eSport | | | |

### F. Unresolved backlog
| Field | Source |
|-------|--------|
| Total unresolved signals | Supabase count |
| Oldest unresolved created_at | Supabase query |
| Resolver health | Last resolve-cron attempt + outcome count |

### G. Action items
Auto-generated bullet list:
- ❌ If no cron ran in 8h: "signal-cache-cron stale — check Railway"
- ❌ If win rate <40% over 24h: "Win rate below threshold — review resolver"
- ❌ If feed has 0 pairs: "Feed empty — check cache-cron and landing-cards API"
- ✅ If all green: "All systems nominal"

## Output format
```markdown
# PolyProPicks Daily Ops Report — 2026-05-28 08:00 GMT+3

## Deploy
| Commit | fe5e0de | Deployed | 2026-05-27 21:14 UTC |

## Cron Health
| Service | Last Run | Window OK? |
| signal-cache-cron | 2026-05-28 07:30 UTC | ✅ |
| signal-resolve-cron | 2026-05-28 06:00 UTC | ✅ |

## Feed
| Pairs total | 8 | Cache age | 12 min |

## Resolved 24h
| Won | Lost | Win% | Conf≥70 Win% |
| 5 | 2 | 71.4% | 80% |

## Action Items
✅ All systems nominal
```

## Implementation plan (future Claude Code task)

1. Create `scripts/ops/daily-report.ts` (TypeScript, Node-compatible)
2. Imports: Supabase client, fetch for `/api/feed/landing-cards` and `/api/signals/resolved`
3. Accepts `--date` flag (default: today GMT+3)
4. Outputs markdown to stdout (can be piped to file or Resend)
5. Add `npm run ops:report` to package.json scripts
6. Optional: schedule via Railway cron `0 5 * * *` (UTC = 08:00 GMT+3)
7. Optional: add Resend email delivery for founder

## DO NOT implement until
- Founder gives explicit task authorization
- Daily ops report task is created with EXACT TASKS format
- Supabase table structure for cron_log is confirmed or designed
- Resend API key exists in Railway env if email delivery needed
