# WINDSURF_WORKFLOW_RULES.md — PolyProPicks (Cascade / Windsurf)

## CONTUR3 24H LOG-FIRST RULE

Cascade/Windsurf must start every Contur3 / night-reservation / event-rebalance /
Ireland investigation by reading or running the canonical live funnel log:

- Read `reports/contur3/live_funnel_latest.md` (+ `.json`).
- If missing or older than 30 minutes during an active battle window:
  `npm run contur3:live-funnel-log`.
- If the log does not exist, fixing the logging layer is **P0** before diagnosis.

No readiness claim without referencing: latest log path, `generated_at`,
`machine_verdict`, `hard_anomaly_count`, next due (Minsk), queue count, Ireland
status.

## Single source of funnel truth

`scripts/contur3/lib/contur3LiveFunnelMonitor.mjs` owns normalization, market
classification, pagination, schema, anomaly codes and verdicts. Do not fork these
definitions into one-off scripts.

## Safety

- READ-ONLY diagnostics never place orders, never write the queue.
- Forbidden markets (halftime/1H/2H, corners, exact score, goalscorer, props,
  futures/outrights) can never be executable anchors.
- Ireland validates/executes only; PREMVP decides pool/tiers/fallback/stake.
