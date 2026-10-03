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

// ── T10_EXACT_MARKET_EXECUTION_EVIDENCE: token-specific taker fee schedule ──
//
// Authoritative source: Gamma `GET /markets?clob_token_ids=<token>` (read-only,
// no auth). The market object carries `feesEnabled` and `feeSchedule`
// {rate, exponent, takerOnly}. Polymarket's documented taker fee per fill is
//   fee_usdc = C * rate * p * (1 - p)            (C = shares, p = fill price)
// which is the exponent = 1 schedule. Any other exponent has no documented
// translation here and fails closed (FEE_SCHEDULE_UNSUPPORTED). The CLOB
// `/fee-rate` `base_fee` (bps an order may sign with) is NOT the economic fee
// and is never used as one. Nothing is assumed: missing / ambiguous => error.

const DEFAULT_GAMMA_BASE = "https://gamma-api.polymarket.com";

export const TAKER_FEE_FORMULA_VERSION = "POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1" as const;

export type TokenFeeScheduleResult =
  | {
      ok: true;
      tokenId: string;
      conditionId: string | null;
      feesEnabled: boolean;
      /** Taker fee rate; 0 only when the provider states feesEnabled=false. */
      takerRate: number;
      exponent: 1;
      feeType: string | null;
      formulaVersion: typeof TAKER_FEE_FORMULA_VERSION;
      source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID";
      observedAtIso: string;
      latencyMs: number;
    }
  | { ok: false; tokenId: string; errorCode: string; latencyMs: number };

/** Pure parser for the Gamma markets-by-token payload (unit-testable). */
export function parseTokenFeeSchedule(
  payload: unknown,
  tokenId: string,
  observedAtIso: string,
  latencyMs: number,
): TokenFeeScheduleResult {
  const fail = (errorCode: string): TokenFeeScheduleResult => ({ ok: false, tokenId, errorCode, latencyMs });
  if (!Array.isArray(payload)) return fail("FEE_PAYLOAD_NOT_ARRAY");
  const owners = payload.filter((m) => {
    if (!m || typeof m !== "object") return false;
    const ids = (m as Record<string, unknown>).clobTokenIds;
    let list: unknown = ids;
    if (typeof ids === "string") { try { list = JSON.parse(ids); } catch { return false; } }
    return Array.isArray(list) && list.map(String).includes(tokenId);
  }) as Record<string, unknown>[];
  if (owners.length !== 1) return fail(owners.length === 0 ? "FEE_MARKET_NOT_FOUND" : "FEE_MARKET_AMBIGUOUS");
  const m = owners[0];
  const base = {
    ok: true as const, tokenId,
    conditionId: typeof m.conditionId === "string" ? m.conditionId : null,
    feeType: typeof m.feeType === "string" ? m.feeType : null,
    formulaVersion: TAKER_FEE_FORMULA_VERSION, source: "GAMMA_MARKETS_BY_CLOB_TOKEN_ID" as const,
    observedAtIso, latencyMs, exponent: 1 as const,
  };
  if (m.feesEnabled === false) return { ...base, feesEnabled: false, takerRate: 0 };
  if (m.feesEnabled !== true) return fail("FEE_ENABLED_FLAG_MISSING");
  const schedule = m.feeSchedule as Record<string, unknown> | null | undefined;
  if (!schedule || typeof schedule !== "object") return fail("FEE_SCHEDULE_MISSING");
  const rate = schedule.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate >= 1) return fail("FEE_RATE_INVALID");
  if (schedule.exponent !== 1) return fail("FEE_SCHEDULE_UNSUPPORTED");
  return { ...base, feesEnabled: true, takerRate: rate };
}

/** Read-only, token-specific, current taker fee schedule. Never throws. */
export async function fetchTokenFeeSchedule(
  tokenId: string,
  opts: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TokenFeeScheduleResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!tokenId) return { ok: false, tokenId: String(tokenId), errorCode: "INVALID_TOKEN_ID", latencyMs: 0 };
  if (typeof fetchImpl !== "function") return { ok: false, tokenId, errorCode: "NO_FETCH", latencyMs: 0 };
  const base = (opts.baseUrl || process.env.LIQUIDITY_GAMMA_BASE_URL || DEFAULT_GAMMA_BASE).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(`${base}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`, {
      method: "GET", headers: { accept: "application/json" }, signal: controller.signal,
    });
    if (!res.ok) return { ok: false, tokenId, errorCode: `FEE_HTTP_${res.status}`, latencyMs: Date.now() - started };
    let payload: unknown;
    try { payload = await res.json(); } catch { return { ok: false, tokenId, errorCode: "FEE_PARSE_FAILED", latencyMs: Date.now() - started }; }
    return parseTokenFeeSchedule(payload, tokenId, new Date().toISOString(), Date.now() - started);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, tokenId, errorCode: aborted ? "FEE_TIMEOUT" : "FEE_FETCH_FAILED", latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
