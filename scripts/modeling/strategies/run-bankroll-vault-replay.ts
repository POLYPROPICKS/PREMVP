#!/usr/bin/env -S node --import tsx
// Bankroll/Vault Historical Replay CLI (Phase 3B / Roadmap_July2).
//
// THEORETICAL_GROSS_HISTORICAL_REPLAY ONLY. Reads ONLY local files (raw
// canonical corpus + classifier registry), runs the pure T-90/one-per-event/
// bankroll-vault replay via the lib module, and (only under
// --write-artifacts) writes exactly two artifacts atomically with re-read
// hash verification. Dry-run is the default and writes zero files. No env
// reads, no network, no Supabase, no forward data, no Ireland, no live
// execution. Import never auto-runs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  runBankrollVaultReplay,
  serializeBankrollVaultReplayJson,
  buildBankrollVaultReplayManifest,
} from "../../../lib/modeling/bankrollVaultReplay";
import { loadExecutableFunnelClassifier, type ExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const DEFAULT_INPUT = path.join("modeling", "local_exports", "generated_signal_pairs_export.json");
const DEFAULT_CLASSIFIER = path.join("modeling", "model_registry", "executable_funnel_classifier.json");
const DEFAULT_OUTPUT_ROOT = path.join("modeling", "local_exports", "bankroll_vault_replay");
const DEFAULT_INSURANCE_BANKROLL = 100;

const JSON_FILENAME = "bankroll_vault_replay.json";
const MANIFEST_FILENAME = "bankroll_vault_replay_manifest.json";

export type BankrollVaultReplayCliMode = "dry-run" | "write";

export interface BankrollVaultReplayArgs {
  mode: BankrollVaultReplayCliMode;
  input: string;
  classifier: string;
  outputRoot: string;
  insuranceBankroll: number;
}

const KNOWN_FLAGS = new Set(["--input", "--classifier", "--output-root", "--insurance-bankroll", "--write-artifacts", "--dry-run"]);

export function parseBankrollVaultReplayArgs(argv: string[]): BankrollVaultReplayArgs {
  let input = DEFAULT_INPUT;
  let classifier = DEFAULT_CLASSIFIER;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  let insuranceBankroll = DEFAULT_INSURANCE_BANKROLL;
  let sawWrite = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg === "--write-artifacts") {
      sawWrite = true;
      continue;
    }
    if (arg === "--dry-run") {
      sawDryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for argument: ${arg}`);
    i += 1;
    if (arg === "--input") input = value;
    else if (arg === "--classifier") classifier = value;
    else if (arg === "--output-root") outputRoot = value;
    else if (arg === "--insurance-bankroll") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--insurance-bankroll must be a positive finite number: ${value}`);
      insuranceBankroll = parsed;
    }
  }

  if (sawWrite && sawDryRun) throw new Error("--dry-run and --write-artifacts cannot be used together");

  return { mode: sawWrite ? "write" : "dry-run", input, classifier, outputRoot, insuranceBankroll };
}

function ensureFile(p: string, label: string): void {
  if (!existsSync(p)) throw new Error(`${label} not found: ${p}`);
  if (statSync(p).isDirectory()) throw new Error(`${label} is a directory, expected a file: ${p}`);
}

function readRaw(p: string, label: string): string {
  ensureFile(p, label);
  return readFileSync(p, "utf8");
}

function parseJson<T>(raw: string, label: string, p: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} is not valid JSON: ${p}`);
  }
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function runBankrollVaultReplayCli(
  argv: string[],
  log: (msg: string) => void = (m) => process.stderr.write(m),
): number {
  let args: BankrollVaultReplayArgs;
  try {
    args = parseBankrollVaultReplayArgs(argv);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }

  try {
    const inputRaw = readRaw(args.input, "input corpus");
    const rawRows = parseJson<ExportRow[]>(inputRaw, "input corpus", args.input);
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new Error(`input corpus must be a non-empty JSON array of rows: ${args.input}`);
    }

    const classifierRaw = args.classifier === DEFAULT_CLASSIFIER ? null : readRaw(args.classifier, "classifier");
    const classifier: ExecutableFunnelClassifier =
      classifierRaw === null ? loadExecutableFunnelClassifier() : parseJson<ExecutableFunnelClassifier>(classifierRaw, "classifier", args.classifier);
    const classifierSha256 =
      classifierRaw === null
        ? sha256(readFileSync(path.join("modeling", "model_registry", "executable_funnel_classifier.json"), "utf8"))
        : sha256(classifierRaw);

    const result = runBankrollVaultReplay({ rawRows, classifier, insuranceBankroll: args.insuranceBankroll });

    if (args.mode === "dry-run") {
      log(
        `${JSON.stringify(
          {
            mode: "dry-run",
            resultLabel: result.resultLabel,
            selectedObservations: result.selectedObservations,
            canonicalEventGroups: result.canonicalEventGroups,
            grossTheoreticalPnl: result.grossTheoreticalPnl,
            grossTheoreticalRoi: result.grossTheoreticalRoi,
            postOverlaySelectionHash: result.postOverlaySelectionHash,
            endingActiveBankroll: result.endingActiveBankroll,
            endingVaultBankroll: result.endingVaultBankroll,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const jsonString = serializeBankrollVaultReplayJson(result);
    // generatedAt is a manifest-only wall-clock timestamp -- it is never
    // included in the replay JSON itself, so jsonSha256/the replay content
    // stay fully deterministic across reruns regardless of generatedAt.
    const generatedAtIso = new Date().toISOString();
    const manifest = buildBankrollVaultReplayManifest(
      result,
      { inputSha256: sha256(inputRaw), classifierSha256 },
      jsonString,
      generatedAtIso,
    );
    const manifestString = `${JSON.stringify(manifest, null, 2)}\n`;

    const outputs: Array<[string, string]> = [
      [JSON_FILENAME, jsonString],
      [MANIFEST_FILENAME, manifestString],
    ];

    for (const [filename, content] of outputs) {
      atomicWrite(path.join(args.outputRoot, filename), content);
    }
    for (const [filename, content] of outputs) {
      if (sha256(readFileSync(path.join(args.outputRoot, filename), "utf8")) !== sha256(content)) {
        throw new Error(`artifact verification failed: ${filename} changed after write`);
      }
    }

    log(`Wrote bankroll vault replay artifacts (THEORETICAL_GROSS_HISTORICAL_REPLAY) to ${args.outputRoot}\n`);
    return 0;
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runBankrollVaultReplayCli(process.argv.slice(2)));
}
