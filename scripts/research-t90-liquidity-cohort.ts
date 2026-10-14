// Research-only runner for EXECUTABLE_LIQUIDITY_COHORT_T90_V1. Reads the Research DBClone with GET requests and explicit
// projections only, reads Polymarket Gamma/CLOB (public, unauthenticated), and writes ONE local JSON receipt.
// It never writes to any database, never places orders and never touches Production.
//   npm run research-clone:t90-liquidity-cohort -- --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import {
  APPROVED_SCORED_FORMULA, buildExecutableLiquidityCohort, COHORT_HORIZON_HOURS, COHORT_PRICE_CAP, COHORT_STAKE_USD, COHORT_VERSION, countReasons,
  NOT_PROVEN, OTHER_QUOTA_T90, sha256, SOCCER_QUOTA_T90, TENNIS_QUOTA_T90, T90_MINUTES, type SourceRow,
} from "../lib/research/executableLiquidityCohortT90";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const TABLE = "research_evidence_page_rows";
const COLUMNS = "observation_id,item_observation_id,observed_at,ingested_at,condition_id,selected_token_id,selected_outcome,metric_formula_version,provider_event_id,provider_sport_family,market_type,game_start_iso,entry_price_num,pre_event_score_num";
const PAGE = 1000;
const SLICE_HOURS = 3;
/** Source observations older than this cannot belong to an event inside the horizon with T-90 availability. */
const LOOKBACK_HOURS = 72;
const MAX_CLOCK_SKEW_MS = 5_000;

function cloneTarget() {
  const url = process.env.SUPABASE_CLONE_URL; const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== CLONE_REF) throw new Error(`REFUSING_NON_CLONE_TARGET: expected ${CLONE_REF}, got ${ref}`);
  return { base: url.replace(/\/$/, ""), key };
}

async function get(target: { base: string; key: string }, query: string, offset: number) {
  const res = await fetch(`${target.base}/rest/v1/${TABLE}?${query}`, {
    method: "GET",
    headers: { apikey: target.key, Authorization: `Bearer ${target.key}`, Range: `${offset}-${offset + PAGE - 1}`, "Range-Unit": "items" },
  });
  if (!res.ok) throw new Error(`CLONE_READ_${res.status}`);
  const serverDate = res.headers.get("date");
  return { rows: (await res.json()) as SourceRow[], serverMs: serverDate ? Date.parse(serverDate) : NaN, localMs: Date.now() };
}

async function readSource() {
  const target = cloneTarget();
  // DB-side clock: the clone API server's Date header on a first (cheap) read; compared with the local clock.
  const probe = await get(target, `select=observation_id&observed_at=gte.${new Date(Date.now() - 3_600_000).toISOString()}&limit=1`, 0);
  if (!Number.isFinite(probe.serverMs)) throw new Error("DB_SERVER_TIME_UNAVAILABLE");
  if (Math.abs(probe.serverMs - probe.localMs) > MAX_CLOCK_SKEW_MS) throw new Error("CLOCK_SKEW_EXCEEDS_BOUND");
  const asOfMs = probe.serverMs;
  const from = asOfMs - LOOKBACK_HOURS * 3_600_000;
  const startMin = new Date(asOfMs + T90_MINUTES * 60_000).toISOString();
  const startMax = new Date(asOfMs + COHORT_HORIZON_HOURS * 3_600_000).toISOString();
  const rows: SourceRow[] = [];
  for (let t = from; t < asOfMs; t += SLICE_HOURS * 3_600_000) {
    const lo = new Date(t).toISOString(); const hi = new Date(Math.min(t + SLICE_HOURS * 3_600_000, asOfMs + 1)).toISOString();
    for (let offset = 0; ; offset += PAGE) {
      const q = `select=${COLUMNS}&metric_formula_version=eq.${APPROVED_SCORED_FORMULA}&observed_at=gte.${lo}&observed_at=lt.${hi}`
        + `&game_start_iso=gt.${startMin}&game_start_iso=lte.${startMax}&order=observed_at.asc,observation_id.asc,item_observation_id.asc`;
      const page = await get(target, q, offset);
      rows.push(...page.rows);
      if (page.rows.length < PAGE) break;
    }
  }
  return { asOfMs, rows };
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (!outDir) throw new Error("--out <dir> is required (receipt contains live prospective identities; never commit it)");
  const result = await buildExecutableLiquidityCohort({ readSource });
  const { selection } = result;
  const selected = selection.selected.map((s, i) => ({
    sport: s.event.sportFamily, bucket: s.bucket, sport_rank: s.sportRank,
    physical_event_id: s.event.physicalEventId, provider_event_id: s.event.providerEventId, provider_game_id: s.event.providerGameId,
    event_start_at: s.event.eventStartIso, minutes_to_start_at_asof: Math.round((Date.parse(s.event.eventStartIso) - result.asOfMs) / 600) / 100,
    condition_id: s.event.conditionId, selected_token_id: s.event.tokenId, opposite_token_id: s.event.oppositeTokenId, outcome: s.event.outcome,
    market_type: s.event.providerMarketType,
    source: { observation_id: s.event.observationId, item_observation_id: s.event.itemObservationId, observed_at: s.event.observedAt, ingested_at: s.event.ingestedAt, formula: APPROVED_SCORED_FORMULA, score: s.event.score, entry_price: s.event.entryPrice },
    book: { ...s.event.book, quote_completed_at: s.event.book.quoteCompletedAtMs ? new Date(s.event.book.quoteCompletedAtMs).toISOString() : null },
    taker_fee: (() => { const f = result.fees[i]; return f.ok ? { state: "KNOWN", rate: f.takerRate, formula: f.formulaVersion } : { state: "UNKNOWN", reason: f.errorCode }; })(),
  }));
  const receipt = {
    version: COHORT_VERSION, research_only: true, is_virtual_bet: false,
    as_of_db_server: new Date(result.asOfMs).toISOString(), generated_local: new Date().toISOString(),
    authority: { quotas: [SOCCER_QUOTA_T90, TENNIS_QUOTA_T90, OTHER_QUOTA_T90], stake_usd: COHORT_STAKE_USD, price_cap: COHORT_PRICE_CAP, horizon_hours: COHORT_HORIZON_HOURS, t90_minutes: T90_MINUTES, not_proven: NOT_PROVEN },
    funnel: { source_rows: result.sourceRowN, source_conditions_after_causal_reduction: result.reducedCandidateN, provider_confirmed: result.providerConfirmedN, book_evaluated: result.evaluated.length },
    diagnostics: selection.diagnostics, rejection_reasons: countReasons(result.rejected),
    cohort_hash: sha256(selected.map((s) => [s.sport, s.sport_rank, s.physical_event_id, s.condition_id, s.selected_token_id, s.book.askDepthUsd])),
    selected,
  };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `t90-liquidity-cohort-${receipt.as_of_db_server.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ file, as_of_db_server: receipt.as_of_db_server, funnel: receipt.funnel, diagnostics: receipt.diagnostics, rejection_reasons: receipt.rejection_reasons, cohort_hash: receipt.cohort_hash }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
