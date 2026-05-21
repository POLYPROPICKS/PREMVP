// Markets-first sports discovery
// Phase 3.6B — Production-grade markets-first discovery

import type {
  SportsMarketCandidate,
  GameGroup,
  SportsDiscoveryConfig,
  SportsDiscoveryCounts,
  SportsDiscoverySample,
  SportsDiscoveryResult,
} from "./types";

import {
  fetchSportsMetadata,
  fetchTeams,
  fetchMarketsBySportsTag,
} from "./polymarketClient";

import {
  normalizeSportsMarket,
  canonicalMarketVolume,
  resolveGameTime,
  isFuturesMarket,
  classifyGameSignal,
} from "./normalizePolymarket";

const DEFAULT_CONFIG: SportsDiscoveryConfig = {
  windowHours: 24,
  fallbackWindowHours: 72,
  fetchVolumeMinUsd: 50000,
  finalEventVolumeMinUsd: 100000,
  targetCards: 5,
  platform: "Polymarket",
  network: "Polygon",
  formulaVersion: "trusted-initial-formula-v1.1",
};

// Resolve league name from a GameGroup using teamsMap and slug/text heuristics
function resolveLeagueName(
  g: GameGroup,
  teamsMap: Map<string, { logo: string | null; name: string; league: string }>,
): string {
  const teamA = g.teamAID ? teamsMap.get(g.teamAID) : null;
  if (teamA?.league) return teamA.league;

  const slug = g.primaryMarket?.slug || g.primaryMarket?.nestedEventSlug || "";
  const prefix = slug.split("-")[0].toLowerCase();
  const prefixMap: Record<string, string> = {
    epl: "Premier League",
    lal: "La Liga",
    ucl: "Champions League",
    bun: "Bundesliga",
    ser: "Serie A",
    fl1: "Ligue 1",
    nba: "NBA",
    nhl: "NHL",
    mlb: "MLB",
    nfl: "NFL",
    ufc: "UFC",
    mls: "MLS",
    mma: "UFC",
    atp: "Tennis",
    wta: "Tennis",
    cs2: "Esports",
    val: "Esports",
    lol: "Esports",
    dota: "Esports",
  };
  if (prefixMap[prefix]) return prefixMap[prefix];

  const q = [
    g.primaryMarket?.question || "",
    slug,
    g.primaryMarket?.nestedEventSlug || "",
    g.groupKey || "",
  ].join(" ").toLowerCase();
  if (q.includes("premier league")) return "Premier League";
  if (q.includes("la liga") || q.includes("laliga")) return "La Liga";
  if (q.includes("champions league")) return "Champions League";
  if (q.includes("bundesliga")) return "Bundesliga";
  if (q.includes("serie a")) return "Serie A";
  if (q.includes("ligue 1")) return "Ligue 1";
  if (q.includes("nba")) return "NBA";
  if (q.includes("nhl")) return "NHL";
  if (q.includes("mlb")) return "MLB";
  if (q.includes("nfl")) return "NFL";
  if (q.includes("ufc") || q.includes("mma")) return "UFC";
  if (q.includes("tennis") || q.includes("atp") || q.includes("wta")) return "Tennis";
  if (q.includes("cs2") || q.includes("csgo") || q.includes("dota") || q.includes("valorant") || q.includes("map handicap")) return "Esports";
  if (q.includes("world cup") || q.includes("wc2026") || q.includes("wc 2026") || q.includes("fifa world cup")) return "World Cup 2026";
  return "Sports";
}

// Create group key for market grouping
function createGroupKey(m: SportsMarketCandidate): string {
  if (m.gameId) return `game:${m.gameId}`;
  if (m.nestedEventId) return `event:${m.nestedEventId}`;
  if (m.teamAID && m.teamBID) {
    const date = m.gameStartTime || m.eventStartTime || m.nestedEventStartTime || m.endDateIso;
    const dateKey = date ? date.split("T")[0] : "nodate";
    return `teams:${m.teamAID}:${m.teamBID}:${dateKey}`;
  }

  // Fallback to slug + date
  const slugBase = m.slug.replace(/-\d{4}-\d{2}-\d{2}.*$/, "").replace(/-\d+$/, "");
  const dateStr = m.gameStartTime || m.eventStartTime || m.nestedEventStartTime || m.endDateIso || "";
  const dateKey = dateStr.split("T")[0] || "nodate";
  return `slug:${slugBase}:${dateKey}`;
}

