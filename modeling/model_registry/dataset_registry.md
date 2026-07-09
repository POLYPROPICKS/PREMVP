# Model_Review_Class1 Dataset Registry

## Purpose

Prevent ad-hoc SQL, display-slice misuse, date-mode confusion, duplicate-market
inflation, and inconsistent ROI/PnL when reviewing or comparing models.

## Canonical dataset

- `public.generated_signal_pairs` = PRIMARY full model-audit dataset.

## Forbidden full-model datasets

Do not use the following as a full-model audit dataset. These are
display/read-model slices and will produce incomplete or biased results:

- `public.track_record_window_results`
- `public.track_record_display_signals`
- `public.track_record_shown_signal_history`
- `public.track_record_window_summary`

## Table registry

| Table | Role |
|---|---|
| `generated_signal_pairs` | PRIMARY full candidate/resolved model audit dataset |
| `generated_signal_research_snapshots` | Research/unresolved candidate universe |
| `track_record_display_signals` | Display/read-model slice — FORBIDDEN for full-model audit |
| `track_record_shown_signal_history` | Display/read-model slice — FORBIDDEN for full-model audit |
| `track_record_window_results` | Display/read-model slice — FORBIDDEN for full-model audit |
| `track_record_window_summary` | Display/read-model slice — FORBIDDEN for full-model audit |
| `night_event_reservations` | Execution scheduling/reservation state |
| `event_execution_queue` | Execution queue state |
| `executor_order_events` | Live order ledger — realized execution audit only |

## Canonical fields for `generated_signal_pairs`

- **dates**: `created_at`, `resolved_at`
- **results**: `signal_result`, `winning_outcome`, `selected_outcome`
- **return**: `entry_price_num`, `realized_return_pct`
- **scores**: `score`, `signal_confidence_num`, `pre_event_score_num`
- **model fields**: `formula_version`, `metric_formula_version`, `source`
- **identity**: `event_slug`, `market_slug`, `condition_id`, `selected_token_id`
- **diagnostics**: `diagnostics`, `premium_signal`, `market_source`, `market_sources`

## Canonical `signal_result` domain

- lowercase `won`
- lowercase `lost`
- `null`

## Date modes

- `created_in_window` — rows generated inside the window, regardless of when they resolve (field: `created_at`)
- `resolved_in_window` — rows resolved inside the window, regardless of when they were generated (field: `resolved_at`)
- `created_then_eventually_resolved` — rows generated inside the window and later resolved; requires explicit resolution cutoff (field: `created_at`)

## Dedup modes

- `all_rows` — every resolved row counts independently
- `strict_market_token` — one row per selected token within condition (key: `condition_id::selected_token_id`)
- `one_event` — one pick per event (key: `event_slug` or `canonical_event_key`)
- `one_physical_match` — one unique sporting match equals one pick (key: `match_family_key` ladder)

## Required declaration for every future comparison

Every model comparison must explicitly declare:

1. dataset source
2. date mode
3. result field
4. dedup mode
5. stake mode
6. return formula
7. formula/model field
8. sport/league extraction method

## Blocked until controlled

- `BLUE_MODEL2_SAFE_CORE_V2`
- final PRIMARY/ALT/SHADOW/KILL selection
- live implementation prompt
