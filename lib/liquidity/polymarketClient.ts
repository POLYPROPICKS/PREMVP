// LIQUIDITY_MODEL — READ-ONLY Polymarket CLOB orderbook client.
//
// Strictly read-only: no trading auth, no API key, no private key, no order
// placement. Fetches a public orderbook by token id and returns a structured
// FetchOrderBookResult (never throws for network/HTTP issues). Parsing is
// delegated to orderbookMath.parseOrderBook so it is unit-testable via fixtures.

import { parseOrderBook } from "./orderbookMath";
import type { FetchOrderBookResult } from "./types";

/** Public CLOB base; overridable via env. No auth headers are ever sent. */
const DEFAULT_CLOB_BASE = "https://clob.polymarket.com";

export interface FetchOrderBookOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function resolveBase(opts: FetchOrderBookOptions): string {
  return (
    opts.baseUrl ||
    process.env.LIQUIDITY_CLOB_BASE_URL ||
    process.env.POLYMARKET_CLOB_BASE_URL ||
    DEFAULT_CLOB_BASE
  ).replace(/\/+$/, "");
}

/**
 * Fetch a single read-only orderbook for `tokenId`. Returns a structured
 * result; transport/HTTP/parse failures are reported via errorCode, never
 * thrown. latencyMs is always populated.
 */
export async function fetchOrderBook(
  tokenId: string,
  opts: FetchOrderBookOptions = {},
): Promise<FetchOrderBookResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  if (!tokenId) {
    return {
      ok: false,
      tokenId: String(tokenId),
      latencyMs: 0,
      errorCode: "INVALID_TOKEN_ID",
      errorMessage: "Empty token id",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      tokenId,
      latencyMs: Date.now() - started,
      errorCode: "NO_FETCH",
      errorMessage: "No fetch implementation available in this runtime",
    };
  }

  const url = `${resolveBase(opts)}/book?token_id=${encodeURIComponent(tokenId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Read-only GET. No Authorization / signature headers.
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        tokenId,
        latencyMs,
        httpStatus: res.status,
        errorCode: "HTTP_ERROR",
        errorMessage: `HTTP ${res.status}`,
      };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return {
        ok: false,
        tokenId,
        latencyMs: Date.now() - started,
        httpStatus: res.status,
        errorCode: "PARSE_FAILED",
        errorMessage: "Response was not valid JSON",
      };
    }
    const book = parseOrderBook(payload, tokenId);
    if (!book) {
      return {
        ok: false,
        tokenId,
        latencyMs: Date.now() - started,
        httpStatus: res.status,
        errorCode: "PARSE_FAILED",
        errorMessage: "Could not parse orderbook payload",
      };
    }
    return { ok: true, tokenId, latencyMs: Date.now() - started, book, httpStatus: res.status };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      tokenId,
      latencyMs: Date.now() - started,
      errorCode: aborted ? "TIMEOUT" : "FETCH_FAILED",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch many orderbooks with bounded concurrency (read-only).
 * Preserves input order in the returned array.
 */
export async function fetchOrderBooksConcurrent(
  tokenIds: string[],
  concurrency = 5,
  opts: FetchOrderBookOptions = {},
): Promise<FetchOrderBookResult[]> {
  const results: FetchOrderBookResult[] = new Array(tokenIds.length);
  const limit = Math.max(1, concurrency);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tokenIds.length) {
      const idx = cursor++;
      results[idx] = await fetchOrderBook(tokenIds[idx], opts);
    }
  }

  const workers = Array.from({ length: Math.min(limit, tokenIds.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
