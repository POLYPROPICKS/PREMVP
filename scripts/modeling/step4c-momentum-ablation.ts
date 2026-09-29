/**
 * STEP 4C bounded historical momentum ablation. RESEARCH ONLY, NOT_EXECUTION_AUTHORITY.
 * Estimator: DETERMINISTIC_L2_LOGISTIC_V1 (frozen). Production READ-ONLY (PostgREST GET only).
 * Labels come from the committed strict terminal resolver, unchanged.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveStrict, summarize, type MarketFetcher, type StrictResult } from "./step4c-strict-terminal-resolver";
import { fetchGammaMarketByConditionId, type GammaMarket } from "../../lib/feed/resolveSignalOutcome";

export const RUN_ID = "f94429cb-eb8e-4607-a06d-701208b8ceb3";
export const PROD_REF = "nbnldzfsxffztsfrrxqy";
export const HISTORICAL_CUTOFF = "2026-09-29T00:00:00Z";
export const ESTIMATOR = Object.freeze({
  NAME: "DETERMINISTIC_L2_LOGISTIC_V1",
  LAMBDA: 1.0,
  INTERCEPT_REGULARIZED: false,
  INIT: "all coefficients = 0",
  OPTIMIZER: "deterministic Newton / IRLS",
  MAX_ITER: 100,
  CONVERGENCE: "max abs coefficient delta < 1e-8",
  CONTINUOUS_NORMALIZATION: "training-fold mean and population std (divide by n); std == 0 => 0",
  MARKET_TYPE: "training-fold one-hot; sorted lexicographic vocabulary; first category dropped as baseline; unknown test category => all-zero vector",
  LOG_LOSS_PROB_CLIP: 1e-15,
  HYPERPARAMETER_SEARCH: false,
  CALIBRATION: false,
  RANDOMNESS: false,
});
export const MIN_TERMINAL_N = 80;
export const MIN_FOLD_TEST_N = 15;

export type Arm = "M0" | "M1" | "M2";
export const ARM_CONTINUOUS: Record<Arm, readonly string[]> = {
  M0: ["selected_price_num"],
  M1: ["selected_price_num", "score", "coverage", "lead_time_hours"],
  M2: ["selected_price_num", "score", "coverage", "lead_time_hours", "price1hAgo", "price6hAgo", "delta1hPp", "delta6hPp"],
};

export interface FeatureRow {
  event_id: string;
  condition_id: string;
  selected_token_id: string;
  selected_price_num: number;
  market_type: string;
  score: number;
  coverage: number;
  snapshot_at: string;
  game_start_iso: string;
  price1hAgo: number;
  price6hAgo: number;
  delta1hPp: number;
  delta6hPp: number;
}
export interface LabeledRow extends FeatureRow { lead_time_hours: number; y: 0 | 1 }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const identityHash = (conditionId: string, tokenId: string) => sha(`${conditionId}::${tokenId}`);

/** Outcome-blind: per event, smallest SHA256(condition_id::selected_token_id); ties by condition_id then token ASC. */
export function selectOnePerEvent<T extends { event_id: string; condition_id: string; selected_token_id: string }>(rows: readonly T[]): T[] {
  const best = new Map<string, { row: T; h: string }>();
  const cmp = (a: { row: T; h: string }, b: { row: T; h: string }) =>
    a.h < b.h ? -1 : a.h > b.h ? 1
      : a.row.condition_id < b.row.condition_id ? -1 : a.row.condition_id > b.row.condition_id ? 1
        : a.row.selected_token_id < b.row.selected_token_id ? -1 : a.row.selected_token_id > b.row.selected_token_id ? 1 : 0;
  for (const row of rows) {
    const cand = { row, h: identityHash(row.condition_id, row.selected_token_id) };
    const cur = best.get(row.event_id);
    if (!cur || cmp(cand, cur) < 0) best.set(row.event_id, cand);
  }
  return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v.row);
}

