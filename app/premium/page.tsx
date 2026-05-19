import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/server";
import { verifyPremiumSession } from "@/lib/auth/premiumSession";
import { premiumSignals as staticPremiumSignals } from "@/content/signals";
import { type PremiumSignal, type TrustMetric, type LandingCardPair } from "@/lib/feed/types";
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
      `${appUrl}/api/feed/landing-cards?limit=5&category=sports&minDataCoverage=40&excludeEnded=true`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.pairs)
      ? (json.pairs as LandingCardPair[]).filter((p) => p?.premiumSignal)
      : [];
  } catch {
    return [];
  }
}

// ── Filter helpers ─────────────────────────────────────────────────────────

type PremiumFilter = "live" | "wc2026" | "nhl" | "nba" | "esport";
type FilterCounts = Record<PremiumFilter, number>;

const FILTER_LABELS: Array<{ tag: PremiumFilter; label: string }> = [
  { tag: "live", label: "Live" },
  { tag: "wc2026", label: "WC2026" },
  { tag: "nhl", label: "NHL" },
  { tag: "nba", label: "NBA" },
  { tag: "esport", label: "eSport" },
];

function parseFilter(raw: string | string[] | undefined): PremiumFilter {
  const s = typeof raw === "string" ? raw : "";
  if (s === "wc2026" || s === "nhl" || s === "nba" || s === "esport") return s;
  return "live";
}

function signalMatchesFilter(signal: PremiumSignal, tag: PremiumFilter): boolean {
  if (tag === "live") return true;
  const league = (signal.league ?? "").toLowerCase();
  const title = (signal.eventTitle ?? "").toLowerCase();
  const combined = `${league} ${title}`;
  if (tag === "wc2026") {
    const isWorldCup =
      combined.includes("world cup") ||
      combined.includes("wc2026") ||
      combined.includes("wc 2026") ||
      combined.includes("fifa");
    const isHockey = combined.includes("hockey") || league.includes("nhl");
    return isWorldCup && !isHockey;
  }
  if (tag === "nhl")
    return league.includes("nhl") || combined.includes("stanley cup") || (combined.includes("hockey") && !combined.includes("world cup"));
  if (tag === "nba")
    return league.includes("nba") || combined.includes("basketball");
  if (tag === "esport") {
    const isEsport =
      league.includes("esport") ||
      league.includes("gaming") ||
      combined.includes("esports") ||
      combined.includes("esport") ||
      combined.includes("e-sport") ||
      combined.includes("league of legends") ||
      combined.includes("cs2") ||
      combined.includes("counter-strike") ||
      combined.includes("dota") ||
      combined.includes("valorant") ||
      combined.includes("overwatch") ||
      combined.includes("fortnite") ||
      combined.includes("rocket league");
    const isTradSport =
      combined.includes("nba") ||
      combined.includes("nhl") ||
      combined.includes("world cup") ||
      combined.includes("soccer") ||
      combined.includes("basketball") ||
      combined.includes("hockey") ||
      combined.includes("baseball") ||
      combined.includes("tennis") ||
      combined.includes("golf");
    return isEsport && !isTradSport;
  }
  return false;
}

function computeFilterCounts(eligible: PremiumSignal[]): FilterCounts {
  return {
    live: eligible.length,
    wc2026: eligible.filter((s) => signalMatchesFilter(s, "wc2026")).length,
    nhl: eligible.filter((s) => signalMatchesFilter(s, "nhl")).length,
    nba: eligible.filter((s) => signalMatchesFilter(s, "nba")).length,
    esport: eligible.filter((s) => signalMatchesFilter(s, "esport")).length,
  };
}

function isEligiblePosition(position: string | undefined): boolean {
  if (!position) return false;
  return position.trim() !== "";
}

function isNoPosition(signal: PremiumSignal): boolean {
  return signal.position?.trim().toLowerCase() === "no";
}

function isQuestionStyleTitle(title: string): boolean {
  const t = title.trim();
  return t.endsWith("?") || /^(will|does|is|can|who|when|which|has|did)\b/i.test(t);
}

function getDisplayTitle(signal: PremiumSignal): string {
  const title = signal.eventTitle ?? "";
  if (!isNoPosition(signal)) return title;
  // question-style title already makes the No position clear
  if (isQuestionStyleTitle(title)) return title;
  // generic matchup: conservative — keep original, Position "No" column provides context
  return title;
}

