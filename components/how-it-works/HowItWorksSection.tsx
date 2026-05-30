// components/how-it-works/HowItWorksSection.tsx
// Production_Howitworks — static · no state · no fetch · inline SVG only

import type { ReactNode } from 'react';
import styles from './HowItWorksSection.module.css';

type HowItWorksSectionProps = { onCtaClick: () => void };

// ── Proof-cell illustrations ───────────────────────────────────────────────────

function EarlyMoveIllustration() {
  return (
    <svg viewBox="0 0 160 80" className={styles.illSvg} aria-hidden="true">
      {/* grid */}
      {[20, 40, 60].map(y => (
        <line key={y} x1="12" y1={y} x2="148" y2={y} stroke="rgba(24,231,255,0.10)" strokeWidth="0.7" />
      ))}
      {[40, 80, 120].map(x => (
        <line key={x} x1={x} y1="8" x2={x} y2="68" stroke="rgba(24,231,255,0.07)" strokeWidth="0.7" />
      ))}
      {/* area fill */}
      <polygon
        points="12,66 30,62 50,58 72,50 92,40 112,28 132,16 148,10 148,68 12,68"
        fill="rgba(24,231,255,0.06)"
      />
      {/* line */}
      <polyline
        points="12,66 30,62 50,58 72,50 92,40 112,28 132,16 148,10"
        fill="none" stroke="#18e7ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* NOW marker */}
      <line x1="112" y1="28" x2="112" y2="69" stroke="#86ff5a" strokeWidth="1.4" strokeDasharray="2.5,2" />
      {/* glow dot */}
      <circle cx="112" cy="28" r="5.5" fill="rgba(24,231,255,0.18)" />
      <circle cx="112" cy="28" r="3.2" fill="#18e7ff" />
      {/* arrow */}
      <path d="M144 7 L152 7 L148 2 Z" fill="#18e7ff" />
      {/* labels */}
      <text x="32"  y="77" fontSize="9" fill="rgba(160,210,230,0.50)" textAnchor="middle">-4h</text>
      <text x="72"  y="77" fontSize="9" fill="rgba(160,210,230,0.50)" textAnchor="middle">-2h</text>
      <text x="112" y="77" fontSize="9" fill="#86ff5a" textAnchor="middle">NOW</text>
    </svg>
  );
}