// ── estimator ────────────────────────────────────────────────────────────────────────────────────────────
export class EstimatorNumericalFailure extends Error {}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-12)) throw new EstimatorNumericalFailure("SINGULAR_HESSIAN");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** X includes intercept column 0 (not regularized). */
export function fitLogistic(X: number[][], y: number[], lambda = ESTIMATOR.LAMBDA): { beta: number[]; iterations: number } {
  const n = X.length, d = X[0].length;
  let beta = new Array<number>(d).fill(0);
  for (let it = 1; it <= ESTIMATOR.MAX_ITER; it++) {
    const g = new Array<number>(d).fill(0);
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += X[i][j] * beta[j];
      const p = sigmoid(z), w = p * (1 - p), r = p - y[i];
      for (let j = 0; j < d; j++) {
        g[j] += X[i][j] * r;
        for (let k = 0; k < d; k++) H[j][k] += w * X[i][j] * X[i][k];
      }
    }
    for (let j = 1; j < d; j++) { g[j] += lambda * beta[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    const next = beta.map((b, j) => b - step[j]);
    if (!next.every(Number.isFinite)) throw new EstimatorNumericalFailure("NON_FINITE_COEFFICIENT");
    const delta = Math.max(...next.map((b, j) => Math.abs(b - beta[j])));
    beta = next;
    if (delta < 1e-8) return { beta, iterations: it };
  }
  throw new EstimatorNumericalFailure("NO_CONVERGENCE_100_ITER");
}

export function buildDesign(arm: Arm, train: readonly LabeledRow[], test: readonly LabeledRow[]) {
  const cols = ARM_CONTINUOUS[arm];
  const vocab = [...new Set(train.map((r) => r.market_type))].sort();
  const cats = vocab.slice(1); // drop first as baseline
  const stats = cols.map((c) => {
    const v = train.map((r) => (r as any)[c] as number);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, std };
  });
  const row = (r: LabeledRow) => [
    1,
    ...cols.map((c, i) => (stats[i].std === 0 ? 0 : (((r as any)[c] as number) - stats[i].mean) / stats[i].std)),
    ...cats.map((k) => (r.market_type === k ? 1 : 0)),
  ];
  return { Xtrain: train.map(row), Xtest: test.map(row), vocab };
}

export interface Metrics { LOG_LOSS: number; BRIER: number; ACCURACY: number; N: number }
export function metrics(p: readonly number[], y: readonly number[]): Metrics {
  const e = ESTIMATOR.LOG_LOSS_PROB_CLIP;
  let ll = 0, br = 0, ok = 0;
  p.forEach((pi, i) => {
    const c = Math.min(1 - e, Math.max(e, pi));
    ll += -(y[i] * Math.log(c) + (1 - y[i]) * Math.log(1 - c));
    br += (pi - y[i]) ** 2;
    ok += (pi >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
  });
  const n = p.length;
  return { LOG_LOSS: ll / n, BRIER: br / n, ACCURACY: ok / n, N: n };
}

export function sortTerminal(rows: readonly LabeledRow[]): LabeledRow[] {
  const c = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows].sort((a, b) => c(a.game_start_iso, b.game_start_iso) || c(a.event_id, b.event_id));
}

export function foldBounds(N: number) {
  const b40 = Math.floor(0.4 * N), b60 = Math.floor(0.6 * N), b80 = Math.floor(0.8 * N);
  return [
    { fold: 1, train: [0, b40], test: [b40, b60] },
    { fold: 2, train: [0, b60], test: [b60, b80] },
    { fold: 3, train: [0, b80], test: [b80, N] },
  ] as const;
}

