'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import styles from './ResolvedSignalsCarousel.module.css';
import ResolvedSignalCard from './ResolvedSignalCard';

const CARD_WIDTH = 330;
const CARD_GAP = 12;
const PUSH_RESULTS = new Set(['push', 'refund', 'tie', 'void', 'cancelled', 'no_contest']);
const MAX_CARDS = 7;
const MAX_LOST = 1;

// Shape returned by /api/signals/resolved?mode=latest
export interface ApiResolvedSignal {
  id: string;
  eventTitle: string;
  pick: string;
  winner: string;
  result: string;         // "won" | "lost"
  returnPct: number | null;
  europeanOdds: number | null;
  americanOdds: string | null;
  signalConfidence: number | null;
  trustMetrics: {
    smartMoney: number | null;
    whaleVsPublicMoney: number | null;
    preEventScoreAI: number | null;
  };
  marketActivityScore: number | null;
  marketActivityLabel: string | null;
  resolvedAt: string;
}

/** Client-side safety filter: mirrors API rules in case API changes. */
function applyClientFilter(raw: ApiResolvedSignal[]): ApiResolvedSignal[] {
  const filtered = raw.filter((s) => !PUSH_RESULTS.has(s.result));
  const out: ApiResolvedSignal[] = [];
  let lostCount = 0;
  for (const s of filtered) {
    if (out.length >= MAX_CARDS) break;
    if (s.result === 'lost') {
      if (lostCount >= MAX_LOST) continue;
      lostCount++;
    }
    out.push(s);
  }
  return out;
}

export default function ResolvedSignalsCarousel() {
  const carouselRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [signals, setSignals] = useState<ApiResolvedSignal[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/signals/resolved?mode=latest&days=7&limit=7')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok || !Array.isArray(json.signals)) {
          setStatus('error');
          return;
        }
        const safe = applyClientFilter(json.signals as ApiResolvedSignal[]);
        setSignals(safe);
        setStatus(safe.length > 0 ? 'ok' : 'empty');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  const handleScroll = useCallback(() => {
    const el = carouselRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / (CARD_WIDTH + CARD_GAP));
    setActiveIndex(Math.max(0, Math.min(signals.length - 1, idx)));
  }, [signals.length]);

  // Don't render section at all while loading or on error with nothing to show
  if (status === 'loading') return null;
  if (status === 'error' || status === 'empty') return null;

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>Latest Resolved Signals</div>
        <div className={styles.headerSubtitle}>Tracking is live · last 7 days</div>
      </div>

      <div
        className={styles.carousel}
        ref={carouselRef}
        onScroll={handleScroll}
      >
        {signals.map((signal) => (
          <ResolvedSignalCard key={signal.id} signal={signal} />
        ))}
      </div>

      {signals.length > 1 && (
        <div className={styles.dots} aria-hidden="true">
          {signals.map((_, i) => (
            <div
              key={i}
              className={[styles.dot, i === activeIndex ? styles.dotActive : ''].join(' ').trim()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
