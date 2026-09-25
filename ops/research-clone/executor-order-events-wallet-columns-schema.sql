-- RESEARCH CLONE ONLY. Never apply through the production migration lifecycle.
-- Target project ref: nppznoujvnyjargjkmnv.
--
-- Repairs the research-clone-daily-sync executor_order_events write failure
-- (RESEARCH_CLONE_TARGET_WRITE_executor_order_events): production added five
-- wallet-observation columns to public.executor_order_events via
-- supabase/migrations/20260910120000_executor_wallet_observation_columns.sql,
-- but the research clone's executor_order_events (created by
-- supabase/migrations/20260719_executor_order_events_schema_and_idempotency.sql)
-- never received the same additive columns, so every upsert of a current
-- production row (which carries these columns) into the clone fails.
--
-- This file mirrors that production migration exactly, additive-only, against
-- the clone's existing executor_order_events table. No column or row is
-- dropped, renamed, rewritten, or re-typed. scripts/research-clone-daily-sync.ts
-- already reads/writes executor_order_events with select("*")/upsert(...), so
-- no application code change is required once this schema is applied -- the
-- clone table becomes column-compatible with the current production row shape.

alter table public.executor_order_events
  add column if not exists spendable_balance_usd numeric;

alter table public.executor_order_events
  add column if not exists collateral_balance_usd numeric;

alter table public.executor_order_events
  add column if not exists allowance_usd numeric;

alter table public.executor_order_events
  add column if not exists wallet_observed_at timestamptz;

alter table public.executor_order_events
  add column if not exists wallet_observation_lifecycle_point text;

create index if not exists executor_order_events_wallet_observed_at_idx
  on public.executor_order_events (wallet_observed_at desc)
  where wallet_observed_at is not null and spendable_balance_usd is not null;