export function runAblation(terminal: readonly LabeledRow[]) {
  const s = sortTerminal(terminal);
  const N = s.length;
  const folds = foldBounds(N);
  const perFold: any[] = [];
  const pooled: Record<Arm, { p: number[]; y: number[] }> = { M0: { p: [], y: [] }, M1: { p: [], y: [] }, M2: { p: [], y: [] } };
  for (const f of folds) {
    const train = s.slice(f.train[0], f.train[1]), test = s.slice(f.test[0], f.test[1]);
    if (test.length < MIN_FOLD_TEST_N) throw new Error(`FOLD_${f.fold}_TEST_N_BELOW_${MIN_FOLD_TEST_N}`);
    const trainEvents = new Set(train.map((r) => r.event_id));
    if (test.some((r) => trainEvents.has(r.event_id))) throw new Error("EVENT_OVERLAP");
    const entry: any = { FOLD: f.fold, TRAIN_N: train.length, TEST_N: test.length, TRAIN_RANGE: f.train, TEST_RANGE: f.test };
    for (const arm of ["M0", "M1", "M2"] as Arm[]) {
      const { Xtrain, Xtest, vocab } = buildDesign(arm, train, test);
      const { beta, iterations } = fitLogistic(Xtrain, train.map((r) => r.y));
      const p = Xtest.map((x) => sigmoid(x.reduce((a, v, j) => a + v * beta[j], 0)));
      const y = test.map((r) => r.y);
      pooled[arm].p.push(...p); pooled[arm].y.push(...y);
      const m = metrics(p, y);
      entry[arm] = { LOG_LOSS: m.LOG_LOSS, BRIER: m.BRIER, ACCURACY: m.ACCURACY, ITERATIONS: iterations, TRAIN_MARKET_TYPE_VOCAB: vocab };
    }
    perFold.push(entry);
  }
  const agg = (arm: Arm) => metrics(pooled[arm].p, pooled[arm].y);
  const a = { M0: agg("M0"), M1: agg("M1"), M2: agg("M2") };
  const m2Better = perFold.filter((f) => f.M2.LOG_LOSS < f.M1.LOG_LOSS).length;
  const positive = a.M2.LOG_LOSS < a.M1.LOG_LOSS && a.M2.BRIER < a.M1.BRIER && m2Better >= 2;
  return {
    TERMINAL_N: N, perFold, aggregate: a, M2_BETTER_LOGLOSS_FOLD_N: m2Better,
    RESULT: positive ? "MOMENTUM_DIAGNOSTIC_POSITIVE" : "NO_MOMENTUM_LIFT_PROVEN",
  } as const;
}

// ── production read-only runner ──────────────────────────────────────────────────────────────────────────
const TABLE = "generated_signal_research_snapshots";
const S2 = `snapshot_run_id=eq.${RUN_ID}&diagnostics->>providerSportFamily=eq.soccer&diagnostics->scoreObservation->>sourceLineage=eq.S2_WIDE_SCORER&event_id=not.is.null&event_id=neq.&game_start_iso=lt.${HISTORICAL_CUTOFF}`;
const OUT = "modeling/evidence/step4c-momentum-ablation-v1";

let rawRows = 0;
async function rest(path: string) {
  const url = process.env.SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetch(`${url}/rest/v1/${TABLE}?${path}`, { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`REST_${res.status}`);
  const rows = (await res.json()) as any[];
  rawRows += rows.length;
  return rows;
}

const num = (v: unknown, name: string) => {
  const n = typeof v === "number" ? v : Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) throw new Error(`MISSING_FEATURE:${name}`);
  return n;
};

