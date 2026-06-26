// LIQUIDITY_MODEL — Supabase repository for the read-only liquidity contour.
//
// IMPORTANT:
//   - This module NEVER creates schema. Tables are created manually by the
//     operator. Code assumes they exist and degrades gracefully.
//   - Missing env => DB_ENV_MISSING (no throw, no secret printed).
//   - Missing table / undefined-table errors => SCHEMA_MISSING.
//   - SUPABASE_SERVICE_ROLE_KEY is never logged or returned.
//
// We do NOT import lib/supabase/server.ts because that module throws at import
// time when env is absent; this contour must fail soft instead.

import type {
  SimulationRow,
  SnapshotRow,
  WatchlistRow,
} from "./types";
import type { SourceResearchRow } from "./watchlistBuilder";

export type RepoStatus = "OK" | "DB_ENV_MISSING" | "SCHEMA_MISSING" | "ERROR";

export interface RepoResult<T> {
  status: RepoStatus;
  data: T;
  errorCode?: string;
  errorMessage?: string;
}

const WATCHLIST_TABLE = "market_tracking_watchlist";
const SNAPSHOT_TABLE = "market_price_liquidity_snapshots";
const SIMULATION_TABLE = "market_entry_exit_simulations";
const SOURCE_TABLE = "generated_signal_research_snapshots";

// Minimal structural typing for the supabase-js surface we use, without
// pulling `any` into a lint-checked file. Chainable filters return the builder;
// terminal operations resolve to a PostgREST-style { data, error } result.
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
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder;
  limit: (count: number) => PostgrestResponse<unknown>;
}

interface SupabaseLike {
  from: (table: string) => QueryBuilder;
}

function hasDbEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** PostgREST undefined-table / missing-relation error signature. */
function isSchemaMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42P01 = undefined_table; PGRST205 = table not found in schema cache.
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
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

  /** Lazily construct the Supabase client. Returns null when env is missing. */
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

  private classify<T>(error: { code?: string; message?: string }, empty: T): RepoResult<T> {
    if (isSchemaMissing(error)) {
      return {
        status: "SCHEMA_MISSING",
        data: empty,
        errorCode: "SCHEMA_MISSING",
        errorMessage: "Target table not found (operator must create schema)",
      };
    }
    return {
      status: "ERROR",
      data: empty,
      errorCode: error.code || "DB_ERROR",
      // Pass through PostgREST message only; never any secret/env value.
      errorMessage: error.message || "Unknown database error",
    };
  }

  /** Read source research rows in the given window for watchlist building. */
  async getSourceRowsForWatchlist(windowStartIso: string): Promise<RepoResult<SourceResearchRow[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<SourceResearchRow[]>([]);
    try {
      const { data, error } = await client
        .from(SOURCE_TABLE)
        .select("*")
        .gte("created_at", windowStartIso)
        .limit(5000);
      if (error) return this.classify<SourceResearchRow[]>(error, []);
      return { status: "OK", data: (data as SourceResearchRow[]) ?? [] };
    } catch (err) {
      return this.classify<SourceResearchRow[]>(toErr(err), []);
    }
  }

  /** Upsert watchlist rows on token_id. */
  async upsertWatchlistRows(rows: WatchlistRow[]): Promise<RepoResult<number>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<number>(0);
    if (rows.length === 0) return { status: "OK", data: 0 };
    try {
      const { error } = await client
        .from(WATCHLIST_TABLE)
        .upsert(rows, { onConflict: "token_id" });
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
        .order("priority_score", { ascending: false })
        .limit(limit);
      if (error) return this.classify<WatchlistRow[]>(error, []);
      return { status: "OK", data: (data as WatchlistRow[]) ?? [] };
    } catch (err) {
      return this.classify<WatchlistRow[]>(toErr(err), []);
    }
  }

  /** Insert snapshot rows (including failure rows). */
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

  /** Read snapshots in the window for simulation. */
  async getSnapshotsForSimulation(windowStartIso: string): Promise<RepoResult<SnapshotRow[]>> {
    const client = await this.getClient();
    if (!client) return this.envMissing<SnapshotRow[]>([]);
    try {
      const { data, error } = await client
        .from(SNAPSHOT_TABLE)
        .select("*")
        .gte("captured_at", windowStartIso)
        .limit(10000);
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

    const source = await this.getSourceRowsForWatchlist(windowStartIso);
    if (source.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };
    const watchlist = await this.getActiveWatchlistRows(1000);
    if (watchlist.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };
    const snapshots = await this.getSnapshotsForSimulation(windowStartIso);
    if (snapshots.status === "SCHEMA_MISSING") return { status: "SCHEMA_MISSING", data: empty };

    let simulationRows: SimulationRow[] = [];
    try {
      const { data, error } = await client
        .from(SIMULATION_TABLE)
        .select("*")
        .gte("simulated_at", windowStartIso)
        .limit(10000);
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

function toErr(err: unknown): { code?: string; message?: string } {
  if (err && typeof err === "object") {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
  return { message: String(err) };
}
