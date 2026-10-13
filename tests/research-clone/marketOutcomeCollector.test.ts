// Box B market-outcome collector: classification parity with the frozen pilot, idempotency, failure recovery,
// bounded checkpointed catch-up, and "absence is never LOSS". Pure: fake store + fake provider, no network, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoxBRejected, DEFAULT_CONFIG, DISCOVERY_SOURCES, STALL_FAIL_CYCLES, classifyOutcome, cycleFailed, cycleVerdict, emptyState, emptyStats, runCollectorCycle, sha256Hex,
  type CollectorConfig, type CollectorState, type CollectorStore, type CycleStats, type DiscoverySource, type HeadPos, type LatestRevision, type Receipt, type RevisionRow,
} from "../../lib/research/marketOutcomeCollector";

const cid = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const rc = (provider: "gamma" | "clob", key: string, status: number | null, body: string, err: string | null = null): Receipt => ({
  provider, request_kind: "condition_id", request_key: key, request_url: "https://x", http_status: status, fetch_error: err,
  fetched_at: "2026-10-13T10:00:00.000Z", raw_body: body, raw_digest: sha256Hex(body),
});

// ---- 1. parity with the frozen pilot (the Python classifier that produced the 20 FINAL revisions) ----
test("classifier parity: all 20 frozen pilot receipts classify exactly as the pilot index", () => {
  const dir = "ops/research-clone/box-b/receipts";
  const index = JSON.parse(readFileSync(`${dir}/receipts_index.json`, "utf8")) as any[];
  let checked = 0;
  for (const it of index) {
    if (!it.condition_id || !it.gamma_receipt) continue;
    const load = (r: any, p: "gamma" | "clob"): Receipt => {
      const body = readFileSync(`${dir}/${r.file}`).toString("utf8");
      return { ...rc(p, it.condition_id, r.http_status, body, r.fetch_error ?? null), raw_digest: r.raw_digest };
    };
    const got = classifyOutcome(it.condition_id, load(it.gamma_receipt, "gamma"), load(it.clob_receipt, "clob"));
    const exp = it.classification;
    assert.equal(got.status, exp.status, it.condition_id);
    assert.equal(got.winner_token_id, exp.winner_token_id);
    assert.equal(got.resolution_time_source, exp.resolution_time_source);
    assert.equal(got.resolved_at, exp.resolved_at);
    assert.deepEqual(got.market_token_ids, exp.market_token_ids);
    checked++;
  }
  assert.ok(checked >= 20, `expected >= 20 frozen markets, checked ${checked}`);
});

// ---- provider + store fakes ----
interface Mkt { closed: boolean; winner?: 0 | 1 | "void" | "none"; closedTime?: string; volume?: number }
function bodies(n: number, m: Mkt) {
  const c = cid(n);
  const toks = [`${n}01`, `${n}02`];
  const prices = !m.closed ? ["0.4", "0.6"] : m.winner === "void" ? ["0.5", "0.5"] : m.winner === "none" ? ["0.6", "0.4"] : m.winner === 1 ? ["0", "1"] : ["1", "0"];
  const g = [{ conditionId: c, closed: m.closed, clobTokenIds: JSON.stringify(toks), outcomePrices: JSON.stringify(prices), volume: m.volume ?? 1, ...(m.closed ? { closedTime: m.closedTime ?? "2026-10-10 10:00:00+00" } : {}) }];
  const cl = { condition_id: c, closed: m.closed, tokens: toks.map((t, i) => ({ token_id: t, winner: m.closed && (m.winner === 0 ? i === 0 : m.winner === 1 ? i === 1 : false) })) };
  return { g: JSON.stringify(g), cl: JSON.stringify(cl) };
}

class World {
  markets = new Map<string, Mkt>();
  throttle = new Set<string>();
  throttleTriage = false;
  down = false;
  calls = 0;
  add(n: number, m: Mkt) { this.markets.set(cid(n), m); }
  fetchImpl = (async (input: any) => {
    this.calls++;
    const url = String(input);
    const resp = (status: number, body: string) => ({ status, text: async () => body }) as unknown as Response;
    if (this.down) throw Object.assign(new Error("boom"), { name: "TypeError" });
    const cond = (url.match(/0x[0-9a-f]{64}/) ?? [])[0]!;
    if (this.throttle.has(cond)) return resp(429, "slow down");
    const n = parseInt(cond.slice(2), 16);
    const m = this.markets.get(cond);
    if (url.includes("clob.polymarket.com")) return m ? resp(200, bodies(n, m).cl) : resp(404, '{"error":"not found"}');
    if (url.includes("condition_ids=") && url.split("condition_ids=").length > 2) { // batch triage
      if (this.throttleTriage) return resp(429, "slow down");
      const ids = [...url.matchAll(/condition_ids=(0x[0-9a-f]{64})/g)].map((x) => x[1]!);
      return resp(200, JSON.stringify(ids.filter((i) => this.markets.get(i)?.closed).map((i) => JSON.parse(bodies(parseInt(i.slice(2), 16), this.markets.get(i)!).g)[0])));
    }
    const wantClosed = url.includes("closed=true");
    if (!m || m.closed !== wantClosed) return resp(200, "[]");
    return resp(200, bodies(n, m).g);
  }) as unknown as typeof fetch;
}

