-- PREMVP_APPLICATION_MIGRATION_V1
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sports_event_market_inventory
    WHERE expires_at >= now()
  ) THEN
    RAISE EXCEPTION 'SPORTS_INVENTORY_UNEXPIRED_ROWS_PRESENT';
  END IF;
END
$$;

TRUNCATE TABLE public.sports_event_market_inventory;
