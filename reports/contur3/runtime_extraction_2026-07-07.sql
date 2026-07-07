-- READ-ONLY extraction queries for 2026-07-07 Contur3 runtime audit.
-- Run in Supabase SQL editor (read-only role) or via `psql` with a read-only connection.
-- No writes/mutations. Safe to run against production as SELECT-only.

-- 1) All night_event_reservations for plan_date_minsk 2026-07-07 (covers overnight July 8 window too,
--    since the 2026-07-07 plan run covers the night of 7->8 July Minsk).
select
  id, plan_run_id, plan_date_minsk, reserved_at, window_start_iso, window_end_iso,
  match_family_key, event_slug, event_title, sport, league, strategic_scope,
  game_start_iso, event_tier, event_score, reservation_rank, status,
  selection_reason, created_at, updated_at
from public.night_event_reservations
where plan_date_minsk = '2026-07-07'
order by reservation_rank asc;

-- 2) Unique event count for that plan date
select count(distinct match_family_key) as unique_events
from public.night_event_reservations
where plan_date_minsk = '2026-07-07';

-- 3) All event_execution_queue rows created July 7 (UTC calendar day covering Minsk evening)
select
  id, reservation_id, plan_run_id, rebalance_run_id, queued_at,
  match_family_key, event_slug, event_title, sport, league, game_start_iso,
  condition_id, token_id, side, market_slug, market_title, market_family,
  score, coverage, tier, stake_usd,
  diagnostics->>'max_entry_price' as max_entry_price,
  preferred_entry_iso, latest_entry_iso, selection_rank, selection_reason,
  status, order_key, idempotency_key, created_at, updated_at
from public.event_execution_queue
where created_at >= '2026-07-07T00:00:00Z' and created_at < '2026-07-09T00:00:00Z'
order by created_at asc;

-- 4) Argentina/Egypt specific rows (reservations)
select id, plan_run_id, match_family_key, event_slug, event_title, status,
       game_start_iso, created_at, updated_at
from public.night_event_reservations
where (event_title ilike '%argentina%egypt%' or event_title ilike '%egypt%argentina%'
       or match_family_key ilike '%argentina%egypt%' or match_family_key ilike '%egypt%argentina%'
       or event_slug ilike '%argentina%egypt%' or event_slug ilike '%egypt%argentina%');

-- 5) Argentina/Egypt specific rows (queue)
select id, reservation_id, idempotency_key, event_slug, market_slug, side,
       stake_usd, diagnostics->>'max_entry_price' as max_entry_price,
       status, latest_entry_iso, created_at, updated_at
from public.event_execution_queue
where (event_title ilike '%argentina%egypt%' or event_title ilike '%egypt%argentina%'
       or match_family_key ilike '%argentina%egypt%' or match_family_key ilike '%egypt%argentina%'
       or event_slug ilike '%argentina%egypt%' or event_slug ilike '%egypt%argentina%');

-- 6) executor_order_events for the same idempotency_keys found in query (5) above
--    Replace :idem_keys with the actual array returned by query 5, e.g. ('abc123','def456')
select created_at, event_type, source, market_slug, selected_side, side, token_id,
       order_status, success, dry_run, live_confirm, stake_usd, submitted_size,
       submitted_price, fee_usd, slippage_usd, cost_model_version, fee_notes,
       clob_order_id, transaction_hashes, error_message
from public.executor_order_events
where raw_event_json->>'idempotency_key' in (/* :idem_keys from query 5 */)
order by created_at asc;

-- 7) Missed-window reservations (status stayed RESERVED/REBALANCE_PENDING past latest window)
select id, match_family_key, event_title, status, window_end_iso, game_start_iso
from public.night_event_reservations
where plan_date_minsk = '2026-07-07' and status in ('RESERVED', 'REBALANCE_PENDING')
  and window_end_iso < now();
