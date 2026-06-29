import test from "node:test";
import assert from "node:assert/strict";
import {
  PPP_EVENTS,
  PPP_EVENT_NAMES,
  isPppEventName,
  LEGACY_EVENT_MAP,
  mapLegacyEvent,
  checkoutReturnEvents,
  webhookEvents,
  planSwitchEvents,
} from "../../lib/analytics/events";

test("event contract has exactly the canonical + hardening event names", () => {
  const canonical = [
    "ppp_landing_view",
    "ppp_free_signal_view",
    "ppp_lead_cta_click",
    "ppp_paywall_view",
    "ppp_plan_selected",
    "ppp_checkout_start",
    "ppp_whop_checkout_redirect",
    "ppp_checkout_return",
    "ppp_payment_webhook_received",
    "ppp_payment_activated",
    "ppp_entitlement_granted",
    "ppp_premium_feed_view",
    "ppp_premium_access_blocked",
  ];
  const hardening = [
    "ppp_signal_card_click",
    "ppp_locked_signal_click",
    "ppp_premium_card_click",
    "ppp_paywall_close",
    "ppp_plan_switch",
    "ppp_referral_cta_click",
    "ppp_referral_page_view",
    "ppp_referral_tab_selected",
    "ppp_referral_link_create_start",
    "ppp_referral_link_created",
    "ppp_referral_link_create_failed",
    "ppp_referral_dashboard_check_start",
    "ppp_referral_dashboard_view",
    "ppp_referral_dashboard_check_failed",
  ];
  const expected = [...canonical, ...hardening].sort();
  assert.deepEqual([...PPP_EVENT_NAMES].sort(), expected);
  // All canonical events from PR #15 must still be present (no regression).
  for (const name of canonical) {
    assert.ok(isPppEventName(name), `${name} missing from contract`);
  }
});

test("every canonical event is ppp_-namespaced and recognized", () => {
  for (const name of PPP_EVENT_NAMES) {
    assert.ok(name.startsWith("ppp_"), `${name} must be ppp_-namespaced`);
    assert.ok(isPppEventName(name));
  }
  assert.equal(isPppEventName("purchase"), false);
  assert.equal(isPppEventName("payment_received"), false);
});

test("legacy SI events map onto canonical funnel intent, never emitted directly", () => {
  assert.equal(mapLegacyEvent("Pageview"), PPP_EVENTS.LANDING_VIEW);
  assert.equal(mapLegacyEvent("single_prediction_viewed"), PPP_EVENTS.FREE_SIGNAL_VIEW);
  assert.equal(mapLegacyEvent("vip_access_click"), PPP_EVENTS.LEAD_CTA_CLICK);
  assert.equal(mapLegacyEvent("upgrade_plan_clicked"), PPP_EVENTS.PAYWALL_VIEW);
  assert.equal(mapLegacyEvent("our_pro_handicappers_plan_select"), PPP_EVENTS.PLAN_SELECTED);
  assert.equal(mapLegacyEvent("Fanbasis_Payment_Form"), PPP_EVENTS.CHECKOUT_START);
  // Payment-truth: legacy payment_received maps conceptually to activation.
  assert.equal(mapLegacyEvent("payment_received"), PPP_EVENTS.PAYMENT_ACTIVATED);
  // Unknown legacy events return null.
  assert.equal(mapLegacyEvent("some_unknown_event"), null);
});

test("every legacy mapping target is a canonical event", () => {
  for (const target of Object.values(LEGACY_EVENT_MAP)) {
    assert.ok(isPppEventName(target));
  }
});

test("checkout return NEVER emits purchase or payment activation", () => {
  const events = checkoutReturnEvents();
  assert.deepEqual([...events], [PPP_EVENTS.CHECKOUT_RETURN]);
  assert.ok(!events.includes(PPP_EVENTS.PAYMENT_ACTIVATED));
  // `purchase` is not even part of the contract.
  assert.ok(!(events as readonly string[]).includes("purchase"));
});

test("payment activation only fires for a processed membership.activated webhook", () => {
  // Confirmed success path: activation + entitlement, plus receipt.
  const confirmed = webhookEvents({ eventType: "membership.activated", processed: true });
  assert.ok(confirmed.includes(PPP_EVENTS.PAYMENT_WEBHOOK_RECEIVED));
  assert.ok(confirmed.includes(PPP_EVENTS.PAYMENT_ACTIVATED));
  assert.ok(confirmed.includes(PPP_EVENTS.ENTITLEMENT_GRANTED));

  // Activated event but processing failed → no activation, receipt only.
  const failed = webhookEvents({ eventType: "membership.activated", processed: false });
  assert.deepEqual([...failed], [PPP_EVENTS.PAYMENT_WEBHOOK_RECEIVED]);

  // Other event types never activate, even if processed.
  const other = webhookEvents({ eventType: "membership.deactivated", processed: true });
  assert.deepEqual([...other], [PPP_EVENTS.PAYMENT_WEBHOOK_RECEIVED]);
});

test("plan switch fires only when the plan actually changes (weekly↔monthly)", () => {
  // Switching weekly → monthly records selection + switch.
  assert.deepEqual([...planSwitchEvents("7day", "monthly")], [
    PPP_EVENTS.PLAN_SELECTED,
    PPP_EVENTS.PLAN_SWITCH,
  ]);
  // Switching monthly → weekly also records both.
  assert.deepEqual([...planSwitchEvents("monthly", "7day")], [
    PPP_EVENTS.PLAN_SELECTED,
    PPP_EVENTS.PLAN_SWITCH,
  ]);
  // Re-selecting the same plan records selection only — no switch.
  assert.deepEqual([...planSwitchEvents("monthly", "monthly")], [
    PPP_EVENTS.PLAN_SELECTED,
  ]);
});

test("no webhook path ever emits a bare `purchase` event", () => {
  for (const processed of [true, false]) {
    for (const eventType of ["membership.activated", "membership.deactivated", "payment.succeeded"]) {
      const events = webhookEvents({ eventType, processed }) as readonly string[];
      assert.ok(!events.includes("purchase"));
    }
  }
});
