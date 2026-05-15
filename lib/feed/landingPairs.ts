import type { PremiumSignal } from '@/content/signals';
import type { MarketSource, MarketSourceEvidenceCard, MarketSourceCardType } from '@/content/marketSources';

export type FilterTag = 'live' | 'wc2026' | 'sports' | 'trending';

export type PassModalStep = 'offer' | 'soldOutEmail' | 'success';

export type LandingPairSource = 'api' | 'fallback';

export interface LandingPair {
  id: string;
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  marketSources?: MarketSourceEvidenceCard[];
  filterTags: FilterTag[];
  isDefaultToday?: boolean;
  priority?: number;
  sortScore?: number;
  volumeUsd?: number;
  source?: LandingPairSource;
}

type RawLandingPair = Partial<LandingPair> & {
  premiumSignal?: PremiumSignal;
  marketSource?: MarketSource;
  marketSources?: MarketSourceEvidenceCard[];
  id?: string;
  pairId?: string;
  filterTags?: FilterTag[];
  tags?: string[];
  isDefaultToday?: boolean;
  priority?: number | string;
  sortScore?: number | string;
  volumeUsd?: number | string;
  volume?: number | string;
};

const FILTERS: FilterTag[] = ['live', 'wc2026', 'sports', 'trending'];

function clampNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function uniqueFilterTags(tags: FilterTag[]): FilterTag[] {
  return FILTERS.filter((tag) => tags.includes(tag));
}

export function getPairFilterTags(pair: Pick<LandingPair, 'premiumSignal' | 'marketSource' | 'volumeUsd' | 'sortScore'>): FilterTag[] {
  const signal = pair.premiumSignal;
  const source = pair.marketSource;

  const combinedText = [
    signal?.league,
    signal?.eventTitle,
    signal?.position,
    source?.platform,
    source?.headline,
    source?.subline,
  ]
    .map(normalizeText)
    .join(' ');

  const tags: FilterTag[] = ['sports'];

  if (
    combinedText.includes('live') ||
    combinedText.includes('now') ||
    combinedText.includes('today')
  ) {
    tags.push('live');
  }

  if (
    combinedText.includes('wc2026') ||
    combinedText.includes('world cup') ||
    combinedText.includes('fifa')
  ) {
    tags.push('wc2026');
  }

  if (
    clampNumber(pair.sortScore) >= 70 ||
    clampNumber(pair.volumeUsd) >= 100000 ||
    combinedText.includes('trend') ||
    combinedText.includes('whale') ||
    combinedText.includes('movement') ||
    combinedText.includes('momentum')
  ) {
    tags.push('trending');
  }

  return uniqueFilterTags(tags);
}

