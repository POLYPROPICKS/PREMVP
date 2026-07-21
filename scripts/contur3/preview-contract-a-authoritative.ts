// scripts/contur3/preview-contract-a-authoritative.ts
//
// Read-only preview of the Contract A authoritative decision chain
// (Integration Phase 2A):
//
//   Contract A final accepted decisions
//   -> buildFireModelCandidates(..., "CONTRACT_A_V1")
//   -> buildReservationPlan            (pure -- no persistence call)
//   -> runEventRebalance(write:false)  (with a strict in-memory repo)
//   -> would-be READY report
//
// This module creates NO new selector/ranking/reservation/rebalance/queue
// logic -- it is a thin orchestration + IO layer around the already-released
// production functions. It never calls persistReservationPlan and never
// constructs the production Supabase repository. write:false already means
// runEventRebalance only ever calls the repo's two read methods
// (loadActiveReservations/loadQueuedReservationIds); the in-memory repo below
// additionally THROWS on every persistence-capable method as a trip-wire, so
// an unexpected write path would fail loudly rather than silently no-op.
//
// Mirrors the existing runner conventions in
// lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts and
// runFrozenExecutionContractBridge.ts: fixture-mode vs. live-mode source
// loading, a pure/testable orchestration function plus a thin CLI entrypoint,
// bounded Supabase reads via the existing fetchBoundedSnapshot seam, and the
// existing sha256OfNormalizedSnapshot helper reused verbatim (not
// re-implemented).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import { FROZEN_MODEL_V2_VERSION } from "../../lib/modeling/frozenModelProducerV2Shadow";
import { fetchBoundedSnapshot, sha256OfNormalizedSnapshot } from "../../lib/modeling/strategies/runFrozenExecutionContractBridge";

// Bounded-source-read requirement: mirrors the exact same approved maximum
// used by the existing frozen-model/bridge runners (never a new limit).
const DEFAULT_SUPABASE_ROW_LIMIT = 5_000;

export interface PreviewArgs {
  fixture?: string;
  sourceLive?: boolean;
  limit?: string;
  asOf?: string;
  planningAsOf?: string;
  rebalanceAsOf?: string;
  pretty?: boolean;
}

export function parseArgs(argv: readonly string[]): PreviewArgs {
  const args: PreviewArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--fixture") { args.fixture = argv[i + 1]; i += 1; }
    else if (flag === "--source") { if (argv[i + 1] === "live") args.sourceLive = true; i += 1; }
    else if (flag === "--limit") { args.limit = argv[i + 1]; i += 1; }
    else if (flag === "--as-of") { args.asOf = argv[i + 1]; i += 1; }
    else if (flag === "--planning-as-of") { args.planningAsOf = argv[i + 1]; i += 1; }
    else if (flag === "--rebalance-as-of") { args.rebalanceAsOf = argv[i + 1]; i += 1; }
    else if (flag === "--pretty") { args.pretty = true; }
  }
  return args;
}

function loadFixtureRows(fixturePath: string): Record<string, unknown>[] {
  if (!existsSync(fixturePath)) throw new Error("PREVIEW_FIXTURE_NOT_FOUND");
  const raw = readFileSync(fixturePath, "utf8");
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error("PREVIEW_FIXTURE_NOT_ARRAY");
  return parsed as Record<string, unknown>[];
}

/**
 * Live-mode data seam: EXACTLY ONE bounded, paginated generated_signal_pairs
 * read via the existing fetchBoundedSnapshot helper (never a new query
 * shape). Only invoked when --source live is given. Never invoked eagerly at
 * import time, so importing this module never requires Supabase env vars.
 * Never prints env values -- only the sanitized missing-env error code.
 */
async function loadLiveRows(limit: number | undefined, asOfIso: string): Promise<Record<string, unknown>[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("PREVIEW_LIVE_SOURCE_MISSING_ENV: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
  }
  const boundedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_SUPABASE_ROW_LIMIT;
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  return fetchBoundedSnapshot(async (from, pageSize) => {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("*")
      .lte("created_at", asOfIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`PREVIEW_LIVE_SOURCE_READ_FAILED:${error.message}`);
    return { rows: (data ?? []) as Record<string, unknown>[] };
  }, boundedLimit);
}

