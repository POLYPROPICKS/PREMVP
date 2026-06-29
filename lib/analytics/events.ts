// Canonical PolyProPicks conversion-funnel event contract.
//
// These are the ONLY event names the product emits. They are intentionally
// namespaced with `ppp_` so they never collide with PostHog autocapture events
// (`$pageview`, `$autocapture`, …) or the legacy SI PRO PICKS event names.
//
// Payment-truth rule (see CLAUDE.md / founder brief):
//   - `ppp_payment_activated` represents the legacy `payment_received` intent,
//     but it MUST only be emitted after the Whop webhook `membership.activated`
//     has been processed successfully on the server.
//   - Returning to the checkout-complete page is NOT payment success, so the
//     return path emits `ppp_checkout_return` only — never `purchase` and never
//     `ppp_payment_activated`.

export const PPP_EVENTS = {
  LANDING_VIEW: "ppp_landing_view",
  FREE_SIGNAL_VIEW: "ppp_free_signal_view",
  LEAD_CTA_CLICK: "ppp_lead_cta_click",
  PAYWALL_VIEW: "ppp_paywall_view",
  PLAN_SELECTED: "ppp_plan_selected",
  CHECKOUT_START: "ppp_checkout_start",
  WHOP_CHECKOUT_REDIRECT: "ppp_whop_checkout_redirect",
  CHECKOUT_RETURN: "ppp_checkout_return",
  PAYMENT_WEBHOOK_RECEIVED: "ppp_payment_webhook_received",
  PAYMENT_ACTIVATED: "ppp_payment_activated",
  ENTITLEMENT_GRANTED: "ppp_entitlement_granted",
  PREMIUM_FEED_VIEW: "ppp_premium_feed_view",
  PREMIUM_ACCESS_BLOCKED: "ppp_premium_access_blocked",
} as const;

export type PppEventName = (typeof PPP_EVENTS)[keyof typeof PPP_EVENTS];

export const PPP_EVENT_NAMES: readonly PppEventName[] =
  Object.values(PPP_EVENTS);

export function isPppEventName(name: string): name is PppEventName {
  return (PPP_EVENT_NAMES as readonly string[]).includes(name);
}

// Legacy SI PRO PICKS events are kept ONLY as a reference for funnel intent.
// They are never emitted. This map documents how a legacy event maps onto the
// canonical contract so dashboards can be migrated without guessing.
//
// IMPORTANT: legacy `payment_received` maps to `ppp_payment_activated`, but the
// canonical event still obeys the payment-truth rule (webhook-confirmed only).
export const LEGACY_EVENT_MAP: Readonly<Record<string, PppEventName>> = {
  Pageview: PPP_EVENTS.LANDING_VIEW,
  page_view: PPP_EVENTS.LANDING_VIEW,
  single_prediction_viewed: PPP_EVENTS.FREE_SIGNAL_VIEW,
  picks_schedule_view_click: PPP_EVENTS.FREE_SIGNAL_VIEW,
  handicapper_subscribe_click: PPP_EVENTS.LEAD_CTA_CLICK,
  vip_access_click: PPP_EVENTS.LEAD_CTA_CLICK,
  our_pro_handicappers_get_access_click: PPP_EVENTS.LEAD_CTA_CLICK,
  get_started_plan_clicked: PPP_EVENTS.PAYWALL_VIEW,
  upgrade_plan_clicked: PPP_EVENTS.PAYWALL_VIEW,
  our_pro_handicappers_plan_select: PPP_EVENTS.PLAN_SELECTED,
  Fanbasis_Payment_Form: PPP_EVENTS.CHECKOUT_START,
  payment_received: PPP_EVENTS.PAYMENT_ACTIVATED,
};

export function mapLegacyEvent(legacyName: string): PppEventName | null {
  return LEGACY_EVENT_MAP[legacyName] ?? null;
}

// ── Funnel-stage event derivation (pure) ────────────────────────────────────
// These helpers centralise WHICH canonical events fire at each server stage so
// the payment-truth rule is enforced in one tested place rather than scattered
// across route handlers.

// Returning from Whop checkout. This is never a payment confirmation, so it can
// only ever yield the return event — explicitly NOT `purchase` / activation.
export function checkoutReturnEvents(): readonly PppEventName[] {
  return [PPP_EVENTS.CHECKOUT_RETURN];
}

export type WebhookEventInput = {
  eventType: string;
  // True only when the webhook handler successfully granted/updated entitlement.
  processed: boolean;
};

// Whop webhook processing. Every verified webhook records that it was received.
// Payment activation + entitlement events are emitted ONLY for a successfully
// processed `membership.activated` event — the single source of payment truth.
export function webhookEvents(
  input: WebhookEventInput
): readonly PppEventName[] {
  const events: PppEventName[] = [PPP_EVENTS.PAYMENT_WEBHOOK_RECEIVED];
  if (input.eventType === "membership.activated" && input.processed) {
    events.push(PPP_EVENTS.PAYMENT_ACTIVATED, PPP_EVENTS.ENTITLEMENT_GRANTED);
  }
  return events;
}
