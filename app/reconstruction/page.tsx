'use client';

import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import styles from './Reconstruction.module.css';
import { premiumSignals as staticPremiumSignals, PremiumSignal } from '@/content/signals';
import { marketSources as staticMarketSources } from '@/content/marketSources';
import {
  normalizeLandingPairs,
  dedupeLandingPairsByMarketOutcome,
  sortLandingPairsByConfidence,
  landingPairMatchesFilter,
  computeLandingFilterCounts,
  type LandingPair,
  type LandingFilter,
  type PassModalStep,
} from '@/lib/feed/landingPairs';
import MarketSourceCarousel from '@/components/carousels/MarketSourceCarousel';
import PremiumEventCarousel from '@/components/carousels/PremiumEventCarousel';
import SignalWeekResultsCard from '@/components/signal-week-results/SignalWeekResultsCard';
import type { WeekResultsCard } from '@/components/signal-week-results/types';
import PassOfferModal from '@/components/modals/PassOfferModal';
import ResolvedSignalsCarousel from '@/components/resolved-signals/ResolvedSignalsCarousel';
import TestimonialsSection from '@/components/testimonials/TestimonialsSection';
import HowItWorksSection from '@/components/how-it-works/HowItWorksSection';
import WhoWeAreSection from '@/components/who-we-are/WhoWeAreSection';
import FooterSection from '@/components/footer/FooterSection';

type MarketEvidenceSource = NonNullable<LandingPair['marketSources']>[number];

type TopCarouselItem =
  | { kind: 'market-source'; id: string; source: MarketEvidenceSource }
  | { kind: 'weekly-resolved-proof'; id: 'weekly-resolved-proof' };

type PublicFilter = LandingFilter;

// ── Portrait-medallion manifest (mirrors public/market-source-portraits/manifest.json) ──
const PORTRAIT_MANIFEST = {
  basePath: '/market-source-portraits/normalized/',
  groups: {
    multi:  ['multi-01.webp','multi-03.webp','multi-04.webp','multi-05.webp','multi-06.webp','multi-07.webp'],
    esport: ['esport-01.webp','esport-02.webp','esport-03.webp'],
    nba:    ['nba-01.webp','nba-02.webp','nfl-nba-01.webp'],
    nfl:    ['nfl-01.webp','nfl-02.webp','nfl-03.webp','nfl-nba-01.webp'],
    nhl:    ['nhl-01.webp','nhl-02.webp'],
    soccer: ['soccer-01.webp','soccer-02.webp','soccer-03.webp','soccer-04.webp','soccer-05.webp','soccer-06.webp','soccer-07.webp'],
  } as Record<string, string[]>,
  aliases: {
    // sport-name aliases
    basketball: 'nba',
    hockey:     'nhl',
    football:   'nfl',
    worldCup:   'soccer',
    wc26:       'soccer',
    // source.id prefix aliases (production feed uses these prefixes)
    mlb:        'multi',   // no MLB-specific portraits yet → use multi pool
    wnba:       'nba',
    mls:        'soccer',
    ncaaf:      'nfl',
    ncaab:      'nba',
  } as Record<string, string>,
};

interface PortraitAvatar {
  src: string;
  alt: string;
}

const fallbackPairs: LandingPair[] = staticPremiumSignals.flatMap((signal, index) => {
  const marketSource = staticMarketSources[index] ?? staticMarketSources[0];

  if (!marketSource) return [];

  return [{
    id: `fallback-${index}`,
    premiumSignal: signal,
    marketSource,
    marketSources: [marketSource],
    filterTags: ['sports', 'trending'],
    priority: staticPremiumSignals.length - index,
    sortScore: signal.winProbability,
    volumeUsd: 0,
    source: 'fallback',
  }];
});

