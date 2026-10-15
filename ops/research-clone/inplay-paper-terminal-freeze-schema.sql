-- Research DBClone nppznoujvnyjargjkmnv ONLY; never Production.
-- Additive: no default/backfill, no historical row writes or provenance changes.
alter table public.research_inplay_paper_decisions
  add column if not exists frozen_db_at timestamptz;

-- The existing guard remains responsible for terminal/identity immutability.
-- This separate guard owns the clock for both direct and delayed terminal writes.
create or replace function public.research_inplay_paper_terminal_freeze()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
begin
  if new.frozen_db_at is not null then
    raise exception 'INPLAY_PAPER_FROZEN_DB_AT_CLIENT_FORBIDDEN';
  end if;
  if new.status in ('BET', 'SKIP') then
    new.frozen_db_at := pg_catalog.clock_timestamp();
  end if;
  return new;
end $$;

create or replace trigger research_inplay_paper_terminal_freeze_trg
  before insert or update on public.research_inplay_paper_decisions
  for each row execute function public.research_inplay_paper_terminal_freeze();
