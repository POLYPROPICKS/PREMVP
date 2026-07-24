import { createHash } from "node:crypto";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;

export class GammaFetchError extends Error {
  constructor(public readonly code: "HTTP_STATUS" | "TIMEOUT" | "RESPONSE_TOO_LARGE" | "CONTENT_TYPE" | "NETWORK", public readonly context: { status?: number; elapsedMs: number; responseBytes?: number }) {
    super(`GAMMA_FETCH_${code}`);
  }
}

export function gammaWeatherUrl(limit = 20): URL {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("GAMMA_FETCH_INVALID_LIMIT");
  const url = new URL(GAMMA_EVENTS_URL);
  url.search = new URLSearchParams({ active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: String(limit), offset: "0" }).toString();
  return url;
}

export async function fetchGammaWeatherPage(options: { limit?: number; timeoutMs?: number; maxBytes?: number } = {}) {
  const started = Date.now(); const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES; const url = gammaWeatherUrl(options.limit);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, headers: { accept: "application/json" } });
    const elapsedMs = Date.now() - started; const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok) throw new GammaFetchError("HTTP_STATUS", { status: response.status, elapsedMs });
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new GammaFetchError("CONTENT_TYPE", { status: response.status, elapsedMs });
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new GammaFetchError("RESPONSE_TOO_LARGE", { status: response.status, elapsedMs, responseBytes: contentLength });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new GammaFetchError("RESPONSE_TOO_LARGE", { status: response.status, elapsedMs, responseBytes: bytes.byteLength });
    return { url, status: response.status, elapsedMs, responseBytes: bytes.byteLength, rawText: new TextDecoder().decode(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof GammaFetchError) throw error;
    const elapsedMs = Date.now() - started;
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new GammaFetchError("TIMEOUT", { elapsedMs });
    throw new GammaFetchError("NETWORK", { elapsedMs });
  } finally { clearTimeout(timer); }
}