export default function ReconstructionPage() {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [passModalStep, setPassModalStep] = useState<PassModalStep>('soldOutEmail');
  const [emailError, setEmailError] = useState('');
  const [apiError, setApiError] = useState('');
  const [allPairs, setAllPairs] = useState<LandingPair[]>(fallbackPairs);
  const [activePairId, setActivePairId] = useState<string>(fallbackPairs[0]?.id ?? '');
  const [activeEvidenceIndex, setActiveEvidenceIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<PublicFilter>("live");
  const [isPassOfferModalOpen, setIsPassOfferModalOpen] = useState(false);
  const [weekCard, setWeekCard] = useState<WeekResultsCard | null>(null);
  const [weekCardLoading, setWeekCardLoading] = useState(false);

  const candidatePairs = useMemo(() => {
    if (activeFilter === "live") return allPairs;
    return allPairs.filter((p) => landingPairMatchesFilter(p, activeFilter));
  }, [allPairs, activeFilter]);

  const filterCounts = useMemo<Record<PublicFilter, number>>(
    () => computeLandingFilterCounts(allPairs),
    [allPairs]
  );

  const landingSignals = useMemo(() => candidatePairs.map((pair) => pair.premiumSignal), [candidatePairs]);

  const activePairIndex = useMemo(() => {
    const index = candidatePairs.findIndex((pair) => pair.id === activePairId);
    return index >= 0 ? index : 0;
  }, [candidatePairs, activePairId]);

  const activePair = candidatePairs[activePairIndex] ?? allPairs[0] ?? fallbackPairs[0] ?? null;
  const activeSignal = activePair?.premiumSignal ?? staticPremiumSignals[0];

  const activeMarketSources = useMemo(() => {
    if (!activePair) return [];

    if (Array.isArray(activePair.marketSources) && activePair.marketSources.length > 0) {
      return activePair.marketSources;
    }

    return activePair.marketSource ? [activePair.marketSource as MarketEvidenceSource] : [];
  }, [activePair]);

  const momentumLine = useMemo<string | undefined>(() => {
    const momentumSource = activeMarketSources.find(isMarketMomentumSource);
    return momentumSource ? normalizeEvidenceHeadline(momentumSource) : undefined;
  }, [activeMarketSources]);

  const topCarouselItems = useMemo<TopCarouselItem[]>(() => {
    const displaySources = activeMarketSources
      .filter((s) => !isMarketMomentumSource(s))
      .slice(0, 2);
    const sourceItems: TopCarouselItem[] = displaySources.map((s) => ({
      kind: 'market-source' as const,
      id: s.id,
      source: s,
    }));
    return [...sourceItems, { kind: 'weekly-resolved-proof' as const, id: 'weekly-resolved-proof' }];
  }, [activeMarketSources]);

  const handleActivePairIndexChange = useCallback((nextIndex: number) => {
    const nextPair = candidatePairs[nextIndex];
    if (nextPair) {
      setActivePairId(nextPair.id);
      setActiveEvidenceIndex(0);
    }
  }, [candidatePairs]);

  const handleEvidenceIndexChange = useCallback((nextIndex: number) => {
    setActiveEvidenceIndex(nextIndex);
  }, []);

  useEffect(() => {
    setActiveEvidenceIndex(0);
  }, [activePair?.id]);

  useEffect(() => {
    if (!activePair || topCarouselItems.length <= 1) return;

    const timer = window.setInterval(() => {
      setActiveEvidenceIndex((currentIndex) => (currentIndex + 1) % topCarouselItems.length);
    }, 4500);

    return () => window.clearInterval(timer);
  }, [activePair, topCarouselItems.length]);

  const handleFilterClick = useCallback((filter: PublicFilter) => {
    setActiveFilter(filter);
    const candidates = filter === "live"
      ? allPairs
      : allPairs.filter((p) => landingPairMatchesFilter(p, filter));
    const first = (candidates.length > 0 ? candidates[0] : allPairs[0]) ?? null;
    if (first) {
      setActivePairId(first.id);
      setActiveEvidenceIndex(0);
    }
  }, [allPairs]);

  const handleCtaClick = useCallback(() => {
    router.push('/referral');
  }, [router]);

  const openModal = useCallback(() => {
    setIsModalOpen(true);
    setPassModalStep('soldOutEmail');
    setEmail('');
    setEmailError('');
    setApiError('');
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setPassModalStep('soldOutEmail');
    setEmail('');
    setEmailError('');
    setApiError('');
  }, []);

  const handleLockedFeedAttempt = useCallback(() => {
    setIsPassOfferModalOpen(true);
  }, []);

  const handlePremiumReserve = useCallback(async (data: {
    email: string;
    planId: '7day' | '3day' | 'monthly';
    planName: string;
    planPrice: string;
  }) => {
    try {
      const captureData = {
        email: data.email,
        signalId: activeSignal.id,
        eventTitle: activeSignal.eventTitle,
        position: activeSignal.position,
        winProbability: activeSignal.winProbability,
        price: activeSignal.price,
        source: 'pass_offer_modal',
        intentType: 'premium_reserve',
        planId: data.planId,
        planName: data.planName,
        planPrice: data.planPrice,
        planSource: 'pass_offer_modal',
        reservedAt: new Date().toISOString(),
      };

      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(captureData),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setIsPassOfferModalOpen(false);
      } else {
        console.error('Premium reserve failed:', result);
      }
    } catch (error) {
      console.error('Premium reserve error:', error);
    }
  }, [activeSignal]);

  const handleReservePass = useCallback((planId: '7day' | '3day' | 'monthly') => {
    setIsPassOfferModalOpen(false);
    setIsModalOpen(true);
    setPassModalStep('soldOutEmail');
    setEmail('');
    setEmailError('');
    setApiError('');
  }, []);

  const validateEmail = (email: string): boolean => {
    return email.includes('@') && email.includes('.');
  };

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateEmail(email)) {
      setEmailError('Please enter a valid email');
      return;
    }

    const captureData = {
      email,
      signalId: activeSignal.id,
      eventTitle: activeSignal.eventTitle,
      position: activeSignal.position,
      winProbability: activeSignal.winProbability,
      price: activeSignal.price,
      source: 'cta_modal',
      createdAt: new Date().toISOString(),
    };

    // Always save to localStorage as fallback/debug
    localStorage.setItem('polypropicks_lead_capture', JSON.stringify(captureData));

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(captureData),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setPassModalStep('success');
        setEmailError('');
        setApiError('');
      } else {
        setApiError('Saved locally. We could not sync yet.');
        setEmailError('');
      }
    } catch {
      setApiError('Saved locally. We could not sync yet.');
      setEmailError('');
    }
  }, [email, activeSignal]);

  // Fetch API feed on mount
  useEffect(() => {
    const fetchFeed = async () => {
      try {
        const response = await fetch('/api/feed/landing-cards?limit=15&category=sports&minDataCoverage=40&excludeEnded=true&includeUpcoming=true');

        if (response.ok) {
          const data = await response.json();
          const allApiPairs = [...(data.pairs ?? []), ...(data.upcomingPairs ?? [])];
          const normalizedPairs = normalizeLandingPairs(allApiPairs, 'api');
          const dedupedPairs = dedupeLandingPairsByMarketOutcome(normalizedPairs);
          const sortedPairs = sortLandingPairsByConfidence(dedupedPairs);

          if (sortedPairs.length > 0) {
            setAllPairs(sortedPairs);
            setActivePairId(sortedPairs[0]?.id ?? fallbackPairs[0]?.id ?? '');
            setActiveEvidenceIndex(0);

            console.log('[landing-feed] using normalized api feed:', normalizedPairs.length, 'pairs');
          } else {
            console.warn('[landing-feed] using manual fallback: empty normalized pairs');
          }
        } else {
          console.warn('[landing-feed] using manual fallback: response not ok');
        }
      } catch (error) {
        console.warn('[landing-feed] using manual fallback: fetch error', error);
      }
    };

    fetchFeed();
  }, []);

  // Fetch weekly resolved proof card for top carousel (global, fetched once on mount)
  useEffect(() => {
    setWeekCardLoading(true);
    fetch('/api/signals/resolved?mode=latest&days=7&limit=7')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const card = json?.weekResultsCard;
        if (card?.cardType === 'signal-week-results') {
          setWeekCard(card as WeekResultsCard);
        }
      })
      .catch(() => {})
      .finally(() => setWeekCardLoading(false));
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.proofMarker}>
        RECONSTRUCTION_RESET_ACTIVE
      </div>
      
      <section className={styles.viewport}>
        <div className={styles.screen}>
          <Header />
          <MarketSourceCarousel<TopCarouselItem>
            sources={topCarouselItems}
            activeIndex={activeEvidenceIndex}
            onActiveIndexChange={handleEvidenceIndexChange}
            renderCard={(item) =>
              item.kind === 'market-source'
                ? <MarketSourceCard
                    source={item.source}
                    extraMomentumLine={isSharkFlowSource(item.source) ? momentumLine : undefined}
                    avatar={isSharkFlowSource(item.source) ? pickMarketSourceAvatar(item.source, activePair) : undefined}
                  />
                : <SignalWeekResultsCard data={weekCard} loading={weekCardLoading} variant="top-carousel" />
            }
          />
          <PillsRow activeFilter={activeFilter} onFilterClick={handleFilterClick} counts={filterCounts} />
          {activeFilter !== "live" && candidatePairs.length === 0 ? (
            <EmptyFilterTeaser
              filterLabel={FILTER_LABELS[activeFilter]}
              onSwitchToLive={() => handleFilterClick("live")}
            />
          ) : (
            <PremiumEventCarousel
              signals={landingSignals}
              activeIndex={activePairIndex}
              onActiveIndexChange={handleActivePairIndexChange}
              renderCard={(signal, onCtaClick) => <PremiumSignalCard signal={signal} onCtaClick={onCtaClick} />}
              onCtaClick={handleCtaClick}
              onLockedFeedAttempt={handleLockedFeedAttempt}
            />
          )}
        </div>
      </section>

      <ResolvedSignalsCarousel />

      <TestimonialsSection />

      <HowItWorksSection onCtaClick={handleLockedFeedAttempt} />

      <WhoWeAreSection />

      <FooterSection />

      {isModalOpen && (
        <UnlockModal
          isOpen={isModalOpen}
          onClose={closeModal}
          email={email}
          setEmail={setEmail}
          emailError={emailError}
          apiError={apiError}
          passModalStep={passModalStep}
          onPassModalStepChange={setPassModalStep}
          onSubmit={handleSubmit}
          activeSignal={activeSignal}
        />
      )}

      {isPassOfferModalOpen && (
        <PassOfferModal
          isOpen={isPassOfferModalOpen}
          onClose={() => setIsPassOfferModalOpen(false)}
          onReserve={handleReservePass}
          onPremiumReserve={handlePremiumReserve}
        />
      )}
    </main>
  );
}


