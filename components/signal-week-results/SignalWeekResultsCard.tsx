'use client';

import styles from './SignalWeekResultsCard.module.css';
import type { WeekResultsCard } from './types';

interface Props {
  data: WeekResultsCard | null;
  loading?: boolean;
  variant?: 'compact' | 'paywall';
}

const SVG_W = 220;
const SVG_H = 64;
const PAD_X = 6;
const PAD_Y = 6;

function buildPath(points: WeekResultsCard['paywallChart']['points']): string {
  if (points.length === 0) return '';
  const vals = points.map((p) => p.cumulativeReturnPct);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;
  const toX = (i: number) =>
    points.length === 1
      ? SVG_W / 2
      : PAD_X + (i / (points.length - 1)) * (SVG_W - PAD_X * 2);
  const toY = (v: number) =>
    SVG_H - PAD_Y - ((v - minV) / range) * (SVG_H - PAD_Y * 2);
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)} ${toY(p.cumulativeReturnPct).toFixed(1)}`)
    .join(' ');
}

export default function SignalWeekResultsCard({ data, loading = false, variant = 'compact' }: Props) {
  if (loading || !data) {
    return (
      <div className={styles.skeleton}>
        <div className={styles.skeletonLabel} />
        <div className={styles.skeletonChart} />
      </div>
    );
  }

  const { paywallChart, displayedStats, window: win } = data;
  const pts = paywallChart.points;
  const pathD = buildPath(pts);
  const finalRet = paywallChart.finalReturnPct;
  const retLabel =
    finalRet !== null
      ? finalRet >= 0
        ? `+${Math.round(finalRet)}%`
        : `${Math.round(finalRet)}%`
      : null;
  const isPositive = finalRet !== null && finalRet >= 0;
  const winRatio = displayedStats.winRatioLabel;

  const vals = pts.map((p) => p.cumulativeReturnPct);
  const minV = pts.length > 0 ? Math.min(0, ...vals) : 0;
  const maxV = pts.length > 0 ? Math.max(0, ...vals) : 1;
  const range = maxV - minV || 1;
  const zeroY = SVG_H - PAD_Y - ((0 - minV) / range) * (SVG_H - PAD_Y * 2);

  const lastPt =
    pts.length > 0
      ? {
          x:
            pts.length === 1
              ? SVG_W / 2
              : PAD_X + ((pts.length - 1) / (pts.length - 1)) * (SVG_W - PAD_X * 2),
          y:
            SVG_H -
            PAD_Y -
            ((pts[pts.length - 1].cumulativeReturnPct - minV) / range) * (SVG_H - PAD_Y * 2),
        }
      : null;

  return (
    <div className={[styles.card, variant === 'paywall' ? styles.cardPaywall : ''].join(' ').trim()}>
      <div className={styles.topRow}>
        <span className={styles.windowLabel}>{win.label}</span>
        {winRatio && <span className={styles.winRatio}>{winRatio}</span>}
      </div>

      {pts.length === 0 ? (
        <div className={styles.noData}>Signal history building…</div>
      ) : (
        <div className={[styles.chartWrap, variant === 'paywall' ? styles.chartWrapPaywall : ''].join(' ').trim()}>
          <svg
            className={styles.chartSvg}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="wrcGreenLine" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#72ff48" stopOpacity="0.8" />
                <stop offset="1" stopColor="#c8ff35" stopOpacity="1" />
              </linearGradient>
            </defs>
            <line
              x1={PAD_X}
              y1={zeroY.toFixed(1)}
              x2={SVG_W - PAD_X}
              y2={zeroY.toFixed(1)}
              className={styles.zeroLine}
            />
            {pathD && (
              <path d={pathD} className={styles.returnLine} stroke="url(#wrcGreenLine)" />
            )}
            {lastPt && (
              <circle
                cx={lastPt.x.toFixed(1)}
                cy={lastPt.y.toFixed(1)}
                r="3"
                className={styles.endDot}
              />
            )}
          </svg>

          {retLabel && (
            <div
              className={[styles.retBadge, isPositive ? styles.retPos : styles.retNeg].join(' ')}
            >
              {retLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
