// Box B market-outcome collector (DBClone only). Market-level, provider-backed, idempotent.
// Writes ONLY to market_outcome_provider_receipts / market_outcome_revisions through the existing Box B
// revision contract (ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql);
// it never copies observations, never reads paper decisions / Ledger, and never turns absence into a LOSS.
// Classification is a line-for-line port of ops/research-clone/box-b/fetch_provider_receipts.py (frozen 20-market
// pilot, parity-tested). The database re-validates every FINAL/VOID against the stored receipts independently.
import { createHash } from "node:crypto";

export const COLLECTOR_SOURCE = "market-outcome-collector-v1";
export const GAMMA_MARKETS = "https://gamma-api.polymarket.com/markets";
export const CLOB_MARKETS = "https://clob.polymarket.com/markets/";
export const COND_RE = /^0x[0-9a-f]{64}$/;
export const DISCOVERY_SOURCES = [
  "research_evidence_page_rows",
  "reservation_market_observations",
  "research_precontract_t20_observations",
  "research_inplay_core_path_observations",
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
export type OutcomeStatus = "FINAL" | "PENDING" | "VOID" | "CONFLICT" | "LOOKUP_FAILED";
export const RECHECK_STATUSES: readonly OutcomeStatus[] = ["PENDING", "CONFLICT", "LOOKUP_FAILED"];

export interface Receipt {
  provider: "gamma" | "clob";
  request_kind: "condition_id";
  request_key: string;
  request_url: string;
  http_status: number | null;
  fetch_error: string | null;
  fetched_at: string;
  raw_body: string;
  raw_digest: string;
}

export interface Classification {
  status: OutcomeStatus;
  reason: string;
  winner_token_id: string | null;
  gamma_winner_token_id: string | null;
  clob_winner_token_id: string | null;
  market_token_ids: string[] | null;
  resolved_at: string | null;
  resolution_time_source: string | null;
}

export interface LatestRevision {
  condition_id: string;
  revision_no: number;
  outcome_status: OutcomeStatus;
  winner_token_id: string | null;
  gamma_winner_token_id: string | null;
  clob_winner_token_id: string | null;
  resolved_at: string | null;
  status_reason: string | null;
  checked_at: string;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ------------------------------------------------------------------ classification

function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return undefined; }
}

function emptyClass(status: OutcomeStatus, reason: string, extra: Partial<Classification> = {}): Classification {
  return {
    status, reason, winner_token_id: null, gamma_winner_token_id: null, clob_winner_token_id: null,
    market_token_ids: null, resolved_at: null, resolution_time_source: null, ...extra,
  };
}