function getTrustMetricIconSrc(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('smart')) return '/icons/trust-smart-money-optimized.webp';
  if (l.includes('whale') || l.includes('public')) return '/icons/trust-public-whale-optimized.webp';
  if (l.includes('ai') || l.includes('preevent') || l.includes('score')) return '/icons/trust-ai-score-optimized.webp';
  return '/icons/trust-smart-money-optimized.webp';
}

function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.brandWrap}>
        <img src="/brand/logo/logo-24.png" className={styles.brandLogo} alt="PolyProPicks" width={24} height={24} />
        <div className={styles.brandText}>PolyProPicks</div>
      </div>
      <div className={styles.livePill}>
        <span className={styles.liveDot} />
        <span className={styles.liveText}>Live shark flow</span>
      </div>
    </header>
  );
}


function normalizeEvidenceDelta(rawDelta: unknown): string {
  const raw = String(rawDelta ?? '').trim();
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');

  if (
    !normalized ||
    normalized === '+0%' ||
    normalized === '0%' ||
    normalized === '+0% up' ||
    normalized === '0% up' ||
    normalized === '0% flat'
  ) {
    return '0%';
  }

  return raw;
}

function isZeroEvidenceDelta(rawDelta: unknown): boolean {
  return normalizeEvidenceDelta(rawDelta) === '0%';
}

function extractMoneyAmount(value: unknown): string | null {
  const match = String(value ?? '').match(/\$[\d,.]+(?:\.\d+)?[KMB]?/i);
  return match?.[0] ?? null;
}

function extractPriceCents(value: unknown): number | null {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*¢/);
  if (!match) return null;

  const cents = Number(match[1]);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function formatImpliedOddsFromCents(cents: number | null): string | null {
  if (!cents || cents <= 0) return null;

  return `${(100 / cents).toFixed(2)}x`;
}

