// components/signal-card/CanonicalSignalCard.tsx
// Shared canonical signal-card body extracted verbatim from the accepted PUBLIC
// landing card (app/reconstruction/page.tsx). Visual source of truth.
// Wrappers provide their own footer (public CTA+referral, or premium Get Details).

import type { ReactNode } from "react";
import type { PremiumSignal, TrustMetric } from "@/lib/feed/types";
import styles from "./CanonicalSignalCard.module.css";

export type CanonicalSignalCardProps = {
  signal: PremiumSignal;
  diagnostics?: {
    currentPrice?: number | null;
  };
  footer?: ReactNode;
  /**
   * Opt-in premium gate for the public homepage. When true, the actionable
   * signal area (Recommended Position + Odds/Expected Profit) is blurred and
   * covered with a "Premium Access Only" overlay. Defaults to false so all
   * existing consumers (incl. /premium) remain fully unlocked.
   */
  lockSignalArea?: boolean;
};

// ── Trust-metric helpers (copied from accepted public card) ──────────────────

function normalizeTrustMetricText(metric: TrustMetric): string {
  return `${metric?.id ?? ""} ${metric?.label ?? ""}`.toLowerCase();
}

function getTrustMetricRank(metric: TrustMetric): number {
  const text = normalizeTrustMetricText(metric);
  if (text.includes("smart")) return 0;
  if (
    (text.includes("whale") && text.includes("public")) ||
    text.includes("public vs whale") ||
    text.includes("whale vs public")
  ) {
    return 1;
  }
  if (
    text.includes("preevent") ||
    text.includes("pre-event") ||
    text.includes("pre event") ||
    text.includes("score") ||
    text.includes("ai")
  ) {
    return 2;
  }
  return 99;
}

