import { verifyPremiumSession } from "./premiumSession";
import { FOUNDER_PREVIEW_SESSION_ID } from "@/app/api/auth/founder-premium-preview/route";

// Same sentinel issued by the existing Founder Preview flow. Premium entitlement is insufficient.
const DAY_MS = 24 * 60 * 60 * 1000;

export function isFounderModelingSession(token: string | undefined, now = Date.now()): boolean {
  if (!token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token) || process.env.ENABLE_FOUNDER_PREMIUM_PREVIEW !== "true") return false;
  try {
    const session = verifyPremiumSession(token);
    const until = typeof session.accessUntil === "string" ? Date.parse(session.accessUntil) : NaN;
    return session.checkoutSessionId === FOUNDER_PREVIEW_SESSION_ID
      && Number.isFinite(session.issuedAt) && session.issuedAt <= now
      && now - session.issuedAt < DAY_MS
      && Number.isFinite(until) && until > now && until <= session.issuedAt + DAY_MS;
  } catch {
    return false;
  }
}

export const PRIVATE_MODELING_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vary": "Cookie",
  "X-Robots-Tag": "noindex, nofollow",
};
