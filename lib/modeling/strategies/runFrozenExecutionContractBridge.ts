// Orchestration for the Frozen Execution Contract Bridge (Integration
// Milestone 2B). Thin CLI/IO layer around the pure
// lib/modeling/frozenExecutionContractBridge.ts comparator. This module must
// never import anything from lib/executor/nightEventReservations.ts,
// eventExecutionQueue*, executorOrderEvents*, executorQueueMark*, or any
// Ireland/CLOB client. Importing lib/executor/buildFireModelCandidates.ts
// (the Contur3 READ path) is fine and expected in live mode.
//
// ARCHITECTURE DECISION -- fixture mode vs live mode (deliberate, disclosed;
// updated in Integration Milestone 2B.1 to bind both sides to ONE bounded
// snapshot):
//
// buildFireModelCandidates() now accepts an optional 4th `injectedRows`
// parameter (added as the smallest behavior-preserving seam -- see
// lib/executor/buildFireModelCandidates.ts's own doc comment on that
// parameter). When supplied, it performs ZERO Supabase reads and instead
// derives its two internal row subsets (scored / planning-shadow) via the
// exact same in-scope predicate constants it already used for its SQL
// queries, applied client-side to the supplied rows. The default call path
// (injectedRows omitted) is byte-for-byte unchanged.
//
//   * LIVE mode (no --fixture, Supabase env vars present): this runner
//     performs EXACTLY ONE bounded, paginated (page size 1000, explicit
//     total limit, default 5000) generated_signal_pairs read via
//     fetchBoundedSnapshot() below, ordered by created_at desc with a
//     deterministic id tie-break, and filters out any row created after
//     --as-of. That single frozen row array is then handed to BOTH sides:
//     produceFrozenModelV2ShadowDecisions() for the frozen side, and
//     buildFireModelCandidates(limit, "all", true, snapshotRows) --
//     planningMode=true, confirmed read-only/no-live-order-placement by
//     reading lib/executor/buildFireModelCandidates.ts -- for the Contur3
//     side, via the injectedRows seam. Contur3 therefore performs zero
//     independent Supabase reads; both sides observe identical row
//     identities, the same as-of boundary, the same limit, and the same
//     normalized ordering.
//
//   * FIXTURE mode (--fixture <path>): the fixture supplies the single raw
//     generated_signal_pairs row snapshot directly (one array, not two
//     separate frozen/Contur3 inputs as in the prior milestone -- this is
//     the whole point of the bounded-snapshot repair). That one row array is
//     fed through produceFrozenModelV2ShadowDecisions() for the frozen side
//     AND through the real buildFireModelCandidates(limit, "all", true,
//     rows) for the Contur3 side -- exactly mirroring live mode, so fixture
//     tests exercise the identical code path as production, not a parallel
//     mock implementation. (The prior milestone's two-array fixture shape --
//     frozenSourceRows + a pre-computed Contur3CandidateSlice[] -- is no
//     longer needed now that buildFireModelCandidates itself is
//     fixture-drivable via the injectedRows seam.)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { produceFrozenModelV2ShadowDecisions, FROZEN_MODEL_V2_VERSION } from "../frozenModelProducerV2Shadow";
import { getCanonicalTokenIdForExportRow, type ExportRow } from "../generatedSignalPairsExportContract";
import { compareFrozenAndContur3, type Contur3CandidateSlice } from "../frozenExecutionContractBridge";

// Query-level bounded pagination for the ONE shared source snapshot. Page
// size is capped at 1000 (Supabase's own default response cap) and the loop
// stops the moment totalLimit rows have been accumulated -- it never issues
// a request for a page beyond the one containing the totalLimit-th row, and
// never materializes more than totalLimit rows in memory. This is
// deliberately NOT `fetchAllPlanningRows` (exported from
// buildFireModelCandidates.ts): that helper has no total-limit stop
// condition by design (planning mode intentionally wants the complete
// universe) and is the wrong tool for a bridge that must stay
// query-level-bounded.
export const SNAPSHOT_PAGE_SIZE = 1_000;

export interface SnapshotPage {
  rows: readonly Record<string, unknown>[];
}

/**
 * `buildPage(from, pageSize)` must return up to `pageSize` rows starting at
 * offset `from`, ordered by created_at desc with a stable identity
 * tie-break (the real implementation below does this via
 * `.order("created_at", { ascending: false }).order("id", { ascending: true })`;
 * a test double can simulate this directly). The loop stops as soon as
 * `totalLimit` rows have been collected, OR the returned page is shorter
 * than `pageSize` (source exhausted) -- whichever comes first. A page
 * beyond the one containing the totalLimit-th row is never requested.
 */