/** Port of classify() in fetch_provider_receipts.py. Absence/failure is never LOSS; closed without a proven winner is never FINAL. */
export function classifyOutcome(cond: string, gRc: Receipt, cRc: Receipt): Classification {
  if (gRc.http_status !== 200 || cRc.http_status !== 200) {
    return emptyClass("LOOKUP_FAILED", `gamma_http=${gRc.http_status} clob_http=${cRc.http_status}`);
  }
  const g = parseJson(gRc.raw_body);
  const c = parseJson(cRc.raw_body) as Record<string, unknown> | undefined;
  const gOk = Array.isArray(g) && g.length === 1;
  const cOk = !!c && typeof c === "object" && !Array.isArray(c);
  if (!(gOk && cOk)) return emptyClass("LOOKUP_FAILED", `gamma_shape_ok=${gOk} clob_shape_ok=${cOk}`);
  const gm = (g as Record<string, unknown>[])[0] ?? {};
  if (gm.conditionId !== cond || c!.condition_id !== cond) {
    return emptyClass("CONFLICT", "condition_id mismatch between request and provider payloads");
  }
  let gt: string[]; let gp: number[]; let cTokens: Record<string, unknown>[]; let ct: string[];
  try {
    gt = (JSON.parse(String(gm.clobTokenIds)) as unknown[]).map(String);
    gp = (JSON.parse(String(gm.outcomePrices)) as unknown[]).map((x) => Number(x));
    cTokens = c!.tokens as Record<string, unknown>[];
    ct = cTokens.map((t) => String(t.token_id));
    if (!Array.isArray(cTokens) || gp.some((p) => Number.isNaN(p))) throw new Error("shape");
  } catch (e) {
    return emptyClass("LOOKUP_FAILED", `unparseable provider payload: ${e instanceof Error ? e.name : "Error"}`);
  }
  const base = emptyClass("PENDING", "", { market_token_ids: gt });
  if ([...gt].sort().join() !== [...ct].sort().join() || gt.length !== gp.length) {
    return { ...base, status: "CONFLICT", reason: "gamma and clob token sets differ" };
  }
  const gClosed = gm.closed === true;
  const cClosed = c!.closed === true;
  const winners = cTokens.filter((t) => t.winner === true).map((t) => String(t.token_id));
  const gWin = gt.filter((_, i) => gp[i] === 1);
  if (gClosed !== cClosed) return { ...base, status: "CONFLICT", reason: `closed differs gamma=${gClosed} clob=${cClosed}` };
  if (!gClosed) return { ...base, status: "PENDING", reason: "market not closed on either provider" };

  let resolvedAt: string | null = null; let src: string | null = null;
  if (gm.closedTime) {
    resolvedAt = String(gm.closedTime).replace(" ", "T");
    if (/[+-]\d\d$/.test(resolvedAt)) resolvedAt += ":00";
    src = "gamma.closedTime";
  } else if (gm.umaEndDate) {
    resolvedAt = String(gm.umaEndDate); src = "gamma.umaEndDate";
  }
  const timed: Classification = {
    ...base, gamma_winner_token_id: gWin.length === 1 ? gWin[0]! : null,
    clob_winner_token_id: winners.length === 1 ? winners[0]! : null,
    resolved_at: resolvedAt, resolution_time_source: src,
  };
  if (gWin.length === 1 && winners.length === 1 && gp.every((p) => p === 0 || p === 1)) {
    if (gWin[0] !== winners[0]) return { ...timed, status: "CONFLICT", reason: "gamma and clob name different winner tokens" };
    if (!resolvedAt) return { ...timed, status: "PENDING", reason: "closed with winner but no provider resolution time" };
    return { ...timed, status: "FINAL", reason: "gamma+clob closed, identical single winner, provider time present", winner_token_id: winners[0]! };
  }
  if (winners.length === 0 && gp.length > 0 && gp.every((p) => p === 0.5)) {
    if (!resolvedAt) return { ...timed, status: "PENDING", reason: "closed 50/50 but no provider resolution time" };
    return { ...timed, status: "VOID", reason: "closed, no winner token, outcomePrices all 0.5" };
  }
  if (winners.length > 1 || gWin.length > 1) return { ...timed, status: "CONFLICT", reason: "multiple winner tokens" };
  return { ...timed, status: "PENDING", reason: "closed but no terminal winner/void evidence yet" };
}

/** Same substance as the latest stored revision -> no new revision (volume/liquidity noise is not a change). */
export function sameSubstance(prev: LatestRevision, next: Classification): boolean {
  const t = (s: string | null) => (s ? Date.parse(s) : null);
  return prev.outcome_status === next.status
    && prev.winner_token_id === next.winner_token_id
    && prev.gamma_winner_token_id === next.gamma_winner_token_id
    && prev.clob_winner_token_id === next.clob_winner_token_id
    && t(prev.resolved_at) === t(next.resolved_at)
    && (prev.status_reason ?? null) === next.reason;
}

// ------------------------------------------------------------------ provider fetch

export interface FetchDeps {
  fetchImpl: typeof fetch;
  now: () => Date;
  timeoutMs: number;
}