/**
 * Strict read-only RebalanceRepoPort for the preview. loadActiveReservations
 * is seeded from the in-memory reservation plan (never a DB read);
 * loadQueuedReservationIds always returns empty (a fresh preview has no
 * pre-existing queue state). Every persistence-capable method throws --
 * write:false already means runEventRebalance never calls them, so these
 * throws are a defense-in-depth trip-wire, not the primary safety mechanism.
 */
export function createStrictReadOnlyRebalanceRepo(
  reservations: readonly NightEventReservationRow[]
): RebalanceRepoPort {
  const mutationError = (method: string) =>
    new Error(`STRICT_READ_ONLY_MUTATION_ATTEMPTED: preview repo method '${method}' must never be invoked`);
  return {
    async loadActiveReservations() {
      return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING");
    },
    async loadQueuedReservationIds() {
      return new Set<string>();
    },
    async markReservationsExpired(): Promise<void> {
      throw mutationError("markReservationsExpired");
    },
    async markReservationSkipped(): Promise<void> {
      throw mutationError("markReservationSkipped");
    },
    async insertQueueRow(): Promise<void> {
      throw mutationError("insertQueueRow");
    },
    async markReservationQueued(): Promise<void> {
      throw mutationError("markReservationQueued");
    },
  };
}

interface PreviewRunOutput {
  candidateCount: number;
  contractAEventGroups: number;
  wouldReserveCount: number;
  wouldRebalanceCount: number;
  wouldReadyCount: number;
  failClosedCount: number;
  failClosedReasons: Record<string, number>;
  identityMismatchCount: number;
  alternateSubstitutionCount: number;
  contur3PhysicalGroups: number;
  marketLevelKeysSkipped: number;
  groupingCollisionCount: number;
  authoritativeDroppedCount: number;
  affectedIdentifiers: string[];
  readyRows: Array<{
    match_family_key: string;
    condition_id: string;
    token_id: string;
    side: string;
    selector_id: unknown;
  }>;
}

const MAX_AFFECTED_IDENTIFIERS = 25;

async function runOnce(
  planningCandidates: readonly FireModelCandidate[],
  finalCandidates: readonly FireModelCandidate[],
  planningNowMs: number,
  rebalanceNowMs: number
): Promise<PreviewRunOutput> {
  const plan = await buildReservationPlan(planningNowMs, {
    fetchCandidates: async () => ({ candidates: planningCandidates as FireModelCandidate[] }),
  });

  const repo = createStrictReadOnlyRebalanceRepo(plan.reservations);
  const rebalance = await runEventRebalance(
    rebalanceNowMs,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: planningCandidates as FireModelCandidate[] }), fetchContractAFinalCandidates: async () => ({ candidates: finalCandidates as FireModelCandidate[] }) }
  );

  let identityMismatchCount = 0;
  let alternateSubstitutionCount = 0;
  const readyRows: PreviewRunOutput["readyRows"] = [];
  const failClosedReasons: Record<string, number> = {};

  for (const outcome of rebalance.outcomes) {
    if (outcome.result === "SKIPPED") {
      failClosedReasons[outcome.reason] = (failClosedReasons[outcome.reason] ?? 0) + 1;
      continue;
    }
    if (outcome.result === "QUEUED" && outcome.queue_row) {
      const row: EventExecutionQueueRow = outcome.queue_row;
      const diag = (row.diagnostics ?? {}) as Record<string, unknown>;
      const selectorId = diag.selector_id;
      const authConditionId = diag.authoritative_condition_id;
      const authTokenId = diag.authoritative_token_id;
      const authSide = diag.authoritative_side;
      if (selectorId !== FROZEN_MODEL_V2_VERSION || authConditionId === undefined || authTokenId === undefined || authSide === undefined) {
        identityMismatchCount += 1;
      } else if (row.condition_id !== authConditionId || row.token_id !== authTokenId || row.side !== authSide) {
        identityMismatchCount += 1;
        alternateSubstitutionCount += 1;
      }
      readyRows.push({
        match_family_key: row.match_family_key,
        condition_id: row.condition_id,
        token_id: row.token_id,
        side: row.side,
        selector_id: selectorId,
      });
    }
  }

  const contractAEventGroups = new Set(planningCandidates.map((c) => c.match_family_key)).size;
  const contur3PhysicalGroups = plan.diagnostics.canonical_event_groups;
  const marketLevelKeysSkipped = plan.diagnostics.market_level_keys_skipped;
  // Candidates that entered SOME canonical group (i.e. were not dropped as a
  // market-level key) but whose group already had a representative -- a true
  // many-to-one merge, computed purely arithmetically from the EXISTING
  // buildReservationPlan diagnostics fields (no new grouping logic).
  const candidatesEnteringGroups = Math.max(0, candidateCountOf(planningCandidates) - marketLevelKeysSkipped);
  const groupingCollisionCount = Math.max(0, candidatesEnteringGroups - contur3PhysicalGroups);
  const authoritativeDroppedCount = Math.max(0, candidateCountOf(planningCandidates) - plan.reservations.length);

  const affectedIdentifiers: string[] = [];
  if (marketLevelKeysSkipped > 0 || groupingCollisionCount > 0) {
    const reservedKeys = new Set(plan.reservations.map((r) => r.match_family_key));
    for (const c of planningCandidates) {
      if (affectedIdentifiers.length >= MAX_AFFECTED_IDENTIFIERS) break;
      if (!reservedKeys.has(c.match_family_key)) {
        affectedIdentifiers.push(`event=${c.match_family_key} observation=${c.signal_id}`);
      }
    }
  }

  return {
    candidateCount: candidateCountOf(finalCandidates),
    contractAEventGroups,
    wouldReserveCount: plan.reservations.length,
    wouldRebalanceCount: rebalance.due_count,
    wouldReadyCount: readyRows.length,
    failClosedCount: rebalance.skipped_count,
    failClosedReasons,
    identityMismatchCount,
    alternateSubstitutionCount,
    contur3PhysicalGroups,
    marketLevelKeysSkipped,
    groupingCollisionCount,
    authoritativeDroppedCount,
    affectedIdentifiers,
    readyRows,
  };
}

