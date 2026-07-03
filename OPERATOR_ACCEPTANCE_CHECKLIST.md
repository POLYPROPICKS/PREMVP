# OPERATOR_ACCEPTANCE_CHECKLIST.md — PolyProPicks Contur3

Operator runs these on Railway `/app` before each due window.

## 1. Canonical log first (always)

```
cd /app
npm run contur3:live-funnel-log
npm run contur3:g2-log
npm run contur3:preflight24h
```

Accept only if:
- [ ] `var/reports/contur3/live_funnel_latest.md` regenerated (fresh `generated_at`; default output dir, override with `CONTUR3_REPORT_DIR`).
- [ ] `machine_verdict` recorded.
- [ ] `hard_anomaly_count` reviewed; every P0 has a recommended command.

## 2. Reservations + rebalance (WRITE operations — labelled)

```
npm run contur3:night-reservations   # WRITES reservations
npm run contur3:event-rebalance      # WRITES queue rows when due
```
- [ ] No forbidden-market anchor selected.
- [ ] Fallback (Tier2/Tier3) only on allowed full-match anchors; logged as fallback.
- [ ] Stake/caps unchanged.

## 3. Battle readiness

```
npm run contur3:battle-ready
```
- [ ] Verdict is one of: `BATTLE_CONTOUR_READY_FOR_DUE_WINDOW`,
      `QUEUE_READY_IRELAND_MANUAL_START_REQUIRED`.

## 4. Ireland

- [ ] Follow `reports/contur3/ireland_manual_command_pack_latest.md`.
- [ ] Dry/fail-closed only. Live order placement requires explicit founder approval.
- [ ] Old `night_live_loop.py` is NOT used as production executor.

## Verdict legend

`BATTLE_CONTOUR_READY_FOR_DUE_WINDOW` · `PREMVP_FIXED_WAITING_RAILWAY_DEPLOY` ·
`RESERVATION_UNDERFILL` · `RESERVED_WAITING_FOR_DUE` · `DUE_REBALANCE_REQUIRED` ·
`QUEUE_READY_IRELAND_MANUAL_START_REQUIRED` · `ORDER_LEDGER_PRESENT` ·
`SOURCE_TO_BUILDER_BROKEN` · `STOPPED_DB_ENV_MISSING`.
