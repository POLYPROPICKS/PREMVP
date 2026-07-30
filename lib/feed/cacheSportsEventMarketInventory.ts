// Broad sports event/market inventory — captured immediately after provider
// sports-tag confirmation and BEFORE any horizon, odds-corridor, outcome-count,
// grouping, ranking, or product-feed filter.
//
// Pure mapper (buildSportsEventMarketInventoryRows): no I/O, no eligibility
// filtering. Only skips rows missing mandatory exact identity (provider event
// id, provider market id, valid event start). Everything else is captured
// verbatim, including props, maps, rounds and 3-way markets.
//
// Writer (writeSportsEventMarketInventory): bounded batched upsert against
// public.sports_event_market_inventory, keyed on the occurrence-safe unique
// constraint (provider, provider_event_id, provider_market_id, event_start_iso).
// Fail-open: callers must treat a failed write as a warning, never an abort.

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