function isMarketMomentumSource(source: MarketEvidenceSource): boolean {
  const type = source.type ?? '';
  const label = String(source.sourceLabel ?? '').toLowerCase();
  return type === 'market-momentum'
    || label.includes('momentum')
    || label.includes('odds moved')
    || label.includes('repricing');
}

function normalizeSharkHeadline(raw: string): string {
  const match = raw.match(/\$[\d,.]+[KMBkmb]?/);
  if (!match) return 'Whale flow signal';
  const amt = match[0].replace(/k$/i, 'K').replace(/m$/i, 'M').replace(/b$/i, 'B');
  return `${amt} whale flow`;
}

function isSharkFlowSource(source: MarketEvidenceSource): boolean {
  const type = source.type ?? '';
  const label = String(source.sourceLabel ?? '').toLowerCase();
  return type === 'sharp-flow'
    || label.includes('sharp flow')
    || label.includes('shark flow')
    || label.includes('whale')
    || label.includes('trade');
}

// ── Portrait-medallion helpers ────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function inferAvatarSport(pair: LandingPair | null): string | null {
  if (!pair) return null;
  const sportKeys = Object.keys(PORTRAIT_MANIFEST.groups);
  for (const tag of (pair.filterTags ?? [])) {
    const lower = tag.toLowerCase();
    if (sportKeys.includes(lower)) return lower;
    const aliased = PORTRAIT_MANIFEST.aliases[lower];
    if (aliased) return aliased;
  }
  const titleRaw = String((pair.premiumSignal as any)?.title ?? (pair.premiumSignal as any)?.market ?? '').toLowerCase();
  const sportKeywords: [string, string[]][] = [
    ['soccer', ['soccer', 'mls', 'premier', 'champions', 'copa', 'world cup', 'wc26', 'wc 2026']],
    ['nba', ['nba', 'basketball']],
    ['nfl', ['nfl', 'super bowl']],
    ['nhl', ['nhl', 'hockey']],
    ['esport', ['esport', 'e-sport', 'gaming', 'league of legends', 'dota', 'cs2', 'valorant']],
  ];
  for (const [sport, kws] of sportKeywords) {
    if (kws.some((kw) => titleRaw.includes(kw))) return sport;
  }
  return null;
}

function pickMarketSourceAvatar(
  source: MarketEvidenceSource,
  pair: LandingPair | null,
): PortraitAvatar | null {
  // 1. Try source.id prefix first — production IDs look like 'nhl-car-mon-2026-...',
  //    'mlb-tb-bal-2026-...', 'nba-...' so the first segment is the sport key.
  const idPrefix = String(source.id ?? '').split('-')[0].toLowerCase();
  const idSport: string | null =
    PORTRAIT_MANIFEST.groups[idPrefix]
      ? idPrefix
      : (PORTRAIT_MANIFEST.aliases[idPrefix] ?? null);

  // 2. Fall back to filterTags / title keyword inference.
  const sport: string | null = idSport ?? inferAvatarSport(pair);

  // 3. Build pool: sport-specific ∪ multi (de-duplicated via Set).
  const sportPool: string[] = sport ? (PORTRAIT_MANIFEST.groups[sport] ?? []) : [];
  const multiPool: string[] = PORTRAIT_MANIFEST.groups['multi'] ?? [];
  const pool: string[] = sportPool.length > 0
    ? [...new Set([...sportPool, ...multiPool])]
    : [...multiPool];
  if (pool.length === 0) return null;

  // 4. Deterministic seed: source.id + pair.id + event title for extra variance.
  const eventTitle = String(
    (pair?.premiumSignal as any)?.eventTitle ??
    (pair?.premiumSignal as any)?.title ??
    (pair?.premiumSignal as any)?.market ?? ''
  );
  const seed = `${source.id ?? ''}::${pair?.id ?? ''}::${eventTitle}`;
  const idx = hashString(seed) % pool.length;

  return {
    src: `${PORTRAIT_MANIFEST.basePath}${pool[idx]}`,
    alt: 'Market source analyst',
  };
}

function getEvidencePills(source: MarketEvidenceSource): string[] {
  const type = source.type ?? 'market-source';
  const time = source.timeAgo || 'Live now';

  if (type === 'sharp-flow') {
    return ['Sharp Flow', 'Trades', time];
  }

  if (type === 'market-momentum') {
    return ['Momentum', 'Odds', time];
  }

  return [
    source.platform || 'Polymarket',
    source.network || 'Polygon',
    time,
  ];
}

function normalizeEvidenceHeadline(source: MarketEvidenceSource): string {
  const type = source.type ?? 'market-source';
  const headline = String(source.headline ?? '').trim();

  if (type === 'market-momentum') {
    const delta = normalizeEvidenceDelta(source.delta);
    return delta === '0%' ? 'Odds holding steady' : `Odds moved ${delta}`;
  }

  return headline || 'Market evidence';
}

function normalizeEvidenceSubline(source: MarketEvidenceSource): string {
  const type = source.type ?? 'market-source';
  const subline = String(source.subline ?? '').trim();

  if (type === 'market-momentum') {
    const cents = extractPriceCents(subline);
    const odds = formatImpliedOddsFromCents(cents);

    if (odds && cents) {
      return `Implied odds ≈ ${odds} at ${cents}¢`;
    }

    const delta = normalizeEvidenceDelta(source.delta);
    return delta === '0%' ? 'No sharp repricing detected' : `Market repricing detected: ${delta}`;
  }

  return subline || 'Live market evidence';
}