class FakeStore implements CollectorStore {
  receipts: (Receipt & { receipt_id: number })[] = [];
  revisions: (RevisionRow & { revision_no: number; evidence: string })[] = [];
  state: CollectorState | null = null;
  jobRuns: CycleStats[] = [];
  src: Record<DiscoverySource, { condition_id: string; observed_at: string }[]> = Object.fromEntries(DISCOVERY_SOURCES.map((s) => [s, []])) as any;
  pageReads = 0;
  failInsertFor: { cond: string; err: Error } | null = null;
  failFinalWrite = false; // simulates a kill between the last phase save and the final checkpoint row
  receiptCountOverride: number | null = null;
  seed(table: DiscoverySource, ns: (number | string)[], at = "2026-10-01T09:00:00.000Z") { // older than the head window: only the backfill sweep sees it
    for (const n of ns) this.src[table].push({ condition_id: typeof n === "number" ? cid(n) : n, observed_at: at });
    this.src[table].sort((a, b) => (a.condition_id < b.condition_id ? -1 : 1));
  }
  async readCheckpoint() { return this.state ? structuredClone(this.state) : null; }
  async writeCheckpoint(s: CollectorState, st: CycleStats) {
    if (this.failFinalWrite && st.verdict !== null) throw new Error("KILLED_BEFORE_FINAL_CHECKPOINT");
    this.state = structuredClone(s); this.jobRuns.push(structuredClone(st));
  }
  async countReceipts() { return this.receiptCountOverride ?? this.receipts.length; }
  async readBackfillPage(t: DiscoverySource, after: string | null, limit: number) {
    this.pageReads++;
    const rows = this.src[t].filter((r) => after === null || r.condition_id > after).slice(0, limit);
    const ids: string[] = []; let bad = 0;
    for (const r of rows) { if (!/^0x[0-9a-f]{64}$/.test(r.condition_id)) { bad++; continue; } if (!ids.includes(r.condition_id)) ids.push(r.condition_id); }
    return { ids, malformed: bad, last: rows.length ? rows[rows.length - 1]!.condition_id : null, exhausted: rows.length < limit };
  }
  async readHeadPage(t: DiscoverySource, pos: HeadPos, limit: number) {
    const after = (r: { condition_id: string; observed_at: string }) =>
      r.observed_at > pos.t || (pos.id !== null && r.observed_at === pos.t && r.condition_id > pos.id);
    const rows = this.src[t].filter(after)
      .sort((a, b) => (a.observed_at === b.observed_at ? (a.condition_id < b.condition_id ? -1 : 1) : a.observed_at < b.observed_at ? -1 : 1)).slice(0, limit);
    const last = rows.length ? rows[rows.length - 1]! : null;
    return { rows: rows.filter((r) => /^0x[0-9a-f]{64}$/.test(r.condition_id)).map((r) => ({ id: r.condition_id, observed_at: r.observed_at })),
      tail: last ? { t: last.observed_at, id: last.condition_id } : null, malformed: 0, exhausted: rows.length < limit };
  }
  async latestRevisions(ids: string[]) {
    const out = new Map<string, LatestRevision>();
    for (const r of this.revisions) if (ids.includes(r.condition_id)) {
      const p = out.get(r.condition_id);
      if (!p || r.revision_no > p.revision_no) out.set(r.condition_id, { ...r, outcome_status: r.outcome_status } as unknown as LatestRevision);
    }
    return out;
  }
  async readRecheckPage(after: string | null, limit: number) {
    const rows = this.revisions.filter((r) => ["PENDING", "CONFLICT", "LOOKUP_FAILED"].includes(r.outcome_status) && (after === null || r.condition_id > after))
      .sort((a, b) => (a.condition_id < b.condition_id ? -1 : 1)).slice(0, limit);
    return { ids: [...new Set(rows.map((r) => r.condition_id))], last: rows.length ? rows[rows.length - 1]!.condition_id : null, exhausted: rows.length < limit };
  }
  async saveReceipts(rs: Receipt[]) {
    const out = new Map<string, number>();
    for (const r of rs) {
      let ex = this.receipts.find((x) => x.provider === r.provider && x.request_key === r.request_key && x.raw_digest === r.raw_digest);
      if (!ex) { ex = { ...r, receipt_id: this.receipts.length + 1 }; this.receipts.push(ex); }
      out.set(`${r.provider}|${r.raw_digest}`, ex.receipt_id);
    }
    return out;
  }
  async insertRevision(row: RevisionRow) {
    if (this.failInsertFor?.cond === row.condition_id) throw this.failInsertFor.err;
    const g = this.receipts.find((r) => r.receipt_id === row.gamma_receipt_id)!; const c = this.receipts.find((r) => r.receipt_id === row.clob_receipt_id)!;
    const ev = createHash("sha256").update([row.condition_id, row.outcome_status, row.winner_token_id ?? "", row.gamma_winner_token_id ?? "", row.clob_winner_token_id ?? "", g.raw_digest, c.raw_digest, row.resolved_at ? Date.parse(row.resolved_at) / 1000 : ""].join("|")).digest("hex");
    const mine = this.revisions.filter((r) => r.condition_id === row.condition_id);
    if (mine.length && mine[mine.length - 1]!.evidence === ev) return false; // guard's idempotent no-op
    this.revisions.push({ ...row, revision_no: mine.length + 1, evidence: ev });
    return true;
  }
  count(status?: string) { return new Set(this.revisions.filter((r) => !status || r.outcome_status === status).map((r) => r.condition_id)).size; }
}

