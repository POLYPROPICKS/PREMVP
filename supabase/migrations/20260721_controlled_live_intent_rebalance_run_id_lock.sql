-- Additive. Does not modify or drop existing columns, tables, or rows.
-- MANUAL APPLICATION REQUIRED: repo has no CI/deploy migration runner. Apply via Supabase
-- SQL editor or supabase db push before the controlled live-intent route is exercised in
-- production.
--
-- This index enforces one queue row per controlled live test ID and closes
-- the cross-reservation check-then-insert race.
--
-- Normal scheduled rebalance always writes rebalance_run_id values of the form
-- `rebalance:<ISO timestamp>` (see lib/executor/nightWindow.ts buildRebalanceRunId),
-- which never match the `founder-live-order-` prefix reserved for controlled,
-- founder-authorized one-dollar live-intent test rows. The partial predicate
-- below therefore applies only to controlled rows and leaves every normal
-- rebalance_run_id completely unrestricted.
create unique index if not exists event_execution_queue_controlled_live_rebalance_run_uniq
  on public.event_execution_queue (rebalance_run_id)
  where rebalance_run_id like 'founder-live-order-%';