async function main() {
  const ref = new URL(process.env.SUPABASE_URL ?? "https://x").hostname.split(".")[0];
  if (ref !== PROD_REF || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log("ENVIRONMENT_MISMATCH_PRODUCTION_DB_UNAVAILABLE"); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  const put = (f: string, o: unknown) => writeFileSync(`${OUT}/${f}`, typeof o === "string" ? o : JSON.stringify(o, null, 2) + "\n");
  put("ESTIMATOR_CONTRACT.json", { NOT_EXECUTION_AUTHORITY: true, ESTIMATOR, ARM_FEATURES: { M0: [...ARM_CONTINUOUS.M0, "market_type"], M1: [...ARM_CONTINUOUS.M1, "market_type"], M2: [...ARM_CONTINUOUS.M2, "market_type"] }, TARGET: "WIN=1 LOSS=0; OPEN/LOOKUP_UNAVAILABLE/INVALID_TOKEN_IDENTITY excluded, never LOSS", FOLDS: "chronological expanding window 40/60/80 percent; sort game_start_iso ASC, event_id ASC (string order)", VERDICT: "POSITIVE iff M2 pooled logloss < M1 AND M2 pooled Brier < M1 AND M2 beats M1 logloss in >=2/3 folds", FEATURE_SOURCES: { market_type: "diagnostics.researchContext.marketType", score: "diagnostics.scoreObservation.scoreValue", coverage: "data_coverage_num", lead_time_hours: "(game_start_iso - snapshot_at) hours", price1hAgo: "diagnostics.price1hAgo", price6hAgo: "diagnostics.price6hAgo", delta1hPp: "diagnostics.delta1hPp", delta6hPp: "diagnostics.delta6hPp" }, HELD_OUT_PARTITION_TOUCHED: false });

  // 1. outcome-blind identity keys of the historical partition (needed to apply the SHA rule; no feature/label columns)
  const keys: { event_id: string; condition_id: string; selected_token_id: string }[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await rest(`select=event_id,condition_id,selected_token_id&${S2}&order=condition_id.asc,selected_token_id.asc&limit=1000&offset=${off}`);
    keys.push(...page);
    if (page.length < 1000) break;
  }
  const chosen = selectOnePerEvent(keys);
  const identityKeyRowsRead = rawRows;
  // 2. exactly the chosen identities' feature rows (<=122)
  const wantTok = chosen.map((c) => c.selected_token_id);
  const cols = "event_id,condition_id,selected_token_id,selected_price_num,market_type:diagnostics->researchContext->>marketType,score:diagnostics->scoreObservation->>scoreValue,coverage:data_coverage_num,snapshot_at,game_start_iso,price1hAgo:diagnostics->>price1hAgo,price6hAgo:diagnostics->>price6hAgo,delta1hPp:diagnostics->>delta1hPp,delta6hPp:diagnostics->>delta6hPp";
  const before = rawRows;
  const feat = await rest(`select=${cols}&${S2}&selected_token_id=in.(${wantTok.join(",")})&order=event_id.asc,condition_id.asc,selected_token_id.asc&limit=1000`);
  const want = new Set(chosen.map((c) => `${c.condition_id}::${c.selected_token_id}`));
  const rows: FeatureRow[] = feat.filter((r) => want.has(`${r.condition_id}::${r.selected_token_id}`)).map((r) => ({
    event_id: String(r.event_id), condition_id: r.condition_id, selected_token_id: r.selected_token_id,
    selected_price_num: num(r.selected_price_num, "selected_price_num"), market_type: String(r.market_type ?? ""),
    score: num(r.score, "score"), coverage: num(r.coverage, "coverage"), snapshot_at: r.snapshot_at, game_start_iso: r.game_start_iso,
    price1hAgo: num(r.price1hAgo, "price1hAgo"), price6hAgo: num(r.price6hAgo, "price6hAgo"),
    delta1hPp: num(r.delta1hPp, "delta1hPp"), delta6hPp: num(r.delta6hPp, "delta6hPp"),
  }));
  if (rows.length !== chosen.length || rows.some((r) => !r.market_type)) throw new Error("FROZEN_MEMBERSHIP_FEATURE_JOIN_INCOMPLETE");
  const featureRowsRead = rawRows - before;
  const membershipSha = sha(JSON.stringify(rows.map((r) => `${r.event_id}|${r.condition_id}|${r.selected_token_id}`)));
  put("MEMBERSHIP.json", { NOT_EXECUTION_AUTHORITY: true, FROZEN_BEFORE_SETTLEMENT: true, SNAPSHOT_RUN_ID: RUN_ID, RULE: "per event smallest SHA256(condition_id::selected_token_id); tie condition_id ASC, selected_token_id ASC", HISTORICAL_PARTITION: `game_start_iso < ${HISTORICAL_CUTOFF}`, HISTORICAL_IDENTITY_KEY_ROWS_READ_N: keys.length, HISTORICAL_EVENT_N: rows.length, MEMBERSHIP_SHA256: membershipSha, IDENTITIES: rows.map((r) => ({ event_id: r.event_id, condition_id: r.condition_id, selected_token_id: r.selected_token_id, sha256: identityHash(r.condition_id, r.selected_token_id) })) });

  // 3. strict labels, cached by condition_id
  let gamma = 0;
  const cache = new Map<string, Promise<GammaMarket | null>>();
  const cached: MarketFetcher = (cid) => {
    if (!cache.has(cid)) { gamma++; cache.set(cid, fetchGammaMarketByConditionId(cid)); }
    return cache.get(cid)!;
  };
  const results: StrictResult[] = [];
  for (const r of rows) results.push(await resolveStrict(r.condition_id, r.selected_token_id, cached));
  const sum = summarize(results);
  const terminalN = sum.WIN_N + sum.LOSS_N;
  const counters = { RAW_DB_ROWS_READ_N: rawRows, IDENTITY_KEY_ROWS_READ_N: identityKeyRowsRead, FEATURE_ROWS_READ_N: featureRowsRead, GAMMA_LOOKUP_N: gamma, PRODUCTION_WRITES: 0 };
  put("LABEL_SUMMARY.json", { NOT_EXECUTION_AUTHORITY: true, MEMBERSHIP_SHA256: membershipSha, ...sum, TERMINAL_N: terminalN, ...counters, RESULTS: results.map((x) => ({ condition_id: x.conditionId, selected_token_id: x.selectedTokenId, label: x.label, reason: x.reason })) });

  const head = { HISTORICAL_EVENT_N: rows.length, WIN_N: sum.WIN_N, LOSS_N: sum.LOSS_N, OPEN_N: sum.OPEN_N, LOOKUP_UNAVAILABLE_N: sum.LOOKUP_UNAVAILABLE_N, INVALID_TOKEN_IDENTITY_N: sum.INVALID_TOKEN_IDENTITY_N, CONDITION_ID_MISMATCH_N: sum.CONDITION_ID_MISMATCH_N, TERMINAL_N: terminalN };
  const finish = (result: string, extra: object = {}) => {
    const out = { NOT_EXECUTION_AUTHORITY: true, RESULT: result, ...head, ...extra, ...counters, PRODUCTION_WRITES: 0, LIVE_CHANGED: false, IRELAND_CHANGED: false };
    put("ABLATION_RESULT.json", out);
    console.log(JSON.stringify(out));
  };
  if (!sum.STRICT_INVARIANTS_PASS) { put("FOLD_RESULTS.json", { NOT_EXECUTION_AUTHORITY: true, SKIPPED: "STRICT_LABEL_INVARIANT_FAILURE" }); return finish("STRICT_LABEL_INVARIANT_FAILURE"); }
  if (terminalN < MIN_TERMINAL_N) { put("FOLD_RESULTS.json", { NOT_EXECUTION_AUTHORITY: true, SKIPPED: "INSUFFICIENT_TERMINAL_SAMPLE" }); return finish("INSUFFICIENT_TERMINAL_SAMPLE"); }

  const labeled: LabeledRow[] = [];
  rows.forEach((r, i) => {
    const l = results[i].label;
    if (l !== "WIN" && l !== "LOSS") return;
    labeled.push({ ...r, lead_time_hours: (Date.parse(r.game_start_iso) - Date.parse(r.snapshot_at)) / 3_600_000, y: l === "WIN" ? 1 : 0 });
  });
  let res;
  try { res = runAblation(labeled); }
  catch (e) {
    const msg = (e as Error).message;
    put("FOLD_RESULTS.json", { NOT_EXECUTION_AUTHORITY: true, SKIPPED: msg });
    return finish(e instanceof EstimatorNumericalFailure ? "ESTIMATOR_NUMERICAL_FAILURE" : msg.startsWith("FOLD_") ? "INSUFFICIENT_TERMINAL_SAMPLE" : "ESTIMATOR_NUMERICAL_FAILURE", { REASON: msg });
  }
  put("FOLD_RESULTS.json", { NOT_EXECUTION_AUTHORITY: true, FOLDS: res.perFold });
  finish(res.RESULT, { AGGREGATE: res.aggregate, M2_BETTER_LOGLOSS_FOLD_N: res.M2_BETTER_LOGLOSS_FOLD_N, FOLD_TEST_N: res.perFold.map((f: any) => f.TEST_N) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