const cfg = (o: Partial<CollectorConfig> = {}): CollectorConfig => ({ ...DEFAULT_CONFIG, pageSize: 4, concurrency: 2, headMaxPagesPerSource: 3, ...o });
const deps = (w: World) => ({ fetchImpl: w.fetchImpl, now: () => new Date("2026-10-13T10:00:00.000Z"), timeoutMs: 1000 });

function seeded(total = 10) {
  const w = new World(); const s = new FakeStore();
  const ns = Array.from({ length: total }, (_, i) => i + 1);
  for (const n of ns) w.add(n, n % 5 === 0 ? { closed: false } : n % 7 === 0 ? { closed: true, winner: "void" } : { closed: true, winner: n % 2 ? 0 : 1 });
  s.seed("reservation_market_observations", ns);
  s.seed("research_precontract_t20_observations", [1, 2, 3, 3, 3]);
  s.state = emptyState();
  s.state.sources.reservation_market_observations!.head_watermark = "2026-10-13T09:30:00.000Z"; // head already past the seed rows
  for (const k of Object.keys(s.state.sources)) s.state.sources[k]!.head_watermark = "2026-10-13T09:30:00.000Z";
  return { w, s };
}

// ---- 2. never LOSS from absence; never FINAL without proven winner ----
test("absence and ambiguity never become FINAL: 404/5xx/network -> LOOKUP_FAILED, closed-without-winner -> PENDING, disagreement -> CONFLICT", () => {
  const n = 7; const c = cid(n);
  const okG = (m: Mkt) => rc("gamma", c, 200, bodies(n, m).g);
  const okC = (m: Mkt) => rc("clob", c, 200, bodies(n, m).cl);
  assert.equal(classifyOutcome(c, rc("gamma", c, 500, "err"), okC({ closed: true, winner: 0 })).status, "LOOKUP_FAILED");
  assert.equal(classifyOutcome(c, okG({ closed: true, winner: 0 }), rc("clob", c, 404, "{}")).status, "LOOKUP_FAILED");
  assert.equal(classifyOutcome(c, rc("gamma", c, null, "", "TimeoutError"), rc("clob", c, null, "", "TimeoutError")).status, "LOOKUP_FAILED");
  assert.equal(classifyOutcome(c, rc("gamma", c, 200, "[]"), okC({ closed: true, winner: 0 })).status, "LOOKUP_FAILED");
  const noWinner = classifyOutcome(c, okG({ closed: true, winner: "none" }), okC({ closed: true, winner: "none" }));
  assert.equal(noWinner.status, "PENDING"); assert.equal(noWinner.winner_token_id, null);
  assert.equal(classifyOutcome(c, okG({ closed: false }), okC({ closed: false })).status, "PENDING");
  assert.equal(classifyOutcome(c, okG({ closed: true, winner: 0 }), okC({ closed: false })).status, "CONFLICT");
  assert.equal(classifyOutcome(c, okG({ closed: true, winner: 0 }), okC({ closed: true, winner: 1 })).status, "CONFLICT");
  assert.equal(classifyOutcome(c, okG({ closed: true, winner: "void" }), okC({ closed: true, winner: "void" })).status, "VOID");
  const fin = classifyOutcome(c, okG({ closed: true, winner: 1 }), okC({ closed: true, winner: 1 }));
  assert.equal(fin.status, "FINAL"); assert.equal(fin.winner_token_id, `${n}02`);
  assert.equal(fin.resolved_at, "2026-10-10T10:00:00+00:00"); assert.equal(fin.resolution_time_source, "gamma.closedTime");
});

