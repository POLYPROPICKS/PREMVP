# P0 Source Coverage Audit Protocol

<!-- OWNER: Operator + Claude Code -->
<!-- RELATED: P0_FEED_FORENSIC_AUTOMATION_PROTOCOL.md -->

## 1. Why this exists

The WC26 incident proved that a feed can show `0` for a strategic category while
Polymarket's official sports page is fully populated with match-level games. Our
discovery queried Gamma `tag_slug` only, which returns tournament-winner futures
and silently misses series-grouped sports games. The founder should not have to
manually open Polymarket UI every day to catch this. This audit automates the
official-source-vs-our-feed comparison.

## 2. What must be checked

For every strategic category, on each audit run:

1. Production feed category counts (`/api/feed/landing-cards`).
2. Official Polymarket sports page reachability + populated markers.
3. Signal-quality hazards in production JSON (Market Watch / Pending / -10000 / +$1).
4. Drift: official page populated but our feed count = 0.

## 3. Strategic category matrix

| Category | Feed matcher | Official Polymarket source |
|---|---|---|
| WC26 | world cup / wc26 / fifa | `polymarket.com/sports/fifa-world-cup/games` |
| NBA | nba / basketball | `polymarket.com/sports/nba/games` |
| NHL | nhl / hockey | `polymarket.com/sports/nhl/games` |
| eSport | esport / cs2 / dota / valorant / lol | `polymarket.com/esports` |

## 4. Official source vs Gamma source rule

**Gamma `public-search` and `tag_slug` are NOT sufficient** for Polymarket sports
categories. Sports match games are grouped by **series** (`series_id` /
`series_slug`, e.g. `soccer-fifwc` id 11433), not by tag. Tag queries return only
futures/outright markets.

- Primary source of truth = official Polymarket sports page + the series endpoint
  that backs it (`gamma-api.polymarket.com/events?series_id=<id>`).
- Gamma tag/public-search = secondary only.
- Any new strategic category must have its **series-backed** source identified
  before discovery is wired.

## 5. Failure conditions (P0)

The audit reports `FAIL` (exit 1) when any of:

- Official sports page for a strategic category looks populated, but our feed
  count for that category = 0.
- Production JSON contains `Position: Market Watch`, `profit: Pending`,
  `Odds -10000`, or `+$1` fake-payout hazards.
- Production feed endpoint is unreachable or non-JSON.

`WARN` = non-P0 alerts only. `PASS` = no alerts.

## 6. How to run manually

```
npm run audit:sports-sources
```

Read-only. No secrets, no DB writes, no file mutation. Exit 0 = PASS/WARN,
exit 1 = FAIL/P0.

## 7. How to wire to Railway cron later

Add a Railway scheduled job (separate service or cron) running:
```
npm run audit:sports-sources
```
Recommended cadence: every 6–12h. Pipe non-zero exit to an alert channel.
Do NOT block feed generation on the audit — it is monitoring, not a gate.

## 8. Alert policy

- `FAIL` → treat as P0 incident: open `P0_FEED_FORENSIC_AUTOMATION_PROTOCOL.md`
  and run the full forensic trace before any patch.
- `WARN` → log and review within 24h.
- `PASS` → no action.

## 9. What NOT to do

- Do not "fix" a FAIL by hiding the category or faking counts.
- Do not weaken the matcher to make counts look non-zero.
- Do not patch feed logic directly from the audit output — the audit only
  detects drift; the forensic protocol governs the fix.
- Do not add secrets or DB access to the audit script.

## 10. Relationship to P0 feed forensic protocol

This audit is the **detection** layer. `P0_FEED_FORENSIC_AUTOMATION_PROTOCOL.md`
is the **diagnosis + patch** layer. Audit FAIL triggers the forensic protocol;
the forensic protocol still requires a full trace table before any code change.
No trace table = no patch.