function RiskLayerIllustration() {
  return (
    <svg viewBox="0 0 160 80" className={styles.illSvg} aria-hidden="true">
      {/* outer orbit ring */}
      <circle cx="80" cy="40" r="33" fill="none" stroke="rgba(24,231,255,0.13)" strokeWidth="1.2" />
      {/* inner orbit ring */}
      <circle cx="80" cy="40" r="22" fill="none" stroke="rgba(24,231,255,0.09)" strokeWidth="0.8" strokeDasharray="2.5,3" />
      {/* ambient glow behind shield */}
      <circle cx="80" cy="40" r="13" fill="rgba(251,191,36,0.07)" />
      {/* shield body */}
      <path d="M80 22 L94 27.5v9.5c0 9.5-5.5 15.5-14 18.5-8.5-3-14-9-14-18.5v-9.5L80 22Z"
        fill="rgba(10,16,28,0.85)" stroke="rgba(251,191,36,0.75)" strokeWidth="1.6"
        filter="url(#sglow)" />
      {/* shield inner fill */}
      <path d="M80 25.5 L91 30v8c0 7.5-4.5 12.5-11 15-6.5-2.5-11-7.5-11-15v-8L80 25.5Z"
        fill="rgba(251,191,36,0.10)" />
      {/* medical cross */}
      <rect x="77.2" y="30" width="5.5" height="14" rx="1.8" fill="#fbbf24" opacity="0.95" />
      <rect x="73.5" y="33.5" width="13" height="5.5" rx="1.8" fill="#fbbf24" opacity="0.95" />
      {/* subtle shield glow lines */}
      <filter id="sglow"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      {/* connector lines to nodes */}
      <line x1="48" y1="26" x2="66" y2="33" stroke="rgba(24,231,255,0.18)" strokeWidth="0.9" />
      <line x1="112" y1="26" x2="94" y2="33" stroke="rgba(24,231,255,0.18)" strokeWidth="0.9" />
      <line x1="80" y1="67" x2="80" y2="57" stroke="rgba(24,231,255,0.14)" strokeWidth="0.9" />
      {/* LEFT node — person/user */}
      <circle cx="40" cy="21" r="9" fill="rgba(6,14,26,0.97)" stroke="rgba(24,231,255,0.50)" strokeWidth="1.3" />
      {/* person: head */}
      <circle cx="40" cy="17.5" r="2.6" fill="rgba(24,231,255,0.00)" stroke="#18e7ff" strokeWidth="1.2" />
      {/* person: body arc */}
      <path d="M34.5 26 C34.5 22.5 37 21 40 21 C43 21 45.5 22.5 45.5 26" stroke="#18e7ff" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      {/* TOP-RIGHT node — document/list */}
      <circle cx="120" cy="21" r="9" fill="rgba(6,14,26,0.97)" stroke="rgba(24,231,255,0.50)" strokeWidth="1.3" />
      {/* doc rect */}
      <rect x="115.5" y="16" width="9" height="10" rx="1.5" fill="none" stroke="#18e7ff" strokeWidth="1.1" />
      {/* doc lines */}
      <line x1="117" y1="19.5" x2="123" y2="19.5" stroke="#18e7ff" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="117" y1="22"   x2="123" y2="22"   stroke="#18e7ff" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="117" y1="24"   x2="121" y2="24"   stroke="rgba(24,231,255,0.50)" strokeWidth="0.9" strokeLinecap="round" />
      {/* BOTTOM node — pulse/health */}
      <circle cx="80" cy="71" r="9" fill="rgba(6,14,26,0.97)" stroke="rgba(24,231,255,0.50)" strokeWidth="1.3" />
      {/* pulse line */}
      <polyline points="72,71 75,71 77,66.5 79.5,75.5 82,68 84.5,71 88,71"
        fill="none" stroke="#18e7ff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WhaleFlowIllustration() {
  return (
    <svg viewBox="0 0 160 80" className={styles.illSvg} aria-hidden="true">
      <defs>
        <radialGradient id="sglow2" cx="42%" cy="50%" r="48%">
          <stop offset="0%" stopColor="#18e7ff" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#18e7ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* outer ring */}
      <circle cx="66" cy="40" r="32" fill="rgba(24,231,255,0.03)" stroke="rgba(24,231,255,0.16)" strokeWidth="1.2" />
      {/* ambient glow */}
      <circle cx="66" cy="40" r="28" fill="url(#sglow2)" />
      {/* shark body — sleek torpedo silhouette */}
      <path
        d="M20 42 C24 35 36 30 52 31 C62 31 70 28 80 30 C88 31 94 29 98 31 C90 37 82 35 74 36 C66 37 60 40 56 44 C50 49 38 52 26 48 C21 46 19 44 20 42 Z"
        fill="none" stroke="rgba(24,231,255,0.70)" strokeWidth="1.4"
      />
      {/* dorsal fin */}
      <path d="M58 31 C60 22 66 18 70 22 L70 31 Z"
        fill="none" stroke="rgba(24,231,255,0.65)" strokeWidth="1.3" />
      {/* tail */}
      <path d="M20 43 C14 38 8 34 10 28 M20 43 C14 48 8 52 10 58"
        fill="none" stroke="rgba(24,231,255,0.55)" strokeWidth="1.3" strokeLinecap="round" />
      {/* pectoral fin */}
      <path d="M52 36 C50 42 44 46 40 44 C46 40 50 38 52 36 Z"
        fill="rgba(24,231,255,0.22)" stroke="rgba(24,231,255,0.45)" strokeWidth="0.8" />
      {/* eye dot */}
      <circle cx="88" cy="32" r="1.8" fill="rgba(24,231,255,0.80)" />
      {/* speed lines / wake */}
      <line x1="10" y1="36" x2="20" y2="36" stroke="rgba(24,231,255,0.22)" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="8"  y1="40" x2="19" y2="40" stroke="rgba(24,231,255,0.16)" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="10" y1="44" x2="20" y2="44" stroke="rgba(24,231,255,0.12)" strokeWidth="0.8" strokeLinecap="round" />
      {/* market bars */}
      <rect x="104" y="58" width="7" height="14" rx="2" fill="rgba(134,255,90,0.45)" />
      <rect x="114" y="50" width="7" height="22" rx="2" fill="rgba(134,255,90,0.65)" />
      <rect x="124" y="40" width="7" height="32" rx="2" fill="rgba(134,255,90,0.88)" />
      <rect x="134" y="32" width="7" height="40" rx="2" fill="rgba(134,255,90,1.00)" />
    </svg>
  );
}

function SharpCheckIllustration() {
  return (
    <svg viewBox="0 0 160 80" className={styles.illSvg} aria-hidden="true">
      {/* outer ring */}
      <circle cx="80" cy="40" r="33" fill="none" stroke="rgba(24,231,255,0.13)" strokeWidth="1.2" />
      {/* mid ring */}
      <circle cx="80" cy="40" r="22" fill="none" stroke="rgba(24,231,255,0.18)" strokeWidth="1" />
      {/* inner ring — target */}
      <circle cx="80" cy="40" r="12" fill="rgba(24,231,255,0.05)" stroke="rgba(24,231,255,0.40)" strokeWidth="1.4" />
      {/* crosshair lines */}
      <line x1="80" y1="4"  x2="80" y2="20"  stroke="rgba(24,231,255,0.32)" strokeWidth="1" strokeLinecap="round" />
      <line x1="80" y1="60" x2="80" y2="76"  stroke="rgba(24,231,255,0.32)" strokeWidth="1" strokeLinecap="round" />
      <line x1="42" y1="40" x2="58" y2="40"  stroke="rgba(24,231,255,0.32)" strokeWidth="1" strokeLinecap="round" />
      <line x1="102" y1="40" x2="118" y2="40" stroke="rgba(24,231,255,0.32)" strokeWidth="1" strokeLinecap="round" />
      {/* center dot */}
      <circle cx="80" cy="40" r="3" fill="rgba(24,231,255,0.20)" stroke="rgba(24,231,255,0.60)" strokeWidth="1" />
      {/* cyan checkmark — crisp, prominent */}
      <path d="M72.5 40.5 L77.5 46 L89 33.5"
        stroke="#18e7ff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* connector lines */}
      <line x1="36" y1="20" x2="60" y2="32" stroke="rgba(24,231,255,0.15)" strokeWidth="0.8" />
      <line x1="124" y1="20" x2="100" y2="32" stroke="rgba(24,231,255,0.15)" strokeWidth="0.8" />
      <line x1="36" y1="60" x2="60" y2="48" stroke="rgba(24,231,255,0.15)" strokeWidth="0.8" />
      <line x1="124" y1="60" x2="100" y2="48" stroke="rgba(24,231,255,0.15)" strokeWidth="0.8" />
      {/* 4 user/person nodes — index 0 is the sharp/gold signal node */}
      {([
        [28, 16],
        [132, 16],
        [28, 64],
        [132, 64],
      ] as [number,number][]).map(([cx, cy], i) => {
        const gold = i === 0;
        const ring  = gold ? 'rgba(251,191,36,0.65)' : 'rgba(24,231,255,0.48)';
        const icon  = gold ? '#fbbf24'               : '#18e7ff';
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r="9"
              fill={gold ? 'rgba(12,10,4,0.97)' : 'rgba(6,14,26,0.97)'}
              stroke={ring} strokeWidth="1.3" />
            {gold && <circle cx={cx} cy={cy} r="9" fill="rgba(251,191,36,0.06)" />}
            {/* person head */}
            <circle cx={cx} cy={cy - 3} r="2.5" fill="none" stroke={icon} strokeWidth="1.1" />
            {/* person body arc */}
            <path d={`M${cx-4.5} ${cy+6} C${cx-4.5} ${cy+2.5} ${cx-2} ${cy+1} ${cx} ${cy+1} C${cx+2} ${cy+1} ${cx+4.5} ${cy+2.5} ${cx+4.5} ${cy+6}`}
              stroke={icon} strokeWidth="1.1" fill="none" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}

// ── Proof grid ─────────────────────────────────────────────────────────────────

const PROOF_CELLS = [
  { n: '01', title: 'Early Move',  value: '2–4h before odds shift',  Ill: EarlyMoveIllustration },
  { n: '02', title: 'Risk Layer',  value: 'Injury + lineup checks',   Ill: RiskLayerIllustration },
  { n: '03', title: 'Whale Flow',  value: 'Live Polymarket moves',    Ill: WhaleFlowIllustration },
  { n: '04', title: 'Sharp Check', value: 'Consensus validation',     Ill: SharpCheckIllustration },
] as const;

function ProofCell({ n, title, value, Ill }: { n: string; title: string; value: string; Ill: () => ReactNode }) {
  return (
    <div className={styles.proofCell}>
      <div className={styles.proofHeader}>
        <span className={styles.proofNum}>{n}</span>
        <span className={styles.proofTitle}>{title}</span>
      </div>
      <div className={styles.proofIll}><Ill /></div>
      <div className={styles.proofValue}>{value}</div>
    </div>
  );
}

// ── Engine icons ───────────────────────────────────────────────────────────────

const IcoOdds  = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="rgba(24,231,255,0.60)" strokeWidth="1.3"/><path d="M8 5v3l2 1.2" stroke="#18e7ff" strokeWidth="1.4" strokeLinecap="round"/></svg>;
const IcoMove  = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><polyline points="2,12 5,8 9,10 14,4" stroke="rgba(134,255,90,0.8)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><polyline points="11,4 14,4 14,7" stroke="rgba(134,255,90,0.8)" strokeWidth="1.5" strokeLinecap="round"/></svg>;
const IcoShark = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 10c4-8 8-3 12-6-4 2-5 6-7 9-2 3-6 4-8 2 2-1 3-2 3-3-2 0-4-1-5-2z" fill="rgba(24,231,255,0.70)"/></svg>;
const IcoWhale = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8c1-4 6-5 9-2.5 2 1.5 3.5 1 4.5 1.5-2 1.5-3.5 1-5 1.5-1 .3-1.5 2.5-3 3.5C6 13 2 12 2 10c1-.5 2-1 1-2z" fill="rgba(251,191,36,0.70)"/></svg>;
const IcoDB    = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><ellipse cx="8" cy="5" rx="5.5" ry="2" stroke="rgba(134,255,90,0.60)" strokeWidth="1.2"/><path d="M2.5 5v6c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5" stroke="rgba(134,255,90,0.60)" strokeWidth="1.2"/><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" stroke="rgba(134,255,90,0.38)" strokeWidth="1"/></svg>;

const ENGINE_BARS = [
  { label: 'Odds Quality',    v: 86, Ico: IcoOdds  },
  { label: 'Market Movement', v: 82, Ico: IcoMove  },
  { label: 'Sharp Flow',      v: 78, Ico: IcoShark },
  { label: 'Public / Whale',  v: 64, Ico: IcoWhale, amber: true },
  { label: 'Data Coverage',   v: 88, Ico: IcoDB    },
];

function EngineBar({ label, v, Ico, amber }: { label: string; v: number; Ico: () => ReactNode; amber?: boolean }) {
  const fill = amber
    ? 'linear-gradient(90deg,#f59e0b,#fcd34d)'
    : v >= 84
    ? 'linear-gradient(90deg,#18e7ff,#61ef4a)'
    : 'linear-gradient(90deg,#18e7ff,#56c5d0)';
  return (
    <div className={styles.barRow}>
      <span className={styles.barIco}><Ico /></span>
      <span className={styles.barLabel}>{label}</span>
      <div className={styles.barTrack}><div className={styles.barFill} style={{ width: `${v}%`, background: fill }} /></div>
      <span className={styles.barVal} style={amber ? { color: '#fbbf24' } : undefined}>{v}</span>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function HowItWorksSection({ onCtaClick }: HowItWorksSectionProps) {
  const deg = Math.round(81 / 100 * 360);
  return (
    <section id="how-it-works" className={styles.section} aria-label="How It Works">

      <div className={styles.hdr}>
        <h2 className={styles.hdrTitle}>HOW IT WORKS</h2>
      </div>

      <div className={styles.grid} role="list">
        {PROOF_CELLS.map(c => (
          <div key={c.n} role="listitem">
            <ProofCell {...c} />
          </div>
        ))}
      </div>

      <div className={styles.engine} aria-label="Signal Confidence Engine">
        <div className={styles.engTitle}>SIGNAL CONFIDENCE ENGINE</div>
        <div className={styles.engBody}>
          <div className={styles.ringCol}>
            <div className={styles.ring}
              style={{ background: `conic-gradient(#18e7ff 0deg ${deg}deg, rgba(255,255,255,0.07) ${deg}deg 360deg)` }}>
              <div className={styles.ringIn}>
                <span className={styles.ringN}>81</span>
                <span className={styles.ringD}>/100</span>
              </div>
            </div>
            <div className={styles.highConf}>HIGH CONFIDENCE</div>
          </div>
          <div className={styles.bars}>
            {ENGINE_BARS.map(b => <EngineBar key={b.label} label={b.label} v={b.v} Ico={b.Ico} amber={b.amber} />)}
          </div>
        </div>
        <div className={styles.chips}>
          <div className={styles.chip}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.5L13.5 4v4.5c0 4-2.5 6.5-5.5 7.5-3-1-5.5-3.5-5.5-7.5V4Z" stroke="rgba(251,191,36,0.65)" strokeWidth="1.3" fill="rgba(251,191,36,0.10)"/>
              <rect x="6.5" y="5" width="3" height="5.5" rx="1" fill="#fbbf24"/>
              <rect x="4.5" y="7" width="7" height="3" rx="1" fill="#fbbf24"/>
            </svg>
            <div><div className={styles.chipLbl}>Injury Prematch Analysis</div><div className={styles.chipVal} style={{color:'#86ff5a'}}>Risk Lower</div></div>
          </div>
          <div className={styles.chip}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" stroke="rgba(24,231,255,0.55)" strokeWidth="1.2"/>
              <circle cx="8" cy="8" r="3.5" stroke="rgba(24,231,255,0.30)" strokeWidth="1"/>
              <circle cx="8" cy="8" r="1.2" fill="#18e7ff"/>
              <line x1="8" y1="1" x2="8" y2="3.5" stroke="rgba(24,231,255,0.45)" strokeWidth="1"/>
              <line x1="8" y1="12.5" x2="8" y2="15" stroke="rgba(24,231,255,0.45)" strokeWidth="1"/>
              <line x1="1" y1="8" x2="3.5" y2="8" stroke="rgba(24,231,255,0.45)" strokeWidth="1"/>
              <line x1="12.5" y1="8" x2="15" y2="8" stroke="rgba(24,231,255,0.45)" strokeWidth="1"/>
            </svg>
            <div><div className={styles.chipLbl}>Sharp Consensus</div><div className={styles.chipVal} style={{color:'#18e7ff'}}>STRONG</div></div>
          </div>
        </div>
      </div>

      <div className={styles.strip}>
        <div className={styles.stripMotto}>ONE MARKET. ONE SCORE. ONE ACTION.</div>
        <div className={styles.stripPills}>
          {[
            { label:'ENTER', cls:styles.pEnter, icon:<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13L13 3M7 3h6v6" stroke="#86ff5a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
            { label:'SMALL', cls:styles.pSmall, icon:<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="9" width="3" height="5" rx="1" fill="#18e7ff" opacity="0.55"/><rect x="6.5" y="6" width="3" height="8" rx="1" fill="#18e7ff" opacity="0.78"/><rect x="11" y="3" width="3" height="11" rx="1" fill="#18e7ff"/></svg> },
            { label:'WATCH', cls:styles.pWatch, icon:<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1 8C3 4 6 2 8 2s5 2 7 6c-2 4-5 6-7 6S3 12 1 8Z" stroke="#fbbf24" strokeWidth="1.4"/><circle cx="8" cy="8" r="2.5" fill="#fbbf24" opacity="0.9"/><circle cx="8" cy="8" r="1" fill="#06220b"/></svg> },
            { label:'SKIP',  cls:styles.pSkip,  icon:<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="rgba(255,255,255,0.26)" strokeWidth="1.3"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="rgba(255,255,255,0.40)" strokeWidth="1.5" strokeLinecap="round"/></svg> },
          ].map(p => (
            <div key={p.label} className={`${styles.pill} ${p.cls}`}>
              {p.icon}
              <span>{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      <button type="button" className={styles.cta} onClick={onCtaClick}>
        Unlock +14 More Signals
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>

    </section>
  );
}