// ---- 3. coverage grows from the four source tables, statuses are provider-backed, receipts kept ----
test("catch-up covers distinct markets from all sources with FINAL/VOID/PENDING, stores receipts, never touches other tables", async () => {
  const { w, s } = seeded(10);
  const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count(), 10);
  assert.deepEqual(stats.by_status, { FINAL: 7, VOID: 1, PENDING: 2 });
  assert.equal(s.revisions.length, 10);
  assert.ok(s.receipts.length >= 20); // gamma + clob per market (+ the closed=true miss for open markets)
  assert.equal(s.revisions.filter((r) => r.outcome_status !== "FINAL").every((r) => r.winner_token_id === null), true);
  assert.equal(cycleFailed(stats), false);
  for (const r of s.revisions.filter((x) => x.outcome_status === "PENDING")) { // open markets: decisive gamma receipt is the plain lookup
    assert.match(s.receipts.find((x) => x.receipt_id === r.gamma_receipt_id)!.request_url, /condition_ids=0x[0-9a-f]{64}$/);
  }
});

// ---- 4. bounded budget + keyset checkpoint: no rescans, no gaps ----
test("budget: processes at most the cycle budget, resumes from the durable checkpoint, shrinks the backlog to zero", async () => {
  const { w, s } = seeded(10);
  const seen: number[] = [];
  for (let i = 0; i < 6 && s.count() < 10; i++) {
    const before = w.calls;
    const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 3, maxRechecks: 0 + 1 }));
    assert.ok(stats.processed_new <= 3, `cycle ${i} processed ${stats.processed_new}`);
    seen.push(s.count());
    assert.ok(w.calls > before || s.count() === 10);
  }
  assert.equal(s.count(), 10);
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]!), "coverage never shrinks");
  assert.ok(seen[0]! <= 3);
  // fully drained sources are marked done and a further cycle does no discovery calls against providers
  const callsBefore = w.calls;
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 3 }));
  assert.ok(w.calls - callsBefore <= 12, "after catch-up only bounded rechecks remain, no archive rescan");
  assert.ok(s.state!.sources.reservation_market_observations!.backfill_done_at);
});

// ---- 5. idempotency + substantive-change revisions ----
test("rerun with identical evidence adds nothing; volume noise adds nothing; PENDING->FINAL adds a chained revision", async () => {
  const { w, s } = seeded(10);
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, recheckMinGapMs: 0 }));
  const revs = s.revisions.length; const rcpts = s.receipts.length;
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, recheckMinGapMs: 0 }));
  assert.equal(s.revisions.length, revs); assert.equal(s.receipts.length, rcpts);

  w.markets.get(cid(5))!.volume = 999; // body digest changes, substance does not
  s.state!.recheck_not_before = null;
  const noise = await runCollectorCycle(s, deps(w), cfg({ recheckMinGapMs: 0 }));
  assert.equal(s.revisions.length, revs);
  assert.ok(noise.stats.triage_closed === 0);

  w.markets.set(cid(5), { closed: true, winner: 1, closedTime: "2026-10-13 09:55:00+00" }); // the market resolves
  s.state!.recheck_not_before = null; s.state!.recheck_cursor = null;
  const res = await runCollectorCycle(s, deps(w), cfg({ recheckMinGapMs: 0 }));
  assert.equal(res.stats.triage_closed >= 1, true);
  const mine = s.revisions.filter((r) => r.condition_id === cid(5));
  assert.deepEqual(mine.map((r) => [r.revision_no, r.outcome_status]), [[1, "PENDING"], [2, "FINAL"]]);
  assert.equal(mine[1]!.winner_token_id, "502");
});

// ---- 6. failure recovery ----
test("429 halts without a verdict or a cursor gap; the next cycle completes the same markets", async () => {
  const { w, s } = seeded(10);
  w.throttle.add(cid(3));
  const a = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, concurrency: 1 }));
  assert.equal(a.stats.rate_limited, true);
  assert.equal(s.revisions.some((r) => r.condition_id === cid(3)), false, "a 429 must not be recorded as an outcome");
  assert.equal(s.revisions.some((r) => r.outcome_status === "LOOKUP_FAILED"), false);
  assert.equal(cycleFailed(a.stats), false, "rate limit is a resumable partial, reported but not a failure");
  w.throttle.clear();
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count(), 10);
  assert.equal(s.revisions.filter((r) => r.condition_id === cid(3)).length, 1);
});