function candidateCountOf(candidates: readonly FireModelCandidate[]): number {
  return candidates.length;
}

function normalizedReplayPayload(out: PreviewRunOutput): unknown {
  return {
    candidateCount: out.candidateCount,
    contractAEventGroups: out.contractAEventGroups,
    wouldReserveCount: out.wouldReserveCount,
    wouldRebalanceCount: out.wouldRebalanceCount,
    wouldReadyCount: out.wouldReadyCount,
    failClosedCount: out.failClosedCount,
    failClosedReasons: out.failClosedReasons,
    identityMismatchCount: out.identityMismatchCount,
    alternateSubstitutionCount: out.alternateSubstitutionCount,
    contur3PhysicalGroups: out.contur3PhysicalGroups,
    marketLevelKeysSkipped: out.marketLevelKeysSkipped,
    groupingCollisionCount: out.groupingCollisionCount,
    authoritativeDroppedCount: out.authoritativeDroppedCount,
    readyRows: [...out.readyRows].sort((a, b) => a.match_family_key.localeCompare(b.match_family_key)),
  };
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface ContractAPreviewSummary {
  status: "PREVIEW_OK";
  sourceMode: "fixture" | "live";
  sourceAsOf: string;
  planningAsOf: string;
  rebalanceAsOf: string;
  sourceRows: number;
  sourceSnapshotSha256: string;
  contractAAcceptedDecisions: number;
  contractACandidates: number;
  wouldReserveCount: number;
  wouldRebalanceCount: number;
  wouldReadyCount: number;
  failClosedCount: number;
  failClosedReasons: Record<string, number>;
  identityMismatchCount: number;
  alternateSubstitutionCount: number;
  contractAEventGroups: number;
  contur3PhysicalGroups: number;
  groupingCollisionCount: number;
  marketLevelKeysSkipped: number;
  authoritativeDroppedCount: number;
  affectedIdentifiers: string[];
  deterministicReplay: boolean;
  replayHash1: string;
  replayHash2: string;
  safety: {
    productionReservationWrites: 0;
    productionQueueWrites: 0;
    callbacks: 0;
    irelandCalls: 0;
    clobOrders: 0;
  };
}

export async function runContractAAuthoritativePreview(
  argv: readonly string[]
): Promise<ContractAPreviewSummary> {
  const args = parseArgs(argv);

  const hasFixture = typeof args.fixture === "string" && args.fixture.trim() !== "";
  const hasLive = args.sourceLive === true;
  if (hasFixture && hasLive) throw new Error("PREVIEW_SOURCE_MODE_MUTUALLY_EXCLUSIVE: pass either --fixture or --source live, not both");
  if (!hasFixture && !hasLive) throw new Error("PREVIEW_SOURCE_MODE_REQUIRED: pass --fixture <path> or --source live");

  const asOfIso = args.asOf && args.asOf.trim() !== "" ? args.asOf : new Date().toISOString();
  const planningAsOf = args.planningAsOf ?? asOfIso;
  const rebalanceAsOf = args.rebalanceAsOf ?? asOfIso;
  const planningNowMs = Date.parse(planningAsOf);
  const rebalanceNowMs = Date.parse(rebalanceAsOf);
  if (!Number.isFinite(planningNowMs) || !Number.isFinite(rebalanceNowMs) || rebalanceNowMs < planningNowMs) throw new Error("PREVIEW_INVALID_AS_OF");

  const parsedLimit = args.limit !== undefined && args.limit.trim() !== "" ? Number(args.limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    throw new Error("PREVIEW_INVALID_LIMIT");
  }
  const boundedLimit = Math.min(parsedLimit ?? DEFAULT_SUPABASE_ROW_LIMIT, DEFAULT_SUPABASE_ROW_LIMIT);

  const sourceMode: "fixture" | "live" = hasFixture ? "fixture" : "live";
  const rows = hasFixture
    ? loadFixtureRows(args.fixture as string).slice(0, boundedLimit)
    : await loadLiveRows(boundedLimit, rebalanceAsOf);

  const sourceRows = rows.length;
  const sourceSnapshotSha256 = sha256OfNormalizedSnapshot(rows);

  // ── Run 1 ──────────────────────────────────────────────────────────────
  const visibleAt = (ms: number) => rows.filter((row) => typeof row.created_at === "string" && Date.parse(row.created_at) <= ms);
  const at = async <T>(ms: number, fn: () => Promise<T>) => {
    const RealDate = Date;
    class SnapshotDate extends RealDate { constructor(value?: any) { super(value ?? ms); } static now() { return ms; } }
    globalThis.Date = SnapshotDate as DateConstructor;
    try { return await fn(); } finally { globalThis.Date = RealDate; }
  };
  const buildStages = async () => {
    const planning = await at(planningNowMs, () => buildFireModelCandidates(boundedLimit, "all", true, visibleAt(planningNowMs), "CONTRACT_A_PLANNING_V1"));
    const final = await at(rebalanceNowMs, () => buildFireModelCandidates(boundedLimit, "all", true, visibleAt(rebalanceNowMs), "CONTRACT_A_V1"));
    return { planning, final };
  };
  const stages1 = await buildStages();
  const out1 = await runOnce(stages1.planning.candidates, stages1.final.candidates, planningNowMs, rebalanceNowMs);
  const replayHash1 = sha256Of(normalizedReplayPayload(out1));

  // ── Run 2 (same immutable source + as-of, for determinism proof) ───────
  const stages2 = await buildStages();
  const out2 = await runOnce(stages2.planning.candidates, stages2.final.candidates, planningNowMs, rebalanceNowMs);
  const replayHash2 = sha256Of(normalizedReplayPayload(out2));

  return {
    status: "PREVIEW_OK",
    sourceMode,
    sourceAsOf: asOfIso,
    planningAsOf,
    rebalanceAsOf,
    sourceRows,
    sourceSnapshotSha256,
    contractAAcceptedDecisions: out1.candidateCount,
    contractACandidates: out1.candidateCount,
    wouldReserveCount: out1.wouldReserveCount,
    wouldRebalanceCount: out1.wouldRebalanceCount,
    wouldReadyCount: out1.wouldReadyCount,
    failClosedCount: out1.failClosedCount,
    failClosedReasons: out1.failClosedReasons,
    identityMismatchCount: out1.identityMismatchCount,
    alternateSubstitutionCount: out1.alternateSubstitutionCount,
    contractAEventGroups: out1.contractAEventGroups,
    contur3PhysicalGroups: out1.contur3PhysicalGroups,
    groupingCollisionCount: out1.groupingCollisionCount,
    marketLevelKeysSkipped: out1.marketLevelKeysSkipped,
    authoritativeDroppedCount: out1.authoritativeDroppedCount,
    affectedIdentifiers: out1.affectedIdentifiers,
    deterministicReplay: replayHash1 === replayHash2,
    replayHash1,
    replayHash2,
    safety: {
      productionReservationWrites: 0,
      productionQueueWrites: 0,
      callbacks: 0,
      irelandCalls: 0,
      clobOrders: 0,
    },
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  runContractAAuthoritativePreview(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, args.pretty ? 2 : 0));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
