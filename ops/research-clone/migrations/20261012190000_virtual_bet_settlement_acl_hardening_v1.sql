-- DBClone-only (nppznoujvnyjargjkmnv). Corrective ACL for public.virtual_bet_settlement_authority.
-- Defect: 20261012180000 revoked from public/anon/authenticated and granted select+insert to service_role, but Supabase's
-- default privileges had already given service_role UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, which a later GRANT never removes.
-- Runtime probe on the clone: no-op UPDATE and DELETE returned 204 instead of 42501. The row/truncate triggers still reject
-- real mutation; this closes the privilege layer so append-only does not rest on the trigger alone. Idempotent, no data change.
revoke all on public.virtual_bet_settlement_authority from public, anon, authenticated, service_role;
grant select, insert on public.virtual_bet_settlement_authority to service_role;