test("provider outage records LOOKUP_FAILED (never LOSS), is loud, and recovers into a normal revision", async () => {
  const { w, s } = seeded(10);
  w.down = true;
  const a = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count("LOOKUP_FAILED"), 10);
  assert.equal(s.revisions.some((r) => r.outcome_status === "FINAL" || r.winner_token_id), false);
  assert.equal(cycleFailed(a.stats), true);
  w.down = false; s.state!.recheck_not_before = null; s.state!.recheck_cursor = null;
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 0 + 1, maxRechecks: 100, recheckScan: 100, recheckMinGapMs: 0 }));
  assert.equal(s.count("FINAL") + s.count("VOID") + s.count("PENDING") > 0, true);
  assert.equal(s.revisions.filter((r) => r.condition_id === cid(1)).map((r) => r.outcome_status).join(), "LOOKUP_FAILED,FINAL");
});

test("DB write failure keeps the cursor behind the failed market and is loud; BOX_B rejection is counted and skipped", async () => {
  const { w, s } = seeded(10);
  s.failInsertFor = { cond: cid(4), err: new Error("BOX_B_COLLECTOR_REVISION_WRITE:connection reset") };
  const a = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, concurrency: 1 }));
  assert.equal(a.stats.db_errors, 1); assert.equal(cycleFailed(a.stats), true);
  assert.ok(s.state!.sources.reservation_market_observations!.backfill_cursor! < cid(4));
  s.failInsertFor = null;
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count(), 10);

  const r = seeded(6);
  r.s.failInsertFor = { cond: cid(2), err: new BoxBRejected("BOX_B_FINAL_NOT_BACKED_BY_RECEIPTS") };
  const b = await runCollectorCycle(r.s, deps(r.w), cfg({ maxNewMarkets: 100 }));
  assert.equal(b.stats.db_rejected, 1); assert.equal(cycleFailed(b.stats), true);
  assert.equal(r.s.count(), 5); // the rest progressed past the rejected market
});

// ---- 7. discovery details ----
test("malformed ids are counted and skipped; new markets appearing later are found by the head scan without a full rescan", async () => {
  const { w, s } = seeded(6);
  s.seed("research_evidence_page_rows", ["0xABC", "not-an-id"]);
  w.add(500, { closed: true, winner: 0 });
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count(), 6);
  assert.ok(s.jobRuns[s.jobRuns.length - 1]!.malformed_ids_skipped >= 2);
  // a market first observed after the backfill finished (id sorts BELOW the cursor) is still discovered
  s.src.research_inplay_core_path_observations.push({ condition_id: cid(500), observed_at: "2026-10-13T11:00:00.000Z" });
  const after = s.pageReads;
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.count(), 7);
  assert.ok(s.revisions.some((r) => r.condition_id === cid(500)));
  assert.ok(s.pageReads - after <= 6, "bounded reads: the archive is not re-swept every cycle");
});

// ---- 8. boundaries ----
test("static: collector writes only Box B tables + job_runs checkpoint, reads only the four sources, no secrets/paper/Ledger coupling", () => {
  const files = ["lib/research/marketOutcomeCollector.ts", "lib/research/marketOutcomeCollectorStore.ts", "scripts/research-clone-market-outcome-collector.ts"];
  const code = files.map((f) => readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")).join("\n");
  const tables = new Set([...code.matchAll(/\.from\(\s*(?:"([a-z_]+)"|table\b)/g)].map((m) => m[1]).filter(Boolean));
  assert.deepEqual([...tables].sort(), ["job_runs", "market_outcome_provider_receipts", "market_outcome_revisions"].sort());
  for (const t of DISCOVERY_SOURCES) assert.ok(code.includes(t));
  assert.doesNotMatch(code, /paper_decision|ledger|virtual_bets|bet_row_key|SUPABASE_PROD|process\.env\.SUPABASE_URL|process\.env\.SUPABASE_SERVICE_ROLE_KEY/i);
  assert.match(code, /nppznoujvnyjargjkmnv/);
  assert.doesNotMatch(code, /\.from\([^)]*\)[\s\S]{0,80}\.(update|delete)\(/); // Box B is append-only; the only conflict handling is ON CONFLICT DO NOTHING
  assert.match(code, /ignoreDuplicates: true/);
  const toml = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8");
  const start = toml.split("\n").find((l) => l.startsWith("startCommand"))!;
  assert.equal((start.match(/research-clone:market-outcome-collector/g) ?? []).length, 2);
  assert.doesNotMatch(start, /(sync|decisions|settlement-cycle)\s*&&\s*npm run research-clone:market-outcome-collector/);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["research-clone:market-outcome-collector"], "tsx scripts/research-clone-market-outcome-collector.ts");
});

test("head scan cut by the budget resumes at the first unsettled market's FIRST observation: no skips, watermark advances, no endless rescan", async () => {
  const w = new World(); const s = new FakeStore(); s.state = emptyState();
  const base = Date.now() - 3 * 3_600_000;
  const N = 12;
  for (let n = 1; n <= N; n++) {
    w.add(n, { closed: true, winner: 0 });
    s.src.reservation_market_observations.push({ condition_id: cid(n), observed_at: new Date(base + n * 60_000).toISOString() });
  }
  // every market is observed AGAIN much later; resuming from the last observation would skip unprocessed markets
  for (let n = 1; n <= N; n++) s.src.reservation_market_observations.push({ condition_id: cid(n), observed_at: new Date(base + 2 * 3_600_000 + n * 1000).toISOString() });
  let prev = "";
  for (let i = 0; i < 8 && s.count() < N; i++) {
    await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 5, maxRechecks: 0, pageSize: 100, headMaxPagesPerSource: 2 }));
    const wm = s.state!.sources.reservation_market_observations!.head_watermark!;
    assert.ok(wm >= prev, "watermark never moves backwards"); prev = wm;
  }
  assert.equal(s.count(), N);
  assert.equal(s.revisions.length, N, "each market exactly one revision");
});

