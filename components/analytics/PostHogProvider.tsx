'use client';

import { useEffect } from 'react';
import { initPostHog, trackClientEvent } from '@/lib/analytics/posthogClient';
import { PPP_EVENTS } from '@/lib/analytics/events';

// Mounts once at the app root. Initializes PostHog (no-op when unconfigured)
// and emits the canonical landing view. Renders nothing.
export default function PostHogProvider() {
  useEffect(() => {
    initPostHog();
    trackClientEvent(PPP_EVENTS.LANDING_VIEW, {
      path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, []);

  return null;
}