function MarketDepthChart({ source }: { source: MarketEvidenceSource }) {
  const delta = normalizeEvidenceDelta(source.delta);
  const hasMovement = !isZeroEvidenceDelta(source.delta);
  const moneyAmount = extractMoneyAmount(source.headline);
  const rawAmount = Number(String(moneyAmount ?? '').replace(/[$,]/g, '').replace(/K/i, '000').replace(/M/i, '000000')) || 0;
  const intensity = Math.min(1, rawAmount / 1000000);
  const lift = Math.round(6 + intensity * 14);

  return (
    <div className={styles.marketChartWrap} style={{ justifyContent: 'center', gap: 4 }}>
      <svg viewBox="0 0 180 72" className={styles.marketChart} aria-hidden="true">
        <path
          d={`M4 58 L18 55 L32 57 L46 51 L60 53 L74 45 L88 48 L102 39 L116 ${36 - lift / 3} L130 31 L144 ${20 - lift / 2} L158 ${10 + lift / 4}`}
          className={styles.chartLine}
        />
        <path
          d={`M4 58 L18 55 L32 57 L46 51 L60 53 L74 45 L88 48 L102 39 L116 ${36 - lift / 3} L130 31 L144 ${20 - lift / 2} L158 ${10 + lift / 4} L158 72 L4 72 Z`}
          className={styles.chartFill}
        />
        <circle cx="158" cy={10 + lift / 4} r="3.7" className={styles.chartDot} />
      </svg>
      {hasMovement ? <div className={styles.marketDelta}>{delta}</div> : null}
    </div>
  );
}

function SharpFlowVisual({ source, avatar }: { source: MarketEvidenceSource; avatar?: PortraitAvatar | null }) {
  const delta = normalizeEvidenceDelta(source.delta);
  const hasMovement = !isZeroEvidenceDelta(source.delta);

  return (
    <div
      className={styles.marketChartWrap}
      style={{ justifyContent: 'center', alignItems: 'center', minHeight: 68 }}
    >
      <div className={styles.sharpAvatarShell}>
        {avatar ? (
          <img
            src={avatar.src}
            alt={avatar.alt}
            className={styles.sharpAvatarImage}
            draggable={false}
          />
        ) : (
          <svg viewBox="0 0 80 80" width="52" height="52" aria-hidden="true">
            <path d="M12 48c10-23 35-29 56-17-12 2-16 9-20 17-6 13-20 20-36 14 8-2 11-6 13-10-5 1-9 0-13-4Z" fill="rgba(190,245,255,.92)" />
            <path d="M27 39c7-7 18-10 31-8-11 2-19 6-26 13-5 5-11 9-18 10 4-4 8-8 13-15Z" fill="rgba(24,231,255,.36)" />
          </svg>
        )}
        {hasMovement && (
          <span className={styles.sharpAvatarDeltaBadge}>{delta}</span>
        )}
      </div>
    </div>
  );
}

function MarketMomentumVisual({ source }: { source: MarketEvidenceSource }) {
  return (
    <div
      className={styles.marketChartWrap}
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 68,
      }}
    >
      <div
        style={{
          width: '100%',
          minHeight: 64,
          borderRadius: 14,
          border: '1px solid rgba(24,231,255,0.24)',
          background: 'linear-gradient(135deg, rgba(20,62,130,0.72), rgba(8,16,34,0.96) 46%, rgba(120,18,34,0.56))',
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          justifyItems: 'center',
          color: '#ffffff',
          overflow: 'hidden',
          boxShadow: 'inset 0 0 22px rgba(24,231,255,0.12)',
        }}
      >
        <span style={{ width: 34, height: 34, borderRadius: 8, background: 'linear-gradient(135deg, #1b4f9c, #eef6ff)', opacity: .9 }} />
        <span style={{ fontSize: 16, fontWeight: 950, color: '#e9fbff', textShadow: '0 0 10px rgba(24,231,255,.45)' }}>VS</span>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: 'linear-gradient(135deg, #e6fff7, #a71930)', opacity: .9 }} />
      </div>
    </div>
  );
}

function MarketVisual({ source, avatar }: { source: MarketEvidenceSource; avatar?: PortraitAvatar | null }) {
  const type = source.type ?? 'market-source';

  if (type === 'sharp-flow') {
    return <SharpFlowVisual source={source} avatar={avatar} />;
  }

  if (type === 'market-momentum') {
    return <MarketMomentumVisual source={source} />;
  }

  return <MarketDepthChart source={source} />;
}

