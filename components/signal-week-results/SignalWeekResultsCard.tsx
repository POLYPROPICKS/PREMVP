'use client';

import styles from './SignalWeekResultsCard.module.css';
import type { WeekResultsCard } from './types';

interface Props {
  data: WeekResultsCard | null;
  loading?: boolean;
  variant?: 'compact' | 'paywall';
}

const SVG_W = 220;
const SVG_H = 92;
const PAD_X = 12;
const PAD_Y_TOP = 18;
const PAD_Y_BOT = 16;
const MARGIN = 0.14;
const MAX_CHIPS = 5;

interface VisPt {
  x: number;
  y: number;
  cumRet: number;
  result: 'won' | 'lost' | 'baseline';
}

interface Segment {
  d: string;
  result: 'won' | 'lost';
}

interface FuturePt {
  x: number;
  y: number;
}

function fmtRet(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (r >= 0 ? '+' : '') + r + '%';
}

function buildChart(apiPts: WeekResultsCard['paywallChart']['points']): {
  pts: VisPt[];
  zeroY: number;
  segments: Segment[];
  futurePts: FuturePt[];
} {
  const raw = [
    { cumRet: 0, result: 'baseline' as const },
    ...apiPts.map((p) => ({ cumRet: p.cumulativeReturnPct, result: p.result })),
  ];

  const vals = raw.map((p) => p.cumRet);
  const rawMin = Math.min(0, ...vals);
  const rawMax = Math.max(0, ...vals);
  const rng = rawMax - rawMin || 1;
  const dMin = rawMin - rng * MARGIN;
  const dMax = rawMax + rng * MARGIN;
  const dRng = dMax - dMin;

  const futureCount = apiPts.length > 0 && apiPts.length < 3 ? 2 : 0;
  const slotCount = Math.max(2, raw.length + futureCount);

  const toX = (i: number) => PAD_X + (i / (slotCount - 1)) * (SVG_W - PAD_X * 2);
  const toY = (v: number) =>
    SVG_H - PAD_Y_BOT - ((v - dMin) / dRng) * (SVG_H - PAD_Y_TOP - PAD_Y_BOT);

  const pts: VisPt[] = raw.map((p, i) => ({
    x: toX(i),
    y: toY(p.cumRet),
    cumRet: p.cumRet,
    result: p.result,
  }));

  const segments: Segment[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    segments.push({
      d: `M${prev.x.toFixed(1)} ${prev.y.toFixed(1)} L${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`,
      result: cur.result === 'lost' ? 'lost' : 'won',
    });
  }

  const zeroY = toY(0);
  const futurePts: FuturePt[] = Array.from({ length: futureCount }, (_, i) => ({
    x: toX(raw.length + i),
    y: zeroY,
  }));

  return { pts, zeroY, segments, futurePts };
}

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

  const hasChart = apiPts.length > 0;
  const { pts: visPts, zeroY, segments, futurePts } = hasChart
    ? buildChart(apiPts)
    : { pts: [] as VisPt[], zeroY: SVG_H / 2, segments: [] as Segment[], futurePts: [] as FuturePt[] };

  const finalVisPt = visPts.length > 0 ? visPts[visPts.length - 1] : null;
  const innerPts = visPts.slice(1);
  const minVisPt = innerPts.length > 0
    ? innerPts.reduce((best, p) => (p.cumRet < best.cumRet ? p : best), innerPts[0])
    : null;
  const showMinLabel = minVisPt !== null && minVisPt.cumRet < 0;

  const xPct = (x: number) => `${((x / SVG_W) * 100).toFixed(1)}%`;
  const yPct = (y: number) => `${((y / SVG_H) * 100).toFixed(1)}%`;

  const chipPts = apiPts.slice(0, MAX_CHIPS);
  const placeholders = Math.max(0, 3 - chipPts.length);

  const wrapCls = [styles.chartWrap, variant === 'paywall' ? styles.chartWrapPaywall : '']
    .join(' ')
    .trim();

  return (
    <div className={[styles.card, variant === 'paywall' ? styles.cardPaywall : ''].join(' ').trim()}>
      <div className={styles.topRow}>
        <span className={styles.topLive}>
          <span className={styles.liveDot} aria-hidden="true" />
          PAST 7 DAYS
        </span>
      </div>

      <div className={styles.heroRow}>
        <div className={styles.heroLeft}>
          <span className={styles.heroMetric}>
            {displayedStats.displayedWon}/{displayedStats.displayedCount}
          </span>
          <span className={styles.heroSub}>WON</span>
        </div>

        {retLabel !== null && (
          <div className={styles.heroRight}>
            <span className={styles.heroLabel}>CUMULATIVE P&amp;L</span>
            <span className={[styles.heroVal, isPositive ? styles.heroValPos : styles.heroValNeg].join(' ')}>
              {retLabel}
            </span>
          </div>
        )}
      </div>

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
              <line
                x1={PAD_X}
                y1={zeroY.toFixed(1)}
                x2={SVG_W - PAD_X}
                y2={zeroY.toFixed(1)}
                className={styles.zeroLine}
              />

              {segments.map((seg, i) => (
                <path
                  key={i}
                  d={seg.d}
                  className={[
                    styles.returnLine,
                    seg.result === 'lost' ? styles.lossLine : styles.recoveryLine,
                  ].join(' ')}
                />
              ))}

              {futurePts.map((p, i) => (
                <circle key={`f-${i}`} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="1.6" className={styles.futureDot} />
              ))}

              {visPts.map((p, i) => {
                if (i === 0) {
                  return <circle key="start" cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="2.2" className={styles.startDot} />;
                }
                return (
                  <circle
                    key={i}
                    cx={p.x.toFixed(1)}
                    cy={p.y.toFixed(1)}
                    r={i === visPts.length - 1 ? '3.4' : '3.0'}
                    className={p.result === 'lost' ? styles.lossDot : styles.endDot}
                  />
                );
              })}
            </svg>

            <span className={styles.zeroLabel} style={{ top: yPct(Math.max(zeroY - 1, 0)) }}>
              0% START
            </span>

            {showMinLabel && minVisPt && (
              <span
                className={styles.lossLabel}
                style={{
                  left: xPct(minVisPt.x),
                  top: yPct(Math.min(minVisPt.y + 8, SVG_H - 8)),
                }}
              >
                {Math.round(minVisPt.cumRet)}%
              </span>
            )}

            {futurePts.length > 0 && (
              <span
                className={styles.futureLabel}
                style={{
                  left: xPct(futurePts[0].x),
                  top: yPct(Math.min(zeroY + 10, SVG_H - 8)),
                }}
              >
                FUTURE
              </span>
            )}

            {finalVisPt && retLabel !== null && (
              <span
                className={[styles.finalLabel, isPositive ? styles.finalLabelPos : styles.finalLabelNeg].join(' ')}
                style={{
                  right: `${Math.max(2, 100 - (finalVisPt.x / SVG_W) * 100).toFixed(1)}%`,
                  top: yPct(Math.max(finalVisPt.y - 13, 0)),
                }}
              >
                {retLabel}
              </span>
            )}
          </>
        )}
      </div>

      <div className={styles.chipsRow}>
        {chipPts.map((p, i) => (
          <span
            key={i}
            className={[styles.chip, p.result === 'won' ? styles.chipWon : styles.chipLost].join(' ')}
          >
            {p.result === 'won' ? '✓' : '✕'} {p.label}
          </span>
        ))}
        {Array.from({ length: placeholders }).map((_, i) => (
          <span key={`ph-${i}`} className={[styles.chip, styles.chipMore].join(' ')}>
            {i === 0 ? 'no data yet' : 'future'}
          </span>
        ))}
      </div>
    </div>
  );
}