// ── Trust metric helpers ───────────────────────────────────────────────────

function normalizeTrustMetricText(m: TrustMetric): string {
  return `${m.id} ${m.label}`.toLowerCase();
}

function getTrustMetricRank(m: TrustMetric): number {
  const t = normalizeTrustMetricText(m);
  if (t.includes("smart")) return 0;
  if ((t.includes("whale") && t.includes("public")) || t.includes("public vs whale")) return 1;
  if (t.includes("preevent") || t.includes("pre-event") || t.includes("score") || t.includes("ai")) return 2;
  return 99;
}

function getOrderedMetrics(metrics: TrustMetric[]): TrustMetric[] {
  return [...metrics].sort((a, b) => getTrustMetricRank(a) - getTrustMetricRank(b));
}

function getMetricDisplayLabel(m: TrustMetric): string {
  const t = normalizeTrustMetricText(m);
  if (t.includes("smart")) return "Smart Money";
  if ((t.includes("whale") && t.includes("public")) || t.includes("public vs whale")) return "Whale vs Public Money";
  if (t.includes("preevent") || t.includes("pre-event") || t.includes("score") || t.includes("ai")) return "PreEventScore AI";
  return m.label;
}

function getMetricValue(m: TrustMetric): number {
  return Math.max(0, Math.min(100, Math.round(Number(m.value) || 0)));
}

function getMetricFillBg(v: number): string {
  if (v >= 85) return "linear-gradient(90deg,#23e6bb 0%,#61ef4a 55%,#fff500 100%)";
  if (v >= 70) return "linear-gradient(90deg,#18e7ff 0%,#23e6bb 45%,#61ef4a 100%)";
  if (v >= 55) return "linear-gradient(90deg,#f59e0b 0%,#facc15 65%,#fff500 100%)";
  return "linear-gradient(90deg,#ef4444 0%,#f97316 100%)";
}

// ── Badge helpers ──────────────────────────────────────────────────────────

function getBadgeText(prob: number): string {
  if (prob >= 80) return "ABSOLUTE CONFIDENCE";
  if (prob > 65) return "HIGH CONFIDENCE";
  if (prob > 55) return "MIDDLE CONFIDENCE";
  return "LOW CONFIDENCE";
}

