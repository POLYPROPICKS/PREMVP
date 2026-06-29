// LIQUIDITY_MODEL — Supabase repository for the read-only liquidity contour.
//
// IMPORTANT:
//   - NEVER creates schema. Tables are created via the migration applied by the
//     operator. Code assumes they exist and degrades gracefully.
//   - Missing env => DB_ENV_MISSING (no throw, no secret printed).
//   - Missing table / undefined-table errors => SCHEMA_MISSING.
//   - SUPABASE_SERVICE_ROLE_KEY is never logged or returned.
//
// We do NOT import lib/supabase/server.ts because that module throws at import
// time when env is absent; this contour must fail soft instead.

import type { SimulationRow, SnapshotRow, WatchlistRow } from "./types";
import type { SourceResearchRow } from "./watchlistBuilder";

export type RepoStatus = "OK" | "DB_ENV_MISSING" | "SCHEMA_MISSING" | "ERROR";

export interface RepoResult<T> {
  status: RepoStatus;
  data: T;
  errorCode?: string;
  errorMessage?: string;
  sourceTableUsed?: string;
}

const WATCHLIST_TABLE = "market_tracking_watchlist";
const SNAPSHOT_TABLE = "market_price_liquidity_snapshots";
const SIMULATION_TABLE = "market_entry_exit_simulations";
const SOURCE_TABLE_PRIMARY = "generated_signal_research_snapshots";
const SOURCE_TABLE_FALLBACK = "generated_signal_pairs";

interface PostgrestError {
  code?: string;
  message?: string;
}
type PostgrestResponse<T> = Promise<{ data: T | null; error: PostgrestError | null }>;

interface QueryBuilder {
  select: (columns: string) => QueryBuilder;
  insert: (rows: unknown[]) => PostgrestResponse<unknown>;
  upsert: (rows: unknown[], options?: { onConflict?: string }) => PostgrestResponse<unknown>;
  gte: (column: string, value: string) => QueryBuilder;
  lte: (column: string, value: string) => QueryBuilder;
  in: (column: string, values: readonly string[]) => QueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder;
  limit: (count: number) => PostgrestResponse<unknown>;
}

/** Minimal recent-snapshot projection used by repeated-404 suppression. */
export interface RecentSnapshotProjection {
  token_id: string;
  captured_at: string;
  snapshot_status: string;
  failure_reason: string | null;
}

interface SupabaseLike {
  from: (table: string) => QueryBuilder;
}

function hasDbEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isSchemaMissing(error: PostgrestError | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

export interface SourceWindow {
  /** Forward window for upcoming matches (preferred). */
  gameStartGteIso?: string;
  gameStartLteIso?: string;
  /** Backward fallback / funnel accounting window on created_at. */
  createdGteIso?: string;
  limit?: number;
}

export class SupabaseLiquidityRepo {
  private client: SupabaseLike | null = null;
  private clientInit = false;
  readonly envPresent: boolean;

  constructor(client?: SupabaseLike) {
    this.envPresent = hasDbEnv();
    if (client) {
      this.client = client;
      this.clientInit = true;
    }
  }

  private async getClient(): Promise<SupabaseLike | null> {
    if (this.clientInit) return this.client;
    this.clientInit = true;
    if (!this.envPresent) {
      this.client = null;
      return null;
    }
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ) as unknown as SupabaseLike;
    return this.client;
  }

  private envMissing<T>(empty: T): RepoResult<T> {
    return {
      status: "DB_ENV_MISSING",
      data: empty,
      errorCode: "DB_ENV_MISSING",
      errorMessage: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
    };
  }

  private classify<T>(error: PostgrestError, empty: T): RepoResult<T> {
    if (isSchemaMissing(error)) {
      return {
        status: "SCHEMA_MISSING",
        data: empty,
        errorCode: "SCHEMA_MISSING",
        errorMessage: "Target table not found (operator must apply migration)",
      };
    }
    return {
      status: "ERROR",
      data: empty,
      errorCode: error.code || "DB_ERROR",
      errorMessage: error.message || "Unknown database error",
    };
  }

  private async readSourceTable(
    client: SupabaseLike,
    table: string,
    window: SourceWindow,
  ): PostgrestResponse<unknown> {
    const limit = window.limit ?? 5000;
    // Prefer the forward game_start window if provided.
    if (window.gameStartGteIso && window.gameStartLteIso) {
      return client
        .from(table)
        .select("*")
        .gte("game_start_iso", window.gameStartGteIso)
        .lte("game_start_iso", window.gameStartLteIso)
        .limit(limit);
    }
    const createdGte = window.createdGteIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return client.from(table).select("*").gte("created_at", createdGte).limit(limit);
  }

  /** Read source rows, preferring the research snapshots table, then pairs. */
  async getSourceRowsForWatchlist(window: SourceWindow): Promise<RepoResult<SourceResearchRow[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<SourceResearchRow[]>([]);

    try {
      const primary = await this.readSourceTable(client, SOURCE_TABLE_PRIMARY, window);
      if (!primary.error) {
        return {
          status: "OK",
          data: (primary.data as SourceResearchRow[]) ?? [],
          sourceTableUsed: SOURCE_TABLE_PRIMARY,
        };
      }
      if (!isSchemaMissing(primary.error)) {
        return this.classify<SourceResearchRow[]>(primary.error, []);
      }
      // Primary missing — try fallback table.
      const fallback = await this.readSourceTable(client, SOURCE_TABLE_FALLBACK, window);
      if (!fallback.error) {
        return {
          status: "OK",
          data: (fallback.data as SourceResearchRow[]) ?? [],
          sourceTableUsed: SOURCE_TABLE_FALLBACK,
        };
      }
      return this.classify<SourceResearchRow[]>(fallback.error, []);
    } catch (err) {
      return this.classify<SourceResearchRow[]>(toErr(err), []);
    }
  }

  /** Upsert watchlist rows on (condition_id, token_id). */
  async upsertWatchlistRows(rows: WatchlistRow[]): Promise<RepoResult<number>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<number>(0);
    if (rows.length === 0) return { status: "OK", data: 0 };
    try {
      const { error } = await client
        .from(WATCHLIST_TABLE)
        .upsert(rows, { onConflict: "condition_id,token_id" });
      if (error) return this.classify<number>(error, 0);
      return { status: "OK", data: rows.length };
    } catch (err) {
      return this.classify<number>(toErr(err), 0);
    }
  }

  /** Read active (gated) watchlist rows for capture. */
  async getActiveWatchlistRows(limit = 200): Promise<RepoResult<WatchlistRow[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<WatchlistRow[]>([]);
    try {
      const { data, error } = await client
        .from(WATCHLIST_TABLE)
        .select("*")
        .order("tracking_priority", { ascending: false })
        .limit(limit);
      if (error) return this.classify<WatchlistRow[]>(error, []);
      return { status: "OK", data: (data as WatchlistRow[]) ?? [] };
    } catch (err) {
      return this.classify<WatchlistRow[]>(toErr(err), []);
    }
  }

  /** Insert snapshot rows (append-only, including failure rows). */
  async insertSnapshotRows(rows: SnapshotRow[]): Promise<RepoResult<number>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<number>(0);
    if (rows.length === 0) return { status: "OK", data: 0 };
    try {
      const { error } = await client.from(SNAPSHOT_TABLE).insert(rows);
      if (error) return this.classify<number>(error, 0);
      return { status: "OK", data: rows.length };
    } catch (err) {
      return this.classify<number>(toErr(err), 0);
    }
  }

  /**
   * Batched read of recent snapshot status/failure history for a set of tokens,
   * used by repeated-http_404 capture suppression. Selects only the columns the
   * suppression rule needs (no book payloads). Empty token list => OK with [].
   */
  async getRecentSnapshotsByToken(
    tokenIds: string[],
    sinceIso: string,
    limit = 20000,
  ): Promise<RepoResult<RecentSnapshotProjection[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<RecentSnapshotProjection[]>([]);
    if (tokenIds.length === 0) return { status: "OK", data: [] };
    try {
      const { data, error } = await client
        .from(SNAPSHOT_TABLE)
        .select("token_id,captured_at,snapshot_status,failure_reason")
        .in("token_id", tokenIds)
        .gte("captured_at", sinceIso)
        .limit(limit);
      if (error) return this.classify<RecentSnapshotProjection[]>(error, []);
      return { status: "OK", data: (data as RecentSnapshotProjection[]) ?? [] };
    } catch (err) {
      return this.classify<RecentSnapshotProjection[]>(toErr(err), []);
    }
  }

  /** Read snapshots in the backward window for simulation. */
  async getSnapshotsForSimulation(windowStartIso: string): Promise<RepoResult<SnapshotRow[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<SnapshotRow[]>([]);
    try {
      const { data, error } = await client
        .from(SNAPSHOT_TABLE)
        .select("*")
        .gte("captured_at", windowStartIso)
        .limit(20000);
      if (error) return this.classify<SnapshotRow[]>(error, []);
      return { status: "OK", data: (data as SnapshotRow[]) ?? [] };
    } catch (err) {
      return this.classify<SnapshotRow[]>(toErr(err), []);
    }
  }

  /** Insert simulation rows. */
  async insertSimulationRows(rows: SimulationRow[]): Promise<RepoResult<number>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<number>(0);
    if (rows.length === 0) return { status: "OK", data: 0 };
    try {
      const { error } = await client.from(SIMULATION_TABLE).insert(rows);
      if (error) return this.classify<number>(error, 0);
      return { status: "OK", data: rows.length };
    } catch (err) {
      return this.classify<number>(toErr(err), 0);
    }
  }

  /** Pull all inputs needed for the 24h funnel report in one call. */
  async getFunnelInputs24h(windowStartIso: string): Promise<
    RepoResult<{
      sourceRows: SourceResearchRow[];
      watchlistRows: WatchlistRow[];
      snapshotRows: SnapshotRow[];
      simulationRows: SimulationRow[];
    }>
  > {
    const empty = {
      sourceRows: [] as SourceResearchRow[],
      watchlistRows: [] as WatchlistRow[],
      snapshotRows: [] as SnapshotRow[],
      simulationRows: [] as SimulationRow[],
    };
    const client = await this.getClient();
    if (!client) return this.envMissing(empty);

    const source = await this.getSourceRowsForWatchlist({ createdGteIso: windowStartIso });
    if (source.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };
    const watchlist = await this.getActiveWatchlistRows(2000);
    if (watchlist.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };
    const snapshots = await this.getSnapshotsForSimulation(windowStartIso);
    if (snapshots.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };

    let simulationRows: SimulationRow[] = [];
    try {
      const { data, error } = await client
        .from(SIMULATION_TABLE)
        .select("*")
        .gte("created_at", windowStartIso)
        .limit(20000);
      if (error && isSchemaMissing(error)) return { status: "SCHEMA_MISSING", data: empty };
      if (!error) simulationRows = (data as SimulationRow[]) ?? [];
    } catch {
      // Non-fatal for the report; leave simulations empty.
    }

    return {
      status: "OK",
      data: {
        sourceRows: source.data,
        watchlistRows: watchlist.data,
        snapshotRows: snapshots.data,
        simulationRows,
      },
    };
  }
}

function toErr(err: unknown): PostgrestError {
  if (err && typeof err === "object") {
    const e = err as PostgrestError;
    return { code: e.code, message: e.message };
  }
  return { message: String(err) };
}
