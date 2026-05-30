"use client";

import { useState } from "react";
import { type LandingCardPair, type TrustMetric } from "@/lib/feed/types";
import CanonicalSignalCard from "@/components/signal-card/CanonicalSignalCard";
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

  // Prefer derivation from real market price (Polymarket 0–1) so extreme but
  // tradable markets show correct American odds. Falls back to profit-string parse.
  const rawPrice = typeof diag.currentPrice === "number" ? diag.currentPrice : NaN;
  const profitPercent = parseFloat((signal.profit || "0").replace("%", "")) || 0;

  let americanOdds = "";
  let profitDollars = 0;

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
  } else if (profitPercent >= 100) {
    americanOdds = `+${Math.round(profitPercent)}`;
    profitDollars = Math.round(profitPercent);
  } else if (profitPercent > 0) {
    americanOdds = `-${Math.round(10000 / profitPercent)}`;
    profitDollars = Math.round(profitPercent);
  }
  // else: no real price and no real profit → leave americanOdds empty (safety guard).

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
      <CanonicalSignalCard signal={signal} diagnostics={diag} />

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