function getRingColor(prob: number): string {
  if (prob >= 65) return "#FFF500";
  if (prob > 55) return "#2190F6";
  return "#FF8A00";
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
          {counts[tag] > 0 && (
            <span className={styles.filterCount}>{counts[tag]}</span>
          )}
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

// ── Premium Signal Card (read-only, no CTA, no paywall) ────────────────────

function PremiumSignalCardReadOnly({ signal }: { signal: PremiumSignal }) {
  const probability = Math.max(0, Math.min(100, Number(signal.winProbability) || 0));
  const ringDegrees = probability * 3.6;
  const ringColor = getRingColor(probability);
  const badgeText = getBadgeText(probability);
  const ringStyle = {
    background: `conic-gradient(${ringColor} 0deg ${ringDegrees}deg, rgba(255,255,255,0.16) ${ringDegrees}deg 360deg)`,
  };

  const profitPercent = parseFloat((signal.profit || "0").replace("%", "")) || 0;
  const americanOdds =
    profitPercent >= 100
      ? `+${Math.round(profitPercent)}`
      : `-${Math.round(10000 / Math.max(profitPercent, 1))}`;
  const americanOddsNum = parseInt(String(americanOdds).replace(/[^\d-]/g, ""), 10);
  const profitDollars = Number.isFinite(americanOddsNum) && americanOddsNum !== 0
    ? Math.round(americanOddsNum > 0 ? americanOddsNum : 10000 / Math.abs(americanOddsNum))
    : Math.round(profitPercent);

  const orderedMetrics = getOrderedMetrics(signal.metrics);

  const safePolymarketUrl =
    typeof signal.polymarketUrl === "string" &&
    signal.polymarketUrl.startsWith("https://polymarket.com/")
      ? signal.polymarketUrl
      : undefined;

  return (
    <article className={styles.premiumSignalCard}>
      {/* Top row */}
      <div className={styles.premiumTop}>
        <div className={styles.leagueMeta}>
          <svg viewBox="0 0 24 24" className={styles.ball} aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="#F4F6FA" />
            <path d="M12 7.1 8.8 9.4 10 13.1h4L15.2 9.4 12 7.1Z" fill="#11161E" />
            <path d="M8.2 10.1 6.1 9.3 4.7 12l1.8 2.5 2.4-.6.9-3.8Z" fill="#11161E" />
            <path d="M15.8 10.1 17.9 9.3 19.3 12l-1.8 2.5-2.4-.6-.9-3.8Z" fill="#11161E" />
            <path d="M8 15.1 6.8 17.7 10 19.2l2-1.5V15H8Z" fill="#11161E" />
            <path d="M16 15.1 17.2 17.7 14 19.2l-2-1.5V15h4Z" fill="#11161E" />
          </svg>
          <span>{signal.league} | {signal.time}</span>
        </div>
        <div className={styles.confidencePill}>
          <svg viewBox="0 0 24 24" className={styles.shield} aria-hidden="true">
            <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" fill="currentColor" />
            <path d="m8.7 12.2 2.1 2.1 4.5-4.7" stroke="#06220B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span>{badgeText}</span>
        </div>
      </div>

      {/* Event title */}
      <h2 className={styles.eventTitle}>{getDisplayTitle(signal)}</h2>

      {/* Position / Profit block */}
      <div className={styles.positionProfit}>
        <div className={styles.positionCol}>
          <div className={styles.label}>Position</div>
          <div className={styles.positionValue}>{signal.position}</div>
        </div>
        <div className={styles.positionProfitDivider} />
        <div className={styles.profitCol}>
          <span className={styles.oddsLabel}>Odds {americanOdds}</span>
          <div className={styles.profitValue}>+${profitDollars}</div>
          <span className={styles.perStake}>per $100 stake</span>
        </div>
      </div>

      {/* Analytics row */}
      <div className={styles.analyticsRow}>
        <div className={styles.trustCard}>
          <div className={styles.trustHeader}>
            <span className={styles.trustTitle}>TRUST METRICS</span>
          </div>
          {orderedMetrics.map((m) => {
            const val = getMetricValue(m);
            return (
              <div key={m.id} className={styles.metricRow}>
                <div className={styles.metricIconWrap}>
                  <img className={styles.metricIconImg} src={m.icon} alt="" aria-hidden="true" draggable={false} />
                </div>
                <div className={styles.metricMain}>
                  <div className={styles.metricTopLine}>
                    <div className={styles.metricLabel}>{getMetricDisplayLabel(m)}</div>
                    <div className={styles.metricValue}>{val}%</div>
                  </div>
                  <div className={styles.metricBar}>
                    <div className={styles.metricFill} style={{ width: `${val}%`, background: getMetricFillBg(val) }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.winCard}>
          <div className={styles.winTitle}>SIGNAL CONFIDENCE</div>
          <div className={styles.ring} style={ringStyle}>
            <div className={styles.ringInner}>
              <span className={styles.ringNumber}>{probability}</span>
            </div>
          </div>
          {safePolymarketUrl && (
            <a
              href={safePolymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.polymarketLink}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              <span>SEE ON POLYMARKET</span>
            </a>
          )}
        </div>
      </div>
    </article>
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
    return (
      <div className={styles.page}>
        <div className={styles.restoreCard}>
          <h1 className={styles.restoreTitle}>Premium access not found</h1>
          <p className={styles.restoreBody}>
            If you already purchased premium, return to checkout to verify your access.
          </p>
          <a href="/checkout/complete" className={styles.ctaLink}>Verify access</a>
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
  const feedPairs = await loadFeedPairs();
  const hasFeed = feedPairs.length > 0;

  // All eligible signals regardless of active filter — used for counts
  const allEligible: PremiumSignal[] = hasFeed
    ? feedPairs.map((p) => p.premiumSignal).filter((s) => isEligiblePosition(s.position))
    : (staticPremiumSignals as unknown as PremiumSignal[]).filter((s) => isEligiblePosition(s.position)).slice(0, 5);

  const filterCounts = computeFilterCounts(allEligible);

  let signalsToRender: PremiumSignal[];
  if (activeFilter === "live") {
    signalsToRender = allEligible;
  } else {
    signalsToRender = allEligible.filter((s) => signalMatchesFilter(s, activeFilter));
  }

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
          {signalsToRender.length === 0 ? (
            <EmptyFilterState active={activeFilter} />
          ) : (
            signalsToRender.map((signal) => (
              <PremiumSignalCardReadOnly key={signal.id} signal={signal} />
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