function createPairId(raw: RawLandingPair, index: number): string {
  const explicitId = raw.id || raw.pairId;
  if (explicitId) return String(explicitId);

  const eventTitle = raw.premiumSignal?.eventTitle || 'event';
  const position = raw.premiumSignal?.position || 'position';

  return `${eventTitle}-${position}-${index}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function normalizeLandingPairs(rawPairs: unknown[], source: LandingPairSource = 'api'): LandingPair[] {
  if (!Array.isArray(rawPairs)) return [];

  return rawPairs
    .map((raw, index): LandingPair | null => {
      const pair = raw as RawLandingPair;

      if (!pair?.premiumSignal || !pair?.marketSource) {
        return null;
      }

      const volumeUsd = clampNumber(pair.volumeUsd ?? pair.volume);
      const sortScore = clampNumber(pair.sortScore);
      const priority = clampNumber(pair.priority);

      const normalizedPair: LandingPair = {
        id: createPairId(pair, index),
        premiumSignal: pair.premiumSignal,
        marketSource: pair.marketSource,
        marketSources: Array.isArray(pair.marketSources) && pair.marketSources.length > 0
          ? pair.marketSources
          : [pair.marketSource as MarketSourceEvidenceCard],
        filterTags: Array.from(new Set([
          ...(Array.isArray(pair.filterTags) && pair.filterTags.length > 0
            ? uniqueFilterTags(pair.filterTags)
            : getPairFilterTags({
                premiumSignal: pair.premiumSignal,
                marketSource: pair.marketSource,
                volumeUsd,
                sortScore,
              })),
          ...(source === 'api' ? ['live' as FilterTag] : []),
        ])) as FilterTag[],
        isDefaultToday: Boolean(pair.isDefaultToday),
        priority,
        sortScore,
        volumeUsd,
        source,
      };

      return normalizedPair;
    })
    .filter((pair): pair is LandingPair => Boolean(pair));
}

function getPairRank(pair: LandingPair): number {
  const defaultBoost = pair.isDefaultToday ? 1_000_000_000_000 : 0;
  const priorityBoost = clampNumber(pair.priority) * 1_000_000_000;
  const scoreBoost = clampNumber(pair.sortScore) * 1_000_000;
  const volumeBoost = clampNumber(pair.volumeUsd);
  const probabilityBoost = clampNumber(pair.premiumSignal?.winProbability) * 1_000;

  return defaultBoost + priorityBoost + scoreBoost + volumeBoost + probabilityBoost;
}

function sortPairsByRank(pairs: LandingPair[]): LandingPair[] {
  return [...pairs].sort((a, b) => getPairRank(b) - getPairRank(a));
}

const FILTER_PREVIEW_OFFSETS: Record<FilterTag, number> = {
  sports: 0,
  trending: 1,
  live: 2,
  wc2026: 3,
};

function rotatePairs(pairs: LandingPair[], offset: number): LandingPair[] {
  if (pairs.length <= 1) return pairs;

  const safeOffset = offset % pairs.length;
  return [...pairs.slice(safeOffset), ...pairs.slice(0, safeOffset)];
}

export function selectDefaultPair(pairs: LandingPair[]): LandingPair | null {
  if (!pairs.length) return null;
  return sortPairsByRank(pairs)[0] ?? null;
}

export function getCandidatePairsForFilter(pairs: LandingPair[], activeFilter: FilterTag): LandingPair[] {
  if (!pairs.length) return [];

  const matchingPairs = pairs.filter((pair) => pair.filterTags.includes(activeFilter));
  const basePairs = matchingPairs.length > 0 ? matchingPairs : pairs;
  const rankedPairs = sortPairsByRank(basePairs);

  return rotatePairs(rankedPairs, FILTER_PREVIEW_OFFSETS[activeFilter]);
}

export function selectBestPairForFilter(pairs: LandingPair[], activeFilter: FilterTag): LandingPair | null {
  const candidates = getCandidatePairsForFilter(pairs, activeFilter);
  return candidates[0] ?? selectDefaultPair(pairs);
}

export function selectPeekPair(pairs: LandingPair[], activePairId: string): LandingPair | null {
  if (pairs.length <= 1) return null;

  const activeIndex = pairs.findIndex((pair) => pair.id === activePairId);

  if (activeIndex < 0) {
    return pairs[1] ?? pairs[0] ?? null;
  }

  return pairs[(activeIndex + 1) % pairs.length] ?? null;
}

/**
 * Ensure marketSources array is never empty by falling back to [marketSource]
 */
export function ensureMarketSourcesArray(
  marketSource: MarketSource,
  marketSources?: MarketSourceEvidenceCard[]
): MarketSourceEvidenceCard[] {
  if (marketSources && marketSources.length > 0) {
    return marketSources;
  }

  // Convert primary marketSource to evidence card, handle type compatibility
  const sourceType = marketSource.type as MarketSourceCardType || 'market-source';
  return [{
    ...marketSource,
    type: sourceType,
  } as MarketSourceEvidenceCard];
}

/**
 * Normalize landing pair to ensure marketSources is always populated
 */
export function normalizeLandingPairEvidenceStack(pair: LandingPair): LandingPair {
  return {
    id: pair.id,
    premiumSignal: pair.premiumSignal,
    marketSource: pair.marketSource,
    marketSources: ensureMarketSourcesArray(pair.marketSource, pair.marketSources),
    filterTags: pair.filterTags,
    isDefaultToday: pair.isDefaultToday,
    priority: pair.priority,
    sortScore: pair.sortScore,
    volumeUsd: pair.volumeUsd,
    source: pair.source,
  };
}
