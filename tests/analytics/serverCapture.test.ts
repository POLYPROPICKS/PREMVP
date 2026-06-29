import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePosthogConfig,
  captureServerEvent,
  captureServerEvents,
} from "../../lib/analytics/serverCapture";
import { PPP_EVENTS } from "../../lib/analytics/events";

const TOKEN = "phc_test_secret_token_value";

// Capture console output so we can assert no raw env/token leaks into logs.
function withConsoleCapture<T>(fn: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  const origLog = console.log;
  const sink = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  console.warn = sink;
  console.error = sink;
  console.log = sink;
  return fn(lines).finally(() => {
    console.warn = origWarn;
    console.error = origError;
    console.log = origLog;
  });
}

test("resolvePosthogConfig honors key, fallback token, and host default", () => {
  assert.deepEqual(
    resolvePosthogConfig({ NEXT_PUBLIC_POSTHOG_KEY: TOKEN }),
    { token: TOKEN, host: "https://us.i.posthog.com" }
  );
  // Fallback token name.
  assert.deepEqual(
    resolvePosthogConfig({ NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: TOKEN }),
    { token: TOKEN, host: "https://us.i.posthog.com" }
  );
  // Custom host respected.
  assert.equal(
    resolvePosthogConfig({
      NEXT_PUBLIC_POSTHOG_KEY: TOKEN,
      NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
    })?.host,
    "https://eu.i.posthog.com"
  );
});

test("missing env makes capture a silent no-op (fail-open)", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await captureServerEvent(PPP_EVENTS.CHECKOUT_START, {
    env: {}, // no token
    fetchImpl,
  });
  assert.deepEqual(result, { captured: false, reason: "missing_config" });
  assert.equal(called, false, "must not hit the network without a token");
});

test("successful capture posts to /capture/ with the event name", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await captureServerEvent(PPP_EVENTS.PAYMENT_ACTIVATED, {
    env: { NEXT_PUBLIC_POSTHOG_KEY: TOKEN },
    fetchImpl,
    distinctId: "user-123",
  });
  assert.deepEqual(result, { captured: true, reason: "ok" });
  assert.equal(capturedUrl, "https://us.i.posthog.com/capture/");
  assert.equal(capturedBody.event, PPP_EVENTS.PAYMENT_ACTIVATED);
  assert.equal(capturedBody.distinct_id, "user-123");
});

test("transport errors are swallowed — analytics never throws (fail-open)", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  await withConsoleCapture(async (lines) => {
    const result = await captureServerEvent(PPP_EVENTS.WHOP_CHECKOUT_REDIRECT, {
      env: { NEXT_PUBLIC_POSTHOG_KEY: TOKEN },
      fetchImpl,
    });
    assert.deepEqual(result, { captured: false, reason: "transport_error" });
    // Sanitized log must not contain the raw token value or the error message.
    for (const line of lines) {
      assert.ok(!line.includes(TOKEN), "log leaked token value");
      assert.ok(!line.includes("network down"), "log leaked raw error message");
    }
  });
});

test("non-2xx responses fail open and never leak the token", async () => {
  const fetchImpl = (async () =>
    new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

  await withConsoleCapture(async (lines) => {
    const result = await captureServerEvent(PPP_EVENTS.PAYMENT_WEBHOOK_RECEIVED, {
      env: { NEXT_PUBLIC_POSTHOG_KEY: TOKEN },
      fetchImpl,
    });
    assert.equal(result.captured, false);
    assert.equal(result.reason, "bad_status");
    for (const line of lines) {
      assert.ok(!line.includes(TOKEN), "log leaked token value");
    }
  });
});

test("captureServerEvents emits each event and resolves all, fail-open", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)).event);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await captureServerEvents(
    [PPP_EVENTS.PAYMENT_ACTIVATED, PPP_EVENTS.ENTITLEMENT_GRANTED],
    { env: { NEXT_PUBLIC_POSTHOG_KEY: TOKEN }, fetchImpl }
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.captured));
  assert.deepEqual(seen.sort(), [
    PPP_EVENTS.ENTITLEMENT_GRANTED,
    PPP_EVENTS.PAYMENT_ACTIVATED,
  ].sort());
});