export async function getReceipt(deps: FetchDeps, provider: "gamma" | "clob", key: string, url: string): Promise<Receipt> {
  let last: Receipt | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fetchedAt = deps.now().toISOString();
    let status: number | null = null; let body = ""; let err: string | null = null;
    try {
      const res = await deps.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "boxb-collector/1" },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      status = res.status; body = await res.text();
    } catch (e) {
      err = e instanceof Error ? e.name : "FetchError"; status = null; body = "";
    }
    last = {
      provider, request_kind: "condition_id", request_key: key, request_url: url,
      http_status: status, fetch_error: err, fetched_at: fetchedAt, raw_body: body, raw_digest: sha256Hex(body),
    };
    const retryable = status === null || (status >= 500 && status < 600);
    if (!retryable) break;
  }
  return last!;
}

export interface MarketFetch {
  condition_id: string;
  gamma: Receipt;
  clob: Receipt;
  extras: Receipt[];
  rateLimited: boolean;
  classification: Classification;
}

/** Gamma hides closed markets unless closed=true and hides open ones with it, so: closed=true first, plain lookup on an empty answer. */
export async function fetchMarket(deps: FetchDeps, cond: string): Promise<MarketFetch> {
  let gamma = await getReceipt(deps, "gamma", cond, `${GAMMA_MARKETS}?condition_ids=${cond}&closed=true`);
  const extras: Receipt[] = [];
  if (gamma.http_status === 200 && (parseJson(gamma.raw_body) as unknown[] | undefined)?.length === 0) {
    extras.push(gamma);
    gamma = await getReceipt(deps, "gamma", cond, `${GAMMA_MARKETS}?condition_ids=${cond}`);
  }
  const clob = await getReceipt(deps, "clob", cond, `${CLOB_MARKETS}${cond}`);
  const rateLimited = [gamma, clob, ...extras].some((r) => r.http_status === 429);
  return { condition_id: cond, gamma, clob, extras, rateLimited, classification: classifyOutcome(cond, gamma, clob) };
}

/** Cheap triage for PENDING markets: which of these ids does Gamma now list as closed. null = triage failed (no verdict). */
export async function triageClosed(deps: FetchDeps, ids: string[]): Promise<Set<string> | "RATE_LIMITED" | null> {
  if (ids.length === 0) return new Set();
  const url = `${GAMMA_MARKETS}?closed=true&limit=${ids.length}&${ids.map((i) => `condition_ids=${i}`).join("&")}`;
  const rc = await getReceipt(deps, "gamma", ids[0]!, url);
  if (rc.http_status === 429) return "RATE_LIMITED";
  if (rc.http_status !== 200) return null;
  const body = parseJson(rc.raw_body);
  if (!Array.isArray(body)) return null;
  return new Set(body.filter((m) => m && (m as Record<string, unknown>).closed === true).map((m) => String((m as Record<string, unknown>).conditionId)));
}

// ------------------------------------------------------------------ store + state

export interface SourceCursor { backfill_cursor: string | null; backfill_done_at: string | null; head_watermark: string | null }
export interface CollectorState {
  v: 1;
  sources: Record<string, SourceCursor>;
  recheck_cursor: string | null;
  recheck_not_before: string | null;
  /** Consecutive degraded (429 / triage failure) cycles with zero progress; FAILED at STALL_FAIL_CYCLES. */
  stalled_cycles?: number;
}
export const emptyState = (): CollectorState => ({
  v: 1,
  sources: Object.fromEntries(DISCOVERY_SOURCES.map((s) => [s, { backfill_cursor: null, backfill_done_at: null, head_watermark: null }])),
  recheck_cursor: null,
  recheck_not_before: null,
});

export interface RevisionRow {
  condition_id: string;
  outcome_status: OutcomeStatus;
  winner_token_id: string | null;
  gamma_winner_token_id: string | null;
  clob_winner_token_id: string | null;
  market_token_ids: string[] | null;
  gamma_receipt_id: number;
  clob_receipt_id: number;
  resolved_at: string | null;
  resolution_time_source: string | null;
  checked_at: string;
  status_reason: string;
}

export class BoxBRejected extends Error {}

/** Head-scan position. `id === null` means "everything after observed_at t" (cycle start, covered by the overlap). */
export interface HeadPos { t: string; id: string | null }