// ======================= BOX_B_ACTIVATE_AND_PROVE_HOURLY_V1: continuity hardening =======================

function headWorld(n: number, observedAt: (i: number) => string) {
  const w = new World(); const s = new FakeStore(); s.state = emptyState();
  for (const k of Object.keys(s.state.sources)) s.state.sources[k]!.backfill_done_at = new Date().toISOString(); // isolate the head scan: the backfill sweep must not rescue lost rows
  for (let i = 1; i <= n; i++) {
    w.add(i, { closed: true, winner: 0 });
    s.src.reservation_market_observations.push({ condition_id: cid(i), observed_at: observedAt(i) });
  }
  return { w, s };
}

test("head scan: markets tied on observed_at across a page edge are not lost (composite cursor), even when the tie is larger than a page", async () => {
  const T = new Date(Date.now() - 3_600_000).toISOString();
  const { w, s } = headWorld(23, () => T); // 23 rows share one timestamp, page size 5
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 1000, pageSize: 5, headMaxPagesPerSource: 10, maxRechecks: 0 }));
  assert.equal(s.count(), 23, "every tied market is discovered in the same cycle");
  assert.equal(s.revisions.length, 23);
});

test("head scan: ties split across cycles by the market budget still lose nothing", async () => {
  const T = new Date(Date.now() - 3_600_000).toISOString();
  const { w, s } = headWorld(14, () => T);
  for (let i = 0; i < 6 && s.count() < 14; i++) await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 4, pageSize: 5, headMaxPagesPerSource: 10, maxRechecks: 0 }));
  assert.equal(s.count(), 14);
});

test("status model: SUCCESS / PARTIAL / FAILED and exit codes are derived in one place", () => {
  const base = emptyStats(new Date());
  assert.deepEqual([cycleVerdict(base).status, cycleVerdict(base).exit_code], ["SUCCESS", 0]);
  for (const patch of [{ rate_limited: true }, { triage_failed: 2 }, { deadline_hit: true }] as Partial<CycleStats>[]) {
    const v = cycleVerdict({ ...base, ...patch });
    assert.deepEqual([v.status, v.exit_code], ["PARTIAL", 0], JSON.stringify(patch));
    assert.ok(v.reasons.length > 0);
  }
  for (const patch of [{ db_errors: 1 }, { db_rejected: 1 }, { capacity_limit_hit: true, receipts_total: 9 }, { stalled_cycles: STALL_FAIL_CYCLES },
    { processed_new: 20, fetch_lookup_failed: 15 }] as Partial<CycleStats>[]) {
    const v = cycleVerdict({ ...base, ...patch });
    assert.deepEqual([v.status, v.exit_code], ["FAILED", 1], JSON.stringify(patch));
  }
  assert.equal(cycleFailed({ ...base, rate_limited: true }), false);
});

test("persistent 429 on new markets: PARTIAL while it lasts, FAILED after 3 cycles without progress, recovers and resets", async () => {
  const { w, s } = seeded(10);
  for (const c of w.markets.keys()) w.throttle.add(c);
  const verdicts: string[] = [];
  for (let i = 0; i < STALL_FAIL_CYCLES; i++) {
    const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, concurrency: 1 }));
    verdicts.push(`${cycleVerdict(stats).status}:${cycleVerdict(stats).exit_code}`);
    assert.equal(s.revisions.length, 0, "a 429 never becomes an outcome");
  }
  assert.deepEqual(verdicts, ["PARTIAL:0", "PARTIAL:0", "FAILED:1"]);
  assert.equal(s.state!.stalled_cycles, STALL_FAIL_CYCLES);
  w.throttle.clear();
  const ok = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(cycleVerdict(ok.stats).status, "SUCCESS");
  assert.equal(s.state!.stalled_cycles, 0);
  assert.equal(s.count(), 10);
});

