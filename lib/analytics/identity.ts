// Browser → server analytics identity stitching helpers.
//
// To keep one PostHog person across the checkout funnel, the browser passes its
// PostHog `distinct_id` to the server (body field `analyticsDistinctId` or header
// `x-posthog-distinct-id`). The server then captures `ppp_checkout_start` /
// `ppp_whop_checkout_redirect` under that SAME distinct id instead of a synthetic
// server id — so browser and server events land on the same person.
//
// These helpers are pure and dependency-free so they can be unit-tested. They
// never throw and never accept PII: a value containing "@" (an email) is
// rejected so a raw email can never be smuggled in as a distinct id.

export const DISTINCT_ID_HEADER = "x-posthog-distinct-id";
export const DISTINCT_ID_BODY_FIELD = "analyticsDistinctId";

const MAX_DISTINCT_ID_LENGTH = 200;

// Returns a safe distinct id, or null when the value is missing/unsafe.
// Rejects: non-strings, empty/whitespace, over-long values, and anything that
// looks like an email address (PII).
export function sanitizeDistinctId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DISTINCT_ID_LENGTH) return null;
  if (trimmed.includes("@")) return null; // never accept an email as an id
  return trimmed;
}

// Resolve the browser distinct id from a request body object and/or headers.
// Body field wins; header is the fallback. Returns null when neither is safe.
export function resolveDistinctId(input: {
  body?: Record<string, unknown> | null;
  headers?: { get(name: string): string | null } | null;
}): string | null {
  const fromBody = input.body
    ? sanitizeDistinctId(input.body[DISTINCT_ID_BODY_FIELD])
    : null;
  if (fromBody) return fromBody;
  const headerValue = input.headers?.get(DISTINCT_ID_HEADER) ?? null;
  return sanitizeDistinctId(headerValue);
}