export interface CollectorStore {
  readCheckpoint(): Promise<CollectorState | null>;
  writeCheckpoint(state: CollectorState, stats: CycleStats): Promise<void>;
  /** distinct valid ids of one page after `after`, ascending; `last` = last row id read (cursor), `exhausted` = short page. */
  readBackfillPage(table: DiscoverySource, after: string | null, limit: number): Promise<{ ids: string[]; malformed: number; last: string | null; exhausted: boolean }>;
  /** rows strictly after the composite position (observed_at, condition_id), ascending by that pair: ties on observed_at cannot be lost at a page edge. */
  readHeadPage(table: DiscoverySource, pos: HeadPos, limit: number): Promise<{ rows: { id: string; observed_at: string }[]; tail: HeadPos | null; malformed: number; exhausted: boolean }>;
  /** estimated total provider receipts (capacity guard). */
  countReceipts(): Promise<number>;
  latestRevisions(ids: string[]): Promise<Map<string, LatestRevision>>;
  /** Box B markets whose revisions include a recheck status, ascending after `after`. */
  readRecheckPage(after: string | null, limit: number): Promise<{ ids: string[]; last: string | null; exhausted: boolean }>;
  saveReceipts(receipts: Receipt[]): Promise<Map<string, number>>; // key = `${provider}|${raw_digest}`
  /** Returns whether a new revision row exists (false = DB idempotency no-op). Throws BoxBRejected for BOX_B_* / constraint errors. */
  insertRevision(row: RevisionRow): Promise<boolean>;
}

export interface CycleStats {
  started_at: string;
  finished_at: string | null;
  processed_new: number;
  processed_recheck: number;
  by_status: Record<string, number>;
  revisions_inserted: number;
  revisions_noop: number;
  unchanged_skipped: number;
  already_covered_skipped: number;
  malformed_ids_skipped: number;
  triage_closed: number;
  triage_failed: number;
  rate_limited: boolean;
  deadline_hit: boolean;
  db_rejected: number;
  db_errors: number;
  fetch_lookup_failed: number;
  /** markets fetched from the providers this cycle (before the unchanged-substance skip), the outage denominator */
  fetched_total: number;
  error_samples: string[];
  stalled_cycles: number;
  receipts_total: number | null;
  capacity_limit_hit: boolean;
  verdict: "SUCCESS" | "PARTIAL" | "FAILED" | null;
  verdict_reasons: string[];
}
export const emptyStats = (now: Date): CycleStats => ({
  started_at: now.toISOString(), finished_at: null, processed_new: 0, processed_recheck: 0, by_status: {},
  revisions_inserted: 0, revisions_noop: 0, unchanged_skipped: 0, already_covered_skipped: 0, malformed_ids_skipped: 0,
  triage_closed: 0, triage_failed: 0, rate_limited: false, deadline_hit: false, db_rejected: 0, db_errors: 0,
  fetch_lookup_failed: 0, fetched_total: 0, error_samples: [], stalled_cycles: 0, receipts_total: null, capacity_limit_hit: false,
  verdict: null, verdict_reasons: [],
});

export interface CollectorConfig {
  maxNewMarkets: number;
  maxRechecks: number;
  recheckScan: number;
  concurrency: number;
  deadlineMs: number;
  pageSize: number;
  headMaxPagesPerSource: number;
  headOverlapMs: number;
  headInitLookbackMs: number;
  recheckMinGapMs: number;
  resweepAfterMs: number;
  triageChunk: number;
  /** Operator/proof only: ignore the rotation gap and re-scan the recheck set now. */
  forceRecheck?: boolean;
  /** Explicit capacity limit: at/above this many receipts new-market intake stops and the cycle reports FAILED. */
  maxReceipts: number;
  /** SIGTERM etc.: stop starting work, write the checkpoint, exit. */
  abortSignal?: AbortSignal;
}
export const DEFAULT_CONFIG: CollectorConfig = {
  maxNewMarkets: 600, maxRechecks: 60, recheckScan: 400, concurrency: 4, deadlineMs: 7 * 60_000, pageSize: 1000,
  headMaxPagesPerSource: 6, headOverlapMs: 60_000, headInitLookbackMs: 6 * 3_600_000,
  recheckMinGapMs: 6 * 3_600_000, resweepAfterMs: 7 * 24 * 3_600_000, triageChunk: 40,
  maxReceipts: 400_000, // measured 3.3 KB/receipt (9.2 KB/market): ~1.3 GB of raw bodies; the full ~45k-market backlog needs ~0.4 GB
};

