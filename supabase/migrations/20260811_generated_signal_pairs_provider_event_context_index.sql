-- Fix: the rebalance-time exact-provider-event sibling lookup in
-- lib/executor/eventExecutionQueue.ts (loadFinalIdentitySourceRows) failed
-- production with EXACT_PROVIDER_EVENT_QUERY_FAILED_57014 (Postgres
-- "canceling statement due to statement timeout") for all 15 natural
-- 2026-08-10 Reservations, 15/15, blocking every one before Queue creation.
--
-- Root cause: the query used
--   .contains("diagnostics", { providerEventContext: { v, provider, eventId, eventStartIso } })
-- a JSONB containment predicate (`diagnostics @> {...}`) against
-- public.generated_signal_pairs with no supporting index on diagnostics.
-- Postgres has no way to serve this except a full sequential scan
-- evaluating the containment check row-by-row. This table has already
-- proven, twice (idx_gsp_shadow_dedup 2026-08-05, idx_gsp_pending_resolution
-- 2026-07-02), that an unindexed predicate over its full row count exceeds
-- the statement timeout before returning.
--
-- Fix: an expression index on the two fields that actually identify the
-- authoritative exact-provider-event sibling set (provider_event_id and its
-- authoritative event start), scoped to the v1/polymarket identity shape,
-- mirroring the corresponding code change from `.contains(...)` to bounded
-- `.eq("diagnostics->providerEventContext->>eventId", ...)` /
-- `.eq("diagnostics->providerEventContext->>eventStartIso", ...)` filters
-- (plus the v/provider equality filters covered by the partial WHERE
-- clause). This changes read cost only — no table column, row data, sibling-
-- selection semantics, or score/Contract A/Queue-identity behavior changes.
--
-- Idempotent — safe to run multiple times.
--
-- CONCURRENTLY: table carries production write traffic from
-- generate-signals/resolve-signals crons; a non-concurrent build would hold
-- a SHARE lock blocking writes for the build's duration. Whether this
-- repository's migration-apply mechanism wraps each file in a transaction is
-- unconfirmed from source -- CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Verify the apply path before running this file; if the
-- apply mechanism is transactional, drop CONCURRENTLY and accept the
-- write-lock window instead of failing the migration.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS idx_gsp_provider_event_context;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsp_provider_event_context
  ON public.generated_signal_pairs (
    (diagnostics -> 'providerEventContext' ->> 'eventId'),
    (diagnostics -> 'providerEventContext' ->> 'eventStartIso')
  )
  WHERE diagnostics -> 'providerEventContext' ->> 'v' = 'v1'
    AND diagnostics -> 'providerEventContext' ->> 'provider' = 'polymarket';
