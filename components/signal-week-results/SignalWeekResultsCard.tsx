'use client';

import styles from './SignalWeekResultsCard.module.css';
import type { WeekResultsCard } from './types';

interface Props {
  data: WeekResultsCard | null;
  loading?: boolean;
  variant?: 'compact' | 'paywall';
}

const SVG_W = 220;
const SVG_H = 78;
const PAD_X = 12;
const PAD_Y_TOP = 16;
const PAD_Y_BOT = 10;
const MARGIN = 0.12;

interface VisPt {
  x: number;
  y: number;
  cumRet: number;
  result: 'won' | 'lost' | 'baseline';
}

function buildChart(apiPts: WeekResultsCard['paywallChart']['points']): {
  pts: VisPt[];
  zeroY: number;
  pathD: string;
} {
  // prepend visual baseline 0 — never mutates API data
  const raw = [
    { cumRet: 0, result: 'baseline' as const },
    ...apiPts.map((p) => ({ cumRet: p.cumulativeReturnPct, result: p.result as 'won' | 'lost' })),
  ];
  const vals = raw.map((p) => p.cumRet);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const rng = rawMax - rawMin || 1;
  const dMin = rawMin - rng * MARGIN;
  const dMax = rawMax + rng * MARGIN;
  const dRng = dMax - dMin;
  const toX = (i: number) =>
    raw.length === 1 ? SVG_W / 2 : PAD_X + (i / (raw.length - 1)) * (SVG_W - PAD_X * 2);
  const toY = (v: number) =>
    SVG_H - PAD_Y_BOT - ((v - dMin) / dRng) * (SVG_H - PAD_Y_TOP - PAD_Y_BOT);
  const pts: VisPt[] = raw.map((p, i) => ({
    x: toX(i),
    y: toY(p.cumRet),
    cumRet: p.cumRet,
    result: p.result,
  }));
  const zeroY = toY(0);
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return { pts, zeroY, pathD };
}

function fmtRet(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (r >= 0 ? '+' : '') + r + '%';
}

const MAX_CHIPS = 5;