// ------------------------------------------------------------------ per-market processing

type Outcome = "DONE" | "RETRY";

export interface CycleCtx {
  store: CollectorStore;
  fetchDeps: FetchDeps;
  cfg: CollectorConfig;
  stats: CycleStats;
  deadlineAt: number;
  attempted: Set<string>; // one attempt per market per cycle, whichever source surfaces it first
  halted: () => boolean;
  halt: (why: "rate" | "deadline") => void;
}

async function persistMarket(ctx: CycleCtx, m: MarketFetch, latest: LatestRevision | undefined): Promise<Outcome> {
  const { stats, store } = ctx;
  const c = m.classification;
  stats.fetched_total++;
  if (c.status === "LOOKUP_FAILED") stats.fetch_lookup_failed++; // counted before the unchanged skip: an outage over already-failed markets is still an outage
  if (latest && sameSubstance(latest, c)) { stats.unchanged_skipped++; return "DONE"; }
  try {
    const ids = await store.saveReceipts([...m.extras, m.gamma, m.clob]);
    const gId = ids.get(`gamma|${m.gamma.raw_digest}`); const cId = ids.get(`clob|${m.clob.raw_digest}`);
    if (gId === undefined || cId === undefined) throw new Error("RECEIPT_ID_LOOKUP_MISSING");
    const inserted = await store.insertRevision({
      condition_id: m.condition_id, outcome_status: c.status, winner_token_id: c.winner_token_id,
      gamma_winner_token_id: c.gamma_winner_token_id, clob_winner_token_id: c.clob_winner_token_id,
      market_token_ids: c.market_token_ids, gamma_receipt_id: gId, clob_receipt_id: cId, resolved_at: c.resolved_at,
      resolution_time_source: c.resolution_time_source, checked_at: m.clob.fetched_at > m.gamma.fetched_at ? m.clob.fetched_at : m.gamma.fetched_at,
      status_reason: c.reason,
    });
    if (inserted) stats.revisions_inserted++; else stats.revisions_noop++;
    stats.by_status[c.status] = (stats.by_status[c.status] ?? 0) + 1;
    return "DONE";
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 160) : "UNKNOWN";
    if (stats.error_samples.length < 5) stats.error_samples.push(`${m.condition_id.slice(0, 10)}:${msg}`);
    if (e instanceof BoxBRejected) { stats.db_rejected++; return "DONE"; } // bounded: logged, not retried forever in-sweep
    stats.db_errors++;
    return "RETRY";
  }
}

/** Runs a list of markets through a bounded pool. Returns the ids fully handled (persisted/skipped/rejected). */
async function processMarkets(ctx: CycleCtx, ids: string[], kind: "new" | "recheck", latest: Map<string, LatestRevision>): Promise<Set<string>> {
  const done = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (!ctx.halted()) {
      const i = next++;
      if (i >= ids.length) return;
      if (Date.now() > ctx.deadlineAt) { ctx.halt("deadline"); return; }
      const id = ids[i]!;
      ctx.attempted.add(id);
      const m = await fetchMarket(ctx.fetchDeps, id);
      if (m.rateLimited) { ctx.halt("rate"); return; } // 429 is no verdict: nothing persisted, retried next cycle
      const r = await persistMarket(ctx, m, latest.get(id));
      if (r === "DONE") {
        done.add(id);
        if (kind === "new") ctx.stats.processed_new++; else ctx.stats.processed_recheck++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, ctx.cfg.concurrency) }, worker));
  return done;
}

