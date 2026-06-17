# One-Per-Match Backtest Runbook

## Purpose

The One-Per-Match Backtest answers a deployment-shape question:

> What would ROI, PnL, winrate, and max drawdown have been if the private/battle server selected only one bet per underlying match/event?

This is a retrospective reporting module. It does not change live execution, public product formulas, or Ireland server behavior.

## Data Source

Primary source:

- `generated_signal_pairs`

Resolved rows are included when they have:

- `signal_result`
- `condition_id`
- `selected_token_id`

Rows are strict-deduped by:

```text
condition_id::selected_token_id
```

## Event Grouping Logic

The event group key is selected in priority order:

1. `match_family_key` when present and not weak
2. `canonical_event_key`
3. `parent_event_key`
4. `event_slug` / `event_key`
5. normalized event title
6. normalized market slug
7. condition fallback

The report logs group-key coverage and top duplicate groups. If fallback keys are used, the result is marked as lower-confidence grouping.

## Selection Logic

Policy name:

```text
ONE_PER_MATCH_EX_ANTE_V1
```

For each event group, the selected row is chosen using ex-ante fields only:

1. live/trade eligible first when available
2. stronger tier: TIER1 > TIER2 > TIER3 > unknown
3. higher model score
4. higher coverage
5. higher smart-money / edge proxy when available
6. reasonable entry-price band
7. earliest created_at
8. stable signal_id lexical tie-breaker

The selector never uses:

- realized outcome
- win/loss
- realized return
- final PnL

## Outputs

Local artifacts:

- `reports/modeling/one_per_match_backtest/latest_summary.json`
- `reports/modeling/one_per_match_backtest/latest_selected_picks.csv`
- `reports/modeling/one_per_match_backtest/latest_event_groups.csv`
- `reports/modeling/one_per_match_backtest/latest_comparison.csv`

Database migration artifact:

- `supabase/migrations/20260618_model_one_per_match_backtest.sql`

Tables:

- `model_one_per_match_backtest_runs`
- `model_one_per_match_backtest_picks`

If tables are not applied yet, the script still writes local artifacts.

## Manual Run

```bash
npm run modeling:one-per-match-backtest
```

## Morning Report Integration

The morning model report runs the backtest automatically and appends a workbook sheet:

```text
OnePerMatchBacktest
```

The morning email body includes a concise one-per-match summary:

- raw resolved picks
- selected one-per-event bets
- baseline ROI/PnL
- one-per-match ROI/PnL
- max drawdown delta
- interpretation

## Limitations

- Retrospective result only.
- Grouping key may be imperfect when event metadata is missing.
- Not proof of live execution profitability.
- Does not promote or change any live model.
- Public product formula remains frozen.
- Costs are flat/gross unless an existing project fee model is explicitly wired in.

## Next Steps

- Apply the Supabase migration if DB persistence is required in production.
- Review `groupKeyCoverage` and duplicate group examples after each run.
- Compare one-per-match economics over future resolved corpora before changing live policy.
