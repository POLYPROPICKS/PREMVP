-- Referral MVP v0.1 Foundation
-- Idempotent — safe to run multiple times.
-- Apply manually in Supabase SQL Editor before deploying referral API routes.
-- No public client access — all writes via service-role backend routes.

-- ---------------------------------------------------------------------------
-- referral_links
-- One row per referrer. ref_code is the shareable slug in /r/[code] URLs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referral_links (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  ref_code       text        NOT NULL UNIQUE,
  lead_intent_id uuid        REFERENCES public.lead_intents(id) ON DELETE SET NULL,
  email          text,
  click_count    integer     NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'active',

  CONSTRAINT referral_links_status_check
    CHECK (status IN ('active', 'blocked', 'archived')),
  CONSTRAINT referral_links_ref_code_length_check
    CHECK (char_length(ref_code) >= 6)
);

-- RLS: service-role key bypasses RLS; no anonymous/public reads or writes.
ALTER TABLE public.referral_links ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Indexes on referral_links
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_referral_links_ref_code
  ON public.referral_links (ref_code);

CREATE INDEX IF NOT EXISTS idx_referral_links_email
  ON public.referral_links (email);

CREATE INDEX IF NOT EXISTS idx_referral_links_lead_intent_id
  ON public.referral_links (lead_intent_id);

-- ---------------------------------------------------------------------------
-- lead_intents — add referred_by_code column
-- Populated when a referred visitor submits their email via /r/[code] flow.
-- ---------------------------------------------------------------------------
ALTER TABLE public.lead_intents
  ADD COLUMN IF NOT EXISTS referred_by_code text;

CREATE INDEX IF NOT EXISTS idx_lead_intents_referred_by_code
  ON public.lead_intents (referred_by_code)
  WHERE referred_by_code IS NOT NULL;
