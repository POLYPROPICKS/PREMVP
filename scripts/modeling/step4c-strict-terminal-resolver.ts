/**
 * STEP 4C strict exact-identity terminal resolver. RESEARCH ONLY, NOT_EXECUTION_AUTHORITY.
 * Reuses the canonical Gamma/CLOB fetch and the pure provider-winner resolver unchanged, and adds
 * the exact-identity assertions the research wrapper lacked. Never infers a label from missing data.
 * Production/live semantics (lib/feed/resolveSignalOutcome.ts) are not modified.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  fetchGammaMarketByConditionId,
  resolveProviderMarketWinner,
  type GammaMarket,
} from "../../lib/feed/resolveSignalOutcome";

export type StrictLabel = "WIN" | "LOSS" | "OPEN" | "LOOKUP_UNAVAILABLE" | "INVALID_TOKEN_IDENTITY";
export type StrictReason =
  | "WINNER_IS_SELECTED_TOKEN"
  | "OPPOSITE_TOKEN_WINS"
  | "MARKET_NOT_CLOSED"
  | "LOOKUP_NULL"
  | "NO_IDENTITY"
  | "CONDITION_ID_MISMATCH"
  | "CLOB_TOKEN_IDS_UNPARSABLE"
  | "SELECTED_TOKEN_NOT_IN_CLOB_TOKEN_IDS"
  | "CLOSED_WITHOUT_SINGLE_WINNER";

export interface StrictResult {
  conditionId: string;
  selectedTokenId: string;
  label: StrictLabel;
  reason: StrictReason;
  /** true only when returned conditionId equals requested conditionId (case-insensitive). */
  conditionIdMatched: boolean;
  /** true only when selected token was found in the returned clobTokenIds. */
  tokenInClobTokenIds: boolean;
}

export type MarketFetcher = (conditionId: string) => Promise<GammaMarket | null>;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

