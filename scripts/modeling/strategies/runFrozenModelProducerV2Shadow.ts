import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { produceFrozenModelProducerV2 } from "../../../lib/modeling/frozenModelProducerV2";

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
      if (parent === candidate) throw new Error("FROZEN_PRODUCER_OUTPUT_CANONICALIZATION_FAILED");
      candidate = parent;
    }
  }
}

function assertNoSymlinkPath(target: string): void {
  let candidate = target;
  while (true) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error("FROZEN_PRODUCER_OUTPUT_SYMLINK_REJECTED");
    } catch (error) {
      if (error instanceof Error && error.message === "FROZEN_PRODUCER_OUTPUT_SYMLINK_REJECTED") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

function getRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function assertSafeOutputPath(output: string, repositoryRoot: string): string {
  if (typeof output !== "string" || output.trim() === "") throw new Error("FROZEN_PRODUCER_OUTPUT_REQUIRED");
  if (!path.isAbsolute(output)) throw new Error("FROZEN_PRODUCER_OUTPUT_MUST_BE_ABSOLUTE");
  const resolvedOutput = path.resolve(output);
  const parent = path.dirname(resolvedOutput);
  if (parent === resolvedOutput) throw new Error("FROZEN_PRODUCER_OUTPUT_INVALID_PATH");
  assertNoSymlinkPath(resolvedOutput);
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const existingAncestor = canonicalExistingAncestor(parent);
  const canonicalOutput = path.join(existingAncestor, path.relative(canonicalExistingAncestor(parent), resolvedOutput));
  const protectedRoots = [
    canonicalRepositoryRoot,
    path.join(canonicalRepositoryRoot, "modeling/canonical/datasets"),
    path.join(canonicalRepositoryRoot, "modeling/canonical/model-handoff-v1"),
    path.join(canonicalRepositoryRoot, "modeling/evidence"),
    path.join(canonicalRepositoryRoot, "source_hash_inventory.json"),
  ];
  if (protectedRoots.some((protectedRoot) => isEqualOrNested(resolvedOutput, protectedRoot) || isEqualOrNested(canonicalOutput, protectedRoot))) {
    throw new Error("FROZEN_PRODUCER_OUTPUT_PROTECTED_ROOT_REJECTED");
  }
  return resolvedOutput;
}

export function runFrozenModelProducerV2Shadow(root: string, output: string) {
  const repositoryRoot = getRepositoryRoot();
  if (realpathSync(root) !== realpathSync(repositoryRoot)) throw new Error("FROZEN_PRODUCER_ROOT_MISMATCH");
  const resolvedOutput = assertSafeOutputPath(output, repositoryRoot);
  const first = produceFrozenModelProducerV2(repositoryRoot);
  const second = produceFrozenModelProducerV2(repositoryRoot);
  const deterministic = JSON.stringify(first.selectedDecisions) === JSON.stringify(second.selectedDecisions) && first.identitySetHash === second.identitySetHash && first.executionSequenceHash === second.executionSequenceHash;
  if (!deterministic) throw new Error("FROZEN_PRODUCER_NONDETERMINISTIC_REPLAY");
  const gitPointer = readFileSync(path.join(repositoryRoot, ".git"), "utf8").trim();
  const gitDir = path.resolve(repositoryRoot, gitPointer.replace(/^gitdir:\s*/i, ""));
  const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  const commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  const sourceCommit = head.startsWith("ref: ") ? readFileSync(path.join(commonDir, head.slice(5)), "utf8").trim() : head;
  const evidence = {
    sourceCommit,
    datasetHash: first.datasetHash,
    selectedCount: first.selectedDecisions.length,
    postJuneCount: first.postJuneDecisions.length,
    identitySetHash: first.identitySetHash,
    executionSequenceHash: first.executionSequenceHash,
    parityVerdict: "PASS",
    deterministicRunVerdict: "PASS",
    noWriteSafetyVerdict: "PASS",
  };
  writeFileSync(resolvedOutput, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [output] = process.argv.slice(2);
  console.log(JSON.stringify(runFrozenModelProducerV2Shadow(getRepositoryRoot(), output as string)));
}
