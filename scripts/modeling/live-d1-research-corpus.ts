/**
 * RESEARCH_CORPUS_FACTORY_LIVE_DELIVERY_V1 — live D-1 compact research corpus.
 *
 * Reads ONE fully-closed Europe/Minsk D-1 window from the RESEARCH CLONE ONLY
 * (project ref nppznoujvnyjargjkmnv), materializes the frozen
 * COMPACT_RESEARCH_MATERIALIZER_V1 corpus, attaches the Gamma-authoritative
 * label layer, and writes one immutable local artifact:
 *
 *   modeling/evidence/research-corpus-factory-live-v1/
 *     CORPUS_<D-1>.jsonl.gz     — compact rows, deterministic order
 *     MANIFEST_<D-1>.json       — provenance + counts (UNIT + SOURCE_STAGE)
 *     SHA256SUMS.txt
 *
 * Bounded reads only (keyset on (created_at,id) / (snapshot_at,id)); no full
 * table scan; production primary is NEVER read. Gamma/CLOB public APIs are the
 * settlement authority; clone signal_result is diagnostic only.
 *
 *   railway run --service research-clone-daily-sync \
 *     npx tsx scripts/modeling/live-d1-research-corpus.ts [--d1 YYYY-MM-DD]
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildCompactCorpus,
  type CompactCorpusSlice,
} from "@/lib/modeling/forward-rich/compactCorpus";
import type {
  ForwardRichSignalPair,
  ForwardRichSnapshotObservation,
  GammaTerminalState,
  PopulationId,
} from "@/lib/modeling/forward-rich/types";
import {
  fetchGammaMarketByConditionId,
  resolveSignalOutcome,
} from "@/lib/feed/resolveSignalOutcome";

const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const OUT_DIR = "modeling/evidence/research-corpus-factory-live-v1";
const MINSK_OFFSET_HOURS = 3; // Europe/Minsk = UTC+3 year-round (no DST since 2011)
const OBS_LOOKBACK_DAYS = 30;
const PAGE = 1000;
const CID_CHUNK = 150;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
type Row = Record<string, unknown>;
function obj(v: unknown): Row {
  return v && typeof v === "object" ? (v as Row) : {};
}
function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Latest fully-closed Minsk D-1 date given a wall clock (defaults to now). */
function resolveD1(explicit?: string): string {
  if (explicit) return explicit;
  const now = new Date();
  const minskNow = new Date(now.getTime() + MINSK_OFFSET_HOURS * 3600_000);
  const minskMidnightUtcMs =
    Date.UTC(
      minskNow.getUTCFullYear(),
      minskNow.getUTCMonth(),
      minskNow.getUTCDate(),
    ) - MINSK_OFFSET_HOURS * 3600_000;
  const d1 = new Date(minskMidnightUtcMs - 24 * 3600_000);
  const minskD1 = new Date(d1.getTime() + MINSK_OFFSET_HOURS * 3600_000);
  return minskD1.toISOString().slice(0, 10);
}

function minskWindow(d1: string): { startUtc: string; endUtc: string } {
  const startUtcMs = Date.parse(`${d1}T00:00:00.000Z`) - MINSK_OFFSET_HOURS * 3600_000;
  return {
    startUtc: new Date(startUtcMs).toISOString(),
    endUtc: new Date(startUtcMs + 24 * 3600_000).toISOString(),
  };
}

function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function resolveCloneClient(): { client: SupabaseClient; url: string } {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE");
    process.exit(3);
  }
  if (projectRef(url) !== EXPECTED_CLONE_REF) {
    console.error(
      `RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH: got ${projectRef(url)} expected ${EXPECTED_CLONE_REF}`,
    );
    process.exit(3);
  }
  const prod = process.env.SUPABASE_URL;
  if (prod && projectRef(prod) === projectRef(url)) {
    console.error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH: clone url equals production url");
    process.exit(3);
  }
  return {
    client: createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
    url,
  };
}

interface RawPair extends ForwardRichSignalPair {
  _createdAt: string;
  _id: string;
  _cloneSignalResultRaw: string | null;
}

const GSP_COLS =
  "id, condition_id, selected_token_id, created_at, entry_price_num, diagnostics, formula_version, signal_result, pre_event_score_num";

/**
 * Two-read (timestamp,id) keyset page — the PROVEN shape from
 * scripts/research-clone-daily-sync.ts. PostgREST's composite `or=` keyset form
 * triggers 57014 on GSP; splitting into a tie-drain + a strictly-greater advance
 * keeps both reads on the (created_at,id) index. `endUtc` is enforced by the
 * caller breaking once a page crosses it (rows arrive ascending).
 */