export default function SignalWeekResultsCard({ data, loading = false, variant = 'compact' }: Props) {
  if (loading || !data) {
    return (
      <div className={styles.skeleton}>
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonHero} />
        <div className={styles.skeletonChart} />
        <div className={styles.skeletonChips} />
      </div>
    );
  }

  const { paywallChart, displayedStats } = data;
  const apiPts = paywallChart.points;
  const finalRet = paywallChart.finalReturnPct;
  const isPositive = finalRet !== null && finalRet >= 0;
  const retLabel = finalRet !== null ? fmtRet(finalRet) : null;

  const sampleLabel =
    displayedStats.displayedCount < 5
      ? `EARLY SAMPLE · N=${displayedStats.displayedCount}`
      : 'RESOLVED TRACKING';

  const hasChart = apiPts.length > 0;
  const { pts: visPts, zeroY, pathD } = hasChart
    ? buildChart(apiPts)
    : { pts: [] as VisPt[], zeroY: SVG_H / 2, pathD: '' };

  const finalVisPt = visPts.length > 0 ? visPts[visPts.length - 1] : null;

  // find the deepest loss point (not baseline, not final)
  const minIdx =
    visPts.length > 2
      ? visPts
          .slice(1, -1)
          .reduce((bi, p, i) => (p.cumRet < visPts.slice(1, -1)[bi].cumRet ? i : bi), 0) + 1
      : -1;
  const minVisPt = minIdx > 0 ? visPts[minIdx] : null;
  const showMinLabel = minVisPt !== null && minVisPt.cumRet < 0;

  // %-based helpers for absolutely-positioned labels (work with preserveAspectRatio="none")
  const xPct = (x: number) => `${((x / SVG_W) * 100).toFixed(1)}%`;
  const yPct = (y: number) => `${((y / SVG_H) * 100).toFixed(1)}%`;

  const chipPts = apiPts.slice(0, MAX_CHIPS);
  const placeholders = Math.max(0, 3 - chipPts.length);

  const wrapCls = [styles.chartWrap, variant === 'paywall' ? styles.chartWrapPaywall : '']
    .join(' ')
    .trim();

  return (
    <div className={[styles.card, variant === 'paywall' ? styles.cardPaywall : ''].join(' ').trim()}>

      {/* Row 1: status bar */}
      <div className={styles.topRow}>
        <span className={styles.topLive}>
          <span className={styles.liveDot} aria-hidden="true" />
          PAST 7 DAYS
        </span>
        <span className={styles.topSample}>{sampleLabel}</span>
      </div>

      {/* Row 2: hero metrics */}
      <div className={styles.heroRow}>
        <div className={styles.heroLeft}>
          <span className={styles.heroMetric}>
            {displayedStats.displayedWon}/{displayedStats.displayedCount}
          </span>
          <span className={styles.heroSub}>WON</span>
        </div>
        {retLabel !== null && (
          <div className={styles.heroRight}>
            <span className={styles.heroLabel}>TOTAL RETURN</span>
            <span
              className={[
                styles.heroVal,
                isPositive ? styles.heroValPos : styles.heroValNeg,
              ].join(' ')}
            >
              {retLabel}
            </span>
          </div>
        )}
      </div>

      {/* Row 3: chart */}
      <div className={wrapCls}>
        {!hasChart ? (
          <div className={styles.noData}>Signal history building…</div>
        ) : (
          <>
            <svg
              className={styles.chartSvg}
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="wrcLine" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor="#72ff48" stopOpacity="0.82" />
                  <stop offset="1" stopColor="#c8ff35" stopOpacity="1" />
                </linearGradient>
              </defs>
              {/* zero dashed baseline */}
              <line
                x1={PAD_X}
                y1={zeroY.toFixed(1)}
                x2={SVG_W - PAD_X}
                y2={zeroY.toFixed(1)}
                className={styles.zeroLine}
              />
              {/* cumulative return path */}
              {pathD && (
                <path d={pathD} className={styles.returnLine} stroke="url(#wrcLine)" />
              )}
              {/* loss dot */}
              {showMinLabel && minVisPt && (
                <circle
                  cx={minVisPt.x.toFixed(1)}
                  cy={minVisPt.y.toFixed(1)}
                  r="2.5"
                  className={styles.lossDot}
                />
              )}
              {/* end dot */}
              {finalVisPt && (
                <circle
                  cx={finalVisPt.x.toFixed(1)}
                  cy={finalVisPt.y.toFixed(1)}
                  r="3"
                  className={styles.endDot}
                />
              )}
            </svg>

            {/* 0% START label — above zero line */}
            <span
              className={styles.zeroLabel}
              style={{ top: yPct(Math.max(zeroY - 1, 0)) }}
            >
              0% START
            </span>

            {/* loss label — below loss dot */}
            {showMinLabel && minVisPt && (
              <span
                className={styles.lossLabel}
                style={{
                  left: xPct(minVisPt.x),
                  top: yPct(Math.min(minVisPt.y + 2, 88)),
                }}
              >
                {Math.round(minVisPt.cumRet)}%
              </span>
            )}

            {/* final return label — above end dot */}
            {finalVisPt && retLabel !== null && (
              <span
                className={[
                  styles.finalLabel,
                  isPositive ? styles.finalLabelPos : styles.finalLabelNeg,
                ].join(' ')}
                style={{
                  right: `${(100 - (finalVisPt.x / SVG_W) * 100).toFixed(1)}%`,
                  top: yPct(Math.max(finalVisPt.y - 14, 0)),
                }}
              >
                {retLabel}
              </span>
            )}
          </>
        )}
      </div>

      {/* Row 4: chips */}
      <div className={styles.chipsRow}>
        {chipPts.map((p, i) => (
          <span
            key={i}
            className={[
              styles.chip,
              p.result === 'won' ? styles.chipWon : styles.chipLost,
            ].join(' ')}
          >
            {p.result === 'won' ? '✓' : '✕'} {p.label}
          </span>
        ))}
        {Array.from({ length: placeholders }).map((_, i) => (
          <span key={`ph-${i}`} className={[styles.chip, styles.chipMore].join(' ')}>
            · —
          </span>
        ))}
      </div>

    </div>
  );
}
