// Fail-open server-side PostHog capture helper.
//
// Design rules (founder brief):
//   - Uses the public project token. No server PostHog secret is required for
//     MVP. Accepts `NEXT_PUBLIC_POSTHOG_KEY` with a
//     `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` fallback.
//   - Host defaults to `https://us.i.posthog.com`.
//   - FAIL OPEN: a missing config or any transport error is swallowed. Analytics
//     must never break checkout, the webhook, or premium access.
//   - NEVER logs the token value, PII (email), or raw env values.
//
// This module is dependency-free (uses global `fetch`) and accepts injectable
// `env` / `fetchImpl` so it can be unit-tested without network or real secrets.

import type { PppEventName } from "./events";

const DEFAULT_HOST = "https://us.i.posthog.com";

export type PosthogConfig = {
  token: string;
  host: string;
};

export type CaptureResult = {
  captured: boolean;
  reason: "ok" | "missing_config" | "transport_error" | "bad_status";
};

type EnvLike = Record<string, string | undefined>;
type FetchLike = typeof fetch;

// Resolve config from env. Returns null (no-op) when no token is configured.
export function resolvePosthogConfig(
  env: EnvLike = process.env
): PosthogConfig | null {
  const token =
    (env.NEXT_PUBLIC_POSTHOG_KEY ?? env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? "")
      .trim();
  if (!token) return null;
  const host = (env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  return { token, host };
}

export type CaptureOptions = {
  distinctId?: string;
  properties?: Record<string, unknown>;
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

// Capture a single canonical funnel event server-side. Always resolves; never
// throws. Returns a small diagnostic result for callers/tests.
export async function captureServerEvent(
  event: PppEventName,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  const env = options.env ?? process.env;
  const config = resolvePosthogConfig(env);
  if (!config) {
    return { captured: false, reason: "missing_config" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const distinctId =
    options.distinctId && options.distinctId.length > 0
      ? options.distinctId
      : `server-${event}`;

  const payload = {
    api_key: config.token,
    event,
    distinct_id: distinctId,
    properties: {
      $lib: "ppp-server",
      ...(options.properties ?? {}),
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetchImpl(`${config.host.replace(/\/$/, "")}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Sanitized — status only, never token / body / PII.
      console.warn(`ppp_analytics_capture_bad_status event=${event} status=${res.status}`);
      return { captured: false, reason: "bad_status" };
    }
    return { captured: true, reason: "ok" };
  } catch (err) {
    // FAIL OPEN — sanitized message only, never token / payload / PII.
    const msg = err instanceof Error ? err.name : "unknown";
    console.warn(`ppp_analytics_capture_failed event=${event} err=${msg}`);
    return { captured: false, reason: "transport_error" };
  }
}

// Convenience for emitting several funnel events at once, fail-open.
export async function captureServerEvents(
  events: readonly PppEventName[],
  options: CaptureOptions = {}
): Promise<CaptureResult[]> {
  return Promise.all(events.map((e) => captureServerEvent(e, options)));
}
