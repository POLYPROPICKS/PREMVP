# Resolver Pipeline Contract

Status: permanent production data-integrity contract.

## Why This Exists

Executed live Polymarket bets were already settled and redeemable, but matching
`generated_signal_pairs` rows stayed unresolved because the generic resolver
backlog did not prioritize real-money executed bets. That corrupted morning PnL,
resolved freezes, CEO report details, and model KPI inputs.

This contract makes the resolver order explicit. Morning datasets are not
truthful unless this resolver pipeline has run first.

## Canonical Daily Order

1. Run live-priority resolver first:

   ```bash
   npm run resolve:signals:live-priority
   ```

   Purpose: resolve executed real-money live bets before any generic backlog.
   Source: execution ledger/report artifact with `condition_id::token_id`.
   Writes only these outcome fields in `public.generated_signal_pairs`:
   `signal_result`, `resolved_at`, `winning_outcome`, `realized_return_pct`.

2. Run generic expired backlog resolver second:

   ```bash
   npm run resolve:signals:cron
   ```

   Required mode:
   `--write --only-expired --order=oldest --dedupe-strict --limit=500 --max-updates=50`

3. Build current resolved freeze and morning model report only after steps 1-2.

4. Build model KPI / CEO report only after the freeze/report input is fresh.

## Railway Command

The Railway resolver cron command must run live priority before generic backlog:

```bash
npm run resolve:signals:live-priority; npm run resolve:signals:cron
```

Do not replace this with the generic resolver alone.

Status: **to configure/verify** — no Railway cron config exists in this repo
proving the above command is actually wired into a scheduled job. Do not
treat it as already live in production until a Railway config or deploy log
confirms it.

## Track-Record Read-Model Chain (WhyTrust)

The WhyTrust trust-block read-model (`track_record_window_results` /
`track_record_window_summary`) is a separate downstream consumer of this
resolver pipeline and is not automatically fresh just because steps 1-2 above
ran. The expected daily chain must also include, in order, after step 2:

3. Priority track-record-display resolver pass:

   ```bash
   npm run resolve:signals -- --write --priority-track-record-display --dedupe-strict --limit=200 --max-updates=100
   ```

4. Track-record window read-model refresh:

   ```bash
   npm run refresh:track-record:write
   ```

Both are also available combined as `npm run track-record:daily:write`. See
`docs/operations/TRACK_RECORD_REFRESH_RUNBOOK.md` for the full data-flow,
report path, and founder-approval boundary for write execution.

Status: **to configure/verify** — as with the Railway resolver command above,
no Railway/cron config in this repo proves `track-record:daily:write` is
scheduled in production. Do not claim it is deployed until proven by a
Railway config or deploy log.

## Required Verification

After the resolver pipeline, run:

```bash
npm run verify:resolver-pipeline
```

The verification must report:

- strict resolved total;
- rows resolved in the last 24h;
- executed live rows loaded from the local execution artifact, if present;
- unresolved executed live rows;
- max `resolved_at`.

`unresolved_executed_live_rows` must be `0`, or every unresolved executed live
row must be explicitly explained before morning reporting/modeling is trusted.

## Ownership

- `scripts/resolve-signals.ts` owns resolver mechanics.
- `package.json` owns runnable command names and the command contract.
- `scripts/verify-resolver-pipeline.ts` owns read-only local verification.
- `scripts/morning-model-report.ts` depends on this pipeline having already run.

## Morning Report Dependency

`scripts/morning-model-report.ts` must not be treated as a truthful morning
dataset builder unless the resolver pipeline has completed in the same daily
cycle. XLSX files are outputs only, never source of truth.

## Failure Modes

- `LIVE_PRIORITY_LEDGER_ARTIFACT_MISSING`: no local execution ledger/report
  artifact exists for live-priority extraction.
- `RESOLVER_SELECTION_GAP`: resolvable executed/live markets are stuck behind
  generic backlog.
- `GENERIC_BACKLOG_NOT_DRAINED`: expired unresolved rows remain after the
  generic cron, requiring additional bounded batches.
- `FREEZE_STALE`: resolved freeze/report was generated before resolver pipeline.

## Operator Recovery

1. Run `npm run resolve:signals:live-priority`.
2. Run `npm run resolve:signals:cron`.
3. Run `npm run verify:resolver-pipeline`.
4. Verify exact live bets if any remain unresolved.
5. Rebuild morning reports/model freeze only after verification passes or the
   warning is explicitly accepted.
