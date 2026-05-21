import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/server";
import { verifyPremiumSession } from "@/lib/auth/premiumSession";
import { premiumSignals as staticPremiumSignals } from "@/content/signals";
import { type PremiumSignal, type LandingCardPair } from "@/lib/feed/types";
import {
  dedupeLandingPairsByMarketOutcome,
  sortLandingPairsByConfidence,
  landingPairMatchesFilter,
  computeLandingFilterCounts,
  type LandingFilter,
} from "@/lib/feed/landingPairs";
import PremiumSignalCard from "./PremiumSignalCard";
import styles from "./Premium.module.css";

export const dynamic = "force-dynamic";

// ── Entitlement helpers ────────────────────────────────────────────────────

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
      year: "numeric", month: "long", day: "numeric",
    });
  } catch { return iso; }
}

// ── Feed loader ────────────────────────────────────────────────────────────

async function loadFeedPairs(): Promise<LandingCardPair[]> {
  try {
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const res = await fetch(
      `${appUrl}/api/feed/landing-cards?limit=15&category=sports&minDataCoverage=40&excludeEnded=true&includeUpcoming=true`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const json = await res.json();
    const allPairs = [
      ...(Array.isArray(json?.pairs) ? (json.pairs as LandingCardPair[]) : []),
      ...(Array.isArray(json?.upcomingPairs) ? (json.upcomingPairs as LandingCardPair[]) : []),
    ];
    return allPairs.filter((p) => p?.premiumSignal);
  } catch {
    return [];
  }
}

// ── Filter helpers ─────────────────────────────────────────────────────────

type PremiumFilter = LandingFilter;
type FilterCounts = Record<PremiumFilter, number>;

const FILTER_LABELS: Array<{ tag: PremiumFilter; label: string }> = [
  { tag: "live", label: "Live" },
  { tag: "wc2026", label: "WC26" },
  { tag: "nhl", label: "NHL" },
  { tag: "nba", label: "NBA" },
  { tag: "esport", label: "eSport" },
];

function parseFilter(raw: string | string[] | undefined): PremiumFilter {
  const s = typeof raw === "string" ? raw : "";
  if (s === "wc2026" || s === "nhl" || s === "nba" || s === "esport") return s;
  return "live";
}

function isEligiblePosition(position: string | undefined): boolean {
  if (!position) return false;
  return position.trim() !== "";
}

// ── Filter row ─────────────────────────────────────────────────────────────

function FilterRow({ active, counts }: { active: PremiumFilter; counts: FilterCounts }) {
  return (
    <div className={styles.filterRow}>
      {FILTER_LABELS.map(({ tag, label }) => (
        <a
          key={tag}
          href={tag === "live" ? "/premium" : `/premium?filter=${tag}`}
          className={`${styles.filterPill}${active === tag ? ` ${styles.filterPillActive}` : ""}`}
        >
          {label}
          <span className={styles.filterCount}>{counts[tag]}</span>
        </a>
      ))}
    </div>
  );
}

// ── Empty filter state ─────────────────────────────────────────────────────

function EmptyFilterState({ active }: { active: PremiumFilter }) {
  return (
    <div className={styles.emptyFilter}>
      <p className={styles.emptyFilterText}>
        No live signals for {active.toUpperCase()} right now.
      </p>
      <a href="/premium" className={styles.emptyFilterLink}>
        View all live signals →
      </a>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function PremiumPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedParams = await searchParams;
  const cookieStore = await cookies();
  const token = cookieStore.get("ppp_session")?.value ?? null;

  if (!token) {
    const restoreStatus = typeof resolvedParams.restore === "string" ? resolvedParams.restore : null;
    const showForm = restoreStatus !== "requested" && restoreStatus !== "provider-missing";
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          {restoreStatus === "invalid" ? (
            <>
              <h1 className={styles.restoreTitle}>Link invalid or expired</h1>
              <p className={styles.restoreBody}>
                This access link is invalid or has already been used. Request a new one below.
              </p>
            </>
          ) : restoreStatus === "requested" ? (
            <>
              <h1 className={styles.restoreTitle}>Check your email</h1>
              <p className={styles.restoreBody}>
                A secure one-time access link has been sent. It expires in 15&nbsp;minutes.
              </p>
            </>
          ) : restoreStatus === "provider-missing" ? (
            <>
              <h1 className={styles.restoreTitle}>Email delivery unavailable</h1>
              <p className={styles.restoreBody}>Email delivery is not configured yet.</p>
            </>
          ) : (
            <h1 className={styles.restoreTitle}>Restore premium access</h1>
          )}

          {showForm && (
            <>
              <p className={styles.restoreBody}>
                Enter the email used at purchase. We&apos;ll send a secure one-time access link.
              </p>
              <form
                method="post"
                action="/api/auth/magic-link/request"
                className={styles.restoreForm}
              >
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="your@email.com"
                  className={styles.restoreInput}
                  aria-label="Email address"
                />
                <button type="submit" className={styles.ctaLink}>
                  Send secure access link
                </button>
              </form>
            </>
          )}

          {restoreStatus === "requested" && (
            <a href="/premium" className={styles.secondaryLink}>Request another link</a>
          )}

          <a href="/checkout/complete" className={styles.secondaryLink}>Verify via checkout ID</a>
          <a href="/" className={styles.secondaryLink}>Back to free signals</a>
        </div>
      </div>
    );
  }

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
          <p className={styles.restoreBody}>Your premium session could not be verified. Please re-verify your access.</p>
          <a href="/checkout/complete" className={styles.ctaLink}>Re-verify access</a>
        </div>
      </div>
    );
  }

  const entitlement = await revalidateEntitlement(sessionCheckoutId);

  if (!entitlement) {
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          <h1 className={styles.restoreTitle}>Access expired</h1>
          <p className={styles.restoreBody}>This premium access is no longer active. Renew to continue.</p>
          <a href="/" className={styles.ctaLink}>Return to PolyProPicks</a>
        </div>
      </div>
    );
  }

  const activePlan = entitlement.activePlan ?? sessionActivePlan;
  const accessUntil = entitlement.accessUntil ?? sessionAccessUntil;

  const activeFilter = parseFilter(resolvedParams.filter);
  const rawFeedPairs = await loadFeedPairs();
  const feedPairs = sortLandingPairsByConfidence(dedupeLandingPairsByMarketOutcome(rawFeedPairs));
  const hasFeed = feedPairs.length > 0;

  // Eligible pairs (with non-empty position) — used for counts and render base
  const eligibleFeedPairs = feedPairs.filter((p) => isEligiblePosition(p.premiumSignal.position));
  const staticFallbackPairs: LandingCardPair[] = (staticPremiumSignals as unknown as PremiumSignal[])
    .filter((s) => isEligiblePosition(s.position))
    .slice(0, 5)
    .map((s, i) => ({
      id: `static-${s.id ?? i}`,
      premiumSignal: s,
      marketSource: { id: "", sourceLabel: "", platform: "", network: "", timeAgo: "", headline: "", subline: "", delta: "" },
      marketSources: [],
      diagnostics: {
        conditionId: null, selectedTokenId: null, selectedOutcome: "",
        currentPrice: null, price1hAgo: null, price6hAgo: null,
        delta1hPp: null, delta6hPp: null, spread: null, openInterest: null,
        recentTradeCash: null, maxTradeCash: null, selectedTradeCount: null,
        totalTradeCount: null, holderConcentrationScore: null,
        dataCoverage: 0, formulaUsed: "", rejectionReasons: [],
      },
    }));

  const eligiblePairsForCount: LandingCardPair[] = hasFeed ? eligibleFeedPairs : staticFallbackPairs;
  const filterCounts = computeLandingFilterCounts(eligiblePairsForCount);

  // pairsToRender uses the same eligible+deduped pair base used for counts.
  const pairsToRender: LandingCardPair[] =
    activeFilter === "live"
      ? eligiblePairsForCount
      : eligiblePairsForCount.filter((p) => landingPairMatchesFilter(p, activeFilter));

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
        <FilterRow active={activeFilter} counts={filterCounts} />
        <p className={styles.sectionLabel}>Live premium signals</p>
        <div className={styles.feedShell}>
          {pairsToRender.length === 0 ? (
            <EmptyFilterState active={activeFilter} />
          ) : (
            pairsToRender.map((pair) => (
              <PremiumSignalCard key={pair.id} pair={pair} />
            ))
          )}
        </div>

        <div className={styles.historySection}>
          <p className={styles.sectionLabel}>48h Signal History</p>
          <p className={styles.historyNote}>
            Coming next: resolved and expired premium signals from the last 48 hours.
          </p>
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
