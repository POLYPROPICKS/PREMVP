// Broad sports event/market inventory — captured from EVERY raw keyset event,
// BEFORE the sports-confirmation gate and before any horizon, odds-corridor,
// outcome-count, grouping, ranking, or product-feed filter. Sports confirmation
// is stored as classification metadata on each row (is_confirmed_sports,
// sports_confirmation_source), never used to exclude a row from capture.
//
// Pure mapper (buildSportsEventMarketInventoryRows): no I/O, no eligibility
// filtering. Only skips rows missing mandatory exact identity (provider event
// id, provider market id, valid event start). Everything else is captured
// verbatim, including props, maps, rounds, 3-way markets, and events that fail
// sports confirmation entirely.
//
// Writer (writeSportsEventMarketInventory): bounded batched upsert against
// public.sports_event_market_inventory, keyed on the occurrence-safe unique
// constraint (provider, provider_event_id, provider_market_id, event_start_iso).
// Fail-open: callers must treat a failed write as a warning, never an abort.
//
// Producer-only opt-in: this module is only ever imported (dynamically) from
// discoverSportsMarkets.ts when `persistInventory === true`, which only
// scripts/generate-signals.ts sets. Every other caller (buildLandingCards,
// buildSportsLandingCards, debug HTTP routes) never touches this module.

export type SportsConfirmationSource =
  | "specific_sports_tag"
  | "generic_sports_tag_only"
  | "no_matching_sports_tag"
  | "sports_metadata_unavailable"
  | "unrecognized_event_tag_shape";

export interface SportsConfirmationResult {
  isConfirmedSports: boolean;
  source: SportsConfirmationSource;
}

const GENERIC_SPORTS_TAGS = new Set(["1", "100639"]);

/**
 * Pure classifier for one raw provider event's sports-confirmation status.
 * Safely handles both observed provider tag shapes: `string[]` and
 * `Array<{id?, label?, slug?}>`. Never excludes an event -- callers must
 * store the result as row metadata, not use it to drop the event from capture.
 *
 * Mirrors the exact confirmation boolean used by the existing discovery
 * filtering loop (specificSportsTagIds when non-empty, else the raw
 * sportsTagIds fallback) so the stored isConfirmedSports value is identical
 * to what that loop computes for its own (unchanged) filtering decision.
 */
export function classifySportsConfirmation(
  event: Record<string, unknown>,
  ctx: {
    specificSportsTagIds: Set<string>;
    sportsTagIds: string[];
    sportsMetadataAvailable: boolean;
  },
): SportsConfirmationResult {
  const rawTags = event.tags;
  if (!Array.isArray(rawTags)) {
    return { isConfirmedSports: false, source: "unrecognized_event_tag_shape" };
  }

  const tagIds: string[] = [];
  let sawUnrecognizedEntry = false;
  for (const t of rawTags) {
    if (typeof t === "string") {
      tagIds.push(t);
    } else if (t && typeof t === "object" && "id" in (t as Record<string, unknown>)) {
      tagIds.push(String((t as Record<string, unknown>).id ?? ""));
    } else {
      sawUnrecognizedEntry = true;
    }
  }

  if (tagIds.length === 0 && (sawUnrecognizedEntry || rawTags.length > 0)) {
    return { isConfirmedSports: false, source: "unrecognized_event_tag_shape" };
  }

  if (!ctx.sportsMetadataAvailable) {
    return { isConfirmedSports: false, source: "sports_metadata_unavailable" };
  }

  const hasSpecific = ctx.specificSportsTagIds.size > 0
    ? tagIds.some((id) => ctx.specificSportsTagIds.has(id))
    : tagIds.some((id) => ctx.sportsTagIds.includes(id));
  if (hasSpecific) {
    return { isConfirmedSports: true, source: "specific_sports_tag" };
  }

  const hasGenericOnly = tagIds.length > 0 && tagIds.every((id) => GENERIC_SPORTS_TAGS.has(id));
  if (hasGenericOnly) {
    return { isConfirmedSports: false, source: "generic_sports_tag_only" };
  }

  return { isConfirmedSports: false, source: "no_matching_sports_tag" };
}

export interface SportsInventoryRawMarket {
  id?: unknown;
  slug?: unknown;
  question?: unknown;
  conditionId?: unknown;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  category?: unknown;
  sportsMarketType?: unknown;
  volume?: unknown;
  volume24hr?: unknown;
  endDate?: unknown;
}

export interface SportsInventoryRawEvent {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  startTime?: unknown;
  tags?: unknown;
  markets?: SportsInventoryRawMarket[];
  isConfirmedSports: boolean;
  sportsConfirmationSource: SportsConfirmationSource;
}

