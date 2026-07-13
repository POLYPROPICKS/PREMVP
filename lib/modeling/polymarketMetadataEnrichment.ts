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

export type IdentityKind = "event_slug" | "market_slug" | "condition_id";

export interface MetadataIdentity {
  kind: IdentityKind;
  value: string;
}

function getStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONDITION_ID_PATTERN = /^0x[a-fA-F0-9]{64}$/;

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

/**
 * Validates that `value` is a well-formed Polymarket condition id: a
 * 0x-prefixed 32-byte (64 hex char) hash. Case is accepted on input and
 * normalized to lowercase by the caller for deterministic keys.
 */
export function isValidConditionId(value: unknown): value is string {
  return typeof value === "string" && CONDITION_ID_PATTERN.test(value);
}

function getValidSlug(row: Row, key: string): string | null {
  const v = row[key];
  return isValidPolymarketSlug(v) ? v : null;
}

function getDiagnostics(row: Row): Record<string, unknown> | undefined {
  const d = row["diagnostics"];
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
}

/**
 * Collects unique metadata identities from `rows`, deterministic order.
 * Priority per row (one best identity per row): valid top-level event_slug,
 * then valid top-level market_slug, then valid diagnostics.marketSlug
 * (emitted as kind "market_slug"), then valid top-level condition_id, then
 * valid diagnostics.conditionId (both emitted as kind "condition_id",
 * normalized to lowercase). Rows with none of these contribute no identity.
 * Never slugifies or infers values from title text. Pure, no fs/env/network.
 */
