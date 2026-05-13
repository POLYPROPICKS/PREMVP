// Polymarket public API client — server-side only
// Uses native fetch, no auth required for public market data

import {
  PolymarketRawEvent,
  PolymarketPricePoint,
  PolymarketTrade,
  PolymarketHolder,
} from "./types";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const CLOB_API_BASE = "https://clob.polymarket.com";
const DATA_API_BASE = "https://data-api.polymarket.com";

// Helper for safe fetch with timeout
async function safeFetch<T>(
  url: string,
  options?: RequestInit,
  timeoutMs = 5000
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        ...options?.headers,
      },
      next: { revalidate: 0 },
    } as RequestInit & { next?: { revalidate: number } });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`Polymarket API error: ${url} -> ${response.status}`);
      return null;
    }

    return await response.json() as T;
  } catch (error) {
    console.warn(`Polymarket fetch failed: ${url}`, error);
    return null;
  }
}

/**
 * Fetch active events from Gamma API
 * Handles multiple response shapes: raw array, { events: [] }, { data: [] }, { items: [] }
 * Supports pagination with offset
 */
export async function fetchPolymarketActiveEvents(options?: {
  limit?: number;
  offset?: number;
}): Promise<PolymarketRawEvent[]> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;

  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    order: "volume_24hr",
    ascending: "false",
    limit: limit.toString(),
    offset: offset.toString(),
  });

  const url = `${GAMMA_API_BASE}/events?${params.toString()}`;

  const response = await safeFetch<unknown>(url, {
    next: { revalidate: 300 }, // 5 minute cache
  });

  if (!response) {
    return [];
  }

  // Handle raw array response (most common from Gamma)
  if (Array.isArray(response)) {
    return response as PolymarketRawEvent[];
  }

  // Handle object wrappers
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>;

    if (Array.isArray(obj.events)) {
      return obj.events as PolymarketRawEvent[];
    }
    if (Array.isArray(obj.data)) {
      return obj.data as PolymarketRawEvent[];
    }
    if (Array.isArray(obj.items)) {
      return obj.items as PolymarketRawEvent[];
    }
  }

  console.warn("Unexpected Gamma API response shape:", typeof response);
  return [];
}

/**
 * Fetch sports metadata from Gamma API
 * Best-effort: if it fails, fallback to keyword filtering
 */