export interface SportsEventMarketInventoryRow {
  provider: "polymarket";
  providerEventId: string;
  providerEventSlug: string | null;
  providerMarketId: string;
  providerMarketSlug: string | null;
  eventTitle: string | null;
  marketQuestion: string | null;
  eventStartIso: string;
  marketEndIso: string | null;
  conditionId: string | null;
  clobTokenIds: unknown[];
  outcomes: unknown[];
  outcomePrices: unknown[];
  providerTags: unknown[];
  rawCategory: string | null;
  leagueHint: string | null;
  sportsMarketType: string | null;
  volumeUsd: number | null;
  volume24hrUsd: number | null;
  isConfirmedSports: boolean;
  sportsConfirmationSource: SportsConfirmationSource;
  siblingMarketCount: number;
  snapshotRunId: string;
  observedAt: string;
  expiresAt: string;
}

export interface SportsInventoryBuildDiagnostics {
  eventsSeen: number;
  marketsSeen: number;
  rowsBuilt: number;
  rowsSkippedMissingEventId: number;
  rowsSkippedMissingMarketId: number;
  rowsSkippedInvalidStart: number;
  maxSiblingMarketCount: number;
}

const INVENTORY_HORIZON_MS = 48 * 60 * 60 * 1000;

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function requiredIdentity(value: unknown): string {
  return nonEmptyString(value) ?? "";
}

function toJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON — fall through
    }
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Pure mapping from provider-shaped confirmed-sports events to inventory rows.
 * No DB access, no environment access, no business eligibility filter.
 */
export function buildSportsEventMarketInventoryRows(
  events: SportsInventoryRawEvent[],
  opts: { observedAt: string; snapshotRunId: string },
): { rows: SportsEventMarketInventoryRow[]; diagnostics: SportsInventoryBuildDiagnostics } {
  const diagnostics: SportsInventoryBuildDiagnostics = {
    eventsSeen: 0,
    marketsSeen: 0,
    rowsBuilt: 0,
    rowsSkippedMissingEventId: 0,
    rowsSkippedMissingMarketId: 0,
    rowsSkippedInvalidStart: 0,
    maxSiblingMarketCount: 0,
  };
  const rows: SportsEventMarketInventoryRow[] = [];

  for (const ev of events) {
    diagnostics.eventsSeen += 1;
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    diagnostics.marketsSeen += markets.length;

    const providerEventId = requiredIdentity(ev.id);
    if (!providerEventId) {
      diagnostics.rowsSkippedMissingEventId += markets.length;
      continue;
    }

    const eventStartIso = toIsoOrNull(ev.startTime);
    if (!eventStartIso) {
      diagnostics.rowsSkippedInvalidStart += markets.length;
      continue;
    }

    const providerEventSlug = nonEmptyString(ev.slug);
    const eventTitle = nonEmptyString(ev.title);
    const providerTags = Array.isArray(ev.tags) ? ev.tags : [];
    const expiresAt = new Date(Date.parse(eventStartIso) + INVENTORY_HORIZON_MS).toISOString();

    const eventRows: SportsEventMarketInventoryRow[] = [];
    for (const mkt of markets) {
      const providerMarketId = requiredIdentity(mkt.id);
      if (!providerMarketId) {
        diagnostics.rowsSkippedMissingMarketId += 1;
        continue;
      }

      eventRows.push({
        provider: "polymarket",
        providerEventId,
        providerEventSlug,
        providerMarketId,
        providerMarketSlug: nonEmptyString(mkt.slug),
        eventTitle,
        marketQuestion: nonEmptyString(mkt.question),
        eventStartIso,
        marketEndIso: toIsoOrNull(mkt.endDate),
        conditionId: nonEmptyString(mkt.conditionId),
        clobTokenIds: toJsonArray(mkt.clobTokenIds),
        outcomes: toJsonArray(mkt.outcomes),
        outcomePrices: toJsonArray(mkt.outcomePrices),
        providerTags,
        rawCategory: nonEmptyString(mkt.category),
        leagueHint: null,
        sportsMarketType: nonEmptyString(mkt.sportsMarketType),
        volumeUsd: toFiniteNumber(mkt.volume),
        volume24hrUsd: toFiniteNumber(mkt.volume24hr),
        isConfirmedSports: ev.isConfirmedSports,
        sportsConfirmationSource: ev.sportsConfirmationSource,
        siblingMarketCount: 0, // patched below once the event's row count is known
        snapshotRunId: opts.snapshotRunId,
        observedAt: opts.observedAt,
        expiresAt,
      });
    }

    const siblingCount = eventRows.length;
    if (siblingCount > diagnostics.maxSiblingMarketCount) {
      diagnostics.maxSiblingMarketCount = siblingCount;
    }
    for (const row of eventRows) {
      row.siblingMarketCount = siblingCount;
    }

    rows.push(...eventRows);
    diagnostics.rowsBuilt += eventRows.length;
  }

  return { rows, diagnostics };
}

