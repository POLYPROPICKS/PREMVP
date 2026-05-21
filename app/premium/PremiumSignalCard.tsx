"use client";

import { useState } from "react";
import { type LandingCardPair, type TrustMetric } from "@/lib/feed/types";
import styles from "./Premium.module.css";

// ── Helpers (card-rendering only) ─────────────────────────────────────────

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

function isNoPosition(position: string | undefined): boolean {
  return position?.trim().toLowerCase() === "no";
}

function isQuestionStyleTitle(title: string): boolean {
  const t = title.trim();
  return t.endsWith("?") || /^(will|does|is|can|who|when|which|has|did)\b/i.test(t);
}

function getDisplayTitle(eventTitle: string | undefined, position: string | undefined): string {
  const title = eventTitle ?? "";
  if (!isNoPosition(position)) return title;
  if (isQuestionStyleTitle(title)) return title;
  return title;
}

function getDisplayPosition(eventTitle: string | undefined, position: string | undefined): string {
  if (!position) return "";
  const pos = position.trim();
  const lower = pos.toLowerCase();
  if (lower !== "yes" && lower !== "no") return pos;
  const title = (eventTitle ?? "").trim();
  const m = title.match(/^will\s+(.+?)\s+beat\s+(.+?)\??$/i);
  if (!m) return pos;
  const teamA = m[1].trim();
  if (!teamA) return pos;
  return lower === "yes" ? `Yes — ${teamA} to win` : `No — ${teamA} not to win`;
}

function fmtCents(p: number): string {
  return `${(p * 100).toFixed(0)}¢`;
}

function fmtPp(p: number): string {
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}pp`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function PremiumSignalCard({ pair }: { pair: LandingCardPair }) {
  const [expanded, setExpanded] = useState(false);

  const signal = pair.premiumSignal;
  const evidenceCards = pair.marketSources ?? (pair.marketSource?.id ? [pair.marketSource] : []);
  const diag = pair.diagnostics;

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
  const profitDollars =
    Number.isFinite(americanOddsNum) && americanOddsNum !== 0
      ? Math.round(americanOddsNum > 0 ? americanOddsNum : 10000 / Math.abs(americanOddsNum))
      : Math.round(profitPercent);

  const orderedMetrics = getOrderedMetrics(signal.metrics);

  const safePolymarketUrl =
    typeof signal.polymarketUrl === "string" &&
    signal.polymarketUrl.startsWith("https://polymarket.com/")
      ? signal.polymarketUrl
      : undefined;

  const hasStats =
    diag.currentPrice != null ||
    diag.delta1hPp != null ||
    diag.openInterest != null ||
    diag.dataCoverage > 0;

  return (
    <div className={styles.cardWrapper}>
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
          <div className={`${styles.confidencePill}${probability <= 55 ? ` ${styles.confidencePillLow}` : ""}`}>
            <svg viewBox="0 0 24 24" className={styles.shield} aria-hidden="true">
              <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" fill="currentColor" />
              <path d="m8.7 12.2 2.1 2.1 4.5-4.7" stroke="#06220B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span>{badgeText}</span>
          </div>
        </div>

        {/* Event title */}
        <h2 className={styles.eventTitle}>{getDisplayTitle(signal.eventTitle, signal.position)}</h2>

        {/* Position / Profit block */}
        <div className={styles.positionProfit}>
          <div className={styles.positionCol}>
            <div className={styles.label}>Position</div>
            <div className={styles.positionValue}>{getDisplayPosition(signal.eventTitle, signal.position)}</div>
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

      {/* Get Details trigger — sits outside article so card overflow:hidden is untouched */}
      <button
        type="button"
        className={styles.detailsTrigger}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`details-${signal.id}`}
      >
        <span>{expanded ? "Hide Details" : "Get Details"}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={expanded ? styles.detailsChevronUp : styles.detailsChevronDown}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Inline details panel */}
      {expanded && (
        <div
          id={`details-${signal.id}`}
          className={styles.detailsPanel}
          role="region"
          aria-label="Signal details"
        >
          {/* Evidence cards */}
          {evidenceCards.length > 0 && (
            <div className={styles.detailsGrid}>
              <p className={styles.detailsSectionTitle}>Evidence</p>
              {evidenceCards.map((card) => (
                <div key={card.id} className={styles.detailsEvidenceCard}>
                  <div className={styles.detailsEvidenceSource}>
                    {card.sourceLabel}{card.platform && card.platform !== card.sourceLabel ? ` · ${card.platform}` : ""}
                    {card.timeAgo ? ` · ${card.timeAgo}` : ""}
                  </div>
                  <div className={styles.detailsEvidenceHeadline}>{card.headline}</div>
                  {card.subline && (
                    <div className={styles.detailsEvidenceSubline}>{card.subline}</div>
                  )}
                  {card.delta && (
                    <div className={styles.detailsEvidenceDelta}>{card.delta}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Market stats */}
          {hasStats && (
            <div className={styles.detailsSection}>
              <p className={styles.detailsSectionTitle}>Market Data</p>
              {diag.currentPrice != null && (
                <div className={styles.detailsMetricRow}>
                  <span className={styles.detailsMetricLabel}>Current Price</span>
                  <span className={styles.detailsMetricValue}>{fmtCents(diag.currentPrice)}</span>
                </div>
              )}
              {diag.delta1hPp != null && (
                <div className={styles.detailsMetricRow}>
                  <span className={styles.detailsMetricLabel}>1h Change</span>
                  <span className={styles.detailsMetricValue}>{fmtPp(diag.delta1hPp)}</span>
                </div>
              )}
              {diag.delta6hPp != null && (
                <div className={styles.detailsMetricRow}>
                  <span className={styles.detailsMetricLabel}>6h Change</span>
                  <span className={styles.detailsMetricValue}>{fmtPp(diag.delta6hPp)}</span>
                </div>
              )}
              {diag.openInterest != null && (
                <div className={styles.detailsMetricRow}>
                  <span className={styles.detailsMetricLabel}>Open Interest</span>
                  <span className={styles.detailsMetricValue}>{fmtUsd(diag.openInterest)}</span>
                </div>
              )}
              {diag.dataCoverage > 0 && (
                <div className={styles.detailsMetricRow}>
                  <span className={styles.detailsMetricLabel}>Data Coverage</span>
                  <span className={styles.detailsMetricValue}>{diag.dataCoverage}%</span>
                </div>
              )}
            </div>
          )}

          <p className={styles.detailsDisclaimer}>
            Signal analysis is informational only. Not financial advice.
          </p>

          {safePolymarketUrl && (
            <a
              href={safePolymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.detailsPolymarketLink}
            >
              View full market on Polymarket →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