async function keysetPage(
  db: SupabaseClient,
  table: string,
  tsField: string,
  cols: string,
  afterTs: string,
  afterId: string,
): Promise<Row[]> {
  if (afterId) {
    const tie = await db
      .from(table)
      .select(cols)
      .eq(tsField, afterTs)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (tie.error) throw new Error(`CLONE_READ_${table}:${tie.error.code ?? ""}:${tie.error.message}`);
    if ((tie.data ?? []).length > 0) return (tie.data ?? []) as unknown as Row[];
  }
  const adv = await db
    .from(table)
    .select(cols)
    .gt(tsField, afterTs)
    .order(tsField, { ascending: true })
    .order("id", { ascending: true })
    .limit(PAGE);
  if (adv.error) throw new Error(`CLONE_READ_${table}:${adv.error.code ?? ""}:${adv.error.message}`);
  return (adv.data ?? []) as unknown as Row[];
}

/** Bounded keyset read of generated_signal_pairs over the D-1 window. */
async function readSignalPairs(
  db: SupabaseClient,
  startUtc: string,
  endUtc: string,
): Promise<{ pairs: RawPair[]; maxWatermark: string | null }> {
  const out: RawPair[] = [];
  // seed 1ms before window start so the first strictly-greater advance includes
  // any row exactly at the Minsk-midnight boundary.
  let afterCreated = new Date(Date.parse(startUtc) - 1).toISOString();
  let afterId = "";
  let maxWatermark: string | null = null;

  for (let guard = 0; guard < 1000; guard++) {
    const chunk = await keysetPage(
      db,
      "generated_signal_pairs",
      "created_at",
      GSP_COLS,
      afterCreated,
      afterId,
    );
    if (chunk.length === 0) break;
    if (String(obj(chunk[0]).created_at) >= endUtc) break;

    let crossed = false;
    for (const raw of chunk) {
      if (String(obj(raw).created_at) >= endUtc) {
        crossed = true;
        break;
      }
      const r = obj(raw);
      const d = obj(r.diagnostics);
      const createdAt = String(r.created_at);
      const id = String(r.id);
      maxWatermark = `${createdAt}|${id}`;
      const cid = str(r.condition_id);
      const tok = str(r.selected_token_id);
      out.push({
        _createdAt: createdAt,
        _id: id,
        conditionId: cid ?? "",
        selectedTokenId: tok ?? "",
        decisionAt: createdAt,
        sourceCreatedAt: createdAt,
        entryPriceNum: num(r.entry_price_num),
        volumeUsd: num(d.volumeUsd),
        eventStartIso: str(d.gameStartIso),
        providerEventId: str(d.providerEventId),
        marketTypeRaw: str(d.marketType),
        marketFamily: str(d.marketFamily),
        providerSportCode: str(d.providerSportCode),
        providerSportFamily: str(d.providerSportFamily),
        formulaVersion: str(r.formula_version),
        preEventScoreNum: num(r.pre_event_score_num),
        gammaTerminal: null,
        cloneSignalResult: str(r.signal_result),
        _cloneSignalResultRaw: str(r.signal_result),
      });
    }
    if (crossed) break;
    if (chunk.length < PAGE) break;
    const last = obj(chunk[chunk.length - 1]);
    afterCreated = String(last.created_at);
    afterId = String(last.id);
  }
  return { pairs: out, maxWatermark };
}

