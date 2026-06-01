'use client';

import { useState } from 'react';
import styles from './ResolvedSignalCard.module.css';
import type { ApiResolvedSignal } from './ResolvedSignalsCarousel';

// ── Helpers ──────────────────────────────────────────────────

function formatReturn(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct >= 0) return `+${Math.round(pct)}%`;
  return `−${Math.abs(Math.round(pct))}%`;
}

function formatOdds(american: string | null, european: number | null): string {
  if (american && european) return `${american} · ${european.toFixed(2)}x`;
  if (american) return american;
  if (european) return `${european.toFixed(2)}x`;
  return '—';
}

// ── Deterministic social-proof helpers ───────────────────────
// FNV-1a 32-bit — deterministic across server/client, no Math.random
function hashStableString(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

function getStableFollowerCount(seed: string): number {
  return 40 + (hashStableString(seed) % 161); // 40–200 inclusive
}

const PHRASES_WON = [
  'followers caught this',
  'bettors tailed this',
  'users tracked this',
  'members spotted this',
  'bettors backed this',
  'followers rode this',
];

const PHRASES_LOST = [
  'followers tracked this',
  'bettors watched this',
  'users saw this signal',
  'members reviewed this',
  'signal was tracked',
  'bettors logged this',
];

const PHRASES_NEUTRAL = [
  'signal tracked',
  'market watched',
  'followers tracked this',
  'members reviewed this',
];

function getStableSocialProofPhrase(seed: string, result: string): string {
  const h = hashStableString(seed + '|phrase');
  if (result === 'won') return PHRASES_WON[h % PHRASES_WON.length];
  if (result === 'lost') return PHRASES_LOST[h % PHRASES_LOST.length];
  return PHRASES_NEUTRAL[h % PHRASES_NEUTRAL.length];
}

// ── Main Card ────────────────────────────────────────────────

interface ResolvedSignalCardProps {
  signal: ApiResolvedSignal;
  defaultExpanded?: boolean;
}

export default function ResolvedSignalCard({ signal, defaultExpanded = false }: ResolvedSignalCardProps) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  const won = signal.result === 'won';
  const { trustMetrics } = signal;

  const oddsStr = formatOdds(signal.americanOdds, signal.europeanOdds);
  const returnStr = formatReturn(signal.returnPct);

  const seed = signal.id || signal.eventTitle || signal.pick;
  const followerCount = getStableFollowerCount(seed);
  const socialPhrase = getStableSocialProofPhrase(seed, signal.result);

  // Trust metric values (0–100 range — render null as 0)
  const smartMoney = trustMetrics?.smartMoney ?? 0;
  const whaleVsPublic = trustMetrics?.whaleVsPublicMoney ?? 0;
  const preEventAI = trustMetrics?.preEventScoreAI ?? 0;

  return (
    <article
      className={[styles.card, won ? styles.cardWon : styles.cardLost].join(' ')}
    >
      {/* Zone 1: Top bar */}
      <div className={styles.cardTop}>
        <div className={[styles.resultPill, won ? styles.resultPillWon : styles.resultPillLost].join(' ')}>
          {won ? '✓ WON' : '✕ LOST'}
        </div>
        <div className={[styles.sportBadge, won ? '' : styles.sportBadgeMuted].join(' ').trim()}>
          {signal.eventTitle}
        </div>
      </div>

      {/* Zone 2: Pick strip */}
      <div className={styles.scoreStrip}>
        <div className={styles.scoreRow}>
          <div className={[styles.teamHome, won ? styles.teamWinner : styles.teamLoser].join(' ')}>
            {signal.pick}
          </div>
          {signal.winner && signal.winner !== signal.pick && (
            <div className={styles.scoreBox}>
              <span className={styles.scoreNum + ' ' + styles.scoreNumWinner} title="Winner">
                ✓
              </span>
            </div>
          )}
          <div className={[styles.teamAway, !won ? styles.teamWinner : styles.teamLoser].join(' ')}>
            {signal.winner || '—'}
          </div>
        </div>
        <div className={styles.pickRow}>
          <span className={styles.pickLabel}>Odds</span>
          <span className={[styles.pickOdds, won ? '' : styles.pickOddsMuted].join(' ').trim()}>
            {oddsStr}
          </span>
        </div>
      </div>

      {/* Zone 3: Social proof row */}
      <div className={[styles.socialRow, won ? styles.socialRowWon : styles.socialRowLost].join(' ')}>
        <div className={styles.socialLeft}>
          <span className={styles.socialIcon}>👥</span>
          <span className={styles.socialText}>
            <strong>{followerCount}</strong> {socialPhrase}
          </span>
        </div>
        {returnStr && (
          <div className={[styles.socialReturn, won ? styles.socialReturnPos : styles.socialReturnNeg].join(' ')}>
            {returnStr}
          </div>
        )}
      </div>

      {/* Zone 4: Accordion trigger */}
      <button
        type="button"
        className={styles.accordionTrigger}
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
      >
        <span>Signal details</span>
        <span className={[styles.chevron, isOpen ? styles.chevronOpen : ''].join(' ').trim()}>
          ▾
        </span>
      </button>

      {/* Zone 5: Accordion body */}
      <div className={[styles.accordionBody, isOpen ? styles.accordionBodyOpen : ''].join(' ').trim()}>
        <div className={styles.accordionInner}>
          {signal.signalConfidence !== null && (
            <div className={styles.confRow}>
              <span className={styles.confLabel}>Signal Confidence</span>
              <span className={styles.confVal}>{signal.signalConfidence}</span>
            </div>
          )}
          {smartMoney > 0 && (
            <div className={styles.trustRow}>
              <div className={styles.trustName}>Smart Money</div>
              <div className={styles.trustBarWrap}>
                <div className={styles.trustBarFill} style={{ width: `${smartMoney}%` }} />
              </div>
              <div className={styles.trustNum}>{smartMoney}</div>
            </div>
          )}
          {whaleVsPublic > 0 && (
            <div className={styles.trustRow}>
              <div className={styles.trustName}>Whale vs Public</div>
              <div className={styles.trustBarWrap}>
                <div className={styles.trustBarFill} style={{ width: `${whaleVsPublic}%` }} />
              </div>
              <div className={styles.trustNum}>{whaleVsPublic}</div>
            </div>
          )}
          {preEventAI > 0 && (
            <div className={styles.trustRow}>
              <div className={styles.trustName}>Injury data & PreMatchPower</div>
              <div className={styles.trustBarWrap}>
                <div className={styles.trustBarFill} style={{ width: `${preEventAI}%` }} />
              </div>
              <div className={styles.trustNum}>{preEventAI}</div>
            </div>
          )}
          {signal.signalConfidence === null && smartMoney === 0 && whaleVsPublic === 0 && preEventAI === 0 && (
            <div className={styles.confRow}>
              <span className={styles.confLabel} style={{ opacity: 0.4 }}>No metrics available</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
