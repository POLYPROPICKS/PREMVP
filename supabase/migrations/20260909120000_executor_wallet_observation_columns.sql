-- PREMVP_APPLICATION_MIGRATION_V1
-- EXECUTOR_WALLET_STATE_V1 — promote the Ireland/Polymarket trading-wallet
-- observation carried by accepted order callbacks from opaque raw_event_json
-- JSON into structured, queryable columns on public.executor_order_events.
--
-- Additive-only. Every statement is `add column if not exists` /
-- `create index if not exists` and is a safe no-op if already applied. No
-- existing column or row is removed, renamed, rewritten, or re-typed.
--
-- MANUAL APPLICATION REQUIRED — this repo has no CI/deploy migration runner.
-- NOT APPLIED as part of the commit that introduced this file. Apply only via
-- the registered PREMVP approved-migration path after Founder review.
--
-- Column semantics (canonical consumer contract:
-- lib/executor/executorWalletState.ts):
--   spendable_balance_usd   — authoritative available trading cash. The
--                             latest valid value by wallet_observed_at is
--                             CURRENT_SPENDABLE_BALANCE_USD.
--   collateral_balance_usd  — Polymarket collateral balance; audit /
--                             reconciliation only.
--   allowance_usd           — contract spend allowance / readiness evidence.
--                             Never bankroll; never stake capital.
--   wallet_observed_at      — instant the executor read the wallet. Wallet
--                             freshness / ordering authority is derived from
--                             THIS, never from created_at.
--   wallet_observation_lifecycle_point — PRE_SUBMIT | POST_SUBMIT |
--                             CURRENT_SNAPSHOT | UNKNOWN.
--
-- raw_event_json continues to hold the full sanitised callback payload, so
-- forensic lineage of every wallet observation is preserved unchanged.

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

-- Fast "latest valid spendable balance by observation time" lookup. Partial:
-- only rows that actually carry a usable spendable observation are indexed,
-- so legacy rows and wallet-less callbacks add no index weight.
create index if not exists executor_order_events_wallet_observed_at_idx
  on public.executor_order_events (wallet_observed_at desc)
  where wallet_observed_at is not null and spendable_balance_usd is not null;
