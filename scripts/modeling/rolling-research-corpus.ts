/**
 * ROLLING_RESEARCH_CORPUS_7D14D30D_V1 — rolling research-window interface CLI.
 *
 * Exposes the immutable D-1 research corpus partitions
 * (modeling/evidence/research-corpus-factory-live-v1/CORPUS_<date>.jsonl.gz)
 * as one logical 7 / 14 / 30 completed-Europe/Minsk-day research window.
 *
 * It NEVER duplicates partition payloads: the rolling manifest references the
 * constituent partition CANONICAL_CONTENT_SHA256 values. It NEVER overwrites an
 * accepted daily partition. When a requested closed day has no immutable
 * artifact yet, `--materialize-missing` runs the ALREADY-CANONICAL live D-1
 * materializer once (clone-only, bounded reads) via `railway run`, then freezes
 * it under the existing immutable AS-OF contract.
 *
 *   # report only (no materialization)
 *   npx tsx scripts/modeling/rolling-research-corpus.ts --window 7
 *
 *   # materialize any missing closed-day partitions from the research clone, then build
 *   railway run --service research-clone-daily-sync \
 *     npx tsx scripts/modeling/rolling-research-corpus.ts --window 7 --materialize-missing
 *
 *   # local stream read proof (no DB, no broad scan)
 *   npx tsx scripts/modeling/rolling-research-corpus.ts --window 7 --read-proof
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  buildRollingManifest,
  resolveWindowDates,
  SUPPORTED_WINDOW_DAYS,
  type LoadedPartition,
  type RollingCompactRow,
  type WindowDays,
} from "@/lib/modeling/research-corpus/rollingCorpus";

const PARTITION_DIR = "modeling/evidence/research-corpus-factory-live-v1";
const OUT_DIR = "modeling/evidence/rolling-research-corpus-v1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function partitionPaths(date: string) {
  return {
    corpus: join(PARTITION_DIR, `CORPUS_${date}.jsonl.gz`),
    manifest: join(PARTITION_DIR, `MANIFEST_${date}.json`),
    sums: join(PARTITION_DIR, `SHA256SUMS_${date}.txt`),
  };
}

function partitionExists(date: string): boolean {
  const p = partitionPaths(date);
  return existsSync(p.corpus) && existsSync(p.manifest);
}

/** Load + hash-verify one immutable D-1 partition from local disk ONLY. */
function loadPartition(date: string): LoadedPartition {
  const p = partitionPaths(date);
  const gz = readFileSync(p.corpus);
  const jsonl = gunzipSync(gz).toString("utf8");
  const canonicalHash = createHash("sha256").update(jsonl, "utf8").digest("hex");

  const manifest = JSON.parse(readFileSync(p.manifest, "utf8")) as Record<string, unknown>;
  const acceptedHash = String(manifest.CANONICAL_CONTENT_SHA256 ?? "");
  if (acceptedHash && acceptedHash !== canonicalHash) {
    throw new Error(`PARTITION_HASH_MISMATCH ${date}: recomputed ${canonicalHash} != manifest ${acceptedHash}`);
  }
  if (existsSync(p.sums)) {
    const sums = readFileSync(p.sums, "utf8");
    if (!sums.includes(canonicalHash)) {
      throw new Error(`PARTITION_SHA256SUMS_MISMATCH ${date}: canonical content hash absent from SHA256SUMS`);
    }
  }

  // ── additive Score LEVEL overlay (RESEARCH_CORPUS_SCORE_LEVEL_CORRECTION_V1) ──
  // Independently hashed; keyed by canonical corpus identity; never mutates the
  // frozen CORPUS artifact. Present for pre-correction accepted partitions; a
  // forward partition carries scoreLevel on the row itself and needs no overlay.
  const overlayGz = join(PARTITION_DIR, `SCORE_LEVEL_OVERLAY_${date}.jsonl.gz`);
  const overlayManifestPath = join(PARTITION_DIR, `SCORE_LEVEL_OVERLAY_MANIFEST_${date}.json`);
  const scoreLevelByIdentity = new Map<string, number | null>();
  let scoreLevelOverlaySha: string | null = null;
  if (existsSync(overlayGz)) {
    const ogz = readFileSync(overlayGz);
    const ojsonl = gunzipSync(ogz).toString("utf8");
    scoreLevelOverlaySha = createHash("sha256").update(ojsonl, "utf8").digest("hex");
    if (existsSync(overlayManifestPath)) {
      const om = JSON.parse(readFileSync(overlayManifestPath, "utf8")) as Record<string, unknown>;
      if (String(om.OVERLAY_CANONICAL_CONTENT_SHA256 ?? "") !== scoreLevelOverlaySha) {
        throw new Error(`SCORE_LEVEL_OVERLAY_HASH_MISMATCH ${date}`);
      }
      if (String(om.PARENT_PARTITION_CANONICAL_SHA256 ?? "") !== canonicalHash) {
        throw new Error(`SCORE_LEVEL_OVERLAY_PARENT_MISMATCH ${date}: overlay was built against a different CORPUS hash`);
      }
    }
    for (const l of ojsonl.split("\n").filter((x) => x.trim().length > 0)) {
      const o = JSON.parse(l);
      scoreLevelByIdentity.set(`${o.conditionId}::${o.selectedTokenId}::${o.decisionAt}`, typeof o.scoreLevel === "number" ? o.scoreLevel : null);
    }
  }

  const rows: RollingCompactRow[] = jsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const r = JSON.parse(l);
      const idKey = `${r.conditionId}::${r.selectedTokenId}::${r.decisionAt}`;
      const scoreLevel =
        typeof r.scoreLevel === "number"
          ? r.scoreLevel
          : scoreLevelByIdentity.has(idKey)
            ? scoreLevelByIdentity.get(idKey)!
            : undefined;
      return {
        populationId: r.populationId,
        conditionId: r.conditionId,
        selectedTokenId: r.selectedTokenId,
        providerEventId: r.providerEventId ?? null,
        decisionAt: r.decisionAt,
        label: r.label,
        score: r.score,
        scoreLevel,
        selectedPrice: r.selectedPrice,
        volumeUsd: r.volumeUsd ?? null,
        leadTimeHours: r.leadTimeHours ?? null,
      } satisfies RollingCompactRow;
    });
  void scoreLevelOverlaySha;

  const win = (manifest.SOURCE_WINDOW_START as { value?: string } | undefined)?.value ?? null;
  const winEnd = (manifest.SOURCE_WINDOW_END as { value?: string } | undefined)?.value ?? null;
  const asOf = (manifest.LABEL_EVIDENCE_AS_OF as { value?: string } | undefined)?.value ?? null;

  return {
    partitionDate: date,
    canonicalHash,
    labelEvidenceAsOf: asOf,
    sourceWindowStart: win,
    sourceWindowEnd: winEnd,
    rows,
  };
}

