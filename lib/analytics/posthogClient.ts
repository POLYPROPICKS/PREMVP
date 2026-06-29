'use client';

// Client-side PostHog bootstrap (posthog-js).
//
// Fail-open: if no public token is configured, initialization is a no-op and
// `trackClientEvent` silently does nothing. Analytics never blocks the UI.
// Never logs the token value.

import posthog from 'posthog-js';
import type { PppEventName } from './events';

const DEFAULT_HOST = 'https://us.i.posthog.com';

let initialized = false;

function resolveToken(): string {
  return (
    process.env.NEXT_PUBLIC_POSTHOG_KEY ??
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ??
    ''
  ).trim();
}

export function initPostHog(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  const token = resolveToken();
  if (!token) return; // no-op when unconfigured

  const host =
    (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;

  try {
    posthog.init(token, {
      api_host: host,
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      person_profiles: 'identified_only',
    });
    initialized = true;
  } catch {
    // Fail open — never surface analytics init errors to the user.
  }
}

export function trackClientEvent(
  event: PppEventName,
  properties?: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return;
  if (!resolveToken()) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Fail open.
  }
}