// Group markets by game
function groupMarketsByGame(markets: SportsMarketCandidate[]): GameGroup[] {
  const groups = new Map<string, SportsMarketCandidate[]>();

  for (const m of markets) {
    const key = createGroupKey(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return Array.from(groups.entries()).map(([groupKey, markets]) => {
    // Find best game time
    let bestTime: { iso: string | null; source: string; confidence: "high" | "medium" | "low" | "none" } = {
      iso: null, source: "none", confidence: "none"
    };

    for (const m of markets) {
      const time = resolveGameTime(m);
      const confidenceOrder = { high: 3, medium: 2, low: 1, none: 0 };
      if (confidenceOrder[time.gameTimeConfidence] > confidenceOrder[bestTime.confidence]) {
        bestTime = { iso: time.resolvedGameTimeIso, source: time.gameTimeSource, confidence: time.gameTimeConfidence };
      }
    }

    // Calculate total volume
    let totalVolume = 0;
    let highestVolumeMarket: SportsMarketCandidate | null = null;
    let maxVolume = 0;

    for (const m of markets) {
      const { volume } = canonicalMarketVolume(m);
      totalVolume += volume;
      if (volume > maxVolume) {
        maxVolume = volume;
        highestVolumeMarket = m;
      }
    }

    // Determine primary market (prefer moneyline/match winner)
    let primaryMarket: SportsMarketCandidate | null = highestVolumeMarket;
    for (const m of markets) {
      const q = m.question.toLowerCase();
      if (q.includes("winner") || q.includes("moneyline") || q.includes("match")) {
        primaryMarket = m;
        break;
      }
    }

    const first = markets[0];

    return {
      groupKey,
      markets,
      gameId: first.gameId,
      nestedEventId: first.nestedEventId,
      teamAID: first.teamAID,
      teamBID: first.teamBID,
      resolvedGameTimeIso: bestTime.iso,
      gameTimeSource: bestTime.source,
      gameTimeConfidence: bestTime.confidence,
      eventVolumeUsd: totalVolume,
      highestVolumeMarket,
      primaryMarket,
    };
  });
}

// Main discovery function
export async function discoverSportsMarkets(
  config?: Partial<SportsDiscoveryConfig>
): Promise<SportsDiscoveryResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();
  const windowEnd = new Date(now.getTime() + cfg.windowHours * 60 * 60 * 1000);

  const warnings: string[] = [];
  const rejectionReasonCounts: Record<string, number> = {};
  const acceptedSamples: SportsDiscoverySample[] = [];
  const rejectedSamples: SportsDiscoverySample[] = [];

  // Track counts
  const counts: SportsDiscoveryCounts = {
    rawMarketsFetched: 0,
    normalizedMarkets: 0,
    activeMarkets: 0,
    closedRejected: 0,
    withGameId: 0,
    withSportsMarketType: 0,
    withTeamIds: 0,
    withGameStartTime: 0,
    withEventStartTime: 0,
    withNestedEventStartTime: 0,
    strongGameSignalCandidates: 0,
    mediumGameSignalCandidates: 0,
    futuresRejected: 0,
    groupedGames: 0,
    within24hGroups: 0,
    within48hGroups: 0,
    volumeEligibleGroups: 0,
    finalPairs: 0,
  };

  // 1. Fetch sports metadata and tag IDs
  const { tagIds: sportsTagIds, success: sportsSuccess, error: sportsError } = await fetchSportsMetadata();
  if (!sportsSuccess) {
    warnings.push(`Sports metadata fetch failed: ${sportsError}`);
  }

  // Add probe tag if available
  const probeTagId = "100639";
  const allTagIds = [...sportsTagIds];
  if (!allTagIds.includes(probeTagId)) {
    allTagIds.push(probeTagId);
  }

  // 2. Fetch teams and build lookup map
  const { teams: teamsRaw } = await fetchTeams();
  const teamsMap = new Map<string, { logo: string | null; name: string; league: string }>();
  for (const t of teamsRaw) {
    const team = t as Record<string, unknown>;
    const id = String(team.id || "");
    if (id) {
      teamsMap.set(id, {
        logo: typeof team.logo === "string" ? team.logo : null,
        name: typeof team.name === "string" ? team.name : "",
        league: typeof team.league === "string" ? team.league : "",
      });
    }
  }

  // 3. Fetch markets by sports tags
  const allRawMarkets: Record<string, unknown>[] = [];

  for (const tagId of allTagIds.slice(0, 5)) { // Limit to first 5 tags
    try {
      const markets = await fetchMarketsBySportsTag(tagId, {
        volumeMinUsd: cfg.fetchVolumeMinUsd,
        limit: 500,
      });
      allRawMarkets.push(...markets);
    } catch (err) {
      warnings.push(`Failed to fetch markets for tag ${tagId}: ${err}`);
    }
  }

  counts.rawMarketsFetched = allRawMarkets.length;

  // Deduplicate by ID
  const seenIds = new Set<string>();
  const uniqueRawMarkets = allRawMarkets.filter(m => {
    const id = String(m.id || "");
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // 4. Normalize markets
  const normalizedMarkets = uniqueRawMarkets.map(normalizeSportsMarket);
  counts.normalizedMarkets = normalizedMarkets.length;

  // Track field availability
  counts.withGameId = normalizedMarkets.filter(m => m.gameId).length;
  counts.withSportsMarketType = normalizedMarkets.filter(m => m.sportsMarketType).length;
  counts.withTeamIds = normalizedMarkets.filter(m => m.teamAID && m.teamBID).length;
  counts.withGameStartTime = normalizedMarkets.filter(m => m.gameStartTime).length;
  counts.withEventStartTime = normalizedMarkets.filter(m => m.eventStartTime).length;
  counts.withNestedEventStartTime = normalizedMarkets.filter(m => m.nestedEventStartTime).length;

  // 5. Filter active and classify
  const activeMarkets = normalizedMarkets.filter(m => {
    if (m.active && !m.closed) {
      counts.activeMarkets++;
      return true;
    }
    counts.closedRejected++;
    return false;
  });

  const gameLikeMarkets: SportsMarketCandidate[] = [];

  for (const m of activeMarkets) {
    const signal = classifyGameSignal(m);

    if (isFuturesMarket(m)) {
      counts.futuresRejected++;
      rejectedSamples.push({
        title: m.question.substring(0, 100),
        slug: m.slug.substring(0, 60),
        eventVolumeUsd: canonicalMarketVolume(m).volume,
        resolvedGameTimeIso: null,
        gameTimeSource: "none",
        gameTimeConfidence: "none",
        marketCount: 1,
        strategy: "futures-rejected",
        rejectionReason: "futures-market",
      });
      rejectionReasonCounts["futures-market"] = (rejectionReasonCounts["futures-market"] || 0) + 1;
    } else if (signal.level === "strong") {
      counts.strongGameSignalCandidates++;
      gameLikeMarkets.push(m);
      acceptedSamples.push({
        title: m.question.substring(0, 100),
        slug: m.slug.substring(0, 60),
        gameId: m.gameId,
        sportsMarketType: m.sportsMarketType,
        eventVolumeUsd: canonicalMarketVolume(m).volume,
        resolvedGameTimeIso: resolveGameTime(m).resolvedGameTimeIso,
        gameTimeSource: resolveGameTime(m).gameTimeSource,
        gameTimeConfidence: resolveGameTime(m).gameTimeConfidence,
        marketCount: 1,
        strategy: "strong-signal",
      });
    } else if (signal.level === "medium") {
      counts.mediumGameSignalCandidates++;
      gameLikeMarkets.push(m);
    }
  }

  // 6. Group by game
  const groupedGames = groupMarketsByGame(gameLikeMarkets);
  counts.groupedGames = groupedGames.length;

  // 7. Filter by time window (24h)
  const within24hGroups = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const d = new Date(g.resolvedGameTimeIso);
    const hoursUntil = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil <= cfg.windowHours &&
           (g.gameTimeConfidence === "high" || g.gameTimeConfidence === "medium");
  });
  counts.within24hGroups = within24hGroups.length;

  // 8. Filter by time window (48h fallback)
  const within48hGroups = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const d = new Date(g.resolvedGameTimeIso);
    const hoursUntil = (d.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntil >= 0 && hoursUntil <= cfg.fallbackWindowHours &&
           (g.gameTimeConfidence === "high" || g.gameTimeConfidence === "medium");
  });
  counts.within48hGroups = within48hGroups.length;

  // 8b. Extended WC2026 window (up to 30d) for upcoming gap-fill
  const WC2026_FUTURES_RE = /\b(winner|champion(s)?|outright|top scorer|group winner|to win (the )?world cup|world cup winner)\b/i;
  const extended30dWc2026Groups = groupedGames.filter(g => {
    if (!g.resolvedGameTimeIso) return false;
    const hoursUntil = (new Date(g.resolvedGameTimeIso).getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursUntil <= cfg.fallbackWindowHours || hoursUntil > 720) return false;
    if (g.gameTimeConfidence !== "high" && g.gameTimeConfidence !== "medium") return false;
    if (g.eventVolumeUsd <= 0) return false;
    const leagueName = resolveLeagueName(g, teamsMap);
    if (leagueName !== "World Cup 2026") return false;
    const title = (g.primaryMarket?.question || g.highestVolumeMarket?.question || "").toLowerCase();
    if (WC2026_FUTURES_RE.test(title)) return false;
    return true;
  });
  extended30dWc2026Groups.sort((a, b) => {
    if (b.eventVolumeUsd !== a.eventVolumeUsd) return b.eventVolumeUsd - a.eventVolumeUsd;
    if (a.resolvedGameTimeIso && b.resolvedGameTimeIso)
      return new Date(a.resolvedGameTimeIso).getTime() - new Date(b.resolvedGameTimeIso).getTime();
    return 0;
  });
  const extendedWc2026Candidates: SportsDiscoverySample[] = extended30dWc2026Groups
    .slice(0, 3)
    .map(g => ({
      title: g.primaryMarket?.question?.substring(0, 100) || g.highestVolumeMarket?.question?.substring(0, 100) || "Unknown",
      slug: g.primaryMarket?.slug?.substring(0, 60) || g.highestVolumeMarket?.slug?.substring(0, 60) || "",
      gameId: g.gameId,
      sportsMarketType: g.primaryMarket?.sportsMarketType,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      gameTimeConfidence: g.gameTimeConfidence,
      marketCount: g.markets.length,
      strategy: "extended-wc2026-30d-fallback",
      leagueName: "World Cup 2026",
      primaryMarketRaw: g.primaryMarket,
    }));

  // 9. Filter by volume
  const volumeEligible24hGroups = within24hGroups.filter(g => g.eventVolumeUsd >= cfg.finalEventVolumeMinUsd);
  const volumeEligible48hGroups = within48hGroups.filter(g => g.eventVolumeUsd >= cfg.finalEventVolumeMinUsd);
  counts.volumeEligibleGroups = volumeEligible24hGroups.length;

  // 10. Sort by volume DESC, then time ASC
  volumeEligible24hGroups.sort((a, b) => {
    if (b.eventVolumeUsd !== a.eventVolumeUsd) {
      return b.eventVolumeUsd - a.eventVolumeUsd;
    }
    // Same volume: earlier time first
    if (a.resolvedGameTimeIso && b.resolvedGameTimeIso) {
      return new Date(a.resolvedGameTimeIso).getTime() - new Date(b.resolvedGameTimeIso).getTime();
    }
    // High confidence before medium
    const confidenceOrder = { high: 0, medium: 1, low: 2, none: 3 };
    return confidenceOrder[a.gameTimeConfidence] - confidenceOrder[b.gameTimeConfidence];
  });

  volumeEligible48hGroups.sort((a, b) => {
    if (b.eventVolumeUsd !== a.eventVolumeUsd) {
      return b.eventVolumeUsd - a.eventVolumeUsd;
    }
    if (a.resolvedGameTimeIso && b.resolvedGameTimeIso) {
      return new Date(a.resolvedGameTimeIso).getTime() - new Date(b.resolvedGameTimeIso).getTime();
    }
    return 0;
  });

  // 11. Build final candidates
  const finalCandidates: SportsDiscoverySample[] = volumeEligible24hGroups
    .slice(0, cfg.targetCards)
    .map((g, idx) => ({
      title: g.primaryMarket?.question?.substring(0, 100) || g.highestVolumeMarket?.question?.substring(0, 100) || "Unknown",
      slug: g.primaryMarket?.slug?.substring(0, 60) || g.highestVolumeMarket?.slug?.substring(0, 60) || "",
      gameId: g.gameId,
      sportsMarketType: g.primaryMarket?.sportsMarketType,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      gameTimeConfidence: g.gameTimeConfidence,
      marketCount: g.markets.length,
      strategy: "markets-first",
      leagueName: resolveLeagueName(g, teamsMap),
      polymarketEventSlug: g.primaryMarket?.nestedEventSlug || g.primaryMarket?.slug || "",
      teamALogo: g.teamAID ? (teamsMap.get(g.teamAID)?.logo ?? null) : null,
      teamBLogo: g.teamBID ? (teamsMap.get(g.teamBID)?.logo ?? null) : null,
      teamAName: g.teamAID ? (teamsMap.get(g.teamAID)?.name ?? null) : null,
      teamBName: g.teamBID ? (teamsMap.get(g.teamBID)?.name ?? null) : null,
      eventImage: (() => {
        const raw = g.primaryMarket?.raw || {};
        return (raw.image as string) || (raw.icon as string) || null;
      })(),
      // Add raw market data for outcome pricing
      primaryMarketRaw: g.primaryMarket ? {
        outcomes: g.primaryMarket.outcomes,
        outcomePrices: g.primaryMarket.outcomePrices,
        clobTokenIds: g.primaryMarket.clobTokenIds,
        question: g.primaryMarket.question,
        sportsMarketType: g.primaryMarket.sportsMarketType,
        gameId: g.primaryMarket.gameId,
        conditionId: g.primaryMarket.conditionId,
        volumeNum: g.primaryMarket.volumeNum,
        volume24hr: g.primaryMarket.volume24hr,
        volumeClob: g.primaryMarket.volumeClob,
        oneDayPriceChange: g.primaryMarket.oneDayPriceChange,
      } : null,
      // Add all grouped markets for mapper to try
      marketsRaw: g.markets.map(m => ({
        outcomes: m.outcomes,
        outcomePrices: m.outcomePrices,
        clobTokenIds: m.clobTokenIds,
        question: m.question,
        sportsMarketType: m.sportsMarketType,
        conditionId: m.conditionId,
        volumeNum: m.volumeNum,
        volume24hr: m.volume24hr,
        volumeClob: m.volumeClob,
        oneDayPriceChange: m.oneDayPriceChange,
      })),
    }));

  counts.finalPairs = finalCandidates.length;

  // 12. Build fallback candidates
  const fallback48hCandidates: SportsDiscoverySample[] = volumeEligible48hGroups
    .filter(g => !finalCandidates.some(fc => fc.gameId && fc.gameId === g.gameId))
    .slice(0, cfg.targetCards)
    .map((g, idx) => ({
      title: g.primaryMarket?.question?.substring(0, 100) || g.highestVolumeMarket?.question?.substring(0, 100) || "Unknown",
      slug: g.primaryMarket?.slug?.substring(0, 60) || g.highestVolumeMarket?.slug?.substring(0, 60) || "",
      gameId: g.gameId,
      sportsMarketType: g.primaryMarket?.sportsMarketType,
      eventVolumeUsd: g.eventVolumeUsd,
      resolvedGameTimeIso: g.resolvedGameTimeIso,
      gameTimeSource: g.gameTimeSource,
      gameTimeConfidence: g.gameTimeConfidence,
      marketCount: g.markets.length,
      strategy: "markets-first-48h-fallback",
      leagueName: resolveLeagueName(g, teamsMap),
    }));

  // 13. Determine diagnosis
  let diagnosis: string;
  let recommendedPath: string;

  if (finalCandidates.length >= 4) {
    diagnosis = "READY_FOR_PRODUCTION_DISCOVERY";
    recommendedPath = "markets-first";
  } else if (finalCandidates.length < 4 && fallback48hCandidates.length >= 4) {
    diagnosis = "24H_SUPPLY_LOW_48H_WORKS";
    recommendedPath = "markets-first-with-48h-fallback";
  } else if (normalizedMarkets.length > 0 && counts.strongGameSignalCandidates > 0 && finalCandidates.length === 0) {
    diagnosis = "TIME_OR_VOLUME_FILTER_TOO_STRICT";
    recommendedPath = "review-filters";
  } else if (normalizedMarkets.length > 0 && counts.strongGameSignalCandidates === 0) {
    diagnosis = "SPORTS_TAG_MARKETS_NOT_GAME_SPECIFIC";
    recommendedPath = "add-game-specific-queries";
  } else {
    diagnosis = "INSUFFICIENT_SPORTS_DISCOVERY_SUPPLY";
    recommendedPath = "hybrid-with-events-fallback";
  }

  return {
    generatedAt: now.toISOString(),
    config: cfg,
    counts,
    rejectionReasonCounts,
    acceptedSamples: acceptedSamples.slice(0, 20),
    rejectedSamples: rejectedSamples.slice(0, 20),
    warnings,
    finalCandidates,
    fallback48hCandidates,
    extendedWc2026Candidates,
    diagnosis,
    recommendedPath,
  };
}