function MarketSourceCard({ source, extraMomentumLine, avatar }: { source: MarketEvidenceSource; extraMomentumLine?: string; avatar?: PortraitAvatar | null }) {
  const pills = getEvidencePills(source);
  const headline = normalizeEvidenceHeadline(source);
  const subline = normalizeEvidenceSubline(source);
  const visibleSourceLabel = String(source.sourceLabel ?? '').replace(/Sharp\s+Flow/gi, 'Shark Flow');
  const normalizePill = (p: string) => (p === 'Sharp Flow' ? 'Shark Flow' : p);
  const isShark = isSharkFlowSource(source);
  const displayHeadline = isShark ? normalizeSharkHeadline(headline) : headline;
  const sharkSecondary = isShark ? (extraMomentumLine || 'Live trade-flow signal') : null;

  const headlineStyle: CSSProperties = isShark ? {
    fontSize: 'clamp(15px, 4.7vw, 20px)',
    lineHeight: 1.02,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } : {
    fontSize: 'clamp(15px, 4.7vw, 20px)',
    lineHeight: 1.02,
    whiteSpace: 'normal',
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  };

  const sublineStyle: CSSProperties = {
    fontSize: 'clamp(10px, 2.9vw, 12px)',
    lineHeight: 1.15,
    whiteSpace: 'normal',
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  };

  return (
    <section className={`${styles.marketSourceCard} ${isShark ? styles.sharkSourceCard : ''}`}>
      <div className={styles.marketTop}>
        <div className={styles.marketSourceLabel}>
          <svg viewBox="0 0 24 24" className={styles.eq} aria-hidden="true">
            <path
              d="M3 12h2m3-4v8m4-12v16m4-10v4m4-7v10"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          {!isSharkFlowSource(source) && <span>{visibleSourceLabel}</span>}
        </div>

        {pills.map((pill) => (
          <div key={pill} className={`${styles.marketPill} ${pill === source.timeAgo ? styles.marketPillTime : ''}`}>
            {pill === 'Polymarket' || pill === source.platform ? (
              <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
                <path
                  d="M4 7.5 13.5 3v8.5L4 21v-8.5L13.5 8M13.5 3 20 7v8.5l-6.5-4"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            ) : null}
            {pill === 'Polygon' || pill === source.network ? (
              <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
                <path
                  d="M8.2 9.2c0-1.8 1.4-3.2 3.2-3.2 1.2 0 2.1.5 2.7 1.4l3.1 3.8a3.2 3.2 0 1 1-5.1 3.9l-1.1-1.4"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            ) : null}
            <span>{normalizePill(pill)}</span>
          </div>
        ))}
      </div>

      <div className={styles.marketBody}>
        <MarketVisual source={source} avatar={isShark ? avatar : undefined} />

        <div className={styles.marketCopy}>
          <div className={styles.marketHeadline} style={headlineStyle}>{displayHeadline}</div>
          {!isShark && <div className={styles.marketSubline} style={sublineStyle}>{subline}</div>}
          {(isShark || extraMomentumLine) && (
            <div style={{
              fontSize: 'clamp(9px, 2.5vw, 11px)',
              color: 'rgba(0, 212, 255, 0.65)',
              fontWeight: 700,
              letterSpacing: '0.04em',
              marginTop: '3px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.2,
            }}>{isShark ? sharkSecondary : extraMomentumLine}</div>
          )}
        </div>
      </div>
    </section>
  );
}

const FILTER_LABELS: Record<PublicFilter, string> = {
  live: "Live",
  wc2026: "WC26",
  nhl: "NHL",
  nba: "NBA",
  esport: "eSport",
};

function EmptyFilterTeaser({
  filterLabel,
  onSwitchToLive,
}: {
  filterLabel: string;
  onSwitchToLive: () => void;
}) {
  return (
    <div className={styles.emptyFilterTeaser}>
      <div className={styles.emptyFilterTeaserEyebrow}>PREMIUM EDGE SCANNING</div>
      <div className={styles.emptyFilterTeaserTitle}>No live {filterLabel} signal right now</div>
      <p className={styles.emptyFilterTeaserBody}>
        We only show a card when market movement, liquidity, and confidence pass our threshold.
      </p>
      <div className={styles.emptyFilterTeaserHint}>
        Next qualified {filterLabel} edge will appear here.
      </div>
      <button
        type="button"
        className={styles.emptyFilterTeaserLink}
        onClick={onSwitchToLive}
      >
        Switch to Live to see all available signals →
      </button>
    </div>
  );
}

function PillsRow({
  activeFilter,
  onFilterClick,
  counts,
}: {
  activeFilter: PublicFilter;
  onFilterClick: (filter: PublicFilter) => void;
  counts: Record<PublicFilter, number>;
}) {
  const filters: Array<{ tag: PublicFilter; label: string }> = [
    { tag: "live", label: "Live" },
    { tag: "wc2026", label: "WC26" },
    { tag: "nhl", label: "NHL" },
    { tag: "nba", label: "NBA" },
    { tag: "esport", label: "eSport" },
  ];

  return (
    <div className={styles.pillsRow}>
      {filters.map((filter) => (
        <button
          key={filter.tag}
          type="button"
          className={`${styles.pill} ${activeFilter === filter.tag ? styles.pillActive : ''}`}
          onClick={() => onFilterClick(filter.tag)}
        >
          {filter.label}
          <span className={styles.pillCount}>{counts[filter.tag]}</span>
        </button>
      ))}
    </div>
  );
}

function normalizeTrustMetricText(metric: any): string {
  return `${metric?.id ?? ''} ${metric?.label ?? ''}`.toLowerCase();
}

function getTrustMetricRank(metric: any): number {
  const text = normalizeTrustMetricText(metric);

  if (text.includes('smart')) return 0;

  if (
    (text.includes('whale') && text.includes('public')) ||
    text.includes('public vs whale') ||
    text.includes('whale vs public')
  ) {
    return 1;
  }

  if (
    text.includes('preevent') ||
    text.includes('pre-event') ||
    text.includes('pre event') ||
    text.includes('score') ||
    text.includes('ai')
  ) {
    return 2;
  }

  return 99;
}