export async function fetchBoundedSnapshot(
  buildPage: (from: number, pageSize: number) => Promise<SnapshotPage>,
  totalLimit: number,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let from = 0;
  while (all.length < totalLimit) {
    const remaining = totalLimit - all.length;
    const pageSize = Math.min(SNAPSHOT_PAGE_SIZE, remaining);
    const page = await buildPage(from, pageSize);
    all.push(...page.rows);
    if (page.rows.length < pageSize) break; // source exhausted
    from += pageSize;
  }
  return all.slice(0, totalLimit);
}

export interface RunFrozenExecutionContractBridgeArgs {
  asOf?: string;
  output?: string;
  fixture?: string;
  limit?: string;
}

export function parseArgs(argv: readonly string[]): RunFrozenExecutionContractBridgeArgs {
  const args: RunFrozenExecutionContractBridgeArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--as-of") args.asOf = value;
    else if (flag === "--output") args.output = value;
    else if (flag === "--fixture") args.fixture = value;
    else if (flag === "--limit") args.limit = value;
    else continue;
    i += 1;
  }
  return args;
}

function loadFixtureSnapshot(fixturePath: string): Record<string, unknown>[] {
  const raw = readFileSync(fixturePath, "utf8");
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  // Accept either a bare row array, or an object with a `sourceSnapshot`
  // array (the latter for symmetry with the runner's own artifact shape).
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).sourceSnapshot)) {
    return (parsed as Record<string, unknown>).sourceSnapshot as Record<string, unknown>[];
  }
  throw new Error("BRIDGE_RUNNER_FIXTURE_MUST_BE_ARRAY_OR_SOURCE_SNAPSHOT_OBJECT");
}

// Bounded-source-read requirement: production Supabase reads must always be
// bounded, even when the caller omits --limit. Mirrors
// lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts's
// DEFAULT_SUPABASE_ROW_LIMIT pattern exactly.
const DEFAULT_SUPABASE_ROW_LIMIT = 5_000;

/**
 * Live-mode data seam: performs EXACTLY ONE bounded, paginated
 * generated_signal_pairs read (via fetchBoundedSnapshot) and returns it as a
 * single row array to be shared by both producers. Only invoked when no
 * --fixture is given. Never invoked eagerly at import time, so this module
 * never requires Supabase env vars to be set just to be imported (as tests
 * do). Rows created after `asOfIso` are excluded at the query level
 * (`.lte("created_at", asOfIso)`), not filtered post-fetch.
 */
async function loadLiveSnapshot(
  limit: number | undefined,
  asOfIso: string,
): Promise<Record<string, unknown>[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("BRIDGE_RUNNER_NO_FIXTURE_AND_MISSING_SUPABASE_ENV");
  }
  const boundedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_SUPABASE_ROW_LIMIT;

  const { supabaseAdmin } = await import("../../supabase/server");
  return fetchBoundedSnapshot(async (from, pageSize) => {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("*")
      .lte("created_at", asOfIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`BRIDGE_RUNNER_SUPABASE_READ_FAILED:${error.message}`);
    return { rows: (data ?? []) as Record<string, unknown>[] };
  }, boundedLimit);
}

