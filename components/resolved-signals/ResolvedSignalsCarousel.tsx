'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './ResolvedSignalsCarousel.module.css';
import ResolvedSignalCard from './ResolvedSignalCard';

const PUSH_RESULTS = new Set(['push', 'refund', 'tie', 'void', 'cancelled', 'no_contest']);
const MAX_CARDS = 7;
const MAX_LOST = 2;

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

/** Client-side safety filter: mirrors API rules in case API changes.
 *  Canonical filtering function — the same selection used for the top proof
 *  card, the paywall proof card, and the Latest Resolved Signals preview. */
export function applyClientFilter(raw: ApiResolvedSignal[]): ApiResolvedSignal[] {
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

interface ResolvedSignalsCarouselProps {
  variant?: 'landing' | 'premium';
  /** Canonical pre-filtered rows supplied by the page. When present, the
   *  carousel renders exactly these rows and never fetches internally. */
  signals?: ApiResolvedSignal[];
  loading?: boolean;
}

export default function ResolvedSignalsCarousel({
  variant = 'landing',
  signals: providedSignals,
  loading = false,
}: ResolvedSignalsCarouselProps) {
  const isPremium = variant === 'premium';
  const hasProvidedSignals = providedSignals !== undefined;
  const [fetchedSignals, setFetchedSignals] = useState<ApiResolvedSignal[]>([]);
  const [fetchStatus, setFetchStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const carouselRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hasProvidedSignals) return;
    let cancelled = false;
    fetch('/api/signals/resolved?mode=latest&days=14&limit=7')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok || !Array.isArray(json.signals)) {
          setFetchStatus('error');
          return;
        }
        const safe = applyClientFilter(json.signals as ApiResolvedSignal[]);
        setFetchedSignals(safe);
        setFetchStatus(safe.length > 0 ? 'ok' : 'empty');
      })
      .catch(() => {
        if (!cancelled) setFetchStatus('error');
      });
    return () => { cancelled = true; };
  }, [hasProvidedSignals]);

  const signals = hasProvidedSignals ? providedSignals : fetchedSignals;
  const status: 'loading' | 'ok' | 'empty' | 'error' = hasProvidedSignals
    ? (loading ? 'loading' : signals.length > 0 ? 'ok' : 'empty')
    : fetchStatus;

  // Desktop / pointer-fine timed auto-scroll. Re-runs once cards mount.
  useEffect(() => {
    const el = carouselRef.current;
    if (!el) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let paused = false;
    const pause = () => { paused = true; };
    const resume = () => { paused = false; };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', resume);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', resume);

    const tick = () => {
      if (paused) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      if (maxScroll <= 0) return;
      const first = el.firstElementChild as HTMLElement | null;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const step = first ? first.getBoundingClientRect().width + gap : el.clientWidth * 0.8;
      const next = el.scrollLeft + step;
      el.scrollTo({ left: next >= maxScroll - 4 ? 0 : next, behavior: 'smooth' });
    };

    const id = window.setInterval(tick, 3000);

    return () => {
      window.clearInterval(id);
      el.removeEventListener('mouseenter', pause);
      el.removeEventListener('mouseleave', resume);
      el.removeEventListener('focusin', pause);
      el.removeEventListener('focusout', resume);
    };
  }, [signals]);


  // Don't render section at all while loading or on error with nothing to show
  if (status === 'loading') return null;
  if (status === 'error' || status === 'empty') return null;

  return (
    <section id={!isPremium ? "resolved-signals" : undefined} className={isPremium ? styles.sectionPremium : styles.section}>
      {!isPremium && (
        <div className={styles.header}>
          <div className={styles.headerTitle}>Latest resolved signals</div>
          <div className={styles.headerSubtitle}>Tracking is live · last 14 days</div>
        </div>
      )}

      <div className={styles.carousel} ref={carouselRef}>
        {signals.map((signal) => (
          <ResolvedSignalCard key={signal.id} signal={signal} />
        ))}
      </div>
    </section>
  );
}
