-- Live Queue lineage has no authoritative model_name. Preserve that absence.
alter table public.bet_execution_ledger alter column model_name drop not null;