/** Contiguous handled prefix of an ordered scan: the cursor may only move past ids that are settled. */
function settledPrefix(order: string[], settled: (id: string) => boolean): number {
  let n = 0;
  while (n < order.length && settled(order[n]!)) n++;
  return n;
}

// ------------------------------------------------------------------ discovery phases

async function newOnly(ctx: CycleCtx, ids: string[]): Promise<{ fresh: string[]; latest: Map<string, LatestRevision> }> {
  const latest = await ctx.store.latestRevisions(ids);
  const fresh = ids.filter((i) => !latest.has(i) && !ctx.attempted.has(i));
  ctx.stats.already_covered_skipped += ids.filter((i) => latest.has(i)).length;
  return { fresh, latest };
}

async function headPhase(ctx: CycleCtx, state: CollectorState, budget: { left: number }): Promise<void> {
  const now = Date.now();
  for (const src of DISCOVERY_SOURCES) {
    const cur = state.sources[src]!;
    let pos: HeadPos = {
      t: cur.head_watermark
        ? new Date(Date.parse(cur.head_watermark) - ctx.cfg.headOverlapMs).toISOString()
        : new Date(now - ctx.cfg.headInitLookbackMs).toISOString(),
      id: null,
    };
    for (let page = 0; page < ctx.cfg.headMaxPagesPerSource && budget.left > 0 && !ctx.halted(); page++) {
      if (Date.now() > ctx.deadlineAt) { ctx.halt("deadline"); break; }
      const p = await ctx.store.readHeadPage(src, pos, ctx.cfg.pageSize);
      ctx.stats.malformed_ids_skipped += p.malformed;
      if (p.tail === null) { cur.head_watermark = cur.head_watermark ?? new Date(now).toISOString(); break; }
      const distinct: string[] = []; const seen = new Set<string>(); const firstRowOf = new Map<string, string>();
      for (const r of p.rows) { if (!seen.has(r.id)) { seen.add(r.id); distinct.push(r.id); } if (!firstRowOf.has(r.id)) firstRowOf.set(r.id, r.observed_at); }
      const { fresh, latest } = await newOnly(ctx, distinct);
      const take = fresh.slice(0, budget.left);
      const done = await processMarkets(ctx, take, "new", latest);
      budget.left -= done.size;
      const clean = take.length === fresh.length && done.size === take.length;
      if (clean) {
        pos = p.tail; // composite (observed_at, condition_id): rows tied on observed_at past the page edge are read next, never skipped
        if (!cur.head_watermark || Date.parse(p.tail.t) > Date.parse(cur.head_watermark)) cur.head_watermark = p.tail.t; // never moves backwards
        if (p.exhausted) break;
      } else {
        // budget/halt cut the page: resume from just before the first unsettled market's FIRST observation
        const firstOpen = take.find((i) => !done.has(i)) ?? fresh[take.length];
        const resumeAt = firstOpen ? firstRowOf.get(firstOpen) : undefined;
        if (resumeAt) cur.head_watermark = new Date(Math.max(Date.parse(cur.head_watermark ?? resumeAt), Date.parse(resumeAt) - 1)).toISOString();
        break;
      }
    }
  }
}

async function backfillPhase(ctx: CycleCtx, state: CollectorState, budget: { left: number }): Promise<void> {
  const now = Date.now();
  for (const src of DISCOVERY_SOURCES) {
    const cur = state.sources[src]!;
    if (cur.backfill_done_at) {
      if (now - Date.parse(cur.backfill_done_at) < ctx.cfg.resweepAfterMs) continue;
      cur.backfill_cursor = null; cur.backfill_done_at = null; // periodic re-sweep catches late-synced stragglers
    }
    while (budget.left > 0 && !ctx.halted()) {
      if (Date.now() > ctx.deadlineAt) { ctx.halt("deadline"); break; }
      const p = await ctx.store.readBackfillPage(src, cur.backfill_cursor, ctx.cfg.pageSize);
      ctx.stats.malformed_ids_skipped += p.malformed;
      const { fresh, latest } = await newOnly(ctx, p.ids);
      const take = fresh.slice(0, budget.left);
      const done = await processMarkets(ctx, take, "new", latest);
      budget.left -= done.size;
      const n = settledPrefix(take, (i) => done.has(i));
      if (n === take.length && take.length === fresh.length) {
        if (p.last) cur.backfill_cursor = p.last;
        if (p.exhausted) { cur.backfill_done_at = new Date().toISOString(); break; }
      } else {
        // stopped inside the page: advance only past ids settled in order
        const firstOpen = take[n] ?? fresh[take.length];
        const at = firstOpen === undefined ? -1 : p.ids.indexOf(firstOpen);
        if (at > 0) cur.backfill_cursor = p.ids[at - 1]!;
        break;
      }
    }
    if (budget.left <= 0 || ctx.halted()) return;
  }
}