export async function fetchPolymarketSportsMetadataSafe(): Promise<{
  tagId?: string;
  tagIds?: string[];
  success: boolean;
  error?: string;
}> {
  const url = `${GAMMA_API_BASE}/sports`;

  const response = await safeFetch<unknown>(url, {
    next: { revalidate: 3600 }, // 1 hour cache
  }, 5000);

  if (!response) {
    return { success: false, error: "No response from /sports endpoint" };
  }

  try {
    // Try to extract tag IDs from various possible shapes
    if (typeof response === "object" && response !== null) {
      const obj = response as Record<string, unknown>;

      // Direct tagId field
      if (obj.tagId && typeof obj.tagId === "string") {
        return { tagId: obj.tagId, success: true };
      }

      // tag_ids array
      if (Array.isArray(obj.tag_ids)) {
        const tagIds = obj.tag_ids.filter((id): id is string => typeof id === "string");
        if (tagIds.length > 0) {
          return { tagId: tagIds[0], tagIds, success: true };
        }
      }

      // nested sports object
      if (obj.sports && typeof obj.sports === "object" && obj.sports !== null) {
        const sports = obj.sports as Record<string, unknown>;
        if (sports.tagId && typeof sports.tagId === "string") {
          return { tagId: sports.tagId, success: true };
        }
      }

      // categories array with sports
      if (Array.isArray(obj.categories)) {
        const sportsCategory = obj.categories.find(
          (c): c is Record<string, unknown> =>
            typeof c === "object" &&
            c !== null &&
            (String(c.name || c.title || "").toLowerCase().includes("sport") ||
             String(c.slug || "").toLowerCase().includes("sport"))
        );
        if (sportsCategory && sportsCategory.tagId) {
          return { tagId: String(sportsCategory.tagId), success: true };
        }
      }
    }

    return { success: false, error: "Could not parse /sports response shape" };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Fetch events by tag ID from Gamma API
 * For sports-specific discovery
 */
export async function fetchPolymarketEventsByTagSafe(tagId: string, limit = 100): Promise<PolymarketRawEvent[]> {
  const params = new URLSearchParams({
    tag_id: tagId,
    active: "true",
    closed: "false",
    limit: limit.toString(),
    related_tags: "true",
  });

  const url = `${GAMMA_API_BASE}/events?${params.toString()}`;

  const response = await safeFetch<unknown>(url, {
    next: { revalidate: 300 },
  });

  if (!response) {
    return [];
  }

  // Handle raw array response
  if (Array.isArray(response)) {
    return response as PolymarketRawEvent[];
  }

  // Handle object wrappers
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>;

    if (Array.isArray(obj.events)) {
      return obj.events as PolymarketRawEvent[];
    }
    if (Array.isArray(obj.data)) {
      return obj.data as PolymarketRawEvent[];
    }
    if (Array.isArray(obj.items)) {
      return obj.items as PolymarketRawEvent[];
    }
  }

  console.warn("Unexpected Gamma tag-filtered response shape:", typeof response);
  return [];
}

/**
 * Fetch price history for a token from CLOB API
 */
export async function fetchPriceHistorySafe(
  tokenId: string,
  interval: "1h" | "6h" | "1d" = "6h"
): Promise<PolymarketPricePoint[] | null> {
  if (!tokenId) return null;

  const params = new URLSearchParams({
    interval,
    market: tokenId,
    fidelity: "60",
  });

  const url = `${CLOB_API_BASE}/prices-history?${params.toString()}`;

  return await safeFetch<PolymarketPricePoint[]>(url);
}

/**
 * Fetch current spread for a token from CLOB API
 */
export async function fetchSpreadSafe(
  tokenId: string
): Promise<{ min: number; max: number } | null> {
  if (!tokenId) return null;

  const url = `${CLOB_API_BASE}/spread?token_id=${encodeURIComponent(tokenId)}`;

  const data = await safeFetch<{ min: string; max: string }>(url);
  if (!data) return null;

  return {
    min: parseFloat(data.min),
    max: parseFloat(data.max),
  };
}

/**
 * Fetch order book for a token from CLOB API
 */
export async function fetchOrderBookSafe(
  tokenId: string
): Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]> } | null> {
  if (!tokenId) return null;

  const url = `${CLOB_API_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;

  return await safeFetch<{ bids: Array<[string, string]>; asks: Array<[string, string]> }>(url);
}

/**
 * Fetch recent trades for a market from Data API
 */
export async function fetchTradesSafe(
  conditionId: string
): Promise<PolymarketTrade[] | null> {
  if (!conditionId) return null;

  // Try multiple possible endpoints
  const urls = [
    `${DATA_API_BASE}/trades?market=${encodeURIComponent(conditionId)}&limit=100&takerOnly=true`,
    `${DATA_API_BASE}/trades?market=${encodeURIComponent(conditionId)}&limit=100`,
  ];

  for (const url of urls) {
    const data = await safeFetch<{ trades?: PolymarketTrade[] } | PolymarketTrade[]>(url);
    if (data) {
      if (Array.isArray(data)) return data;
      if ("trades" in data && Array.isArray(data.trades)) return data.trades;
    }
  }

  return null;
}

/**
 * Fetch holders for a market from Data API
 */
export async function fetchHoldersSafe(
  conditionId: string
): Promise<PolymarketHolder[] | null> {
  if (!conditionId) return null;

  const urls = [
    `${DATA_API_BASE}/holders?market=${encodeURIComponent(conditionId)}&limit=20&minBalance=1`,
    `${DATA_API_BASE}/v1/market-positions?market=${encodeURIComponent(conditionId)}&status=OPEN&sortBy=TOKENS&limit=50`,
  ];

  for (const url of urls) {
    const data = await safeFetch<{ holders?: PolymarketHolder[] } | PolymarketHolder[]>(url);
    if (data) {
      if (Array.isArray(data)) return data;
      if ("holders" in data && Array.isArray(data.holders)) return data.holders;
    }
  }

  return null;
}

/**
 * Fetch open interest for a market from Data API
 */
export async function fetchOpenInterestSafe(
  conditionId: string
): Promise<number | null> {
  if (!conditionId) return null;

  const url = `${DATA_API_BASE}/oi?market=${encodeURIComponent(conditionId)}`;

  const data = await safeFetch<{ openInterest?: number; value?: number }>(url);
  if (!data) return null;

  return data.openInterest ?? data.value ?? null;
}

// ============================================================================
// Sports Discovery Markets-First API (Phase 3.6B)
// ============================================================================

/**
 * Fetch sports metadata from Gamma API
 * Returns sports list with extracted tag IDs
 */
export async function fetchSportsMetadata(): Promise<{
  sports: unknown[];
  tagIds: string[];
  success: boolean;
  error?: string;
}> {
  const url = `${GAMMA_API_BASE}/sports`;
  const response = await safeFetch<unknown>(url, {}, 10000);

  if (!response) {
    return { sports: [], tagIds: [], success: false, error: "No response from /sports" };
  }

  const sports = Array.isArray(response) ? response : [];
  const tagIds: string[] = [];

  for (const s of sports) {
    const sport = s as Record<string, unknown>;
    const tagsVal = sport.tags;
    if (typeof tagsVal === "string") {
      tagIds.push(...tagsVal.split(",").map(t => t.trim()).filter(Boolean));
    } else if (Array.isArray(tagsVal)) {
      tagIds.push(...tagsVal.map(String).filter(Boolean));
    }
  }

  // Also check for tag_id field directly
  for (const s of sports) {
    const sport = s as Record<string, unknown>;
    if (sport.tag_id && typeof sport.tag_id === "string") {
      tagIds.push(sport.tag_id);
    }
    if (sport.tagId && typeof sport.tagId === "string") {
      tagIds.push(sport.tagId);
    }
  }

  const uniqueTagIds = [...new Set(tagIds)];
  return { sports, tagIds: uniqueTagIds, success: true };
}

/**
 * Fetch teams from Gamma API
 */
export async function fetchTeams(): Promise<{ teams: unknown[]; count: number }> {
  const url = `${GAMMA_API_BASE}/teams`;
  const response = await safeFetch<unknown>(url, {}, 10000);
  const teams = Array.isArray(response) ? response : [];
  return { teams, count: teams.length };
}

/**
 * Fetch sports market types from Gamma API (diagnostic only)
 */
export async function fetchSportsMarketTypes(): Promise<{ types: string[]; count: number }> {
  const url = `${GAMMA_API_BASE}/sports/market-types`;
  const response = await safeFetch<unknown>(url, {}, 10000);

  const types: string[] = [];
  if (Array.isArray(response)) {
    for (const t of response) {
      const text = typeof t === "string" ? t : (t as Record<string, unknown>).name || (t as Record<string, unknown>).type || (t as Record<string, unknown>).slug;
      if (text) types.push(String(text));
    }
  }

  return { types, count: types.length };
}

/**
 * Fetch markets by sports tag ID
 * Primary discovery endpoint for markets-first approach
 */
export async function fetchMarketsBySportsTag(
  tagId: string,
  options?: {
    relatedTags?: boolean;
    volumeMinUsd?: number;
    limit?: number;
  }
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    closed: "false",
    tag_id: tagId,
    include_tag: "true",
    volume_num_min: String(options?.volumeMinUsd ?? 50000),
    limit: String(options?.limit ?? 500),
  });

  if (options?.relatedTags !== false) {
    params.set("related_tags", "true");
  }

  const url = `${GAMMA_API_BASE}/markets?${params.toString()}`;
  const response = await safeFetch<unknown>(url, {}, 15000);

  if (!response) return [];

  // Handle raw array response
  if (Array.isArray(response)) {
    return response as Record<string, unknown>[];
  }

  // Handle object wrappers
  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
    if (Array.isArray(obj.markets)) return obj.markets as Record<string, unknown>[];
    if (Array.isArray(obj.results)) return obj.results as Record<string, unknown>[];
  }

  return [];
}

/**
 * Fetch events by sports tag ID (fallback only)
 */
export async function fetchEventsBySportsTag(
  tagId: string,
  options?: {
    volumeMinUsd?: number;
    limit?: number;
  }
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    tag_id: tagId,
    related_tags: "true",
    volume_min: String(options?.volumeMinUsd ?? 50000),
    limit: String(options?.limit ?? 500),
  });

  const url = `${GAMMA_API_BASE}/events?${params.toString()}`;
  const response = await safeFetch<unknown>(url, {}, 15000);

  if (!response) return [];

  if (Array.isArray(response)) {
    return response as Record<string, unknown>[];
  }

  if (typeof response === "object" && response !== null) {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as Record<string, unknown>[];
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  }

  return [];
}