function getOrderedTrustMetrics(metrics: TrustMetric[]): TrustMetric[] {
  if (!Array.isArray(metrics)) return [];
  return metrics
    .map((metric, index) => ({ metric, index }))
    .sort((a, b) => {
      const rankDiff = getTrustMetricRank(a.metric) - getTrustMetricRank(b.metric);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((item) => item.metric);
}

function getTrustMetricDisplayLabel(metric: TrustMetric): string {
  const text = normalizeTrustMetricText(metric);
  if (text.includes("smart")) return "Smart Money";
  if (
    (text.includes("whale") && text.includes("public")) ||
    text.includes("public vs whale") ||
    text.includes("whale vs public")
  ) {
    return "Whale vs Public Money";
  }
  if (
    text.includes("preevent") ||
    text.includes("pre-event") ||
    text.includes("pre event") ||
    text.includes("score") ||
    text.includes("ai")
  ) {
    return "Injury data & PreMatchPower";
  }
  return metric?.label ?? "Trust Metric";
}

function getTrustMetricValue(metric: TrustMetric): number {
  const rawValue = (metric?.value ?? metric?.bar ?? 0) as number | string;
  const normalizedValue =
    typeof rawValue === "string" ? Number(rawValue.replace("%", "").trim()) : Number(rawValue);
  if (!Number.isFinite(normalizedValue)) return 0;
  return Math.max(0, Math.min(100, Math.round(normalizedValue)));
}

function getTrustMetricFillBackground(value: number): string {
  if (value >= 85) {
    return "linear-gradient(90deg, #23e6bb 0%, #61ef4a 55%, #fff500 100%)";
  }
  if (value >= 70) {
    return "linear-gradient(90deg, #18e7ff 0%, #23e6bb 45%, #61ef4a 100%)";
  }
  if (value >= 55) {
    return "linear-gradient(90deg, #f59e0b 0%, #facc15 65%, #fff500 100%)";
  }
  return "linear-gradient(90deg, #ef4444 0%, #f97316 100%)";
}

function getTrustMetricIconSrc(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("smart")) return "/icons/trust-smart-money-optimized.webp";
  if (l.includes("whale") || l.includes("public")) return "/icons/trust-public-whale-optimized.webp";
  if (l.includes("ai") || l.includes("preevent") || l.includes("score")) return "/icons/trust-ai-score-optimized.webp";
  return "/icons/trust-smart-money-optimized.webp";
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CanonicalSignalCard({ signal, diagnostics, footer, lockSignalArea = false }: CanonicalSignalCardProps) {
  const orderedTrustMetrics = getOrderedTrustMetrics(signal.metrics);

  const probability = Math.max(0, Math.min(100, Number(signal.winProbability) || 0));
  const ringDegrees = probability * 3.6;

  const getRingColor = (prob: number): string => {
    if (prob >= 80) return "#FFF500"; // ABSOLUTE
    if (prob > 65) return "#FFF500"; // HIGH
    if (prob > 55) return "#2190F6"; // MIDDLE
    return "#FF8A00"; // LOW
  };

  const actionLabel = signal.actionLabel as "ENTER" | "SMALL" | "WATCH" | undefined;
  const ringColor = getRingColor(probability);

  // Frontend-only display mappers (no backend fields changed)
  const actionDisplay = ((): string => {
    const a = (signal.actionLabel ?? "").toString().trim().toUpperCase();
    if (a === "ENTER") return "ENTER";
    if (a === "SMALL") return "LIGHT ENTRY";
    if (a === "WATCH") return "WATCH";
    return a.length > 0 ? a : "WATCH";
  })();
  const actionContext = ((): string => {
    switch ((signal.confidenceLabel ?? "").toString().trim()) {
      case "Strong Favorite": return "Strong favorite";
      case "Favorite Edge": return "Favorite setup";
      case "Core Signal": return "Core signal";
      case "Value Lean": return "Value setup";
      case "Underdog Value": return "Higher-odds setup";
      case "Longshot Value": return "Longshot setup";
      case "High-Upside Longshot": return "Speculative watch";
      default: return "Market setup";
    }
  })();
  const actionColorClass =
    actionLabel === "ENTER" ? styles.actionEnterLg :
    actionLabel === "SMALL" ? styles.actionSmallLg :
    styles.actionWatchLg;

  const ringStyle = {
    background: `conic-gradient(${ringColor} 0deg ${ringDegrees}deg, rgba(255,255,255,0.16) ${ringDegrees}deg 360deg)`,
  };

  // Odds calculation: prefer accurate American/decimal odds from real market price
  // (diagnostics.currentPrice, Polymarket 0–1) when present; otherwise preserve the
  // accepted public fallback derived from signal.profit. Expected Profit semantics unchanged.
  const profitPercent = parseFloat((signal.profit || "0").replace("%", "")) || 0;
  const rawPrice = typeof diagnostics?.currentPrice === "number" ? diagnostics.currentPrice : NaN;

  let americanOdds: string;
  let profitDollars: number;
  let decimalOdds: string;

  if (Number.isFinite(rawPrice) && rawPrice > 0 && rawPrice < 1) {
    if (rawPrice >= 0.5) {
      const neg = Math.max(1, Math.round((rawPrice / (1 - rawPrice)) * 100));
      americanOdds = `-${neg}`;
      profitDollars = Math.max(1, Math.round(((1 - rawPrice) / rawPrice) * 100));
    } else {
      const pos = Math.max(1, Math.round(((1 - rawPrice) / rawPrice) * 100));
      americanOdds = `+${pos}`;
      profitDollars = pos;
    }
    decimalOdds = (1 / rawPrice).toFixed(2);
  } else {
    americanOdds =
      profitPercent >= 100
        ? `+${Math.round(profitPercent)}`
        : `-${Math.round(10000 / Math.max(profitPercent, 1))}`;
    const americanOddsNumber = Number.parseInt(String(americanOdds).replace(/[^\d-]/g, ""), 10);
    profitDollars =
      Number.isFinite(americanOddsNumber) && americanOddsNumber !== 0
        ? Math.round(americanOddsNumber > 0 ? americanOddsNumber : 10000 / Math.abs(americanOddsNumber))
        : Math.round(profitPercent);
    decimalOdds =
      profitPercent >= 100
        ? ((profitPercent / 100) + 1).toFixed(2)
        : (100 / Math.max(profitPercent, 1) + 1).toFixed(2);
  }

  const positionDisplay = signal.positionDisplay || signal.position;
  const positionQualifier = signal.positionQualifier || "";
  const polymarketUrl = signal.polymarketUrl;

  return (
    <article className={styles.premiumSignalCard}>
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
      </div>
      <h1 className={styles.eventTitle}>{signal.eventTitle}</h1>
      {/* 3+4 · Lockable actionable signal area (Recommended Position + Odds/Profit) */}
      <div className={styles.lockableSignalArea}>
        <div
          className={`${styles.lockableSignalAreaContent} ${
            lockSignalArea ? styles.lockableSignalAreaContentLocked : ""
          }`}
          aria-hidden={lockSignalArea ? true : undefined}
        >
      {/* 3 · Recommended Position */}
      <div className={styles.recommendedPosition}>
        <svg className={styles.posTarget} viewBox="0 0 24 24" fill="none" stroke="#8bff4d" strokeWidth="1.2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" />
          <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
        </svg>
        <div className={styles.posKLabel}>Recommended Position</div>
        <div className={styles.posRow}>
          <span className={styles.posName}>{positionDisplay}</span>
          {positionQualifier && <span className={styles.posQual}>{positionQualifier}</span>}
        </div>
      </div>

      {/* 4 · Odds / Expected Profit */}
      <div className={styles.oddsProfitRow}>
        <div className={styles.oddsCell}>
          <div className={styles.cellCap}>Odds</div>
          <div className={styles.cellBig}>
            {americanOdds}
            <svg className={styles.cellBigSpark} viewBox="0 0 24 18" fill="none" stroke="#8bff4d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 15l5-5 3 3 6-8" /><path d="M14 5h4v4" />
            </svg>
          </div>
          <div className={`${styles.cellSub} ${styles.oddsSub}`}><span>Decimal</span><span className={styles.cellSubVal}>{decimalOdds}</span></div>
        </div>
        <div className={styles.profitCell}>
          <div className={styles.cellCap}>Expected Profit</div>
          <div className={styles.cellBig}>+${profitDollars}</div>
          <div className={styles.cellSub}><span>per $100 stake</span></div>
        </div>
      </div>
        </div>

        {lockSignalArea ? (
          <div className={styles.premiumAccessOverlay} aria-label="Premium Access Only">
            <span>Premium Access Only</span>
          </div>
        ) : null}
      </div>

      {/* 5 · Market Signal Score / Recommended Action */}
      <div className={styles.scoreActionRow}>
        <div className={styles.scoreCell}>
          <div className={styles.cellCap}>Market Signal Score</div>
          <div className={styles.scoreRing}>
            <div className={styles.ring} style={ringStyle}>
              <div className={styles.ringInner}>
                <span className={styles.ringNumber}>{probability}</span>
              </div>
            </div>
            <span className={styles.scoreOf}>/100</span>
          </div>
        </div>
        <div className={styles.actionCell}>
          <div className={`${styles.cellCap} ${styles.actionCap}`}>Recommended Action</div>
          <div className={styles.actionGroup}>
            <div className={`${styles.actionPill} ${actionColorClass}`}>
              {actionDisplay}
            </div>
            <div className={styles.actionContext}>{actionContext}</div>
          </div>
          {polymarketUrl && (
            <a
              href={polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View on Polymarket"
              className={styles.polyLink}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 17L17 7M9 7h8v8" />
              </svg>
              <span>SEE ON POLYMARKET</span>
            </a>
          )}
        </div>
      </div>

      {/* 6 · Supporting metrics */}
      <div className={styles.whySignalCard}>
        <a
          className={styles.metricsInfoLink}
          href="#how-it-works"
          aria-label="Learn how trust metrics work"
        >
          i
        </a>
        {orderedTrustMetrics.map((metric) => {
          const displayLabel = getTrustMetricDisplayLabel(metric);
          const safeVal = Math.max(0, Math.min(100, getTrustMetricValue(metric)));
          return (
            <div key={metric.id} className={styles.whyRow}>
              <img src={getTrustMetricIconSrc(displayLabel)} className={styles.whyIcon} alt="" width={18} height={18} />
              <span className={styles.whyLabel}>{displayLabel}</span>
              <span className={styles.whyTrack}>
                <span className={styles.whyFill} style={{ width: `${safeVal}%`, background: getTrustMetricFillBackground(safeVal) }} />
              </span>
              <span className={styles.whyVal}>{safeVal}%</span>
            </div>
          );
        })}
      </div>
      {footer}
    </article>
  );
}