/** Run the canonical live D-1 materializer + freeze for one missing day. Never overwrites. */
function materializeMissingDay(date: string): void {
  if (partitionExists(date)) {
    process.stderr.write(`[rolling] ${date} already frozen — skipped (immutable)\n`);
    return;
  }
  process.stderr.write(`[rolling] materializing missing partition ${date} from research clone …\n`);
  const runTs = (script: string, extra: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", script, "--d1", date, ...extra], {
      stdio: "inherit",
    });
  runTs("scripts/modeling/live-d1-research-corpus.ts", []);
  runTs("scripts/modeling/freeze-d1-research-corpus.ts", []);
  if (!partitionExists(date)) {
    throw new Error(`MATERIALIZE_FAILED ${date}: no artifact produced`);
  }
}

function main() {
  const windowRaw = Number(arg("--window"));
  if (!SUPPORTED_WINDOW_DAYS.includes(windowRaw as WindowDays)) {
    console.error(`BLOCKED_WINDOW: --window must be one of ${SUPPORTED_WINDOW_DAYS.join(" / ")}`);
    process.exit(2);
  }
  const windowDays = windowRaw as WindowDays;
  const nowUtc = arg("--now") ?? new Date().toISOString();
  const generatedAt = new Date().toISOString();

  const { windowStart, windowEnd, dates } = resolveWindowDates(windowDays, nowUtc);
  const missing = dates.filter((d) => !partitionExists(d));

  if (missing.length && has("--materialize-missing")) {
    for (const d of missing) materializeMissingDay(d);
  }

  const available = dates.filter((d) => partitionExists(d));
  const stillMissing = dates.filter((d) => !partitionExists(d));
  const partitions = available.map(loadPartition);

  const manifest = buildRollingManifest({ windowDays, nowUtc, partitions }, generatedAt);

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `ROLLING_MANIFEST_${windowDays}d_${windowEnd}`;
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = join(OUT_DIR, `${stem}.json`);
  writeFileSync(manifestPath, manifestJson);
  writeFileSync(
    join(OUT_DIR, `${stem}.SHA256SUMS.txt`),
    [
      `${createHash("sha256").update(manifestJson, "utf8").digest("hex")}  ${stem}.json`,
      ...manifest.PARTITIONS.map((p) => `${p.PARTITION_CANONICAL_HASH}  PARTITION_CANONICAL_CONTENT ${p.PARTITION_DATE}`),
    ].join("\n") + "\n",
  );

  // ── optional local stream-read proof (no DB, no broad scan) ─────────────
  let readProof: Record<string, unknown> | undefined;
  if (has("--read-proof")) {
    let streamedRows = 0;
    let streamedBytes = 0;
    const perPartition: Array<{ date: string; rows: number; bytes: number }> = [];
    for (const d of available) {
      const gz = readFileSync(partitionPaths(d).corpus);
      const jsonl = gunzipSync(gz).toString("utf8");
      const n = jsonl.split("\n").filter((l) => l.trim().length > 0).length;
      streamedRows += n;
      streamedBytes += gz.length;
      perPartition.push({ date: d, rows: n, bytes: gz.length });
    }
    readProof = {
      READ_SOURCE: "local immutable partition artifacts only",
      DB_READS: 0,
      BROAD_SCANS: 0,
      PARTITIONS_STREAMED: available.length,
      ROWS_STREAMED: streamedRows,
      COMPRESSED_BYTES_STREAMED: streamedBytes,
      PER_PARTITION: perPartition,
      MATCHES_MANIFEST_PRE_COLLAPSE:
        streamedRows === manifest.CROSS_PARTITION_IDENTITY.WINDOW_PRE_COLLAPSE_ROW_N.value,
    };
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        WINDOW_DAYS_REQUESTED: windowDays,
        WINDOW_START: windowStart,
        WINDOW_END: windowEnd,
        WINDOW_COMPLETE: manifest.WINDOW_COMPLETE,
        AVAILABLE_DAYS: available,
        MISSING_DAYS: stillMissing,
        AVAILABLE_PARTITION_N: manifest.AVAILABLE_PARTITION_N,
        MISSING_PARTITION_N: manifest.MISSING_PARTITION_N,
        CROSS_PARTITION_IDENTITY: manifest.CROSS_PARTITION_IDENTITY,
        PIT_FUTURE_LEAK_N: manifest.PIT_FUTURE_LEAK_N,
        POPULATIONS: manifest.POPULATIONS,
        LABEL_AS_OF_OVERLAY: manifest.LABEL_AS_OF_OVERLAY,
        manifestPath,
        readProof,
      },
      null,
      2,
    ) + "\n",
  );
}

main();
