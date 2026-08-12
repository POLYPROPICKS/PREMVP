-- Current serving state is an internal operational projection. The server
-- service-role client is its only reader/writer; no browser role may access it.

ALTER TABLE public.current_signal_pair_serving ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.current_signal_pair_serving_backfill_checkpoint ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.current_signal_pair_serving FROM anon, authenticated;
REVOKE ALL ON TABLE public.current_signal_pair_serving_backfill_checkpoint FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.refresh_current_signal_pair_serving(uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.backfill_current_signal_pair_serving(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_current_signal_pair_serving(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_current_signal_pair_serving(integer) TO service_role;
