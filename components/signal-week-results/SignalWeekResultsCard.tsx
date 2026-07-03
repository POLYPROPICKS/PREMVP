'use client';

import styles from './SignalWeekResultsCard.module.css';
import type { WeekResultsCard, TrackRecordRow } from './types';

interface Props {
  data: WeekResultsCard | null;
  loading?: boolean;
  variant?: 'compact' | 'paywall' | 'top-carousel';
}

const SVG_W = 220;
const SVG_H = 92;
const PAD_X = 12;
const PAD_Y_TOP = 18;
const PAD_Y_BOT = 16;
const MARGIN = 0.14;
const MAX_CHIPS = 7;

interface VisPt {
  x: number;
  y: number;
  cumRet: number;
}

interface FuturePt {
  x: number;
  y: number;
}

function fmtUsd(v: number): string {
  const r = Math.round(v * 100) / 100;
  return (r >= 0 ? '+$' : '-$') + Math.abs(r).toFixed(2);
}

function buildChart(rows: TrackRecordRow[]): {
  pts: VisPt[];
  zeroY: number;
  segments: string[];
  futurePts: FuturePt[];
} {
  // Chronological order (oldest first) for a left-to-right cumulative line.
  const chronological = [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  let running = 0;
  const raw = [
    { cumRet: 0 },
    ...chronological.map((r) => {
      running = Math.round((running + r.projectedReturnUsd) * 100) / 100;
      return { cumRet: running };
    }),
  ];

  const vals = raw.map((p) => p.cumRet);
  const rawMin = Math.min(0, ...vals);
  const rawMax = Math.max(0, ...vals);
  const rng = rawMax - rawMin || 1;
  const dMin = rawMin - rng * MARGIN;
  const dMax = rawMax + rng * MARGIN;
  const dRng = dMax - dMin;

  const futureCount = chronological.length > 0 && chronological.length < 3 ? 2 : 0;
  const slotCount = Math.max(2, raw.length + futureCount);

  const toX = (i: number) => PAD_X + (i / (slotCount - 1)) * (SVG_W - PAD_X * 2);
  const toY = (v: number) =>
    SVG_H - PAD_Y_BOT - ((v - dMin) / dRng) * (SVG_H - PAD_Y_TOP - PAD_Y_BOT);

  const pts: VisPt[] = raw.map((p, i) => ({
    x: toX(i),
    y: toY(p.cumRet),
    cumRet: p.cumRet,
  }));

  const segments: string[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    segments.push(`M${prev.x.toFixed(1)} ${prev.y.toFixed(1)} L${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`);
  }

  const zeroY = toY(0);
  const futurePts: FuturePt[] = Array.from({ length: futureCount }, (_, i) => ({
    x: toX(raw.length + i),
    y: zeroY,
  }));

  return { pts, zeroY, segments, futurePts };
}

function cardRows(data: WeekResultsCard): TrackRecordRow[] {
  const table = data.trackRecordDisplayTable as unknown;
  return Array.isArray(table)
    ? table
    : ((table as { rows?: TrackRecordRow[] } | null | undefined)?.rows ?? []);
}

/** True when the card carries real renderable proof. Guards against the broken
 *  zero-state (+0% / 0% rate / avg odds 0.00) when the window has no usable
 *  data — those requests render the tracking fallback instead.
 *  A backend-declared `status: 'ready'` is authoritative (it is only ever set
 *  once real resolved rows exist) and is trusted directly rather than
 *  re-derived from resolvedCount/avgDecimalOdds — those can be legitimately
 *  0 (e.g. partial odds coverage) on an otherwise-ready card, which used to
 *  cause a ready card to fall through to the "loading" placeholder. */
function hasUsableProof(data: WeekResultsCard | null): boolean {
  if (!data) return false;
  if (data.status === 'ready') return cardRows(data).length > 0;
  if (data.status === 'insufficient_history') return false;
  return cardRows(data).length > 0 && data.resolvedCount > 0 && data.avgDecimalOdds > 0;
}

export default function SignalWeekResultsCard({ data, loading = false, variant = 'compact' }: Props) {
  if (variant === 'top-carousel') {
    return <TopCarouselCard data={data} loading={loading} />;
  }

  if (!loading && data && !hasUsableProof(data)) {
    return (
      <div className={[styles.card, variant === 'paywall' ? styles.cardPaywall : ''].join(' ').trim()}>
        <div className={styles.topRow}>
          <span className={styles.topLive}>
            <span className={styles.liveDot} aria-hidden="true" />
            TRACKING LIVE
          </span>
        </div>
        <div className={styles.chartWrap}>
          <div className={styles.noData}>Signal history loading…</div>
        </div>
      </div>
    );
  }

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

  const rows: TrackRecordRow[] = cardRows(data);
  const isPositive = data.projectedRoiPct >= 0;
  // Modal proof card is width-constrained: show whole-percent figures so the
  // hero metrics never overlap the paired stat. Other variants keep full precision.
  const roiDisplay = variant === 'paywall' ? Math.round(data.projectedRoiPct) : data.projectedRoiPct;
  const winRateDisplay = variant === 'paywall' ? Math.round(data.projectedWinRatePct) : data.projectedWinRatePct;
  const retLabel = `${isPositive ? '+' : ''}${roiDisplay}%`;

  const hasChart = rows.length > 0;
  const { pts: visPts, zeroY, segments, futurePts } = hasChart
    ? buildChart(rows)
    : { pts: [] as VisPt[], zeroY: SVG_H / 2, segments: [] as string[], futurePts: [] as FuturePt[] };

  const finalVisPt = visPts.length > 0 ? visPts[visPts.length - 1] : null;
  const innerPts = visPts.slice(1);
  const minVisPt = innerPts.length > 0
    ? innerPts.reduce((best, p) => (p.cumRet < best.cumRet ? p : best), innerPts[0])
    : null;
  const showMinLabel = minVisPt !== null && minVisPt.cumRet < 0;

  const xPct = (x: number) => `${((x / SVG_W) * 100).toFixed(1)}%`;
  const yPct = (y: number) => `${((y / SVG_H) * 100).toFixed(1)}%`;

  const chipRows = rows.slice(0, MAX_CHIPS);
  const placeholders = Math.max(0, 3 - chipRows.length);

  const wrapCls = [styles.chartWrap, variant === 'paywall' ? styles.chartWrapPaywall : '']
    .join(' ')
    .trim();

  return (
    <div className={[styles.card, variant === 'paywall' ? styles.cardPaywall : ''].join(' ').trim()}>
      <div className={styles.topRow}>
        <span className={styles.topLive}>
          <span className={styles.liveDot} aria-hidden="true" />
          {data.window.label.toUpperCase()}
        </span>
      </div>

      <div className={styles.heroRow}>
        <div className={styles.heroLeft}>
          <span className={styles.heroMetric}>{data.selectedSignals}</span>
          <span className={styles.heroSub}>PUBLISHED</span>
        </div>

        <div className={styles.heroRight}>
          <span className={styles.heroLabel}>PROJECTED RETURN</span>
          <span className={[styles.heroVal, isPositive ? styles.heroValPos : styles.heroValNeg].join(' ')}>
            {retLabel}
          </span>
        </div>
      </div>

      <div className={styles.heroRow}>
        <div className={styles.heroLeft}>
          <span className={styles.heroMetric}>{winRateDisplay}%</span>
          <span className={styles.heroSub}>PROJECTED RATE</span>
        </div>

        <div className={styles.heroRight}>
          <span className={styles.heroLabel}>AVG ODDS</span>
          <span className={styles.heroVal}>{data.avgDecimalOdds.toFixed(2)}</span>
        </div>
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

              {segments.map((d, i) => (
                <path key={i} d={d} className={[styles.returnLine, styles.recoveryLine].join(' ')} />
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
                    className={styles.endDot}
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
                {fmtUsd(minVisPt.cumRet)}
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

            {finalVisPt && (
              <span
                className={[styles.finalLabel, isPositive ? styles.finalLabelPos : styles.finalLabelNeg].join(' ')}
                style={{
                  right: `${Math.max(2, 100 - (finalVisPt.x / SVG_W) * 100).toFixed(1)}%`,
                  top: yPct(Math.max(finalVisPt.y - 13, 0)),
                }}
              >
                {fmtUsd(finalVisPt.cumRet)}
              </span>
            )}
          </>
        )}
      </div>

      <div className={styles.chipsRow}>
        {chipRows.map((r, i) => (
          <span key={i} className={[styles.chip, styles.chipWon].join(' ')}>
            {r.pick} · {r.returnLabel}
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

// ── Top-carousel variant ────────────────────────────────────────────────────

function TopCarouselRing({ rate }: { rate: number }) {
  const r = 25;
  const cx = 32;
  const cy = 32;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, rate / 100));
  const dash = circ * frac;

  return (
    <svg width="64" height="64" viewBox="0 0 64 64" className={styles.tcRing} aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="4" />
      {rate > 0 && (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#74ff4f"
          strokeWidth="5.4"
          strokeDasharray={`${dash.toFixed(2)} ${circ.toFixed(2)}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ filter: 'drop-shadow(0 0 5px rgba(116,255,79,0.75))' }}
        />
      )}
      <text
        x={cx}
        y={cy - 3}
        textAnchor="middle"
        fill="#ffffff"
        fontSize="14.2"
        fontWeight="900"
        letterSpacing="-0.05em"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {Math.round(rate)}%
      </text>
      <text
        x={cx}
        y={cy + 9}
        textAnchor="middle"
        fill="rgba(116,255,79,0.92)"
        fontSize="7.4"
        fontWeight="900"
        letterSpacing="0.11em"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        PROJECTED
      </text>
    </svg>
  );
}

function TopCarouselCard({ data, loading }: { data: WeekResultsCard | null; loading: boolean }) {
  if (loading || !data) {
    return (
      <div className={styles.tcSkeleton}>
        <div className={styles.tcSkeletonBody} />
        <div className={styles.tcSkeletonChips} />
      </div>
    );
  }

  const isPos = data.projectedRoiPct >= 0;
  const retLabel = `${isPos ? '+' : ''}${data.projectedRoiPct}%`;
  const displayRows = cardRows(data).slice(0, 7);

  return (
    <div className={styles.cardTopCarousel}>
      <div className={styles.tcBody}>
        <TopCarouselRing rate={data.projectedWinRatePct} />

        <div className={styles.tcCopy}>
          <div className={styles.tcTopLine}>
            <div className={styles.tcMetaPills}>
              <span className={styles.tcLivePill}>
                <span className={styles.tcLiveDot} aria-hidden="true" />
                LIVE TRACKING
              </span>
              <span className={styles.tcPeriodPill}>{data.window.label}</span>
            </div>
          </div>

          <div className={styles.tcMetricLine}>
            <span className={styles.tcReturnLabel}>PROJECTED RETURN</span>
            <span className={[styles.tcReturn, !isPos ? styles.tcReturnNeg : ''].join(' ').trim()}>
              {retLabel}
            </span>
          </div>
        </div>
      </div>

      {displayRows.length > 0 && (
        <div className={styles.tcChipsRow}>
          {displayRows.map((r, i) => (
            <span key={i} className={[styles.tcChip, styles.tcChipWon].join(' ')}>
              {r.pick} · {r.returnLabel}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
