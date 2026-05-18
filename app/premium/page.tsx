import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/server";
import { verifyPremiumSession } from "@/lib/auth/premiumSession";
import { premiumSignals } from "@/content/signals";
import styles from "./Premium.module.css";

export const dynamic = "force-dynamic";

async function revalidateEntitlement(checkoutSessionId: string) {
  const { data } = await supabaseAdmin
    .from("user_entitlements")
    .select("has_premium_access, status, active_plan, access_until")
    .eq("checkout_session_id", checkoutSessionId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const until = data.access_until ? new Date(data.access_until) : null;
  const isActive =
    data.has_premium_access === true &&
    until !== null &&
    !isNaN(until.getTime()) &&
    until > new Date();

  return isActive
    ? { activePlan: data.active_plan as string | null, accessUntil: data.access_until as string | null }
    : null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default async function PremiumPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("ppp_session")?.value ?? null;

  // ── No cookie → restore state ──────────────────────────────────────────
  if (!token) {
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          <h1 className={styles.restoreTitle}>Premium access not found</h1>
          <p className={styles.restoreBody}>
            If you already purchased premium, return to checkout to verify your access.
          </p>
          <a href="/checkout/complete" className={styles.cta}>Verify access</a>
          <a href="/" className={styles.cta} style={{ background: "none", color: "rgba(160,190,215,0.6)", fontSize: "13px", padding: "4px 0" }}>
            Back to free signals
          </a>
        </div>
      </div>
    );
  }

  // ── Verify cookie signature ────────────────────────────────────────────
  let sessionCheckoutId: string;
  let sessionActivePlan: string | null;
  let sessionAccessUntil: string | null;
  try {
    const payload = verifyPremiumSession(token);
    sessionCheckoutId = payload.checkoutSessionId;
    sessionActivePlan = payload.activePlan;
    sessionAccessUntil = payload.accessUntil;
  } catch {
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          <h1 className={styles.restoreTitle}>Session invalid or expired</h1>
          <p className={styles.restoreBody}>
            Your premium session could not be verified. Please re-verify your access.
          </p>
          <a href="/checkout/complete" className={styles.cta}>Re-verify access</a>
        </div>
      </div>
    );
  }

  // ── Server-side entitlement revalidation ──────────────────────────────
  const entitlement = await revalidateEntitlement(sessionCheckoutId);

  if (!entitlement) {
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          <h1 className={styles.restoreTitle}>Access expired</h1>
          <p className={styles.restoreBody}>
            This premium access is no longer active. Renew to continue.
          </p>
          <a href="/" className={styles.cta}>Return to PolyProPicks</a>
        </div>
      </div>
    );
  }

  const activePlan = entitlement.activePlan ?? sessionActivePlan;
  const accessUntil = entitlement.accessUntil ?? sessionAccessUntil;

  // ── Premium feed ──────────────────────────────────────────────────────
  const signals = premiumSignals.slice(0, 6);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.liveDot} aria-hidden="true" />
        <h1 className={styles.headerTitle}>Premium Feed</h1>
        {activePlan && (
          <span className={styles.planChip}>{activePlan.replace(/_/g, " ")}</span>
        )}
      </header>

      <div className={styles.body}>
        <p className={styles.sectionLabel}>Top live premium signals</p>
        <div className={styles.feedShell}>
          {signals.map((signal, i) => (
            <div key={i} className={styles.signalCard}>
              <p className={styles.signalEvent}>{signal.eventTitle}</p>
              <p className={styles.signalPos}>{signal.position}</p>
              <div className={styles.signalMeta}>
                <span className={`${styles.badge} ${styles.badgeGreen}`}>
                  {Math.round(signal.winProbability * 100)}% WIN
                </span>
                <span className={`${styles.badge} ${styles.badgeBlue}`}>
                  {signal.confidenceLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {accessUntil && (
        <p className={styles.until}>Access active until {formatDate(accessUntil)}</p>
      )}

      <p className={styles.compliance}>
        Sports market intelligence is informational only. No guarantee of results.
      </p>
    </div>
  );
}
