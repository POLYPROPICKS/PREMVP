import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";
import { normalizeAsOfIso, produceForwardLocalShadowDecisions } from "../../../lib/modeling/forwardLocalShadowProducer";
import { acquireExclusiveLock, buildEvidenceRecord, commitAppend, planAppend, readExistingJournal } from "../../../lib/modeling/forwardShadowEvidenceStore";

function isEqualOrNested(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalExistingAncestor(target: string): string {
  let candidate = target;
  while (true) {
    try {
      return realpathSync(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("FORWARD_RUNNER_PATH_CANONICALIZATION_FAILED");
      candidate = parent;
    }
  }
}

function assertNoSymlinkPath(target: string): void {
  let candidate = target;
  while (true) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error("FORWARD_RUNNER_PATH_SYMLINK_REJECTED");
    } catch (error) {
      if (error instanceof Error && error.message === "FORWARD_RUNNER_PATH_SYMLINK_REJECTED") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

function getRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function assertSafeExternalPath(target: string, repositoryRoot: string, label: string): string {
  if (typeof target !== "string" || target.trim() === "") throw new Error(`FORWARD_RUNNER_${label}_REQUIRED`);
  if (!path.isAbsolute(target)) throw new Error(`FORWARD_RUNNER_${label}_MUST_BE_ABSOLUTE`);
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (parent === resolved) throw new Error(`FORWARD_RUNNER_${label}_INVALID_PATH`);
  assertNoSymlinkPath(resolved);
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const existingAncestor = canonicalExistingAncestor(parent);
  const canonicalTarget = path.join(existingAncestor, path.relative(canonicalExistingAncestor(parent), resolved));
  const protectedRoots = [
    canonicalRepositoryRoot,
    path.join(canonicalRepositoryRoot, "modeling/canonical/datasets"),
    path.join(canonicalRepositoryRoot, "modeling/canonical/model-handoff-v1"),
    path.join(canonicalRepositoryRoot, "modeling/evidence"),
    path.join(canonicalRepositoryRoot, "source_hash_inventory.json"),
  ];
  if (protectedRoots.some((protectedRoot) => isEqualOrNested(resolved, protectedRoot) || isEqualOrNested(canonicalTarget, protectedRoot))) {
    throw new Error(`FORWARD_RUNNER_${label}_PROTECTED_ROOT_REJECTED`);
  }
  return resolved;
}

function readSourceCommit(repositoryRoot: string): string {
  const gitPointer = readFileSync(path.join(repositoryRoot, ".git"), "utf8").trim();
  const gitDir = path.resolve(repositoryRoot, gitPointer.replace(/^gitdir:\s*/i, ""));
  const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  const commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  return head.startsWith("ref: ") ? readFileSync(path.join(commonDir, head.slice(5)), "utf8").trim() : head;
}

function loadSnapshotRows(inputPath: string): { rows: ExportRow[]; snapshotSha256: string } {
  const raw = readFileSync(inputPath);
  const snapshotSha256 = createHash("sha256").update(raw).digest("hex");
  const lines = raw.toString("utf8").split("\n").filter((line) => line.trim() !== "");
  const rows: ExportRow[] = lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as ExportRow;
    } catch {
      throw new Error(`FORWARD_RUNNER_MALFORMED_SNAPSHOT:line=${index + 1}`);
    }
  });
  return { rows, snapshotSha256 };
}

interface ParsedArgs {
  input?: string;
  asOf?: string;
  journal?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--input") args.input = value;
    else if (flag === "--as-of") args.asOf = value;
    else if (flag === "--journal") args.journal = value;
    i += 1;
  }
  return args;
}

export function runForwardLocalShadow(argv: readonly string[]): { appended: number; existing: number; decisionsTotal: number; asOfIso: string; waterfallVersion: string; classifierRegistrySha: string; snapshotSha256: string; sourceCommit: string } {
  const { input, asOf, journal } = parseArgs(argv);
  if (input === undefined || input.trim() === "") throw new Error("FORWARD_RUNNER_INPUT_REQUIRED");
  if (asOf === undefined || asOf.trim() === "") throw new Error("FORWARD_RUNNER_AS_OF_REQUIRED");
  if (journal === undefined || journal.trim() === "") throw new Error("FORWARD_RUNNER_JOURNAL_REQUIRED");

  const repositoryRoot = getRepositoryRoot();
  const resolvedInput = assertSafeExternalPath(input, repositoryRoot, "INPUT");
  const resolvedJournal = assertSafeExternalPath(journal, repositoryRoot, "JOURNAL");
  if (resolvedInput === resolvedJournal) throw new Error("FORWARD_RUNNER_INPUT_JOURNAL_SAME_PATH");
  if (!existsSync(resolvedInput)) throw new Error("FORWARD_RUNNER_INPUT_NOT_FOUND");

  const asOfIso = normalizeAsOfIso(asOf);
  const { rows, snapshotSha256 } = loadSnapshotRows(resolvedInput);

  const lock = acquireExclusiveLock(resolvedJournal);
  try {
    const sourceCommit = readSourceCommit(repositoryRoot);
    const result = produceForwardLocalShadowDecisions(rows, asOfIso);
    const records = result.decisions.map((decision) => buildEvidenceRecord(decision, { snapshotSha256, sourceCommit }));
    const existingJournal = readExistingJournal(resolvedJournal);
    const plan = planAppend(existingJournal, records);
    const outcome = commitAppend(resolvedJournal, plan);
    return {
      appended: outcome.appended,
      existing: outcome.existing,
      decisionsTotal: result.decisions.length,
      asOfIso: result.asOfIso,
      waterfallVersion: result.waterfallVersion,
      classifierRegistrySha: result.classifierRegistrySha,
      snapshotSha256,
      sourceCommit,
    };
  } finally {
    lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const summary = runForwardLocalShadow(process.argv.slice(2));
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
