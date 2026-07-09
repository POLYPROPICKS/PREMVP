# Dataset Registry — Phase 3C.2

## Purpose

This is the permanent, versioned record of which datasets/tables are suitable
sources for model audit, backtest, and strategy comparison work, and which
are display-only or execution-only. Future model/strategy work MUST cite
this registry instead of relying on memory, screenshots, or ad-hoc SQL.

Companion machine-readable file: `modeling/model_registry/dataset_registry.json`

Source evidence: Phase 3C.1 inspect report (branch
`claude/dqa-r1-baseline-verify-itidmp`, HEAD `fe6f87e`).

## Rules

1. The canonical full model-audit source is `generated_signal_pairs`. Any
   model audit, backtest, or strategy comparison that needs both a result
   field and a return/price field must read from this table (directly or via
   a documented join), not from a display or execution table.
2. `track_record_display_signals`, `track_record_shown_signal_history`, and
   `track_record_window_results`/`track_record_window_summary` are
   display/read-model layers built for the trust-block UI. They are NOT
   substitutes for `generated_signal_pairs` in model audit work, even though
   `track_record_window_results` carries resolved-looking fields
   (`signal_result`, `resolved_at`, `real_pnl_usd`).
3. `night_event_reservations`, `event_execution_queue`, and
   `executor_order_events` are execution-contour tables (Contur3 / Ireland
   live execution). They are not model audit sources and must not be used as
   a substitute for `generated_signal_pairs` in dataset quality or return
   analysis.
4. DQA-R1 (`resultFieldConsistency`), DQA-R2 (`returnFormulaConsistency`),
   and DQA-R3 (`dateModeConsistency`) must be run against the relevant
   dataset before: (a) any backtest, (b) any strategy comparison, (c) any
   live promotion decision. See `lib/modeling/datasetAudit/*.ts` and
   `modeling/sql_registry/dataset_audits/02-04_*.sql`.
5. `track_record_window_results.metric_formula_version` default is
   `realized-flat-stake-v1`. `projected_return_usd` / `projected_pnl_units` /
   `projected_win_probability` MUST NOT be used as realized results anywhere
   downstream (source: `supabase/migrations/20260702_track_record_window_results.sql`).

## Dataset Table

| Dataset | Role | Suitability | Key fields | Evidence paths | Notes / gaps |
|---|---|---|---|---|---|
| `generated_signal_pairs` | Canonical full generated/resolved model audit source | FULL | date: `created_at`, `resolved_at`; result: `signal_result`, `winning_outcome`; return/price: `entry_price_num`, `decimal_odds` (derived), `real_pnl_usd` (derived), `realized_return_pct` (when present); model/formula: `metric_formula_version`, `formula_version`, `score` | `app/api/signals/resolved/route.ts`; `supabase/migrations/20260525_signal_pairs_metric_formula_version.sql` | Source of truth for model audit and DQA. |
| `generated_signal_research_snapshots` | Broad research candidate snapshot, mostly unresolved/pre-decision | PARTIAL | `created_at`, `snapshot_at`, `score`, `coverage`, `entry_price`, `diagnostics` | `modeling/sql_registry/datasets/all_sports_research_candidates_v1.sql` | Not a direct ROI source without join/resolution against `generated_signal_pairs`. |
| `track_record_display_signals` | Current live/display-selected rows, refreshed/ephemeral | DISPLAY_ONLY | no persistent date-of-result fields; refreshed on each cycle | `supabase/migrations/20260702_track_record_window_results.sql` | Not a full model audit source; rows disappear on refresh. |
| `track_record_shown_signal_history` | Persistent shown-signal history | PARTIAL | `shown_at`, `created_at`, `updated_at`, `selected_outcome`, `stake_usd`, `display_source_model` | `supabase/migrations/20260702_track_record_window_results.sql` | Needs join to a resolved source (`generated_signal_pairs`) for the actual win/loss result. |
| `track_record_window_results` | Realized read-model/window result for trust-block/display windows | DISPLAY_ONLY / PARTIAL_DISPLAY_REALIZED (not canonical full dataset) | `resolved_at`, `signal_result`, `display_status`, `is_resolved`, `entry_price_num`, `decimal_odds`, `real_pnl_usd`, `return_label`, `metric_formula_version` (default `realized-flat-stake-v1`) | `supabase/migrations/20260702_track_record_window_results.sql` | CRITICAL RULE: `projected_return_usd` / `projected_pnl_units` / `projected_win_probability` MUST NOT be used as realized results. Not a full model audit source despite having resolved-looking fields. |
| `track_record_window_summary` | Aggregate window summary (7D/14D) | DISPLAY_ONLY | `window_days`, `status`, `resolved_unique_rows`, `wins_count`, `losses_count`, `net_pnl_usd`, `net_return_pct` | `supabase/migrations/20260702_track_record_window_results.sql` | Aggregate only, not row-level. |
| `night_event_reservations` | Frozen night plan/reservation contour | EXECUTION_ONLY | `reserved_at`, `game_start_iso`, `status`, `event_score` | `supabase/migrations/20260622_night_reservation_execution_queue.sql` | Contur3 execution-contour table, not a modeling dataset. |
| `event_execution_queue` | Per-event execution queue; Ireland reads only this table via the executor queue API | EXECUTION_ONLY | `queued_at`, `preferred_entry_iso`, `latest_entry_iso`, `status`, `stake_usd` | `supabase/migrations/20260622_night_reservation_execution_queue.sql` | Execution-contour table, not a modeling dataset. |
| `executor_order_events` | Execution/order audit ledger | EXECUTION_ONLY | `created_at`, `run_id`, `trace_id`, `status`, `reason`, `stake_usd` | `modeling/sql_registry/datasets/execution_ledger_v1.sql` | GAP: CREATE TABLE was not found in `supabase/migrations/` during Phase 3C.1 inspect — table definition source is unconfirmed. Do not assume schema beyond the fields cited in the SQL registry contract. |
