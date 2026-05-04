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
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        ...options?.headers,
      },
    });

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
 */
export async function fetchPolymarketActiveEvents(options?: {
  limit?: number;
}): Promise<PolymarketRawEvent[]> {
  const limit = options?.limit ?? 20;

  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    order: "volume_24hr",
    ascending: "false",
    limit: limit.toString(),
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
 * Fetch price history for a token from CLOB API
 */
export async function fetchPriceHistorySafe(
  tokenId: string,
  interval: "1h" | "6h" | "1d" = "6h"
): Promise<PolymarketPricePoint[] | null> {
  if (!tokenId) return null;

  const params = new URLSearchParams({
    interval,
    token_id: tokenId,
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
  marketId: string
): Promise<PolymarketTrade[] | null> {
  if (!marketId) return null;

  // Try multiple possible endpoints
  const urls = [
    `${DATA_API_BASE}/markets/${marketId}/trades`,
    `${DATA_API_BASE}/markets/${marketId}/recent-trades`,
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
  marketId: string
): Promise<PolymarketHolder[] | null> {
  if (!marketId) return null;

  const urls = [
    `${DATA_API_BASE}/markets/${marketId}/holders`,
    `${DATA_API_BASE}/markets/${marketId}/positions`,
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
  marketId: string
): Promise<number | null> {
  if (!marketId) return null;

  const url = `${DATA_API_BASE}/markets/${marketId}/open-interest`;

  const data = await safeFetch<{ openInterest?: number; value?: number }>(url);
  if (!data) return null;

  return data.openInterest ?? data.value ?? null;
}