export function collectUniqueMetadataIdentities(rows: readonly Row[]): MetadataIdentity[] {
  const seen = new Set<string>();
  const identities: MetadataIdentity[] = [];
  for (const row of rows) {
    const eventSlug = getValidSlug(row, "event_slug");
    const marketSlug = getValidSlug(row, "market_slug");
    const diagnostics = getDiagnostics(row);
    let kind: IdentityKind | null = null;
    let value: string | null = null;
    if (eventSlug !== null) {
      kind = "event_slug";
      value = eventSlug;
    } else if (marketSlug !== null) {
      kind = "market_slug";
      value = marketSlug;
    } else if (diagnostics && isValidPolymarketSlug(diagnostics["marketSlug"])) {
      kind = "market_slug";
      value = diagnostics["marketSlug"] as string;
    } else if (isValidConditionId(row["condition_id"])) {
      kind = "condition_id";
      value = (row["condition_id"] as string).toLowerCase();
    } else if (diagnostics && isValidConditionId(diagnostics["conditionId"])) {
      kind = "condition_id";
      value = (diagnostics["conditionId"] as string).toLowerCase();
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
  sportsMarketType?: string;
  conditionId?: string;
  category?: string;
  subcategory?: string;
  tags?: unknown[];
}

export type UnresolvedReason =
  | "MISSING_EVENT_IDENTITY"
  | "OFFICIAL_EVENT_NOT_FOUND"
  | "OFFICIAL_MARKET_NOT_FOUND"
  | "AMBIGUOUS_CONDITION_ID_RESPONSE"
  | "INVALID_MARKET_RESPONSE"
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
  /** Total unique identities requested, broken down by identity kind. */
  byIdentityKind?: Record<IdentityKind, number>;
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
  /**
   * Markets resolved by condition id (Phase 3E.8D.3B), keyed by normalized
   * lowercase condition id. Optional for backward compatibility with
   * pre-3E.8D.3B snapshots that never had this field.
   */
  marketsByConditionId?: Record<string, OfficialMarketMetadata>;
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

export type ConditionLookupResult =
  | { ok: true; market: OfficialMarketMetadata }
  | {
      ok: false;
      reason: "OFFICIAL_MARKET_NOT_FOUND" | "AMBIGUOUS_CONDITION_ID_RESPONSE" | "INVALID_MARKET_RESPONSE" | "FETCH_ERROR";
      status?: number;
    };

export interface ConditionLookupOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * Resolves a single official market by condition id via the Gamma
 * `GET /markets?condition_ids=<id>` endpoint, which returns an array of zero
 * or more market objects. Selects the record whose `conditionId` exactly
 * matches (case-insensitively) the requested id -- never inferring a match
 * from title or array position. Zero exact matches -> OFFICIAL_MARKET_NOT_FOUND;
 * more than one exact match -> AMBIGUOUS_CONDITION_ID_RESPONSE; a non-array
 * response, or a non-empty array whose records all lack a `conditionId`
 * field -> INVALID_MARKET_RESPONSE. Pure transport via the injected fetch;
 * never logs raw payloads or secrets.
 */
export async function fetchMarketMetadataByConditionId(
  fetchImpl: FetchImpl,
  conditionId: string,
  options: ConditionLookupOptions = {},
): Promise<ConditionLookupResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const normalized = conditionId.toLowerCase();

  const url = `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
  const result = await fetchJsonWithRetry(fetchImpl, url, maxAttempts, timeoutMs, retryDelayMs);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.status === 404 ? "OFFICIAL_MARKET_NOT_FOUND" : "FETCH_ERROR",
      status: result.status || undefined,
    };
  }

  const body = result.body;
  if (!Array.isArray(body)) {
    return { ok: false, reason: "INVALID_MARKET_RESPONSE" };
  }

  const withConditionId = body.filter(
    (m): m is Record<string, unknown> =>
      m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).conditionId === "string",
  );
  // A non-empty array whose records all lack a conditionId field is a
  // contract violation, not a legitimate "not found".
  if (body.length > 0 && withConditionId.length === 0) {
    return { ok: false, reason: "INVALID_MARKET_RESPONSE" };
  }

  const exact = withConditionId.filter((m) => (m.conditionId as string).toLowerCase() === normalized);
  if (exact.length === 0) return { ok: false, reason: "OFFICIAL_MARKET_NOT_FOUND" };
  if (exact.length > 1) return { ok: false, reason: "AMBIGUOUS_CONDITION_ID_RESPONSE" };
  return { ok: true, market: exact[0] as OfficialMarketMetadata };
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
    `${GAMMA_BASE}/markets?condition_ids={conditionId}`,
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
  const marketsByConditionId: Record<string, OfficialMarketMetadata> = resumeFrom?.marketsByConditionId
    ? { ...resumeFrom.marketsByConditionId }
    : {};
  const resumedUnresolved = new Map((resumeFrom?.unresolvedIdentities ?? []).map((u) => [`${u.kind}::${u.value}`, u]));

  const byIdentityKind: Record<IdentityKind, number> = { event_slug: 0, market_slug: 0, condition_id: 0 };
  for (const identity of identities) byIdentityKind[identity.kind] += 1;

  const unresolvedIdentities: UnresolvedIdentity[] = [];

  // Cross-index a condition-resolved market under its own valid slug too,
  // but never overwrite an existing slug record that resolved to a
  // materially different condition id.
  function crossIndexBySlug(market: OfficialMarketMetadata): void {
    if (!isValidPolymarketSlug(market.slug)) return;
    const existing = marketsBySlug[market.slug as string];
    if (existing) {
      const existingCid = typeof existing.conditionId === "string" ? existing.conditionId.toLowerCase() : undefined;
      const incomingCid = typeof market.conditionId === "string" ? market.conditionId.toLowerCase() : undefined;
      if (existingCid !== undefined && incomingCid !== undefined && existingCid !== incomingCid) return; // conflict: keep existing
    }
    marketsBySlug[market.slug as string] = market;
  }

  await mapWithConcurrency(identities, concurrency, async (identity) => {
    const cacheKey = `${identity.kind}::${identity.value}`;
    const alreadyResolved =
      identity.kind === "event_slug"
        ? eventsBySlug[identity.value] !== undefined
        : identity.kind === "market_slug"
          ? marketsBySlug[identity.value] !== undefined
          : marketsByConditionId[identity.value] !== undefined;
    if (alreadyResolved && !resumedUnresolved.has(cacheKey)) {
      cachedReuseCount += 1;
      successCount += 1;
      return;
    }

    if (identity.kind === "condition_id") {
      const lookup = await fetchMarketMetadataByConditionId(fetchImpl, identity.value, { maxAttempts, timeoutMs, retryDelayMs });
      if (lookup.ok) {
        successCount += 1;
        marketsByConditionId[identity.value] = lookup.market;
        crossIndexBySlug(lookup.market);
        return;
      }
      failureCount += 1;
      unresolvedIdentities.push({ kind: identity.kind, value: identity.value, reason: lookup.reason, httpStatus: lookup.status });
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
    byIdentityKind,
  };

  const snapshotForHash = {
    corpusHash,
    officialSources,
    sportsMetadata,
    validSportsMarketTypes,
    tagsById,
    eventsBySlug,
    marketsBySlug,
    marketsByConditionId,
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
    marketsByConditionId,
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