// Exported so the standalone frozen-model runner (Integration Milestone
// 2B.2) can compute its sourceSnapshotSha256 with the exact same
// implementation, proving shared-loader parity by construction rather than
// by a re-derived duplicate hash function.
export function sha256OfNormalizedSnapshot(rows: readonly Record<string, unknown>[]): string {
  // Order-independent: sorted by a stable composite key before hashing, so
  // two snapshots containing the same rows in different orders hash
  // identically (a page-boundary shuffle in a test double must not change
  // this hash).
  const ids = rows
    .map((row) => `${String(row.condition_id ?? "")}:${getCanonicalTokenIdForExportRow(row as ExportRow) ?? ""}:${String(row.created_at ?? "")}:${String(row.id ?? "")}`)
    .sort();
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

export interface RunFrozenExecutionContractBridgeSummary {
  asOfIso: string;
  modelVersion: string;
  sourceRowCount: number;
  frozenDecisionCount: number;
  contur3CandidateCount: number;
  exactCompatibleCount: number;
  classificationCounts: Record<string, number>;
  sourceSnapshotSha256: string;
  frozenInputSnapshotSha256: string;
  contur3InputSnapshotSha256: string;
  independentContur3SourceReads: number;
  outputPath: string;
  artifactSha256: string;
}

export async function runFrozenExecutionContractBridge(
  argv: readonly string[],
): Promise<RunFrozenExecutionContractBridgeSummary> {
  const { asOf, output, fixture, limit } = parseArgs(argv);
  if (asOf === undefined || asOf.trim() === "") throw new Error("BRIDGE_RUNNER_AS_OF_REQUIRED");
  if (output === undefined || output.trim() === "") throw new Error("BRIDGE_RUNNER_OUTPUT_REQUIRED");

  const parsedLimit = limit !== undefined && limit.trim() !== "" ? Number(limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new Error("BRIDGE_RUNNER_INVALID_LIMIT");
  }
  const boundedLimit = parsedLimit ?? DEFAULT_SUPABASE_ROW_LIMIT;

  let sourceSnapshot: Record<string, unknown>[];
  if (fixture !== undefined && fixture.trim() !== "") {
    if (!existsSync(fixture)) throw new Error("BRIDGE_RUNNER_FIXTURE_NOT_FOUND");
    // As-of integrity applies identically in fixture mode: a row created
    // after --as-of is excluded from the ONE shared snapshot before either
    // producer ever sees it (live mode enforces this at the query level via
    // `.lte("created_at", asOfIso)`; fixture mode enforces it here so both
    // paths share the same read contract).
    const asOfMs = Date.parse(asOf);
    sourceSnapshot = loadFixtureSnapshot(fixture)
      .filter((row) => {
        const createdMs = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
        return Number.isFinite(createdMs) && createdMs <= asOfMs;
      })
      .slice(0, boundedLimit);
  } else {
    sourceSnapshot = await loadLiveSnapshot(parsedLimit, asOf);
  }

  // ONE shared snapshot fed to both sides -- same row objects, same order,
  // same as-of boundary, same limit. Contur3's own generated_signal_pairs
  // reads are bypassed entirely via the injectedRows seam.
  const frozenSourceRows = sourceSnapshot as unknown as ExportRow[];
  const { buildFireModelCandidates } = await import("../../executor/buildFireModelCandidates");
  const { candidates } = await buildFireModelCandidates(boundedLimit, "all", true, sourceSnapshot);
  const contur3Candidates = candidates as unknown as Contur3CandidateSlice[];
  const independentContur3SourceReads = 0;

  const frozenResult = produceFrozenModelV2ShadowDecisions(frozenSourceRows, asOf);
  const comparison = compareFrozenAndContur3(frozenResult.acceptedDecisions, frozenSourceRows, contur3Candidates);

  const sourceSnapshotSha256 = sha256OfNormalizedSnapshot(sourceSnapshot);
  // Both sides were derived from the exact same sourceSnapshot array, so
  // their input-snapshot hashes are computed over that same array and are
  // therefore always equal by construction -- this is asserted by a
  // dedicated test rather than assumed silently.
  const frozenInputSnapshotSha256 = sourceSnapshotSha256;
  const contur3InputSnapshotSha256 = sourceSnapshotSha256;

  // Deterministic serialization: stable key order, single trailing newline.
  const artifact = {
    metadata: {
      generatedBy: "runFrozenExecutionContractBridge",
      schemaVersion: "FROZEN_EXECUTION_CONTRACT_BRIDGE_V1",
    },
    asOfIso: frozenResult.asOfIso,
    frozenModelVersion: FROZEN_MODEL_V2_VERSION,
    sourceRowCount: frozenSourceRows.length,
    sourceSnapshotSha256,
    sourcePageCount: Math.ceil(Math.max(sourceSnapshot.length, 1) / SNAPSHOT_PAGE_SIZE),
    configuredLimit: boundedLimit,
    frozenInputSnapshotSha256,
    contur3InputSnapshotSha256,
    independentContur3SourceReads,
    frozenDecisionCount: frozenResult.acceptedDecisions.length,
    contur3CandidateCount: contur3Candidates.length,
    eventCount: comparison.eventCount,
    exactCompatibleCount: comparison.classificationCounts.EXACT_EXECUTION_COMPATIBLE,
    classificationCounts: comparison.classificationCounts,
    comparisonRows: comparison.rows,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const resolvedOutput = path.resolve(output);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, serialized, "utf8");
  const artifactSha256 = createHash("sha256").update(serialized).digest("hex");

  return {
    asOfIso: frozenResult.asOfIso,
    modelVersion: FROZEN_MODEL_V2_VERSION,
    sourceRowCount: frozenSourceRows.length,
    frozenDecisionCount: frozenResult.acceptedDecisions.length,
    contur3CandidateCount: contur3Candidates.length,
    exactCompatibleCount: comparison.classificationCounts.EXACT_EXECUTION_COMPATIBLE,
    classificationCounts: comparison.classificationCounts,
    sourceSnapshotSha256,
    frozenInputSnapshotSha256,
    contur3InputSnapshotSha256,
    independentContur3SourceReads,
    outputPath: resolvedOutput,
    artifactSha256,
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runFrozenExecutionContractBridge(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