test("triage failures (429 and non-200) are visible: triage 429 halts as rate limit, PARTIAL, then FAILED when it never recovers; cursor stays behind", async () => {
  const { w, s } = seeded(10);
  await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  const pendingBefore = s.count("PENDING");
  assert.ok(pendingBefore >= 2);
  w.throttleTriage = true;
  const out: string[] = [];
  for (let i = 0; i < STALL_FAIL_CYCLES; i++) {
    const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 0, forceRecheck: true }));
    assert.ok(stats.triage_failed >= 1); assert.equal(stats.rate_limited, true);
    out.push(cycleVerdict(stats).status);
  }
  assert.deepEqual(out, ["PARTIAL", "PARTIAL", "FAILED"]);
  assert.equal(s.state!.recheck_cursor, null, "cursor did not skip the triage-failed markets");
  w.throttleTriage = false;
  w.markets.set(cid(5), { closed: true, winner: 1 }); // resolves while triage was down
  const rec = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 0, forceRecheck: true }));
  assert.equal(cycleVerdict(rec.stats).status, "SUCCESS");
  assert.equal(s.revisions.filter((r) => r.condition_id === cid(5)).at(-1)!.outcome_status, "FINAL");
});

test("checkpoint stays recoverable: a kill after a phase save resumes from the saved cursor without redoing or losing markets", async () => {
  const base = Date.now() - 3 * 3_600_000;
  const { w, s } = headWorld(12, (i) => new Date(base + i * 60_000).toISOString());
  s.failFinalWrite = true;
  await assert.rejects(runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 6, pageSize: 100, maxRechecks: 0 })), /COLLECTOR_CYCLE_FATAL|KILLED_BEFORE_FINAL_CHECKPOINT/);
  assert.equal(s.count(), 6);
  const saved = s.state!.sources.reservation_market_observations!.head_watermark;
  assert.ok(saved, "head progress was persisted by the phase save, before the final row");
  s.failFinalWrite = false;
  const callsBefore = w.calls;
  const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, pageSize: 100, maxRechecks: 0 }));
  assert.equal(s.count(), 12);
  assert.equal(s.revisions.length, 12, "no market written twice");
  assert.equal(stats.processed_new, 6);
  assert.ok(w.calls - callsBefore <= 6 * 3, "only the remaining markets hit the providers");
});

test("abort (SIGTERM) stops starting work, still writes the final checkpoint, and reports PARTIAL", async () => {
  const { w, s } = seeded(10);
  const ac = new AbortController(); ac.abort();
  const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100, abortSignal: ac.signal }));
  assert.equal(stats.deadline_hit, true);
  assert.equal(cycleVerdict(stats).status, "PARTIAL");
  assert.equal(s.jobRuns.at(-1)!.verdict, "PARTIAL");
  assert.equal(s.revisions.length, 0);
});

test("capacity limit: at the receipt cap new intake stops, rechecks still run, and the cycle is FAILED with the reason", async () => {
  const { w, s } = seeded(10);
  s.receiptCountOverride = 400_000;
  const { stats } = await runCollectorCycle(s, deps(w), cfg({ maxNewMarkets: 100 }));
  assert.equal(s.revisions.length, 0);
  assert.equal(stats.capacity_limit_hit, true);
  const v = cycleVerdict(stats);
  assert.deepEqual([v.status, v.exit_code], ["FAILED", 1]);
  assert.match(v.reasons.join(), /capacity_limit/);
});

// ---- the script's real exit code / STATUS against a minimal PostgREST stand-in (no network, no real DB) ----
async function runScript(mode: "ok" | "count_500" | "capacity"): Promise<{ code: number | null; out: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "HEAD" && url.includes("market_outcome_provider_receipts")) {
      if (mode === "count_500") { res.writeHead(500, { "content-type": "application/json" }); return res.end(); }
      res.writeHead(200, { "content-range": `*/${mode === "capacity" ? 999999999 : 5}` }); return res.end();
    }
    if (req.method === "POST") { res.writeHead(201); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" }); res.end("[]");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/research-clone-market-outcome-collector.ts"], {
        env: { ...process.env, SUPABASE_CLONE_URL: `http://127.0.0.1:${port}/nppznoujvnyjargjkmnv`, SUPABASE_CLONE_SERVICE_ROLE_KEY: "test-key", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", HTTPS_PROXY: "", HTTP_PROXY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  } finally { server.close(); }
}

test("script: empty healthy DBClone -> STATUS SUCCESS exit 0", async () => {
  const r = await runScript("ok");
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out.trim().split("\n").at(-1)!).STATUS, "SUCCESS");
});

