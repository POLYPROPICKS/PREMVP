// Official Polymarket metadata enrichment layer (Phase 3E.8D).
//
// Fetches OFFICIAL Polymarket Gamma API metadata (sports, sports/market-
// types, tags, events/slug/{slug}, markets/slug/{slug}) for the unique
// event/market identities present in the canonical corpus, and assembles a
// deterministic, resumable snapshot. This module never talks to Supabase,
// never reads env vars, and the fetch transport is fully injectable so unit
// tests run offline against a fake fetch -- never real network.
//
// Identity join priority: event_slug -> market_slug (event_id/market_id are
// not physically present on the current export; see
// docs/modeling/POLYMARKET_SPORT_MARKET_CLASSIFICATION.md for the field
// coverage audit this priority was derived from).

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export const MAX_CONCURRENCY = 5;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRY_DELAY_MS = 250;

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export type Row = Record<string, unknown>;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

export type IdentityKind = "event_slug" | "market_slug";

export interface MetadataIdentity {
  kind: IdentityKind;
  value: string;
}

function getStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validates that `value` is a genuine Polymarket URL-style slug: lowercase
 * ASCII letters, digits, and hyphens only, no whitespace/colon/parentheses,
 * no leading/trailing hyphen. Rejects human-readable display titles.
 */
export function isValidPolymarketSlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (trimmed !== value) return false;
  return SLUG_PATTERN.test(trimmed);
}

function getValidSlug(row: Row, key: string): string | null {
  const v = row[key];
  return isValidPolymarketSlug(v) ? v : null;
}

/**
 * Collects unique metadata identities from `rows`, deterministic order.
 * Priority per row: valid top-level event_slug, then valid top-level
 * market_slug, then valid diagnostics.marketSlug (emitted as kind
 * "market_slug"). Rows with none of these contribute no identity. Never
 * slugifies or infers values from title text. Pure, no fs/env/network.
 */