async function recheckPhase(ctx: CycleCtx, state: CollectorState): Promise<void> {
  const now = Date.now();
  if (!ctx.cfg.forceRecheck && state.recheck_not_before && now < Date.parse(state.recheck_not_before)) return;
  const p = await ctx.store.readRecheckPage(state.recheck_cursor, ctx.cfg.recheckScan);
  const latest = await ctx.store.latestRevisions(p.ids);
  const due = p.ids.filter((i) => latest.has(i) && RECHECK_STATUSES.includes(latest.get(i)!.outcome_status));
  const pending = due.filter((i) => latest.get(i)!.outcome_status === "PENDING");
  const direct = new Set(due.filter((i) => latest.get(i)!.outcome_status !== "PENDING"));
  const triageFailed = new Set<string>();
  for (let i = 0; i < pending.length && !ctx.halted(); i += ctx.cfg.triageChunk) {
    const chunk = pending.slice(i, i + ctx.cfg.triageChunk);
    const closed = await triageClosed(ctx.fetchDeps, chunk);
    if (closed === "RATE_LIMITED") { ctx.stats.triage_failed++; chunk.forEach((c) => triageFailed.add(c)); ctx.halt("rate"); break; }
    if (closed === null) { ctx.stats.triage_failed++; chunk.forEach((c) => triageFailed.add(c)); continue; }
    for (const c of chunk) if (closed.has(c)) { direct.add(c); ctx.stats.triage_closed++; }
  }
  const order = due.filter((i) => direct.has(i)).slice(0, ctx.cfg.maxRechecks);
  const done = await processMarkets(ctx, order, "recheck", latest);
  const capped = direct.size > order.length;
  // scan items that need no work (still-open PENDING) are settled; triage-failed and cut-off ones are not.
  const scanOrder = p.ids;
  const settled = (i: string) => done.has(i) || (!direct.has(i) && !triageFailed.has(i));
  const n = settledPrefix(scanOrder, settled);
  const complete = n === scanOrder.length && !capped && triageFailed.size === 0;
  if (complete) {
    if (p.exhausted) { state.recheck_cursor = null; state.recheck_not_before = new Date(now + ctx.cfg.recheckMinGapMs).toISOString(); }
    else if (p.last) state.recheck_cursor = p.last;
  } else if (n > 0) {
    state.recheck_cursor = scanOrder[n - 1]!;
  }
}

// ------------------------------------------------------------------ cycle