// ── Writer ──────────────────────────────────────────────────────────────

export const SPORTS_INVENTORY_CONFLICT_TARGET =
  "provider,provider_event_id,provider_market_id,event_start_iso";

const MAX_BATCH_SIZE = 500;

export interface SportsInventoryRepoPort {
  upsertBatch(
    rows: Record<string, unknown>[],
  ): Promise<{ error: { message: string; code?: string } | null; count: number | null }>;
}

/**
 * Default port: service-role Supabase client via the approved server-only path.
 * first_observed_at is intentionally never included in the upsert payload, so
 * Postgres applies its column default on INSERT and leaves it untouched on
 * UPDATE (PostgREST only sets columns present in the payload).
 */
export function createSupabaseSportsInventoryRepoPort(): SportsInventoryRepoPort {
  return {
    async upsertBatch(rows) {
      const { supabaseAdmin } = await import("../supabase/server");
      const { error, count } = await supabaseAdmin
        .from("sports_event_market_inventory")
        .upsert(rows, { onConflict: SPORTS_INVENTORY_CONFLICT_TARGET, count: "exact" });
      return {
        error: error ? { message: error.message, code: (error as { code?: string }).code } : null,
        count: count ?? null,
      };
    },
  };
}

export interface SportsEventMarketInventoryWriteResult {
  attempted: number;
  inserted: number;
  batches: number;
  failed: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

function toDbRow(row: SportsEventMarketInventoryRow): Record<string, unknown> {
  return {
    provider: row.provider,
    provider_event_id: row.providerEventId,
    provider_event_slug: row.providerEventSlug,
    provider_market_id: row.providerMarketId,
    provider_market_slug: row.providerMarketSlug,
    event_title: row.eventTitle,
    market_question: row.marketQuestion,
    event_start_iso: row.eventStartIso,
    market_end_iso: row.marketEndIso,
    condition_id: row.conditionId,
    clob_token_ids: row.clobTokenIds,
    outcomes: row.outcomes,
    outcome_prices: row.outcomePrices,
    provider_tags: row.providerTags,
    raw_category: row.rawCategory,
    league_hint: row.leagueHint,
    sports_market_type: row.sportsMarketType,
    volume_usd: row.volumeUsd,
    volume_24hr_usd: row.volume24hrUsd,
    is_confirmed_sports: row.isConfirmedSports,
    sports_confirmation_source: row.sportsConfirmationSource,
    sibling_market_count: row.siblingMarketCount,
    snapshot_run_id: row.snapshotRunId,
    last_observed_at: row.observedAt,
    expires_at: row.expiresAt,
    // first_observed_at intentionally omitted — see createSupabaseSportsInventoryRepoPort.
  };
}

/**
 * Bounded batched upsert. Never throws on a DB-level failure -- returns
 * `failed: true` with a safe structured error so callers can log a warning
 * and continue without altering their own return value (fail-open contract).
 */
export async function writeSportsEventMarketInventory(
  rows: SportsEventMarketInventoryRow[],
  deps: { repoPort?: SportsInventoryRepoPort } = {},
): Promise<SportsEventMarketInventoryWriteResult> {
  const result: SportsEventMarketInventoryWriteResult = {
    attempted: rows.length,
    inserted: 0,
    batches: 0,
    failed: false,
    errorCode: null,
    errorMessage: null,
  };
  if (rows.length === 0) return result;

  const repoPort = deps.repoPort ?? createSupabaseSportsInventoryRepoPort();

  for (let i = 0; i < rows.length; i += MAX_BATCH_SIZE) {
    const batch = rows.slice(i, i + MAX_BATCH_SIZE);
    result.batches += 1;
    const dbRows = batch.map(toDbRow);

    let error: { message: string; code?: string } | null = null;
    let count: number | null = null;
    try {
      const outcome = await repoPort.upsertBatch(dbRows);
      error = outcome.error;
      count = outcome.count;
    } catch (thrown) {
      error = {
        message: thrown instanceof Error ? thrown.message : String(thrown),
      };
    }

    if (error) {
      result.failed = true;
      result.errorCode = "SPORTS_INVENTORY_BATCH_FAILED";
      result.errorMessage = error.message.slice(0, 200);
      console.warn(
        `[cacheSportsEventMarketInventory] SPORTS_INVENTORY_BATCH_FAILED ` +
          `operation=upsert batch=${result.batches} row_count=${batch.length} ` +
          `provider=polymarket error_code=${error.code ?? "unknown"} error_message=${result.errorMessage}`,
      );
      break;
    }

    result.inserted += count ?? batch.length;
  }

  return result;
}
