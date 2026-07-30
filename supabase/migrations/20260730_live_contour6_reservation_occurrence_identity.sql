-- Live Contour 6: canonical Reservation occurrence identity.
-- Forward-only and backward-compatible: legacy rows remain nullable and are
-- never fuzzy-backfilled. New application writes require both fields.

alter table public.night_event_reservations
  add column if not exists physical_event_id text,
  add column if not exists event_start_iso timestamptz;

alter table public.night_event_reservations
  drop constraint if exists night_event_reservations_plan_event_uniq;

create unique index if not exists night_event_reservations_legacy_plan_event_uniq
  on public.night_event_reservations (plan_run_id, match_family_key)
  where physical_event_id is null;

create unique index if not exists night_event_reservations_physical_event_uniq
  on public.night_event_reservations (physical_event_id)
  where physical_event_id is not null;
