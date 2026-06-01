-- SMS consent events v1
-- Append-only audit table for TCPA / 10DLC / TFN consent records.
-- Idempotent — safe to run multiple times.
-- Apply manually in Supabase SQL Editor before deploying app/api/sms-opt-in route.
-- No public client access — all writes via service-role backend route only.

-- ---------------------------------------------------------------------------
-- sms_consent_events
-- One row per consent action. No UPDATE or DELETE permitted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_consent_events (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164         text        NOT NULL,
  event_type         text        NOT NULL DEFAULT 'opt_in',
  consent_source     text        NOT NULL,
  disclosure_version text        NOT NULL,
  disclosure_text    text        NOT NULL,
  ip_address         text        NULL,
  user_agent         text        NULL,
  referrer           text        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sms_consent_events_event_type_check
    CHECK (event_type IN ('opt_in', 'opt_out')),

  -- E.164 format: leading +, 8–15 digits only.
  CONSTRAINT sms_consent_events_phone_e164_check
    CHECK (phone_e164 ~ '^\+[0-9]{8,15}$')
);

-- RLS: service-role key bypasses RLS; no anonymous/public reads or writes.
ALTER TABLE public.sms_consent_events ENABLE ROW LEVEL SECURITY;

-- No public policies added. Append-only enforcement via application layer.

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sms_consent_events_phone_e164_idx
  ON public.sms_consent_events (phone_e164);

CREATE INDEX IF NOT EXISTS sms_consent_events_created_at_idx
  ON public.sms_consent_events (created_at DESC);
