/**
 * RESEARCH_CORPUS_D1_FREEZE_RELEASE_V1 — re-emit the manifest for an ALREADY
 * PRODUCED, immutable D-1 corpus artifact WITHOUT touching the clone or Gamma.
 *
 * Input:  modeling/evidence/research-corpus-factory-live-v1/CORPUS_<d1>.jsonl.gz
 *         (+ the prior MANIFEST_<d1>.json for the frozen source-window / AS-OF
 *          provenance that cannot be recomputed from rows).
 * Output: a corrected MANIFEST_<d1>.json + SHA256SUMS_<d1>.txt.
 *
 * Corpus rows are NEVER changed. CANONICAL_CONTENT_SHA256 is recomputed from the
 * frozen rows and asserted to equal the accepted hash.
 *
 *   npx tsx scripts/modeling/freeze-d1-research-corpus.ts --d1 2026-09-02 \
 *     --accepted-hash 0e06fd869462118b79138cf6741c188f2d58c551f3f8023eadbc6b18eb2d7287
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "modeling/evidence/research-corpus-factory-live-v1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const d1 = arg("--d1");
if (!d1) throw new Error("BLOCKED_MISSING_D1: pass --d1 YYYY-MM-DD");
const acceptedHash = arg("--accepted-hash") ?? null;

const corpusPath = join(OUT_DIR, `CORPUS_${d1}.jsonl.gz`);
const priorManifestPath = join(OUT_DIR, `MANIFEST_${d1}.json`);

const gz = readFileSync(corpusPath);
const jsonl = gunzipSync(gz).toString("utf8");
const canonicalContentSha256 = createHash("sha256").update(jsonl, "utf8").digest("hex");
if (acceptedHash && canonicalContentSha256 !== acceptedHash) {
  throw new Error(
    `FROZEN_ARTIFACT_HASH_MISMATCH: recomputed ${canonicalContentSha256} != accepted ${acceptedHash}`,
  );
}

interface CompactRow {
  populationId: string;
  conditionId: string;
  selectedTokenId: string;
  providerEventId: string | null;
  decisionAt: string;
  label: string;
  score: { lastEligibleObservedAt: string | null };
  selectedPrice: { lastEligibleObservedAt: string | null };
}
const rows: CompactRow[] = jsonl
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as CompactRow);

const prior = JSON.parse(readFileSync(priorManifestPath, "utf8")) as Record<string, unknown>;
const priorCounts = (prior.COUNTS as Array<{ name: string; value: number }>) ?? [];
const priorCount = (n: string) => priorCounts.find((c) => c.name === n)?.value ?? null;

// ── recomputed OUTPUT-side facts (from frozen rows only) ──────────────────
let pitFutureLeakN = 0;
for (const r of rows) {
  for (const s of [r.score, r.selectedPrice]) {
    if (s.lastEligibleObservedAt !== null && s.lastEligibleObservedAt > r.decisionAt) pitFutureLeakN++;
  }
}
const settledN = rows.filter((r) => ["WIN", "LOSS", "VOID"].includes(r.label)).length;
const openN = rows.filter((r) => r.label === "OPEN").length;
const noMatchN = rows.filter((r) => r.label === "NO_MATCH").length;

const outputProviderEventIds = new Set(
  rows.map((r) => r.providerEventId).filter((v): v is string => !!v),
);
const outputUnresolvedProviderEventIdN = rows.filter((r) => !r.providerEventId).length;

const popRowCounts: Record<string, number> = {};
const popEventIds: Record<string, Set<string>> = {};
const popUnresolved: Record<string, number> = {};
const popLabelCounts: Record<string, Record<string, number>> = {};
for (const r of rows) {
  popRowCounts[r.populationId] = (popRowCounts[r.populationId] ?? 0) + 1;
  (popEventIds[r.populationId] ??= new Set());
  if (r.providerEventId) popEventIds[r.populationId].add(r.providerEventId);
  else popUnresolved[r.populationId] = (popUnresolved[r.populationId] ?? 0) + 1;
  ((popLabelCounts[r.populationId] ??= {})[r.label] =
    (popLabelCounts[r.populationId]?.[r.label] ?? 0) + 1);
}

const rawUncompressedBytes = Buffer.byteLength(jsonl, "utf8");
const artifactBytes = statSync(corpusPath).size;

const manifest = {
  CORPUS_SCHEMA_VERSION: "research-corpus-factory-live-v1",
  MISSION: "RESEARCH_CORPUS_D1_FREEZE_RELEASE_V1",
  RELEASE_STATUS: "ACCEPTED_IMMUTABLE",

  GENERATED_AT: prior.GENERATED_AT ?? null,
  MANIFEST_FROZEN_AT: new Date().toISOString(),
  AS_OF_MODEL: "IMMUTABLE_AS_OF",
  ARTIFACT_IMMUTABLE: true,
  LABEL_EVIDENCE_AS_OF: {
    value: prior.GENERATED_AT ?? null,
    unit: "ISO-8601 UTC instant",
    meaning:
      "Gamma/CLOB terminal state was queried as of GENERATED_AT. Settlement may legitimately evolve later; a future rerun of the same D-1 date is NOT required to reproduce this label hash and MUST NOT overwrite this artifact.",
  },
  DETERMINISM_MODEL:
    "fixed captured clone inputs -> pure compact materializer -> deterministic artifact content. Pure materializer layer proven by tests/modeling/forward-rich/compactCorpus.test.ts (16/16). The label layer is AS-OF and time-varying by design.",

  SOURCE_PROJECT: prior.SOURCE_PROJECT ?? null,
  SOURCE_KIND: "RESEARCH_CLONE",
  SOURCE_WINDOW_START: prior.SOURCE_WINDOW_START ?? null,
  SOURCE_WINDOW_END: prior.SOURCE_WINDOW_END ?? null,
  SOURCE_D1_DATE_MINSK: d1,
  SOURCE_MAX_WATERMARK: prior.SOURCE_MAX_WATERMARK ?? null,
  OBS_LOOKBACK_FLOOR: prior.OBS_LOOKBACK_FLOOR ?? null,

  COUNTS: [
    { name: "INPUT_RAW_ROW_N", value: priorCount("INPUT_RAW_ROW_N"), unit: "generated_signal_pairs decision rows (repeated emissions included)", source_stage: "INPUT_RAW" },
    { name: "INPUT_OBSERVATION_ROW_N", value: priorCount("INPUT_OBSERVATION_ROW_N"), unit: "generated_signal_research_snapshots rows", source_stage: "INPUT_RAW_OBSERVATION" },
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
      COMPACT_PHYSICAL_EVENT_N: {
        value: popEventIds[pop].size,
        unit: "distinct provider_event_id (== Gamma event.id)",
        source_stage: "OUTPUT_COMPACT",
        unresolved_provider_event_id_rows: popUnresolved[pop] ?? 0,
      },
      LABEL_COUNTS: { value: popLabelCounts[pop], unit: "compact rows by label", source_stage: "OUTPUT_COMPACT_LABEL" },
    })),
  POPULATION_POOLING: "FORBIDDEN — counts are per population_id and are never summed across populations",

  COMPRESSION_EVIDENCE: {
    ROWS: {
      UNIT: "rows",
      SOURCE_STAGE: "INPUT_RAW -> OUTPUT_COMPACT",
      INPUT_DENOMINATOR: priorCount("INPUT_RAW_ROW_N"),
      OUTPUT_DENOMINATOR: rows.length,
      ratio:
        priorCount("INPUT_RAW_ROW_N") && rows.length
          ? Math.round(((priorCount("INPUT_RAW_ROW_N") as number) / rows.length) * 10000) / 10000
          : 0,
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

  PHYSICAL_EVENT_CENSUS: {
    UNIT: "distinct provider_event_id (== Gamma event.id)",
    IDENTITY_RULE:
      "RESEARCH_CORPUS_CONTRACT.md §2 — provider_event_id only; rows with no provider_event_id are counted separately as UNRESOLVED, never folded in via a condition_id fallback",
    INPUT_RAW: {
      SOURCE_STAGE: "INPUT_RAW",
      DENOMINATOR: null,
      NOTE: "not recomputable from the frozen compact artifact alone (raw generated_signal_pairs rows are not retained in the artifact); see COMPRESSION_EVIDENCE.ROWS for the denominator-consistent raw->compact reduction",
    },
    OUTPUT_COMPACT: {
      SOURCE_STAGE: "OUTPUT_COMPACT",
      DENOMINATOR: outputProviderEventIds.size,
      UNRESOLVED_PROVIDER_EVENT_ID_ROWS: outputUnresolvedProviderEventIdN,
    },
    NOTE: "Per-stage census, NOT a compression funnel. The prior manifest's 834->844 'physical events' line mixed a provider_event_id||condition_id fallback rule and is withdrawn.",
  },

  ARTIFACT_BYTES: { value: artifactBytes, unit: "bytes (CORPUS_<d1>.jsonl.gz on disk)" },
  CANONICAL_CONTENT_SHA256: canonicalContentSha256,
  CANONICAL_CONTENT_DEFINITION:
    "sha256(utf8) of the newline-joined canonical (sorted-key) JSON of every compact row in deterministic materializer order; independent of gzip framing",

  SETTLEMENT_AUTHORITY:
    "Gamma/CLOB public terminal state only; clone signal_result recorded per-row as cloneSignalResult cross-check, never promoted",
  GAMMA_RESOLVER_STATE_COUNTS: prior.GAMMA_RESOLVER_STATE_COUNTS ?? null,
  PRODUCTION_PRIMARY_READS: 0,
  PRODUCTION_WRITES: 0,
};

const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(priorManifestPath, manifestJson);
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
      RELEASE_STATUS: "ACCEPTED_IMMUTABLE",
      CANONICAL_CONTENT_SHA256: canonicalContentSha256,
      hashMatchesAccepted: acceptedHash ? canonicalContentSha256 === acceptedHash : null,
      OUTPUT_COMPACT_ROW_N: rows.length,
      PIT_FUTURE_LEAK_N: pitFutureLeakN,
      SETTLED_N: settledN,
      OPEN_N: openN,
      NO_MATCH_N: noMatchN,
      populationRowCounts: popRowCounts,
      PHYSICAL_EVENT_CENSUS_OUTPUT_provider_event_id: outputProviderEventIds.size,
    },
    null,
    2,
  ) + "\n",
);
