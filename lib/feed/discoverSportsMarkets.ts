// Markets-first sports discovery
// Phase 3.6B — Production-grade markets-first discovery

import type {
  SportsMarketCandidate,
  GameGroup,
  SportsDiscoveryConfig,
  SportsDiscoveryCounts,
  SportsDiscoverySample,
  SportsDiscoveryResult,
  PolymarketRawEvent,
} from "./types";

import {
  fetchSportsMetadata,
  fetchTeams,
  fetchMarketsBySportsTag,
  fetchEventsByTagSlugSafe,
  fetchEventsBySeriesSafe,
  fetchActiveEventsByStartWindowKeysetSafe,
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
    // Event spine diagnostics (Patch S1)
    eventSpineUsed: false,
    eventSpineFallbackUsed: false,
    eventPagesFetched: 0,
    eventSpineTruncated: false,
    officialEventsFetched48h: 0,
    confirmedSportsEvents48h: 0,
    nestedSportsMarketsFlattened: 0,
    canonicalStartTimeApplied: 0,
  };

  // 1. Fetch sports metadata and tag IDs
  const { tagIds: sportsTagIds, sports: sportsRaw, success: sportsSuccess, error: sportsError } = await fetchSportsMetadata();
  if (!sportsSuccess) {
    warnings.push(`Sports metadata fetch failed: ${sportsError}`);
  }

  // Build sport-specific tag set (exclude generic root tags that appear on every event)
  // Generic tags: "1" (root Sports) and "100639" (near-universal Live Sports) — these
  // are present on 98-100% of sports config entries and would match non-sports events.
  const GENERIC_SPORTS_TAGS = new Set(["1", "100639"]);
  const specificSportsTagIds = new Set<string>();
  for (const s of (sportsRaw as Record<string, unknown>[])) {
    const tagsVal = s.tags;
    if (typeof tagsVal === "string") {
      tagsVal.split(",").map((t: string) => t.trim()).filter(Boolean).forEach((t: string) => {
        if (!GENERIC_SPORTS_TAGS.has(t)) specificSportsTagIds.add(t);
      });
    }
  }

  // Add probe tag if available (for flat fallback path)
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

  // 3a. PRIMARY SPINE: fetch events via /events/keyset for now → now+48h
  // This is the official event universe; nested markets are flattened and augmented
  // with canonical event.startTime so resolveGameTime returns the correct start time.
  const keysetEndIso = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const keysetResult = await fetchActiveEventsByStartWindowKeysetSafe(
    now.toISOString(),
    keysetEndIso,
  );

  counts.eventPagesFetched = keysetResult.pagesFetched;
  counts.eventSpineTruncated = keysetResult.truncated;
  counts.officialEventsFetched48h = keysetResult.events.length;

  if (keysetResult.errorState) {
    warnings.push(`Event keyset fetch error: ${keysetResult.errorState}`);
  }

  // Classify events and flatten nested markets with event context injected
  const keysetMarkets: Record<string, unknown>[] = [];
  let confirmedSportsCount = 0;

  for (const ev of keysetResult.events) {
    const event = ev as Record<string, unknown>;
    const evTags = (event.tags as Array<Record<string, unknown>>) ?? [];
    // Tier A: has at least one sport-specific tag (not the generic root tags)
    const isConfirmedSports = specificSportsTagIds.size > 0
      ? evTags.some(t => specificSportsTagIds.has(String(t.id ?? "")))
      : evTags.some(t => sportsTagIds.includes(String(t.id ?? ""))); // fallback if metadata failed

    if (!isConfirmedSports) continue;
    confirmedSportsCount++;

    const eventStartTime = typeof event.startTime === "string" ? event.startTime : undefined;
    const eventId = String(event.id ?? "");
    const eventSlug = String(event.slug ?? "");

    const nestedMarkets = Array.isArray(event.markets)
      ? (event.markets as Record<string, unknown>[])
      : [];

    for (const mkt of nestedMarkets) {
      counts.nestedSportsMarketsFlattened = (counts.nestedSportsMarketsFlattened ?? 0) + 1;

      // Augment the nested market with event context so normalizeSportsMarket picks up:
      //   - eventStartTime → m.eventStartTime (canonical start)
      //   - events[0]     → m.nestedEventId, m.nestedEventSlug, m.nestedEventStartTime
      // Both eventStartTime AND nestedEventStartTime being set gives classifyGameSignal
      // 2 reasons → "strong" signal for all keyset-derived markets with a valid startTime.
      const augmented: Record<string, unknown> = {
        ...mkt,
        eventStartTime: eventStartTime ?? null,
        events: [{
          id: eventId,
          slug: eventSlug,
          startTime: eventStartTime ?? null,
          title: event.title,
        }],
      };
      if (eventStartTime) {
        counts.canonicalStartTimeApplied = (counts.canonicalStartTimeApplied ?? 0) + 1;
      }
      keysetMarkets.push(augmented);
    }
  }

  counts.confirmedSportsEvents48h = confirmedSportsCount;

  // 3b. Decide whether to use event spine or fall back to flat /markets
  // Spine is used if it returned confirmed sports events without a hard error.
  // Fall back to flat /markets if spine returned zero confirmed sports (e.g. metadata
  // failure left specificSportsTagIds empty) so discovery is never silently empty.
  const useEventSpine = confirmedSportsCount > 0;
  counts.eventSpineUsed = useEventSpine;
  counts.eventSpineFallbackUsed = !useEventSpine;

  const allRawMarkets: Record<string, unknown>[] = [];

  if (useEventSpine) {
    allRawMarkets.push(...keysetMarkets);
  } else {
    // Flat /markets fallback (original spine) — runs only when keyset yields 0 sports events
    warnings.push("Event spine fallback: using flat /markets because keyset returned 0 confirmed sports events");
    for (const tagId of allTagIds.slice(0, 5)) {
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

  // 8c. Targeted WC2026 match-game discovery via Polymarket series soccer-fifwc.
  // Polymarket FIFA World Cup match fixtures (Mexico vs South Africa, etc.) live under
  // series_id 11433 — NOT tag_slug=fifa-world-cup (which returns only winner futures).
  {
    const WC2026_PROP_EXCLUDE_RE = /\b(top goalscorer|longshots parlay|qualification longshots|squad|winner|champion|outright)\b|player to make|will .+ play/i;
    const WC2026_SERIES_ID = "11433"; // series slug: soccer-fifwc
    let rawTagEvents: PolymarketRawEvent[] = [];
    try {
      rawTagEvents = await fetchEventsBySeriesSafe(WC2026_SERIES_ID, 50);
    } catch {
      warnings.push(`WC2026 series fetch failed for series_id=${WC2026_SERIES_ID}`);
    }
    if (rawTagEvents.length > 0) {
      const existingKeys = new Set(extendedWc2026Candidates.map(s => s.slug || s.gameId || s.title));
      const seenTagIds = new Set<string>();
      const nowMs = now.getTime();
      const wc2026FromTag: SportsDiscoverySample[] = [];
      for (const event of rawTagEvents) {
        if (!event.active || event.closed) continue;
        const key = event.id || event.slug;
        if (!key || seenTagIds.has(key)) continue;
        seenTagIds.add(key);
        const title = event.title || event.slug || "";
        if (WC2026_PROP_EXCLUDE_RE.test(title)) continue;
        if (existingKeys.has(event.slug || title)) continue;
        const endIso = event.endDateIso || event.endDate || null;
        if (endIso) {
          const hoursUntil = (new Date(endIso).getTime() - nowMs) / 3600000;
          // 2160h = 90 days. FIFA WC settles on tournament-end (July 20, 2026) which is
          // ~60d out; per-match markets are sooner. Match NBA/NHL futures horizon.
          if (hoursUntil < 0 || hoursUntil > 2160) continue;
        }
        // Scan match sub-markets (Will TeamA win / Will draw / Will TeamB win) and pick
        // the most actionable one. Unified bands only — no tournament-futures tier.
        // Tier 3: primary band [0.333, 0.588]; Tier 2: fallback band [0.20, 0.741].
        const PRIMARY_MIN = 0.333, PRIMARY_MAX = 0.588;
        const FALLBACK_MIN = 0.20, FALLBACK_MAX = 0.741;
        type Cand = { m: Record<string, unknown>; nm: SportsMarketCandidate; tier: number; inBandPrice: number };
        const subCands: Cand[] = [];
        for (const m of event.markets ?? []) {
          const nm = normalizeSportsMarket(m as unknown as Record<string, unknown>);
          if (!Array.isArray(nm.outcomePrices) || nm.outcomePrices.length === 0) continue;
          const findBand = (lo: number, hi: number) =>
            nm.outcomePrices.findIndex((p) => typeof p === "number" && p >= lo && p <= hi);
          let tier = -1;
          let chosenPriceIdx = -1;
          const idxP = findBand(PRIMARY_MIN, PRIMARY_MAX);
          if (idxP !== -1) { tier = 3; chosenPriceIdx = idxP; }
          else {
            const idxF = findBand(FALLBACK_MIN, FALLBACK_MAX);
            if (idxF !== -1) { tier = 2; chosenPriceIdx = idxF; }
          }
          if (tier === -1 || chosenPriceIdx === -1) continue;
          const inBandPrice = nm.outcomePrices[chosenPriceIdx];
          if (typeof inBandPrice !== "number") continue;
          subCands.push({ m: m as unknown as Record<string, unknown>, nm, tier, inBandPrice });
        }
        if (subCands.length === 0) continue;
        // Higher tier first; within tier, in-band price closest to 0.45 = strongest edge.
        subCands.sort((a, b) =>
          b.tier - a.tier || Math.abs(a.inBandPrice - 0.45) - Math.abs(b.inBandPrice - 0.45));

        // One signal per match game (not per sub-market) — avoids win+draw duplicates.
        const PER_EVENT_CAP = 1;
        for (const cand of subCands.slice(0, PER_EVENT_CAP)) {
          if (wc2026FromTag.length >= 5) break;
          const pm = cand.m as { volume?: number; volume24hr?: number; question?: string; conditionId?: string; slug?: string };
          const vol = typeof pm.volume === "number" ? pm.volume
            : typeof pm.volume24hr === "number" ? pm.volume24hr
            : typeof event.volume24hr === "number" ? event.volume24hr : 0;
          const gameSlug = (event.slug || cand.nm.slug || pm.slug || "").substring(0, 60);
          wc2026FromTag.push({
            // Event title = the matchup ("Mexico vs. South Africa"); buildUpcomingPairs
            // humanizes it with the picked Yes/No position downstream.
            title: (title || cand.nm.question || pm.question || "").substring(0, 100),
            slug: gameSlug,
            gameId: undefined,
            sportsMarketType: undefined,
            eventVolumeUsd: vol,
            resolvedGameTimeIso: endIso,
            gameTimeSource: "gamma-event-enddate",
            gameTimeConfidence: "medium",
            marketCount: event.markets?.length ?? 1,
            strategy: "targeted-wc2026-series-games",
            leagueName: "World Cup 2026",
            polymarketEventSlug: (event.slug || "").substring(0, 80),
            primaryMarketRaw: {
              outcomes: cand.nm.outcomes,
              outcomePrices: cand.nm.outcomePrices,
              clobTokenIds: cand.nm.clobTokenIds,
              question: cand.nm.question || (pm.question ?? title),
              conditionId: cand.nm.conditionId || (pm.conditionId ?? undefined),
              volumeNum: typeof pm.volume === "number" ? pm.volume : null,
              volume24hr: typeof pm.volume24hr === "number" ? pm.volume24hr : null,
              volumeClob: null,
            },
          });
        }
        // Continue outer event loop (don't `continue` to skip post-push lines)
        continue;
      }
      wc2026FromTag.sort((a, b) => b.eventVolumeUsd - a.eventVolumeUsd);
      extendedWc2026Candidates.push(...wc2026FromTag.slice(0, 5));
    }
  }

  // 8d. Targeted eSports tag-slug fetch — collect all within 30d, sort by primary-band
  // match-like candidates first (tier 3 > tier 2, vs/BO3/BO5 > futures, OddsFit desc).
  const extendedEsportsCandidates: SportsDiscoverySample[] = [];
  {
    const ESPORTS_PROP_EXCLUDE_RE = /\b(longshots|outright|champion(s)?|tournament winner|top fragger)\b/i;
    const ESPORTS_TAG_SLUGS = ["esports", "counter-strike", "cs2", "dota-2", "valorant", "league-of-legends"];
    const MAX_WINDOW_HOURS = 720; // 30d
    const TARGET_ESPORTS_FALLBACK = 2;
    const PRIMARY_MIN = 0.333, PRIMARY_MAX = 0.588;
    const FALLBACK_MIN = 0.20, FALLBACK_MAX = 0.741;

    const isMatchLikeEsportTitle = (t: string): boolean =>
      /\bvs\.?\b|\bBO[135]\b/i.test(t);

    type EsportCand = {
      event: PolymarketRawEvent;
      pm: Record<string, unknown>;
      normalized: SportsMarketCandidate;
      tier: number;
      inBandPrice: number;
      endIso: string;
      vol: number;
      matchLike: boolean;
    };

    const rawEsportsEvents: PolymarketRawEvent[] = [];
    for (const tagSlug of ESPORTS_TAG_SLUGS) {
      try {
        const events = await fetchEventsByTagSlugSafe(tagSlug, 30);
        rawEsportsEvents.push(...events);
      } catch {
        warnings.push(`Esports tag-slug fetch failed for ${tagSlug}`);
      }
    }

    const seenKeys = new Set<string>();
    const nowMs = now.getTime();
    const pool: EsportCand[] = [];

    for (const event of rawEsportsEvents) {
      if (!event.active || event.closed) continue;
      const key = event.id || event.slug;
      if (!key || seenKeys.has(key)) continue;
      const title = event.title || event.slug || "";
      if (ESPORTS_PROP_EXCLUDE_RE.test(title)) continue;
      const endIso = event.endDateIso || event.endDate || null;
      if (!endIso) continue;
      const hoursUntil = (new Date(endIso).getTime() - nowMs) / 3600000;
      if (hoursUntil < 0 || hoursUntil > MAX_WINDOW_HOURS) continue;

      // Score each sub-market; pick best by tier then OddsFit (price closest to 0.45)
      type SubCand = { pm: Record<string, unknown>; nm: SportsMarketCandidate; tier: number; inBandPrice: number };
      const subCands: SubCand[] = [];
      for (const m of Array.isArray(event.markets) ? event.markets : []) {
        const nm = normalizeSportsMarket(m as unknown as Record<string, unknown>);
        if (!Array.isArray(nm.outcomePrices) || nm.outcomePrices.length === 0) continue;
        const idxP = nm.outcomePrices.findIndex((p) => typeof p === "number" && p >= PRIMARY_MIN && p <= PRIMARY_MAX);
        if (idxP !== -1) {
          subCands.push({ pm: m as unknown as Record<string, unknown>, nm, tier: 3, inBandPrice: nm.outcomePrices[idxP] });
          continue;
        }
        const idxF = nm.outcomePrices.findIndex((p) => typeof p === "number" && p >= FALLBACK_MIN && p <= FALLBACK_MAX);
        if (idxF !== -1) {
          subCands.push({ pm: m as unknown as Record<string, unknown>, nm, tier: 2, inBandPrice: nm.outcomePrices[idxF] });
        }
      }
      if (subCands.length === 0) continue;
      subCands.sort((a, b) => b.tier - a.tier || Math.abs(a.inBandPrice - 0.45) - Math.abs(b.inBandPrice - 0.45));
      const best = subCands[0];
      const pmTyped = best.pm as { volume?: number; volume24hr?: number };
      const vol = typeof pmTyped.volume === "number" ? pmTyped.volume
        : typeof pmTyped.volume24hr === "number" ? pmTyped.volume24hr
        : typeof event.volume24hr === "number" ? event.volume24hr : 0;

      seenKeys.add(key);
      pool.push({
        event, pm: best.pm, normalized: best.nm,
        tier: best.tier, inBandPrice: best.inBandPrice,
        endIso, vol, matchLike: isMatchLikeEsportTitle(title),
      });
    }

    // Primary-band first; match-like (vs/BO3) before futures; OddsFit desc; earlier end; higher vol
    pool.sort((a, b) =>
      b.tier - a.tier ||
      (b.matchLike ? 1 : 0) - (a.matchLike ? 1 : 0) ||
      Math.abs(a.inBandPrice - 0.45) - Math.abs(b.inBandPrice - 0.45) ||
      new Date(a.endIso).getTime() - new Date(b.endIso).getTime() ||
      b.vol - a.vol
    );

    for (const cand of pool.slice(0, TARGET_ESPORTS_FALLBACK)) {
      const pmTyped = cand.pm as { volume?: number; volume24hr?: number; question?: string; conditionId?: string };
      const title = cand.event.title || cand.event.slug || "";
      extendedEsportsCandidates.push({
        title: title.substring(0, 100),
        slug: (cand.event.slug || "").substring(0, 60),
        gameId: undefined,
        sportsMarketType: undefined,
        eventVolumeUsd: cand.vol,
        resolvedGameTimeIso: cand.endIso,
        gameTimeSource: "gamma-event-enddate",
        gameTimeConfidence: "medium",
        marketCount: cand.event.markets?.length ?? 1,
        strategy: "targeted-esports-tag-slug",
        leagueName: "Esports",
        polymarketEventSlug: (cand.event.slug || "").substring(0, 80),
        primaryMarketRaw: {
          outcomes: cand.normalized.outcomes,
          outcomePrices: cand.normalized.outcomePrices,
          clobTokenIds: cand.normalized.clobTokenIds,
          question: cand.normalized.question || (pmTyped.question ?? title),
          conditionId: cand.normalized.conditionId || (pmTyped.conditionId ?? undefined),
          volumeNum: typeof pmTyped.volume === "number" ? pmTyped.volume : null,
          volume24hr: typeof pmTyped.volume24hr === "number" ? pmTyped.volume24hr : null,
          volumeClob: null,
        },
      });
    }
  }

  // 8e. Targeted NBA/NHL tag-slug fetch (futures-style supply; allows championship/series-winner
  // events because regular-season match supply is sparse outside playoffs).
  const extendedNbaCandidates: SportsDiscoverySample[] = [];
  const extendedNhlCandidates: SportsDiscoverySample[] = [];
  {
    const STRAT_PROP_EXCLUDE_RE = /\b(mvp|coach of the year|rookie of the year|top scorer|player to|sixth man|defensive player|finals mvp)\b/i;
    const PRIMARY_MIN = 0.333, PRIMARY_MAX = 0.588;
    const FALLBACK_MIN = 0.20, FALLBACK_MAX = 0.741;
    const findActionableIdx = (prices: number[]): number => {
      let idx = prices.findIndex((p) => typeof p === "number" && p >= PRIMARY_MIN && p <= PRIMARY_MAX);
      if (idx === -1) idx = prices.findIndex((p) => typeof p === "number" && p >= FALLBACK_MIN && p <= FALLBACK_MAX);
      return idx;
    };
    type Picked = { pm: Record<string, unknown>; normalized: SportsMarketCandidate };
    const pickActionableMarket = (event: PolymarketRawEvent): Picked | null => {
      const markets = Array.isArray(event.markets) ? event.markets : [];
      for (const m of markets) {
        const nm = normalizeSportsMarket(m as unknown as Record<string, unknown>);
        if (!Array.isArray(nm.outcomePrices) || nm.outcomePrices.length === 0) continue;
        if (findActionableIdx(nm.outcomePrices) !== -1) {
          return { pm: m as unknown as Record<string, unknown>, normalized: nm };
        }
      }
      return null;
    };
    const TARGET_PER_LEAGUE = 2;
    // Windows up to 90d because NBA/NHL futures (Stanley Cup / NBA Champion) settle ~40-60d
    const WINDOWS_HOURS = [48, 168, 336, 720, 1440, 2160];

    const buildStrategicCandidate = (
      event: PolymarketRawEvent,
      picked: Picked,
      endIso: string,
      leagueLabel: "NBA" | "NHL",
      strategy: string,
    ): SportsDiscoverySample => {
      const pm = picked.pm as { volume?: number; volume24hr?: number; question?: string; conditionId?: string };
      const title = event.title || event.slug || "";
      const vol = typeof pm.volume === "number" ? pm.volume
        : typeof pm.volume24hr === "number" ? pm.volume24hr
        : typeof event.volume24hr === "number" ? event.volume24hr : 0;
      return {
        title: title.substring(0, 100),
        slug: (event.slug || "").substring(0, 60),
        gameId: undefined,
        sportsMarketType: undefined,
        eventVolumeUsd: vol,
        resolvedGameTimeIso: endIso,
        gameTimeSource: "gamma-event-enddate",
        gameTimeConfidence: "medium",
        marketCount: event.markets?.length ?? 1,
        strategy,
        leagueName: leagueLabel,
        polymarketEventSlug: (event.slug || "").substring(0, 80),
        primaryMarketRaw: {
          outcomes: picked.normalized.outcomes,
          outcomePrices: picked.normalized.outcomePrices,
          clobTokenIds: picked.normalized.clobTokenIds,
          question: picked.normalized.question || (pm.question ?? title),
          conditionId: picked.normalized.conditionId || (pm.conditionId ?? undefined),
          volumeNum: typeof pm.volume === "number" ? pm.volume : null,
          volume24hr: typeof pm.volume24hr === "number" ? pm.volume24hr : null,
          volumeClob: null,
        },
      };
    };

    const collectForSlug = async (
      slug: string,
      bucket: SportsDiscoverySample[],
      leagueLabel: "NBA" | "NHL",
      strategy: string,
    ) => {
      let raw: PolymarketRawEvent[] = [];
      try {
        raw = await fetchEventsByTagSlugSafe(slug, 50);
      } catch {
        warnings.push(`${leagueLabel} tag-slug fetch failed for ${slug}`);
        return;
      }
      if (raw.length === 0) return;
      const seen = new Set<string>();
      const nowMs = now.getTime();
      for (const winHours of WINDOWS_HOURS) {
        if (bucket.length >= TARGET_PER_LEAGUE) break;
        for (const event of raw) {
          if (bucket.length >= TARGET_PER_LEAGUE) break;
          if (!event.active || event.closed) continue;
          const key = event.id || event.slug;
          if (!key || seen.has(key)) continue;
          const title = event.title || event.slug || "";
          if (STRAT_PROP_EXCLUDE_RE.test(title)) continue;
          const endIso = event.endDateIso || event.endDate || null;
          if (!endIso) continue;
          const hoursUntil = (new Date(endIso).getTime() - nowMs) / 3600000;
          if (hoursUntil < 0 || hoursUntil > winHours) continue;
          const picked = pickActionableMarket(event);
          if (!picked) continue;
          seen.add(key);
          bucket.push(buildStrategicCandidate(event, picked, endIso, leagueLabel, strategy));
        }
      }
    };

    await collectForSlug("nba", extendedNbaCandidates, "NBA", "targeted-nba-tag-slug");
    if (extendedNbaCandidates.length < 2) {
      await collectForSlug("basketball", extendedNbaCandidates, "NBA", "targeted-nba-basketball-tag-slug");
    }
    await collectForSlug("nhl", extendedNhlCandidates, "NHL", "targeted-nhl-tag-slug");
    if (extendedNhlCandidates.length < 2) {
      await collectForSlug("ice-hockey", extendedNhlCandidates, "NHL", "targeted-nhl-icehockey-tag-slug");
    }
  }

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
    .map((g) => ({
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
    extendedEsportsCandidates,
    extendedNbaCandidates,
    extendedNhlCandidates,
    diagnosis,
    recommendedPath,
  };
}