function getOrderedTrustMetrics(metrics: any[]): any[] {
  if (!Array.isArray(metrics)) return [];

  return metrics
    .map((metric, index) => ({ metric, index }))
    .sort((a, b) => {
      const rankDiff = getTrustMetricRank(a.metric) - getTrustMetricRank(b.metric);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((item) => item.metric);
}

function getTrustMetricDisplayLabel(metric: any): string {
  const text = normalizeTrustMetricText(metric);

  if (text.includes('smart')) return 'Smart Money';

  if (
    (text.includes('whale') && text.includes('public')) ||
    text.includes('public vs whale') ||
    text.includes('whale vs public')
  ) {
    return 'Whale vs Public Money';
  }

  if (
    text.includes('preevent') ||
    text.includes('pre-event') ||
    text.includes('pre event') ||
    text.includes('score') ||
    text.includes('ai')
  ) {
    return 'PreEventScore AI';
  }

  return metric?.label ?? 'Trust Metric';
}

function getTrustMetricValue(metric: any): number {
  const rawValue = metric?.value ?? metric?.bar ?? 0;
  const normalizedValue =
    typeof rawValue === 'string'
      ? Number(rawValue.replace('%', '').trim())
      : Number(rawValue);

  if (!Number.isFinite(normalizedValue)) return 0;

  return Math.max(0, Math.min(100, Math.round(normalizedValue)));
}

function getTrustMetricFillBackground(value: number): string {
  if (value >= 85) {
    return 'linear-gradient(90deg, #23e6bb 0%, #61ef4a 55%, #fff500 100%)';
  }

  if (value >= 70) {
    return 'linear-gradient(90deg, #18e7ff 0%, #23e6bb 45%, #61ef4a 100%)';
  }

  if (value >= 55) {
    return 'linear-gradient(90deg, #f59e0b 0%, #facc15 65%, #fff500 100%)';
  }

  return 'linear-gradient(90deg, #ef4444 0%, #f97316 100%)';
}

function PremiumSignalCard({ signal, onCtaClick }: { signal: typeof staticPremiumSignals[0]; onCtaClick: () => void }) {
  const orderedTrustMetrics = getOrderedTrustMetrics(signal.metrics);
  // Compute sanitized probability and confidence data
  const probability = Math.max(0, Math.min(100, Number(signal.winProbability) || 0));
  const ringDegrees = probability * 3.6;
  
  // Get badge text: use backend odds-context label if present, else fallback to probability tiers
  const getBadgeText = (prob: number) => {
    const backendLabel = (signal as any).confidenceLabel as string | undefined;
    if (backendLabel && backendLabel.length > 0) return backendLabel.toUpperCase();
    if (prob >= 80) return "ABSOLUTE CONFIDENCE";
    if (prob > 65)  return "HIGH CONFIDENCE";
    if (prob > 55)  return "MIDDLE CONFIDENCE";
    return "LOW CONFIDENCE";
  };

  // Resolve action label from backend (actionLabel field)
  const actionLabel = (signal as any).actionLabel as "ENTER" | "SMALL" | "WATCH" | undefined;

  // Get ring color based on probability
  const getRingColor = (prob: number) => {
    if (prob >= 80) {
      return "#FFF500"; // ABSOLUTE
    }
    if (prob > 65) {
      return "#FFF500"; // HIGH
    }
    if (prob > 55) {
      return "#2190F6"; // MIDDLE
    }
    return "#FF8A00"; // LOW
  };

  const badgeText = getBadgeText(probability);
  const ringColor = getRingColor(probability);

  const profitPercent = parseFloat((signal.profit || '0').replace('%', '')) || 0;
  const americanOdds = profitPercent >= 100
    ? `+${Math.round(profitPercent)}`
    : `-${Math.round(10000 / Math.max(profitPercent, 1))}`;
  const americanOddsNumber = Number.parseInt(String(americanOdds).replace(/[^\d-]/g, ''), 10);
  const profitDollars = Number.isFinite(americanOddsNumber) && americanOddsNumber !== 0
    ? Math.round(americanOddsNumber > 0 ? americanOddsNumber : 10000 / Math.abs(americanOddsNumber))
    : Math.round(profitPercent);

  // Compute ring style with direct conic-gradient
  const ringStyle = {
    background: `conic-gradient(${ringColor} 0deg ${ringDegrees}deg, rgba(255,255,255,0.16) ${ringDegrees}deg 360deg)`
  };
  return (
    <article className={styles.premiumSignalCard}>
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
        <div className={styles.confidencePill}>
          <svg viewBox="0 0 24 24" className={styles.shield} aria-hidden="true">
            <path
              d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z"
              fill="currentColor"
            />
            <path
              d="m8.7 12.2 2.1 2.1 4.5-4.7"
              stroke="#06220B"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>{badgeText}</span>
        </div>
      </div>
      <h1 className={styles.eventTitle}>{signal.eventTitle}</h1>
      <div className={styles.positionProfit}>
        <div className={styles.positionCol}>
          <div className={styles.label}>Position</div>
          <div className={styles.positionValue}>{signal.position}</div>
          <div className={styles.target} aria-hidden="true">
            <img src="/icons/position-target-optimized.webp" className={styles.decorIconImg} alt="" width={160} height={160} />
          </div>
        </div>
        <div className={styles.positionProfitDivider} />
        <div className={styles.profitCol}>
          <span style={{display:'inline-block',fontSize:'clamp(8px,1.9vw,10px)',whiteSpace:'nowrap',position:'relative',zIndex:4}}>Odds {americanOdds}</span>
          <div className={styles.profitValue} style={{color:'#86FF5A',textShadow:'0 0 14px rgba(134,255,90,0.32)'}}>+${profitDollars}</div>
          <div style={{fontSize:'clamp(9px,2.3vw,11px)',fontWeight:600,color:'rgba(213,229,238,0.72)',lineHeight:1.2,position:'relative',zIndex:3,marginTop:'1px',textAlign:'right',alignSelf:'stretch',paddingRight:'clamp(4px,1.4vw,8px)'}}>per $100 stake</div>
          <div className={styles.trend} aria-hidden="true">
            <img src="/icons/profit-trend-optimized.webp" className={styles.decorIconImg} alt="" width={160} height={160} />
          </div>
        </div>
      </div>
      <div className={styles.analyticsRow}>
        <div className={styles.trustCard}>
          <div className={styles.trustHeader}>
            <div className={styles.trustTitle}>TRUST METRICS</div>
            <svg viewBox="0 0 24 24" className={styles.info} aria-hidden="true">
              <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 10.2v5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="12" cy="7.2" r="1.1" fill="currentColor" />
            </svg>
          </div>
          {orderedTrustMetrics.map((metric: any) => {
            const displayLabel = getTrustMetricDisplayLabel(metric);
            return (
              <MetricRow
                key={metric.id}
                icon={<img src={getTrustMetricIconSrc(displayLabel)} className={styles.metricIconImg} alt="" width={24} height={24} />}
                label={displayLabel}
                value={getTrustMetricValue(metric)}
              />
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
          <div className={styles.confidenceFooterRow}>
            {actionLabel && (
              <span className={
                actionLabel === "ENTER" ? styles.actionEnter :
                actionLabel === "SMALL" ? styles.actionSmall :
                styles.actionWatch
              }>
                {actionLabel}
              </span>
            )}
            {(signal as any).polymarketUrl && (
              <a
                href={(signal as any).polymarketUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on Polymarket"
                style={{
                  lineHeight: 1,
                  textAlign: 'center',
                  color: 'rgba(135,255,77,0.55)',
                  textDecoration: 'none',
                }}
              >
                <span style={{display:'flex',alignItems:'center',gap:'4px'}}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  <span style={{fontSize:'9px',fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',opacity:0.9}}>see on polymarket</span>
                </span>
              </a>
            )}
          </div>
        </div>
      </div>
      <button className={styles.cta} onClick={onCtaClick}>Get $30 Premium Credit</button>
      <p className={styles.ctaSubline}>
        <span>Give a friend a free week</span>
        <span className={styles.ctaSublineSeparator}>·</span>
        <a className={styles.ctaSublineLink} href="#resolved-signals">see latest resolved signals →</a>
      </p>
    </article>
  );
}

function MetricRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  const safeValue = Math.max(0, Math.min(100, value));

  return (
    <div className={styles.metricRow}>
      <div className={styles.metricIconWrap}>{icon}</div>
      <div className={styles.metricMain}>
        <div className={styles.metricTopLine}>
          <div className={styles.metricLabel}>{label}</div>
          <div className={styles.metricValue}>{safeValue}%</div>
        </div>
        <div className={styles.metricBar}>
          <div
            className={styles.metricFill}
            style={{
              width: `${safeValue}%`,
              background: getTrustMetricFillBackground(safeValue),
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface UnlockModalProps {
  isOpen: boolean;
  onClose: () => void;
  email: string;
  setEmail: (email: string) => void;
  emailError: string;
  apiError: string;
  passModalStep: PassModalStep;
  onPassModalStepChange: (step: PassModalStep) => void;
  onSubmit: (e: React.FormEvent) => void;
  activeSignal: {
    eventTitle: string;
    position: string;
    winProbability: number;
    price: string;
  };
}

function UnlockModal({
  isOpen,
  onClose,
  email,
  setEmail,
  emailError,
  apiError,
  passModalStep,
  onPassModalStepChange,
  onSubmit,
  activeSignal,
}: UnlockModalProps) {
  if (!isOpen) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {passModalStep === 'offer' ? (
          <>
            <h2 className={styles.modalTitle}>Early Access — 3-Day Signal Pass</h2>
            <p className={styles.modalSubtitle}>
              Unlock the premium signal feed for 3 days. Pass access is limited while we tune the product.
            </p>

            <div className={styles.modalPreview}>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Pass</span>
                <span className={styles.previewValue}>3 days</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Price</span>
                <span className={styles.previewValue}>$4.99</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Event</span>
                <span className={`${styles.previewValue} ${styles.previewEventValue}`}>{activeSignal.eventTitle}</span>
              </div>
            </div>

            <button
              type="button"
              className={styles.modalPrimary}
              onClick={() => onPassModalStepChange('soldOutEmail')}
            >
              Reserve My Spot — $4.99
            </button>

            <p className={styles.modalFineprint}>No charge today. Early access is released in small batches.</p>
          </>
        ) : passModalStep === 'soldOutEmail' ? (
          <>
            <h2 className={styles.modalTitle}>Get 5 Free Signals</h2>
            <p className={styles.modalSubtitle}>
              Get 5 free sports picks with full analysis and live alerts.
            </p>

            <div className={styles.modalPreview}>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Event</span>
                <span className={`${styles.previewValue} ${styles.previewEventValue}`}>{activeSignal.eventTitle}</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Win Probability</span>
                <span className={styles.previewValue}>{activeSignal.winProbability}%</span>
              </div>
            </div>

            <form onSubmit={onSubmit} className={styles.modalForm}>
              <input
                type="email"
                className={styles.modalInput}
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              {emailError && <span className={styles.modalError}>{emailError}</span>}
              {apiError && <span className={styles.modalError}>{apiError}</span>}
              <button type="submit" className={styles.modalPrimary}>
                Get 5 Free Signals NOW
              </button>
            </form>

            <p className={styles.modalFineprint}>No spam. Early access users get priority signal access.</p>
            <p className={styles.modalFooter}>Free signals unlock after email confirmation.</p>
          </>
        ) : (
          <div className={styles.modalSuccess}>
            <h2 className={styles.modalTitle}>You&apos;re on the early list</h2>
            <p className={styles.modalSubtitle}>
              We saved your request. Your free signals access is reserved.
            </p>
            <button className={styles.modalPrimary} onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