test("script: capacity limit -> STATUS FAILED exit 1 with the reason; DB failure -> FAILED exit 1 (never a green run)", async () => {
  const cap = await runScript("capacity");
  assert.equal(cap.code, 1, cap.out);
  const j = JSON.parse(cap.out.trim().split("\n").at(-1)!);
  assert.equal(j.STATUS, "FAILED"); assert.match(j.reasons.join(), /capacity_limit/);
  const bad = await runScript("count_500");
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /"STATUS":"FAILED"/);
});

test("script refuses a non-DBClone target before doing anything", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/research-clone-market-outcome-collector.ts"], {
    env: { ...process.env, SUPABASE_CLONE_URL: "https://someotherproject.supabase.co", SUPABASE_CLONE_SERVICE_ROLE_KEY: "k" }, encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT_THE_RESEARCH_CLONE/);
});

// ---- the REAL cron start command, executed by /bin/sh with stubbed `npm` and `date` ----
function startCommand(): string {
  const line = readFileSync("ops/railway/research-clone-daily-sync.toml", "utf8").split("\n").find((l) => l.startsWith("startCommand"))!;
  return line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).replace(/\\"/g, '"');
}
function runCron(hour: string, failing: string[]): { code: number | null; steps: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "cron-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "steps.log");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$*" >> "${log}"\nfor f in $FAIL_STEPS; do case "$*" in *"$f"*) exit 1;; esac; done\nexit 0\n`);
  writeFileSync(join(bin, "date"), `#!/bin/sh\necho ${hour}\n`);
  chmodSync(join(bin, "npm"), 0o755); chmodSync(join(bin, "date"), 0o755);
  const r = spawnSync("/bin/sh", ["-c", startCommand()], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAIL_STEPS: failing.join(" ") }, encoding: "utf8" });
  let steps: string[] = [];
  try { steps = readFileSync(log, "utf8").trim().split("\n").map((l) => l.replace(/^run /, "")); } catch { /* no steps ran */ }
  return { code: r.status, steps };
}
const COLLECTOR = "research-clone:market-outcome-collector";

test("cron shell (hourly branch): collector runs last; all green -> exit 0", () => {
  const r = runCron("05", []);
  assert.equal(r.code, 0);
  assert.deepEqual(r.steps.map((s) => s.split(" ")[0]), ["research-clone:sync", "research-clone:inplay-paper-decisions", "research-clone:inplay-paper-settlement-cycle", COLLECTOR]);
});

test("cron shell: collector failure turns the run red but never skips an earlier step; decisions/settlement failures never skip the collector", () => {
  for (const hour of ["05", "02"]) {
    const c = runCron(hour, [COLLECTOR]);
    assert.notEqual(c.code, 0, `${hour}: collector failure must be visible`);
    assert.equal(c.steps.at(-1)!.split(" ")[0], COLLECTOR);
    assert.ok(c.steps.some((s) => s.startsWith("research-clone:inplay-paper-settlement-cycle")));
    for (const failing of ["research-clone:inplay-paper-decisions", "research-clone:inplay-paper-settlement-cycle"]) {
      const r = runCron(hour, [failing]);
      assert.notEqual(r.code, 0, `${hour}: ${failing} failure must stay visible`);
      assert.equal(r.steps.at(-1)!.split(" ")[0], COLLECTOR, `${hour}: ${failing} must not suppress the collector`);
      assert.ok(r.steps.some((s) => s.startsWith("research-clone:inplay-paper-decisions")) && r.steps.some((s) => s.startsWith("research-clone:inplay-paper-settlement-cycle")));
    }
  }
});

test("cron shell: a failing sync never suppresses decisions, settlement or the collector in either branch", () => {
  const h = runCron("05", ["research-clone:sync"]);
  assert.deepEqual(h.steps.map((s) => s.split(" ")[0]).slice(1), ["research-clone:inplay-paper-decisions", "research-clone:inplay-paper-settlement-cycle", COLLECTOR]);
  const n = runCron("02", ["research-clone:sync"]); // legacy `&&` gating of model-ready on sync is unchanged
  const names = n.steps.map((s) => s.split(" ")[0]);
  assert.ok(!names.includes("research-clone:model-ready"));
  assert.deepEqual(names.slice(-3), ["research-clone:inplay-paper-decisions", "research-clone:inplay-paper-settlement-cycle", COLLECTOR]);
});

test("cron shell, 02:00 branch all green: legacy steps unchanged and in order, collector last", () => {
  const r = runCron("02", []);
  assert.equal(r.code, 0);
  assert.deepEqual(r.steps.map((s) => s.split(" ")[0]), [
    "research-clone:sync", "research-clone:model-ready", "research-clone:model-ready-direct", "research-clone:modeling-conveyor",
    "research-clone:modeling-dashboard-refresh", "research-clone:inplay-paper-decisions", "research-clone:inplay-paper-settlement-cycle", COLLECTOR,
  ]);
});
