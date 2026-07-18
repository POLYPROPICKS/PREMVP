#!/usr/bin/env -S node --import tsx
// Read-only forward snapshot exporter CLI (Track B, Phase 4B companion).
//
// Reads UNRESOLVED forward observations from generated_signal_pairs and writes
// a deterministic JSONL snapshot + JSON manifest to an operator-owned external
// directory. GET-only source transport, no database writes, no default paths,
// no implicit current time, no implicit production environment.
//
// Usage:
//   node --import tsx scripts/modeling/strategies/exportForwardLocalShadowSnapshot.ts \
//     --as-of <ISO> --output <abs snapshot.jsonl> --manifest <abs manifest.json> [--page-size N]
//
// All argument/path validation runs BEFORE any Supabase config is resolved or
// any adapter is built, so a bad invocation never touches the network.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeExternalOutputPath,
  createSupabaseForwardSourceAdapter,
  exportForwardSnapshot,
  normalizeAsOfIso,
} from "../../../lib/modeling/forwardSnapshotExporter";
import { resolveSupabaseReadConfig } from "./export-generated-signal-pairs-from-supabase";

function getRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function readSourceCommit(repositoryRoot: string): string {
  try {
    const gitPointer = readFileSync(path.join(repositoryRoot, ".git"), "utf8").trim();
    const gitDir = path.resolve(repositoryRoot, gitPointer.replace(/^gitdir:\s*/i, ""));
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    return head.startsWith("ref: ") ? readFileSync(path.join(commonDir, head.slice(5)), "utf8").trim() : head;
  } catch {
    return "UNKNOWN";
  }
}

interface ParsedArgs {
  asOf?: string;
  output?: string;
  manifest?: string;
  pageSize?: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--as-of") { args.asOf = value; i += 1; }
    else if (flag === "--output") { args.output = value; i += 1; }
    else if (flag === "--manifest") { args.manifest = value; i += 1; }
    else if (flag === "--page-size") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) args.pageSize = Math.floor(n);
      i += 1;
    }
  }
  return args;
}

export async function runExportForwardSnapshot(argv: readonly string[]): Promise<{ outputPath: string; manifestPath: string; rowCount: number; rawSnapshotSha256: string; normalizedIdentitySetSha256: string; asOf: string }> {
  const { asOf, output, manifest, pageSize } = parseArgs(argv);
  if (asOf === undefined || asOf.trim() === "") throw new Error("FORWARD_EXPORT_AS_OF_REQUIRED");
  if (output === undefined || output.trim() === "") throw new Error("FORWARD_EXPORT_OUTPUT_REQUIRED");
  if (manifest === undefined || manifest.trim() === "") throw new Error("FORWARD_EXPORT_MANIFEST_REQUIRED");

  // Pre-flight validation — never touches the network.
  const asOfIso = normalizeAsOfIso(asOf);
  const repositoryRoot = getRepositoryRoot();
  const resolvedOutput = assertSafeExternalOutputPath(output, repositoryRoot, "OUTPUT");
  const resolvedManifest = assertSafeExternalOutputPath(manifest, repositoryRoot, "MANIFEST");
  if (resolvedOutput === resolvedManifest) throw new Error("FORWARD_EXPORT_OUTPUT_MANIFEST_SAME_PATH");
  if (existsSync(resolvedOutput)) throw new Error("FORWARD_EXPORT_OUTPUT_EXISTS");
  if (existsSync(resolvedManifest)) throw new Error("FORWARD_EXPORT_MANIFEST_EXISTS");

  // Only now resolve read config (throws safely, naming missing vars) and read.
  const config = resolveSupabaseReadConfig();
  const adapter = createSupabaseForwardSourceAdapter(config);
  const sourceCommit = readSourceCommit(repositoryRoot);

  return exportForwardSnapshot({
    adapter,
    asOfIso,
    outputPath: resolvedOutput,
    manifestPath: resolvedManifest,
    repositoryRoot,
    sourceCommit,
    pageSize,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runExportForwardSnapshot(process.argv.slice(2))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
