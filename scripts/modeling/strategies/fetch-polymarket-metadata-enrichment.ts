#!/usr/bin/env -S node --import tsx
// Real official Polymarket metadata fetch CLI (Phase 3E.8D).
//
// Reads the canonical dedup corpus (applying the same strict dedup as the
// other real runners), builds the unique event/market identity list, fetches
// official Gamma API metadata for each, and writes a deterministic,
// resumable snapshot. Uses the platform's real fetch (no injected mock) --
// this is the one script in this module that actually talks to the network,
// and only to the official gamma-api.polymarket.com host. Never reads
// Supabase, never reads secrets, never logs raw rows.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildMetadataEnrichmentSnapshot,
  type MetadataEnrichmentSnapshot,
} from "../../../lib/modeling/polymarketMetadataEnrichment";
import { projectGeneratedSignalPairsStrictDedup } from "../../../lib/modeling/generatedSignalPairsDedupPolicy";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";
import { validateRowLevelInput } from "./run-historical-funnel-comparison";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_OUTPUT = path.join("modeling", "local_exports", "polymarket_metadata_enrichment.json");
const DEFAULT_MANIFEST = path.join("modeling", "local_exports", "polymarket_metadata_enrichment_manifest.json");
const EXPECTED_CORPUS_SHA256 = "90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72";

interface ParsedArgs {
  input: string;
  output: string;
  manifest: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i] ?? args.input;
    else if (a === "--output") args.output = argv[++i] ?? args.output;
    else if (a === "--manifest") args.manifest = argv[++i] ?? args.manifest;
  }
  return args;
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function dedupCorpusHash(dedupRows: ExportRow[]): string {
  const { getStrictDedupKeyForExportRow } = require("../../../lib/modeling/generatedSignalPairsExportContract");
  const ordered = [...dedupRows].sort((a, b) => {
    const ak = getStrictDedupKeyForExportRow(a) ?? "";
    const bk = getStrictDedupKeyForExportRow(b) ?? "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export async function runFetchPolymarketMetadataCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): Promise<number> {
  const args = parseArgs(argv);
  try {
    ensureFile(args.input, "input artifact");
    const inputRaw = readFileSync(args.input, "utf8");
    const parsed = JSON.parse(inputRaw);
    const rowCheck = validateRowLevelInput(parsed);
    if (!rowCheck.ok) throw new Error(`input validation failed (${args.input}): ${rowCheck.reason}`);

    const projection = projectGeneratedSignalPairsStrictDedup(rowCheck.rows! as ExportRow[]);
    const dedupRows = projection.dedupedRows;
    const corpusHash = dedupCorpusHash(dedupRows);
    if (corpusHash !== EXPECTED_CORPUS_SHA256) {
      throw new Error(`corpus hash mismatch: expected ${EXPECTED_CORPUS_SHA256}, computed ${corpusHash}`);
    }

    let resumeFrom: MetadataEnrichmentSnapshot | undefined;
    if (existsSync(args.output)) {
      try {
        resumeFrom = JSON.parse(readFileSync(args.output, "utf8")) as MetadataEnrichmentSnapshot;
      } catch {
        resumeFrom = undefined;
      }
    }

    // Real network fetch -- the platform's actual fetch, hitting only the
    // official gamma-api.polymarket.com host.
    const fetchImpl = globalThis.fetch as unknown as Parameters<typeof buildMetadataEnrichmentSnapshot>[0]["fetchImpl"];

    const snapshot = await buildMetadataEnrichmentSnapshot({
      rows: dedupRows,
      corpusHash,
      fetchImpl,
      resumeFrom,
    });

    const dir = path.dirname(args.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    writeFileSync(
      args.manifest,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          corpusHash: snapshot.corpusHash,
          snapshotHash: snapshot.snapshotHash,
          status: snapshot.status,
          retrievedAt: snapshot.retrievedAt,
          requestSummary: snapshot.requestSummary,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    log(
      `Wrote metadata enrichment snapshot to ${args.output}\nWrote manifest to ${args.manifest}\nstatus: ${snapshot.status}\nsuccess/failure/retry: ${snapshot.requestSummary.successCount}/${snapshot.requestSummary.failureCount}/${snapshot.requestSummary.retryCount}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log(`Error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  runFetchPolymarketMetadataCli(process.argv.slice(2)).then((code) => process.exit(code));
}