export async function runCollectorCycle(
  store: CollectorStore, fetchDeps: FetchDeps, cfg: CollectorConfig = DEFAULT_CONFIG,
): Promise<{ stats: CycleStats; state: CollectorState }> {
  const start = fetchDeps.now();
  const stats = emptyStats(start);
  const state = (await store.readCheckpoint()) ?? emptyState();
  for (const s of DISCOVERY_SOURCES) state.sources[s] ??= { backfill_cursor: null, backfill_done_at: null, head_watermark: null };
  let halted = false;
  const ctx: CycleCtx = {
    store, fetchDeps, cfg, stats, deadlineAt: Date.now() + cfg.deadlineMs, attempted: new Set(),
    halted: () => {
      if (cfg.abortSignal?.aborted && !halted) { halted = true; stats.deadline_hit = true; }
      return halted;
    },
    halt: (why) => { halted = true; if (why === "rate") stats.rate_limited = true; else stats.deadline_hit = true; },
  };
  const budget = { left: cfg.maxNewMarkets };
  let fatal: unknown = null;
  // Durable progress: the state is saved after every phase that moved it, so a crash/kill between phases loses at most one phase.
  let lastSaved = JSON.stringify(state);
  const save = async () => {
    const now = JSON.stringify(state);
    if (now === lastSaved) return;
    stats.finished_at = fetchDeps.now().toISOString();
    await store.writeCheckpoint(state, stats);
    lastSaved = now;
  };
  try {
    stats.receipts_total = await store.countReceipts();
    if (stats.receipts_total >= cfg.maxReceipts) { stats.capacity_limit_hit = true; budget.left = 0; } // new intake stops; rechecks still finalize known markets
    await headPhase(ctx, state, budget);
    await save();
    if (!ctx.halted()) { await recheckPhase(ctx, state); await save(); }
    if (!ctx.halted()) { await backfillPhase(ctx, state, budget); }
  } catch (e) {
    fatal = e;
    stats.db_errors++;
    if (stats.error_samples.length < 5) stats.error_samples.push(`FATAL:${e instanceof Error ? e.message.slice(0, 160) : "UNKNOWN"}`);
  }
  const progress = stats.processed_new + stats.processed_recheck + stats.triage_closed > 0;
  const degraded = stats.rate_limited || stats.triage_failed > 0;
  state.stalled_cycles = degraded && !progress ? (state.stalled_cycles ?? 0) + 1 : 0;
  stats.stalled_cycles = state.stalled_cycles;
  const verdict = cycleVerdict(stats);
  stats.verdict = verdict.status; stats.verdict_reasons = verdict.reasons;
  stats.finished_at = fetchDeps.now().toISOString();
  await store.writeCheckpoint(state, stats); // final row always written, even after a partial/failed cycle (cursors only moved past settled ids)
  if (fatal) throw Object.assign(new Error("COLLECTOR_CYCLE_FATAL"), { stats, state, cause: fatal });
  return { stats, state };
}

export const STALL_FAIL_CYCLES = 3;

/**
 * Single source of truth for the status line and the process exit code.
 * FAILED (exit 1): DB/code failure, provider outage, capacity limit, or a degraded state (429 / triage failure) with no progress for STALL_FAIL_CYCLES cycles.
 * PARTIAL (exit 0, but never printed as SUCCESS): rate limit, triage failure or deadline in an otherwise progressing cycle; it resumes by itself.
 */
export function cycleVerdict(s: CycleStats): { status: "SUCCESS" | "PARTIAL" | "FAILED"; exit_code: 0 | 1; reasons: string[] } {
  const failed: string[] = [];
  if (s.db_errors > 0) failed.push(`db_errors=${s.db_errors}`);
  if (s.db_rejected > 0) failed.push(`db_rejected=${s.db_rejected}`);
  if (s.fetched_total >= 5 && s.fetch_lookup_failed / s.fetched_total > 0.5) failed.push(`provider_outage lookup_failed=${s.fetch_lookup_failed}/${s.fetched_total}`);
  if (s.capacity_limit_hit) failed.push(`capacity_limit receipts=${s.receipts_total}`);
  if (s.stalled_cycles >= STALL_FAIL_CYCLES) failed.push(`stalled_cycles=${s.stalled_cycles}`);
  if (failed.length) return { status: "FAILED", exit_code: 1, reasons: failed };
  const partial: string[] = [];
  if (s.rate_limited) partial.push("rate_limited");
  if (s.triage_failed > 0) partial.push(`triage_failed=${s.triage_failed}`);
  if (s.deadline_hit) partial.push("deadline_or_abort");
  if (partial.length) return { status: "PARTIAL", exit_code: 0, reasons: partial };
  return { status: "SUCCESS", exit_code: 0, reasons: [] };
}

/** Back-compat helper: true iff the verdict is FAILED. */
export function cycleFailed(s: CycleStats): boolean {
  return cycleVerdict(s).status === "FAILED";
}