/** Bounded read of GSRS observations for the seen identities only. */
async function readObservations(
  db: SupabaseClient,
  conditionIds: string[],
  floorUtc: string,
  endUtc: string,
): Promise<ForwardRichSnapshotObservation[]> {
  const out: ForwardRichSnapshotObservation[] = [];
  for (let i = 0; i < conditionIds.length; i += CID_CHUNK) {
    const slice = conditionIds.slice(i, i + CID_CHUNK);
    const cols =
      "id, condition_id, selected_token_id, snapshot_at, created_at, snapshot_run_id, selected_price_num, opposing_price_num, event_id, game_start_iso, data_coverage_num, diagnostics";
    let afterSnap = new Date(Date.parse(floorUtc) - 1).toISOString();
    let afterId = "";
    for (let guard = 0; guard < 2000; guard++) {
      let chunk: Row[] = [];
      if (afterId) {
        const tie = await db
          .from("generated_signal_research_snapshots")
          .select(cols)
          .in("condition_id", slice)
          .eq("snapshot_at", afterSnap)
          .gt("id", afterId)
          .order("id", { ascending: true })
          .limit(PAGE);
        if (tie.error)
          throw new Error(`CLONE_READ_generated_signal_research_snapshots:${tie.error.code ?? ""}:${tie.error.message}`);
        chunk = (tie.data ?? []) as Row[];
      }
      if (chunk.length === 0) {
        const adv = await db
          .from("generated_signal_research_snapshots")
          .select(cols)
          .in("condition_id", slice)
          .gt("snapshot_at", afterSnap)
          .order("snapshot_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(PAGE);
        if (adv.error)
          throw new Error(`CLONE_READ_generated_signal_research_snapshots:${adv.error.code ?? ""}:${adv.error.message}`);
        chunk = (adv.data ?? []) as Row[];
      }
      if (chunk.length === 0) break;
      if (String(obj(chunk[0]).snapshot_at) >= endUtc) break;
      let crossed = false;
      for (const raw of chunk) {
        if (String(obj(raw).snapshot_at) >= endUtc) { crossed = true; break; }
        const r = obj(raw);
        const d = obj(r.diagnostics);
        const so = obj(d.scoreObservation);
        const fireModel = obj(d.fireModel);
        const modelCandidate = obj(fireModel.modelCandidate);
        out.push({
          conditionId: String(r.condition_id),
          selectedTokenId: String(r.selected_token_id),
          snapshotAt: String(r.snapshot_at),
          sourceCreatedAt: str(r.created_at) ?? String(r.snapshot_at),
          snapshotRunId: str(r.snapshot_run_id),
          scoreValue:
            num(so.scoreValue) ?? num(d.formulaScore) ?? num(modelCandidate.score),
          scoreMetricFormulaVersion:
            str(so.metricFormulaVersion) ?? str(fireModel.formulaVersion),
          selectedPriceNum: num(r.selected_price_num),
          opposingPriceNum: num(r.opposing_price_num),
          providerEventId: str(r.event_id),
          gameStartIso: str(r.game_start_iso),
          dataCoverageNum: num(r.data_coverage_num),
        });
      }
      if (crossed) break;
      if (chunk.length < PAGE) break;
      const last = obj(chunk[chunk.length - 1]);
      afterSnap = String(last.snapshot_at);
      afterId = String(last.id);
    }
  }
  return out;
}

/** Gamma/CLOB settlement authority, per market (condition_id). */
async function resolveGammaTerminal(
  conditionId: string,
  selectedTokenId: string,
  entryPriceNum: number | null,
): Promise<{ terminal: GammaTerminalState | null; resolverState: string }> {
  if (!conditionId || !selectedTokenId) return { terminal: null, resolverState: "no_identity" };
  const market = await fetchGammaMarketByConditionId(conditionId);
  const r = resolveSignalOutcome({ conditionId, selectedTokenId, entryPriceNum, market });
  if (r.resolverState === "resolved_candidate" && r.signalResult === "won") {
    return { terminal: "WIN", resolverState: r.resolverState };
  }
  if (r.resolverState === "resolved_candidate" && r.signalResult === "lost") {
    return { terminal: "LOSS", resolverState: r.resolverState };
  }
  // closed_unknown / active_unresolved / lookup_failed / invalid_snapshot -> OPEN
  return { terminal: null, resolverState: r.resolverState };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function canonicalRow(row: Record<string, unknown>): string {
  // stable key order — deterministic canonical content
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Row)
          .sort()
          .map((k) => [k, sortKeys((v as Row)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(row));
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const d1 = resolveD1(arg("--d1"));
  const { startUtc, endUtc } = minskWindow(d1);
  if (Date.parse(endUtc) > Date.now()) {
    console.error(`D1_WINDOW_NOT_CLOSED: ${d1} window ends ${endUtc} which is in the future`);
    process.exit(4);
  }
  const { client: db, url } = resolveCloneClient();
  const sourceProject = projectRef(url);

  const { pairs, maxWatermark } = await readSignalPairs(db, startUtc, endUtc);
  const rawRowN = pairs.length;

  const conditionIds = Array.from(
    new Set(pairs.map((p) => p.conditionId).filter(Boolean)),
  );
  const floorUtc = new Date(
    Date.parse(startUtc) - OBS_LOOKBACK_DAYS * 24 * 3600_000,
  ).toISOString();
  const observations = conditionIds.length
    ? await readObservations(db, conditionIds, floorUtc, endUtc)
    : [];

  // ── Gamma settlement authority (public API), per unique identity ──────────
  const identities = Array.from(
    new Map(
      pairs
        .filter((p) => p.conditionId && p.selectedTokenId)
        .map((p) => [
          `${p.conditionId}::${p.selectedTokenId}`,
          {
            conditionId: p.conditionId,
            selectedTokenId: p.selectedTokenId,
            entryPriceNum: p.entryPriceNum,
          },
        ]),
    ).values(),
  );
  const gammaResults = await mapWithConcurrency(identities, 8, (id) =>
    resolveGammaTerminal(id.conditionId, id.selectedTokenId, id.entryPriceNum),
  );
  const gammaByIdentity = new Map<string, GammaTerminalState | null>();
  const resolverStateCounts: Record<string, number> = {};
  identities.forEach((id, i) => {
    const g = gammaResults[i];
    gammaByIdentity.set(`${id.conditionId}::${id.selectedTokenId}`, g.terminal);
    resolverStateCounts[g.resolverState] = (resolverStateCounts[g.resolverState] ?? 0) + 1;
  });
  for (const p of pairs) {
    p.gammaTerminal =
      gammaByIdentity.get(`${p.conditionId}::${p.selectedTokenId}`) ?? null;
  }

  // ── frozen compact materializer (pure) ──────────────────────────────────
  const slice: CompactCorpusSlice = {
    sliceDateUtc: d1,
    sinceCutoff: startUtc,
    materializedAt: runStartedAt,
    signalPairs: pairs.map((p) => {
      const { _createdAt, _id, _cloneSignalResultRaw, ...clean } = p;
      return clean;
    }),
    observations,
  };
  const corpus = buildCompactCorpus(slice);
  const rows = corpus.rows;

  // ── PIT leak check (hard) ──────────────────────────────────────────────
  let pitFutureLeakN = 0;
  for (const r of rows) {
    for (const s of [r.score, r.selectedPrice]) {
      if (s.lastEligibleObservedAt !== null && s.lastEligibleObservedAt > r.decisionAt) {
        pitFutureLeakN++;
      }
    }
  }

  // ── population counts (UNIT: compact rows; SOURCE_STAGE: OUTPUT_COMPACT) ─
  const popRowCounts: Record<string, number> = {};
  const popEventCounts: Record<string, Set<string>> = {};
  const popLabelCounts: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    popRowCounts[r.populationId] = (popRowCounts[r.populationId] ?? 0) + 1;
    (popEventCounts[r.populationId] ??= new Set()).add(r.providerEventId || r.conditionId);
    ((popLabelCounts[r.populationId] ??= {})[r.label] =
      (popLabelCounts[r.populationId]?.[r.label] ?? 0) + 1);
  }

  const settledN = rows.filter((r) => ["WIN", "LOSS", "VOID"].includes(r.label)).length;
  const openN = rows.filter((r) => r.label === "OPEN").length;
  const noMatchN = rows.filter((r) => r.label === "NO_MATCH").length;

  // ── physical-event census — ONE canonical identity rule, both stages ────
  // RESEARCH_CORPUS_CONTRACT.md §2: physical event identity = provider_event_id
  // (== Gamma event.id). Applied identically to INPUT_RAW and OUTPUT_COMPACT.
  // This is a per-stage CENSUS, never a compression funnel: OUTPUT can exceed
  // INPUT because provider_event_id is enriched from GSRS event_id for
  // identities that carried only condition_id at the GSP stage.
  const inputProviderEventIds = new Set(
    pairs.map((p) => p.providerEventId).filter((v): v is string => !!v),
  );
  const inputUnresolvedProviderEventIdN = pairs.filter((p) => !p.providerEventId).length;
  const outputProviderEventIds = new Set(
    rows.map((r) => r.providerEventId).filter((v): v is string => !!v),
  );
  const outputUnresolvedProviderEventIdN = rows.filter((r) => !r.providerEventId).length;

  // ── artifact ───────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  // Immutability: a previously accepted D-1 artifact is never overwritten with
  // newer Gamma settlement state. Re-emit only with an explicit --force-rebuild.
  if (statExists(join(OUT_DIR, `MANIFEST_${d1}.json`)) && !process.argv.includes("--force-rebuild")) {
    console.error(
      `D1_ARTIFACT_ALREADY_ACCEPTED: ${d1} manifest exists and is immutable AS-OF its label-evidence time. ` +
        `Refusing to overwrite (pass --force-rebuild only to build a NEW dated as-of artifact).`,
    );
    process.exit(5);
  }
  const jsonl =
    rows.map((r) => canonicalRow(r as unknown as Record<string, unknown>)).join("\n") +
    (rows.length ? "\n" : "");
  const canonicalContentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");
  const gz = gzipSync(Buffer.from(jsonl, "utf8"), { level: 9 });
  const corpusPath = join(OUT_DIR, `CORPUS_${d1}.jsonl.gz`);
  writeFileSync(corpusPath, gz);
  const artifactBytes = statSync(corpusPath).size;
  const rawUncompressedBytes = Buffer.byteLength(jsonl, "utf8");

  const manifest = {
    CORPUS_SCHEMA_VERSION: "research-corpus-factory-live-v1",
    MISSION: "RESEARCH_CORPUS_D1_FREEZE_RELEASE_V1",
    GENERATED_AT: runStartedAt,

    AS_OF_MODEL: "IMMUTABLE_AS_OF",
    ARTIFACT_IMMUTABLE: true,
    LABEL_EVIDENCE_AS_OF: {
      value: runStartedAt,
      unit: "ISO-8601 UTC instant",
      meaning:
        "Gamma/CLOB terminal state was queried as of this instant. Settlement may legitimately evolve later; a future rerun of the same D-1 date is NOT required to reproduce this label hash and MUST NOT overwrite this artifact.",
    },
    DETERMINISM_MODEL:
      "fixed captured clone inputs -> pure compact materializer -> deterministic artifact content. The pure materializer layer is proven by tests/modeling/forward-rich/compactCorpus.test.ts (16/16). The label layer is AS-OF and time-varying by design.",

    SOURCE_PROJECT: sourceProject,
    SOURCE_KIND: "RESEARCH_CLONE",
    SOURCE_WINDOW_START: { value: startUtc, unit: "ISO-8601 UTC instant", tz: "Europe/Minsk D-1 00:00" },
    SOURCE_WINDOW_END: { value: endUtc, unit: "ISO-8601 UTC instant", tz: "Europe/Minsk D 00:00" },
    SOURCE_D1_DATE_MINSK: d1,
    SOURCE_MAX_WATERMARK: {
      value: maxWatermark,
      unit: "generated_signal_pairs (created_at|id) keyset",
      source_stage: "INPUT_RAW",
    },
    OBS_LOOKBACK_FLOOR: floorUtc,

    COUNTS: [
      { name: "INPUT_RAW_ROW_N", value: rawRowN, unit: "generated_signal_pairs decision rows (repeated emissions included)", source_stage: "INPUT_RAW" },
      { name: "INPUT_OBSERVATION_ROW_N", value: observations.length, unit: "generated_signal_research_snapshots rows", source_stage: "INPUT_RAW_OBSERVATION" },
      { name: "OUTPUT_COMPACT_ROW_N", value: rows.length, unit: "compact PIT feature rows (1 per canonical identity)", source_stage: "OUTPUT_COMPACT" },
      { name: "PIT_FUTURE_LEAK_N", value: pitFutureLeakN, unit: "compact rows with an eligible observation after DECISION_AT", source_stage: "OUTPUT_COMPACT" },
      { name: "SETTLED_N", value: settledN, unit: "compact rows with Gamma terminal label WIN|LOSS|VOID", source_stage: "OUTPUT_COMPACT_LABEL" },
      { name: "OPEN_N", value: openN, unit: "compact rows with label OPEN (no Gamma terminal state)", source_stage: "OUTPUT_COMPACT_LABEL" },
      { name: "NO_MATCH_N", value: noMatchN, unit: "compact rows with label NO_MATCH (broken identity)", source_stage: "OUTPUT_COMPACT_LABEL" },
    ],

    POPULATIONS: Object.keys(popRowCounts)
      .sort()
      .map((pop) => ({
        population_id: pop,
        COMPACT_ROW_N: { value: popRowCounts[pop], unit: "compact rows", source_stage: "OUTPUT_COMPACT" },
        COMPACT_PHYSICAL_EVENT_N: { value: popEventCounts[pop].size, unit: "distinct provider_event_id", source_stage: "OUTPUT_COMPACT" },
        LABEL_COUNTS: { value: popLabelCounts[pop], unit: "compact rows by label", source_stage: "OUTPUT_COMPACT_LABEL" },
      })),
    POPULATION_POOLING: "FORBIDDEN — counts above are per population_id and are never summed across populations",

    // Monotonic reductions only — genuine before/after with a shared denominator.
    COMPRESSION_EVIDENCE: {
      ROWS: {
        UNIT: "rows",
        SOURCE_STAGE: "INPUT_RAW -> OUTPUT_COMPACT",
        INPUT_DENOMINATOR: rawRowN,
        OUTPUT_DENOMINATOR: rows.length,
        ratio: rows.length ? Math.round((rawRowN / rows.length) * 10000) / 10000 : 0,
        note: "raw generated_signal_pairs decision rows (repeated emissions) collapsed to one first-eligible compact row per canonical identity",
      },
      BYTES: {
        UNIT: "bytes",
        SOURCE_STAGE: "canonical JSONL -> gzip -9 artifact on disk",
        INPUT_DENOMINATOR: rawUncompressedBytes,
        OUTPUT_DENOMINATOR: artifactBytes,
        ratio: artifactBytes ? Math.round((rawUncompressedBytes / artifactBytes) * 100) / 100 : 0,
      },
    },

    // Per-stage CENSUS, NOT a funnel. Same canonical identity rule both sides.
    PHYSICAL_EVENT_CENSUS: {
      UNIT: "distinct provider_event_id (== Gamma event.id)",
      IDENTITY_RULE: "RESEARCH_CORPUS_CONTRACT.md §2 — provider_event_id only; rows with no provider_event_id are counted separately as UNRESOLVED, never folded in via a condition_id fallback",
      INPUT_RAW: {
        SOURCE_STAGE: "INPUT_RAW",
        DENOMINATOR: inputProviderEventIds.size,
        UNRESOLVED_PROVIDER_EVENT_ID_ROWS: inputUnresolvedProviderEventIdN,
      },
      OUTPUT_COMPACT: {
        SOURCE_STAGE: "OUTPUT_COMPACT",
        DENOMINATOR: outputProviderEventIds.size,
        UNRESOLVED_PROVIDER_EVENT_ID_ROWS: outputUnresolvedProviderEventIdN,
      },
      NOTE: "OUTPUT_COMPACT.DENOMINATOR may exceed INPUT_RAW.DENOMINATOR because the pure materializer enriches provider_event_id from GSRS event_id for identities that carried only condition_id at the generated_signal_pairs stage. This is identity resolution, not new physical events, and is not presented as compression.",
    },

    ARTIFACT_BYTES: { value: artifactBytes, unit: "bytes (CORPUS_<d1>.jsonl.gz on disk)" },
    CANONICAL_CONTENT_SHA256: canonicalContentSha256,
    CANONICAL_CONTENT_DEFINITION:
      "sha256(utf8) of the newline-joined canonical (sorted-key) JSON of every compact row in deterministic materializer order; independent of gzip framing",

    SETTLEMENT_AUTHORITY: "Gamma/CLOB public terminal state only; clone signal_result recorded per-row as cloneSignalResult cross-check, never promoted",
    GAMMA_RESOLVER_STATE_COUNTS: resolverStateCounts,
    PRODUCTION_PRIMARY_READS: 0,
    PRODUCTION_WRITES: 0,
  };

  const manifestPath = join(OUT_DIR, `MANIFEST_${d1}.json`);
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(manifestPath, manifestJson);
  writeFileSync(
    join(OUT_DIR, `SHA256SUMS_${d1}.txt`),
    [
      `${canonicalContentSha256}  CANONICAL_CONTENT`,
      `${createHash("sha256").update(gz).digest("hex")}  CORPUS_${d1}.jsonl.gz`,
      `${createHash("sha256").update(manifestJson, "utf8").digest("hex")}  MANIFEST_${d1}.json`,
    ].join("\n") + "\n",
  );

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        d1,
        window: { startUtc, endUtc },
        INPUT_RAW_ROW_N: rawRowN,
        OUTPUT_COMPACT_ROW_N: rows.length,
        PHYSICAL_EVENT_CENSUS: {
          INPUT_RAW_provider_event_id: inputProviderEventIds.size,
          OUTPUT_COMPACT_provider_event_id: outputProviderEventIds.size,
        },
        PIT_FUTURE_LEAK_N: pitFutureLeakN,
        SETTLED_N: settledN,
        OPEN_N: openN,
        NO_MATCH_N: noMatchN,
        populationRowCounts: popRowCounts,
        CANONICAL_CONTENT_SHA256: canonicalContentSha256,
        ARTIFACT_BYTES: artifactBytes,
        corpusPath,
        manifestPath,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
