-- =============================================================================
-- PolyProPicks — Whop v0.1 Payment Foundation
-- Migration: 20260518_whop_v0_1_payment_foundation
--
-- APPLY MANUALLY in Supabase SQL Editor (Dashboard > SQL Editor > New Query).
-- This repo has no prior automated migration convention.
-- Service-role backend routes write/read these tables.
-- UI must NOT query these tables directly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- checkout_sessions
-- Tracks each checkout attempt initiated from the app.
-- ---------------------------------------------------------------------------
create table if not exists public.checkout_sessions (
  id                         uuid        primary key default gen_random_uuid(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  lead_intent_id             uuid,
  internal_plan_id           text        not null,
  source                     text,
  provider                   text        not null default 'whop',
  provider_checkout_config_id text,
  provider_plan_id           text,
  provider_product_id        text,
  provider_purchase_url      text,
  status                     text        not null default 'created',
  email                      text,
  metadata                   jsonb       default '{}'::jsonb
);

-- RLS: service-role key bypasses RLS; no public access.
alter table public.checkout_sessions enable row level security;

create index if not exists idx_checkout_sessions_lead_intent_id
  on public.checkout_sessions (lead_intent_id);
create index if not exists idx_checkout_sessions_email
  on public.checkout_sessions (email);
create index if not exists idx_checkout_sessions_status
  on public.checkout_sessions (status);
create index if not exists idx_checkout_sessions_provider
  on public.checkout_sessions (provider);

-- ---------------------------------------------------------------------------
-- payment_events
-- Idempotent log of all incoming provider webhook events.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_events (
  id                          uuid        primary key default gen_random_uuid(),
  created_at                  timestamptz not null default now(),
  provider                    text        not null default 'whop',
  provider_event_id           text        not null,
  event_type                  text        not null,
  provider_object_id          text,
  provider_checkout_config_id text,
  provider_membership_id      text,
  provider_payment_id         text,
  checkout_session_id         uuid,
  processed_at                timestamptz,
  processing_status           text        not null default 'received',
  error                       text,
  raw_payload                 jsonb       not null,
  headers                     jsonb,
  constraint uq_payment_events_provider_event unique (provider, provider_event_id)
);

alter table public.payment_events enable row level security;

create index if not exists idx_payment_events_checkout_session_id
  on public.payment_events (checkout_session_id);
create index if not exists idx_payment_events_provider_membership_id
  on public.payment_events (provider_membership_id);
create index if not exists idx_payment_events_processing_status
  on public.payment_events (processing_status);

-- ---------------------------------------------------------------------------
-- user_entitlements
-- Source of truth for access grants. Written by webhook handler only.
-- ---------------------------------------------------------------------------
create table if not exists public.user_entitlements (
  id                      uuid        primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  user_identifier         text        not null,
  email                   text,
  lead_intent_id          uuid,
  provider                text        not null default 'whop',
  provider_user_id        text,
  provider_member_id      text,
  provider_membership_id  text,
  provider_plan_id        text,
  provider_product_id     text,
  checkout_session_id     uuid,
  active_plan             text        not null,
  has_premium_access      boolean     not null default false,
  access_until            timestamptz,
  status                  text        not null default 'active',
  last_event_id           text,
  raw_source              jsonb       default '{}'::jsonb
);

alter table public.user_entitlements enable row level security;

create unique index if not exists uq_user_entitlements_provider_membership_id
  on public.user_entitlements (provider_membership_id)
  where provider_membership_id is not null;

create index if not exists idx_user_entitlements_user_identifier
  on public.user_entitlements (user_identifier);
create index if not exists idx_user_entitlements_email
  on public.user_entitlements (email);
create index if not exists idx_user_entitlements_checkout_session_id
  on public.user_entitlements (checkout_session_id);
create index if not exists idx_user_entitlements_has_premium_access
  on public.user_entitlements (has_premium_access);