function parseTokenIds(v: unknown): string[] | null {
  let arr: unknown = v;
  if (typeof v === "string") {
    try { arr = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(arr) && arr.length > 0 ? arr.map((t) => String(t).trim()) : null;
}

/** Pure strict classification of one exact identity against one fetched market. */
export function classifyStrict(conditionId: string, selectedTokenId: string, market: GammaMarket | null): StrictResult {
  const base = { conditionId, selectedTokenId, conditionIdMatched: false, tokenInClobTokenIds: false };
  if (!conditionId || !selectedTokenId) return { ...base, label: "LOOKUP_UNAVAILABLE", reason: "NO_IDENTITY" };
  if (!market) return { ...base, label: "LOOKUP_UNAVAILABLE", reason: "LOOKUP_NULL" };
  // A. returned conditionId must equal requested conditionId (a missing one cannot be asserted).
  if (norm(market.conditionId) !== norm(conditionId)) {
    return { ...base, label: "LOOKUP_UNAVAILABLE", reason: "CONDITION_ID_MISMATCH" };
  }
  const matched = { ...base, conditionIdMatched: true };
  // B. selected token must be one of the market's tokens; never LOSS otherwise.
  const tokens = parseTokenIds(market.clobTokenIds);
  if (!tokens) return { ...matched, label: "INVALID_TOKEN_IDENTITY", reason: "CLOB_TOKEN_IDS_UNPARSABLE" };
  const sel = selectedTokenId.trim();
  if (!tokens.includes(sel)) return { ...matched, label: "INVALID_TOKEN_IDENTITY", reason: "SELECTED_TOKEN_NOT_IN_CLOB_TOKEN_IDS" };
  const valid = { ...matched, tokenInClobTokenIds: true };
  // C. terminal classification.
  const w = resolveProviderMarketWinner(market);
  if (w.resolverState === "active_unresolved") return { ...valid, label: "OPEN", reason: "MARKET_NOT_CLOSED" };
  if (w.resolverState !== "resolved_candidate" || !w.candidateWinningTokenId) {
    // closed but no single unambiguous winner: unknown, never OPEN and never inferred.
    return { ...valid, label: "LOOKUP_UNAVAILABLE", reason: "CLOSED_WITHOUT_SINGLE_WINNER" };
  }
  const winner = w.candidateWinningTokenId.trim();
  if (!tokens.includes(winner)) return { ...valid, label: "LOOKUP_UNAVAILABLE", reason: "CLOSED_WITHOUT_SINGLE_WINNER" };
  return winner === sel
    ? { ...valid, label: "WIN", reason: "WINNER_IS_SELECTED_TOKEN" }
    : { ...valid, label: "LOSS", reason: "OPPOSITE_TOKEN_WINS" };
}

export async function resolveStrict(
  conditionId: string,
  selectedTokenId: string,
  fetchMarket: MarketFetcher = fetchGammaMarketByConditionId,
): Promise<StrictResult> {
  let market: GammaMarket | null = null;
  try { market = await fetchMarket(conditionId); } catch { market = null; }
  return classifyStrict(conditionId, selectedTokenId, market);
}

export interface Identity { condition_id: string; selected_token_id: string; event_id?: string }
export const identityKey = (i: { condition_id: string; selected_token_id: string }) => `${i.condition_id}::${i.selected_token_id}`;

export async function resolveIdentities(
  ids: readonly Identity[],
  fetchMarket: MarketFetcher = fetchGammaMarketByConditionId,
  concurrency = 5,
): Promise<StrictResult[]> {
  const out: StrictResult[] = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      out[i] = await resolveStrict(ids[i].condition_id, ids[i].selected_token_id, fetchMarket);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return out;
}

export interface StrictSummary {
  SAMPLE_N: number; WIN_N: number; LOSS_N: number; OPEN_N: number;
  LOOKUP_UNAVAILABLE_N: number; INVALID_TOKEN_IDENTITY_N: number; CONDITION_ID_MISMATCH_N: number;
  REASON_COUNTS: Record<string, number>;
  INVARIANTS: Record<string, boolean>;
  STRICT_INVARIANTS_PASS: boolean;
}

export function summarize(results: readonly StrictResult[]): StrictSummary {
  const n = (l: StrictLabel) => results.filter((r) => r.label === l).length;
  const reasons: Record<string, number> = {};
  for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const terminal = results.filter((r) => r.label === "WIN" || r.label === "LOSS");
  const invariants = {
    NO_LOOKUP_FAILURE_BECAME_OPEN: results.filter((r) => r.label === "OPEN").every((r) => r.reason === "MARKET_NOT_CLOSED" && r.conditionIdMatched && r.tokenInClobTokenIds),
    NO_MISSING_TOKEN_BECAME_LOSS: results.filter((r) => r.label === "LOSS").every((r) => r.tokenInClobTokenIds),
    EVERY_WIN_LOSS_TOKEN_IN_CLOB_TOKEN_IDS: terminal.every((r) => r.tokenInClobTokenIds),
    EVERY_RETURNED_CONDITION_ID_MATCHES: results
      .filter((r) => r.reason !== "LOOKUP_NULL" && r.reason !== "NO_IDENTITY" && r.reason !== "CONDITION_ID_MISMATCH")
      .every((r) => r.conditionIdMatched),
    LABELS_EXHAUSTIVE: n("WIN") + n("LOSS") + n("OPEN") + n("LOOKUP_UNAVAILABLE") + n("INVALID_TOKEN_IDENTITY") === results.length,
  };
  return {
    SAMPLE_N: results.length, WIN_N: n("WIN"), LOSS_N: n("LOSS"), OPEN_N: n("OPEN"),
    LOOKUP_UNAVAILABLE_N: n("LOOKUP_UNAVAILABLE"), INVALID_TOKEN_IDENTITY_N: n("INVALID_TOKEN_IDENTITY"),
    CONDITION_ID_MISMATCH_N: results.filter((r) => r.reason === "CONDITION_ID_MISMATCH").length,
    REASON_COUNTS: Object.fromEntries(Object.entries(reasons).sort()),
    INVARIANTS: invariants,
    STRICT_INVARIANTS_PASS: Object.values(invariants).every(Boolean),
  };
}

// ── runner: production READ-ONLY (PostgREST GET/HEAD only), bounded to <=50 exact identities ──────────────
const RUN_ID = "f94429cb-eb8e-4607-a06d-701208b8ceb3";
const TABLE = "generated_signal_research_snapshots";
const S2 = `snapshot_run_id=eq.${RUN_ID}&diagnostics->>providerSportFamily=eq.soccer&diagnostics->scoreObservation->>sourceLineage=eq.S2_WIDE_SCORER&event_id=not.is.null&event_id=neq.`;
const BATCH_SIZE = 50;
const OUT = "modeling/evidence/step4c-label-closure-v1";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function rest(path: string, headers: Record<string, string> = {}, method = "GET") {
  const url = process.env.SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (method !== "GET" && method !== "HEAD") throw new Error("PRODUCTION_WRITE_FORBIDDEN");
  const res = await fetch(`${url}/rest/v1/${TABLE}?${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers } });
  if (!res.ok && res.status !== 206) throw new Error(`REST_${res.status}`);
  return res;
}

async function main() {
  const ref = new URL(process.env.SUPABASE_URL ?? "https://x").hostname.split(".")[0];
  if (ref !== "nbnldzfsxffztsfrrxqy") { console.log("ENVIRONMENT_MISMATCH_PRODUCTION_DB_UNAVAILABLE"); process.exit(2); }
  let rawRows = 0, gammaLookups = 0;
  const count = async (extra = "") => {
    const r = await rest(`select=condition_id&${S2}${extra}`, { Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" }, "HEAD");
    return Number((r.headers.get("content-range") ?? "").split("/")[1]);
  };
  const s2N = await count();
  const nonEmptyN = await count("&condition_id=neq.&selected_token_id=neq.");
  // frozen sample: outcome-blind deterministic ordering, columns are identity only
  const r = await rest(`select=condition_id,selected_token_id,event_id&${S2}&order=condition_id.asc,selected_token_id.asc&limit=${BATCH_SIZE}`);
  const rows = (await r.json()) as Identity[];
  rawRows += rows.length;
  const sample = rows.map((x) => ({ condition_id: x.condition_id, selected_token_id: x.selected_token_id, event_id: x.event_id! }));
  const membershipSha = sha(JSON.stringify(sample));
  // keyset probe: prove next page is reachable from the last sample key (1 row)
  const last = sample[sample.length - 1];
  const kp = await rest(`select=condition_id,selected_token_id&${S2}&or=(condition_id.gt.${last.condition_id},and(condition_id.eq.${last.condition_id},selected_token_id.gt.${last.selected_token_id}))&order=condition_id.asc,selected_token_id.asc&limit=1`);
  const kpRows = (await kp.json()) as Identity[];
  rawRows += kpRows.length;

  mkdirSync(OUT, { recursive: true });
  const put = (f: string, o: unknown) => writeFileSync(`${OUT}/${f}`, typeof o === "string" ? o : JSON.stringify(o, null, 2) + "\n");
  put("SAMPLE_MEMBERSHIP.json", { NOT_EXECUTION_AUTHORITY: true, FROZEN_BEFORE_RESOLUTION: true, SNAPSHOT_RUN_ID: RUN_ID, SAMPLE_RULE: "S2 identities ORDER BY condition_id ASC, selected_token_id ASC LIMIT 50; identity columns only, no settlement field", SAMPLE_N: sample.length, MEMBERSHIP_SHA256: membershipSha, IDENTITIES: sample });

  const t0 = Date.now();
  // one Gamma lookup per exact identity; the reversed-order pass re-classifies the cached responses
  const cache = new Map<string, Promise<GammaMarket | null>>();
  const cached: MarketFetcher = (cid) => {
    if (!cache.has(cid)) { gammaLookups++; cache.set(cid, fetchGammaMarketByConditionId(cid)); }
    return cache.get(cid)!;
  };
  const fwd = await resolveIdentities(sample, cached);
  const rev = await resolveIdentities([...sample].reverse(), cached);
  const s = summarize(fwd), sr = summarize(rev);
  const reversedSame = ["WIN_N", "LOSS_N", "OPEN_N", "LOOKUP_UNAVAILABLE_N", "INVALID_TOKEN_IDENTITY_N", "CONDITION_ID_MISMATCH_N"].every((k) => (s as any)[k] === (sr as any)[k]);
  put("SAMPLE_RESULTS.json", { NOT_EXECUTION_AUTHORITY: true, MEMBERSHIP_SHA256: membershipSha, ...s, REVERSED_INPUT_SAME_LABEL_COUNTS: reversedSame, REVERSED_COUNTS: { WIN_N: sr.WIN_N, LOSS_N: sr.LOSS_N, OPEN_N: sr.OPEN_N, LOOKUP_UNAVAILABLE_N: sr.LOOKUP_UNAVAILABLE_N, INVALID_TOKEN_IDENTITY_N: sr.INVALID_TOKEN_IDENTITY_N }, RESOLVED_AT_ISO_NOTE: "labels are point-in-time provider state; OPEN may later become WIN/LOSS", RESULTS: fwd.map((x) => ({ condition_id: x.conditionId, selected_token_id: x.selectedTokenId, label: x.label, reason: x.reason })), ELAPSED_MS: Date.now() - t0 });

  const totalBatches = Math.ceil(s2N / BATCH_SIZE);
  const retrievable = s2N === 3276 && nonEmptyN === s2N && kpRows.length === 1;
  put("BATCH_PLAN.json", { NOT_EXECUTION_AUTHORITY: true, SNAPSHOT_RUN_ID: RUN_ID, S2_IDENTITY_N: s2N, NON_EMPTY_IDENTITY_N: nonEmptyN, BATCH_SIZE, TOTAL_BATCH_N_REQUIRED: totalBatches, LAST_BATCH_SIZE: s2N - (totalBatches - 1) * BATCH_SIZE, BATCH_1: "frozen sample membership (ranks 1..50)", KEYSET_RULE: "order by (condition_id, selected_token_id) ASC; next page = rows strictly greater than the previous page's last key; UNIQUE(snapshot_run_id, condition_id, selected_token_id) makes the order total", KEYSET_PROBE_ROWS_RETURNED: kpRows.length, IDENTITIES_RETRIEVABLE_DETERMINISTICALLY: retrievable, GAMMA_LOOKUPS_PER_BATCH_MAX: BATCH_SIZE, TOTAL_GAMMA_LOOKUPS_FULL_CLOSURE: s2N, REMAINING_BATCHES_EXECUTED: 0 });
  put("LABEL_CONTRACT.json", { NOT_EXECUTION_AUTHORITY: true, RESEARCH_ONLY: true, IDENTITY: "condition_id + selected_token_id", LABELS: ["WIN", "LOSS", "OPEN", "LOOKUP_UNAVAILABLE", "INVALID_TOKEN_IDENTITY"], RULES: { A: "returned conditionId must equal requested; else LOOKUP_UNAVAILABLE/CONDITION_ID_MISMATCH", B: "selected_token_id must be in clobTokenIds; else INVALID_TOKEN_IDENTITY, never LOSS", C: "WIN iff selected token is the single winning token; LOSS iff selected token valid and opposite token wins; OPEN iff matched market not closed", D: "null lookup, malformed response, closed without single >=0.99 winner => LOOKUP_UNAVAILABLE; never OPEN, never inferred" }, REUSES: ["fetchGammaMarketByConditionId (Gamma + CLOB fallback)", "resolveProviderMarketWinner"], PRODUCTION_RESOLVER_MODIFIED: false });

  console.log(JSON.stringify({ s2N, nonEmptyN, rawRows, gammaLookups, sampleN: s.SAMPLE_N, ...{ WIN: s.WIN_N, LOSS: s.LOSS_N, OPEN: s.OPEN_N, LOOKUP: s.LOOKUP_UNAVAILABLE_N, INVALID: s.INVALID_TOKEN_IDENTITY_N, MISMATCH: s.CONDITION_ID_MISMATCH_N }, inv: s.INVARIANTS, pass: s.STRICT_INVARIANTS_PASS, reversedSame, reasons: s.REASON_COUNTS, totalBatches, retrievable }));
  writeFileSync(`${OUT}/RUN_COUNTERS.json`, JSON.stringify({ RAW_DB_ROWS_READ_N: rawRows, GAMMA_LOOKUP_N: gammaLookups, PRODUCTION_WRITES: 0 }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