export function collectUniqueMetadataIdentities(rows: readonly Row[]): MetadataIdentity[] {
  const seen = new Set<string>();
  const identities: MetadataIdentity[] = [];
  for (const row of rows) {
    const eventSlug = getValidSlug(row, "event_slug");
    const marketSlug = getValidSlug(row, "market_slug");
    let kind: IdentityKind | null = null;
    let value: string | null = null;
    if (eventSlug !== null) {
      kind = "event_slug";
      value = eventSlug;
    } else if (marketSlug !== null) {
      kind = "market_slug";
      value = marketSlug;
    } else {
      const diagnostics = row["diagnostics"];
      const diagnosticsSlug =
        diagnostics && typeof diagnostics === "object"
          ? (diagnostics as Record<string, unknown>)["marketSlug"]
          : undefined;
      if (isValidPolymarketSlug(diagnosticsSlug)) {
        kind = "market_slug";
        value = diagnosticsSlug;
      }
    }
    if (kind === null || value === null) continue;
    const dedupeKey = `${kind}::${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    identities.push({ kind, value });
  }
  return identities;
}

// ---- Snapshot contract ----

export interface OfficialEventMetadata {
  id?: string;
  slug?: string;
  title?: string;
  question?: string;
  category?: string;
  subcategory?: string;
  series?: string;
  tags?: unknown[];
  sport?: string;
  league?: string;
  eventType?: string;
  competition?: string;
  startDate?: string;
  endDate?: string;
}

export interface OfficialMarketMetadata {
  id?: string;
  slug?: string;
  title?: string;
  question?: string;
  marketType?: string;
  category?: string;
  subcategory?: string;
  tags?: unknown[];
}

export type UnresolvedReason =
  | "MISSING_EVENT_IDENTITY"
  | "OFFICIAL_EVENT_NOT_FOUND"
  | "OFFICIAL_MARKET_NOT_FOUND"
  | "NO_SPORT_TAG"
  | "NO_COMPETITION_TAG"
  | "NO_MARKET_TYPE_FIELD"
  | "AMBIGUOUS_MULTI_SPORT_TAGS"
  | "NON_SPORT_EVENT"
  | "UNSUPPORTED_OFFICIAL_MARKET_TYPE"
  | "BOUNDED_FALLBACK_ONLY"
  | "FETCH_ERROR";

export interface UnresolvedIdentity {
  kind: IdentityKind;
  value: string;
  reason: UnresolvedReason;
  httpStatus?: number;
}

export interface RequestSummary {
  totalIdentities: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  cachedReuseCount: number;
}

export interface MetadataEnrichmentSnapshot {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  status: "COMPLETE" | "PARTIAL";
  corpusHash: string;
  retrievedAt: string;
  officialSources: string[];
  sportsMetadata: unknown[];
  validSportsMarketTypes: unknown[];
  tagsById: Record<string, { id: string; label?: string; [k: string]: unknown }>;
  eventsBySlug: Record<string, OfficialEventMetadata>;
  marketsBySlug: Record<string, OfficialMarketMetadata>;
  unresolvedIdentities: UnresolvedIdentity[];
  requestSummary: RequestSummary;
  snapshotHash: string;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(
  fetchImpl: FetchImpl,
  url: string,
  maxAttempts: number,
  timeoutMs: number,
  retryDelayMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await withTimeout(fetchImpl(url), timeoutMs);
      if (res.ok) {
        return { ok: true, body: await res.json() };
      }
      lastStatus = res.status;
      if (!isRetryableStatus(res.status) || attempt === maxAttempts) {
        return { ok: false, status: res.status };
      }
    } catch {
      lastStatus = 0;
      if (attempt === maxAttempts) return { ok: false, status: 0 };
    }
    // Bounded exponential backoff before the next attempt.
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
  }
  return { ok: false, status: lastStatus };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const current = nextIndex;
    nextIndex += 1;
    if (current >= items.length) return;
    results[current] = await worker(items[current]);
    await runNext();
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => {
          (acc as Record<string, unknown>)[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

export interface BuildSnapshotOptions {
  rows: readonly Row[];
  corpusHash: string;
  fetchImpl: FetchImpl;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  resumeFrom?: MetadataEnrichmentSnapshot;
}

/**
 * Builds a deterministic, resumable metadata enrichment snapshot for the
 * unique identities in `rows`. Reuses any successful entries already present
 * in `resumeFrom`; only failed/absent identities are (re)fetched. Retries
 * only 429/5xx, up to maxAttempts, with bounded exponential backoff.
 * Concurrency is capped. Never logs raw rows, env values, or secrets.
 */
export async function buildMetadataEnrichmentSnapshot(options: BuildSnapshotOptions): Promise<MetadataEnrichmentSnapshot> {
  const {
    rows,
    corpusHash,
    fetchImpl,
    concurrency = MAX_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    resumeFrom,
  } = options;

  const officialSources = [
    `${GAMMA_BASE}/sports`,
    `${GAMMA_BASE}/sports/market-types`,
    `${GAMMA_BASE}/tags`,
    `${GAMMA_BASE}/events/slug/{slug}`,
    `${GAMMA_BASE}/markets/slug/{slug}`,
  ];

  let successCount = 0;
  let failureCount = 0;
  let retryCount = 0;
  let cachedReuseCount = 0;

  // Global metadata (sports, market-types, tags) -- always refetched (cheap,
  // single call each); reused from resumeFrom only on total failure to avoid
  // silently dropping previously-fetched globals.
  const sportsRes = await fetchJsonWithRetry(fetchImpl, `${GAMMA_BASE}/sports`, maxAttempts, timeoutMs, retryDelayMs);
  const marketTypesRes = await fetchJsonWithRetry(fetchImpl, `${GAMMA_BASE}/sports/market-types`, maxAttempts, timeoutMs, retryDelayMs);
  const tagsRes = await fetchJsonWithRetry(fetchImpl, `${GAMMA_BASE}/tags`, maxAttempts, timeoutMs, retryDelayMs);

  const sportsMetadata = sportsRes.ok ? (sportsRes.body as unknown[]) : resumeFrom?.sportsMetadata ?? [];
  const validSportsMarketTypes = marketTypesRes.ok ? (marketTypesRes.body as unknown[]) : resumeFrom?.validSportsMarketTypes ?? [];
  const tagsById: MetadataEnrichmentSnapshot["tagsById"] = resumeFrom ? { ...resumeFrom.tagsById } : {};
  if (tagsRes.ok) {
    for (const tag of tagsRes.body as Array<{ id: string; [k: string]: unknown }>) {
      if (tag && typeof tag.id === "string") tagsById[tag.id] = tag as MetadataEnrichmentSnapshot["tagsById"][string];
    }
  }

  const identities = collectUniqueMetadataIdentities(rows);
  const eventsBySlug: MetadataEnrichmentSnapshot["eventsBySlug"] = resumeFrom ? { ...resumeFrom.eventsBySlug } : {};
  const marketsBySlug: MetadataEnrichmentSnapshot["marketsBySlug"] = resumeFrom ? { ...resumeFrom.marketsBySlug } : {};
  const resumedUnresolved = new Map((resumeFrom?.unresolvedIdentities ?? []).map((u) => [`${u.kind}::${u.value}`, u]));

  const unresolvedIdentities: UnresolvedIdentity[] = [];

  await mapWithConcurrency(identities, concurrency, async (identity) => {
    const cacheKey = `${identity.kind}::${identity.value}`;
    const alreadyResolved =
      identity.kind === "event_slug" ? eventsBySlug[identity.value] !== undefined : marketsBySlug[identity.value] !== undefined;
    if (alreadyResolved && !resumedUnresolved.has(cacheKey)) {
      cachedReuseCount += 1;
      successCount += 1;
      return;
    }

    const url =
      identity.kind === "event_slug"
        ? `${GAMMA_BASE}/events/slug/${encodeURIComponent(identity.value)}`
        : `${GAMMA_BASE}/markets/slug/${encodeURIComponent(identity.value)}`;

    const result = await fetchJsonWithRetry(fetchImpl, url, maxAttempts, timeoutMs, retryDelayMs);
    if (result.ok) {
      successCount += 1;
      if (identity.kind === "event_slug") {
        eventsBySlug[identity.value] = result.body as OfficialEventMetadata;
      } else {
        marketsBySlug[identity.value] = result.body as OfficialMarketMetadata;
      }
      return;
    }

    failureCount += 1;
    const reason: UnresolvedReason =
      result.status === 404
        ? identity.kind === "event_slug"
          ? "OFFICIAL_EVENT_NOT_FOUND"
          : "OFFICIAL_MARKET_NOT_FOUND"
        : "FETCH_ERROR";
    unresolvedIdentities.push({ kind: identity.kind, value: identity.value, reason, httpStatus: result.status || undefined });
  });

  const status: MetadataEnrichmentSnapshot["status"] = unresolvedIdentities.length > 0 ? "PARTIAL" : "COMPLETE";

  const requestSummary: RequestSummary = {
    totalIdentities: identities.length,
    successCount,
    failureCount,
    retryCount,
    cachedReuseCount,
  };

  const snapshotForHash = {
    corpusHash,
    officialSources,
    sportsMetadata,
    validSportsMarketTypes,
    tagsById,
    eventsBySlug,
    marketsBySlug,
    unresolvedIdentities,
  };

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status,
    corpusHash,
    retrievedAt: new Date().toISOString(),
    officialSources,
    sportsMetadata,
    validSportsMarketTypes,
    tagsById,
    eventsBySlug,
    marketsBySlug,
    unresolvedIdentities,
    requestSummary,
    snapshotHash: await sha256Hex(stableStringify(snapshotForHash)),
  };
}

/**
 * Validates a snapshot's corpus hash against the expected value. Throws if
 * they differ -- a mismatched snapshot must never be silently reused.
 */
export function validateMetadataSnapshot(snapshot: MetadataEnrichmentSnapshot, expectedCorpusHash: string): void {
  if (snapshot.corpusHash !== expectedCorpusHash) {
    throw new Error(
      `metadata enrichment snapshot: corpus hash mismatch (expected ${expectedCorpusHash}, snapshot has ${snapshot.corpusHash})`,
    );
  }
}
