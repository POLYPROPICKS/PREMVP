import { createHash } from "node:crypto";
import type { LandingCardPair } from "./types";
import { selectCanonicalPrimaryExtras } from "./buildLandingCards";
import { MoneyPersistenceBoundaryError, type WritePairsInput } from "./cacheGeneratedSignals";
import { chunkArray } from "./writeBatching";
import { publishPrimaryEvidenceToServing, type PrimaryServingPublicationResult } from "./primaryEvidenceServing";

type WriteInputPair = WritePairsInput["pairs"][number];

// MIGRATION_FREE_BOUNDED_PRIMARY_PUBLICATION_V1: the unchanged live DB ceiling
// (primary_evidence_outbox CHECK evidence_row_count BETWEEN 1 AND 508, and the
// matching guard inside publish_primary_signal_observation). This is a
// per-publication-call transport ceiling, not a population ceiling -- one
// logical producer cycle now publishes as multiple bounded shards instead of
// depending on a DB migration to raise it.
const PRIMARY_EVIDENCE_SHARD_MAX_ROWS = 508;

function toWriteInputPair(p: LandingCardPair): WriteInputPair {
  const metrics = Array.isArray(p.premiumSignal?.metrics) ? p.premiumSignal.metrics : [];
  return {
    premiumSignal: { ...p.premiumSignal, metrics: metrics.map((m) => ({
      ...m,
      value: typeof m.value === "number" ? m.value : parseFloat(String(m.value)) || 0,
    })) },
    marketSource: p.marketSource,
    marketSources: p.marketSources,
    diagnostics: p.diagnostics,
  };
}

/**
 * The deterministic shard boundary: the same three authorized market families
 * (moneyline/spread/total) the producer's own bounded fan-out
 * (BOUNDED_MULTI_IDENTITY_SOURCE_QUALIFICATION_V1,
 * AUTHORIZED_RECOVERY_MARKET_TYPES in buildLandingCards.ts) already uses. Each
 * family is independently bounded at <=508 by that existing derivation
 * (PRIMARY_SCORER_PROVEN_CAPACITY=254 sampled physical events * 2 sides), so
 * grouping by family is a natural fit, not an arbitrary split. A pair whose
 * market type does not resolve to one of the three (legacy/non-fanout path)
 * falls into its own "other" bucket rather than being merged or dropped.
 */
function marketFamilyOf(pair: WriteInputPair): string {
  const raw = String(pair.diagnostics?.providerEventContext?.marketType ?? "").trim().toLowerCase();
  if (raw === "moneyline") return "moneyline";
  if (raw === "spread" || raw === "spreads") return "spread";
  if (raw === "total" || raw === "totals") return "total";
  return "other";
}

/** Deterministic per-shard envelope id, derived from the one logical producer-cycle id. */
function shardEnvelopeId(baseObservationId: string, shardLabel: string): string {
  const hex = createHash("sha256").update(`${baseObservationId}::shard::${shardLabel}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Splits one logical producer cycle's already-qualified pairs into
 * publication shards, each independently within PRIMARY_EVIDENCE_SHARD_MAX_ROWS.
 * Transport only: no ranking, no filtering, no dropped identities -- every
 * input pair appears in exactly one output shard, in stable order. A family
 * bucket that still exceeds the cap (should not happen given the producer's
 * own bound, but never assumed) falls back to positional chunking WITHIN that
 * bucket only, never across families.
 */
function shardWriteInputPairs(
  pairs: readonly WriteInputPair[]
): Array<{ label: string; pairs: WriteInputPair[] }> {
  const byFamily = new Map<string, WriteInputPair[]>();
  for (const pair of pairs) {
    const family = marketFamilyOf(pair);
    const arr = byFamily.get(family) ?? [];
    arr.push(pair);
    byFamily.set(family, arr);
  }
  const shards: Array<{ label: string; pairs: WriteInputPair[] }> = [];
  for (const [family, group] of byFamily) {
    const chunks = chunkArray(group, PRIMARY_EVIDENCE_SHARD_MAX_ROWS);
    chunks.forEach((chunk, idx) => {
      shards.push({ label: chunks.length > 1 ? `${family}#${idx}` : family, pairs: chunk });
    });
  }
  return shards;
}

export interface PrimaryPopulationPersistResult {
  publicPersistedCount: number;
  canonicalExtrasProposed: number;
  canonicalExtrasPersistedCount: number;
  canonicalPersistedCount: number;
  servingProjectedCount: number;
  primaryEvidenceCapturedCount: number;
  primaryPersistDurationMs: number;
  servingProjectDurationMs: number;
  gspWriteStatus: "DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX" | "FAILED_NON_FATAL" | "SUCCEEDED_NON_BLOCKING_PROBE";
}

/**
 * Atomically-per-shard captures the exact primary payload and publishes
 * Serving. One logical producer cycle may now publish as multiple bounded
 * shards (see shardWriteInputPairs) instead of requiring the DB row-count
 * ceiling to cover the whole cycle in one call. Every shard is attempted
 * (a failure in one family does not block the others -- each is an
 * independent, disjoint identity set), and any failure is surfaced via
 * MoneyPersistenceBoundaryError so the overall producer run is recorded as
 * failed/partial rather than falsely presented as a complete success, even
 * though the identities from succeeding shards are still correctly published.
 */
export async function persistCanonicalPrimarySignalPopulation(args: {
  primaryQualifiedPairs: readonly LandingCardPair[];
  publicPairsToCache: readonly LandingCardPair[];
  source: string;
  formulaVersion: string;
  expiresAt: string;
  observationId: string;
  observedAt: string;
  publish?: typeof publishPrimaryEvidenceToServing;
  /** Failure-injection seam only; production leaves GSP deferred to the outbox. */
  legacyGspProbe?: (input: WritePairsInput) => Promise<void>;
}): Promise<PrimaryPopulationPersistResult> {
  const extras = selectCanonicalPrimaryExtras(args.primaryQualifiedPairs, args.publicPairsToCache);
  const combinedPairs = [...extras, ...args.publicPairsToCache].map(toWriteInputPair);
  const shards = shardWriteInputPairs(combinedPairs);

  const publish = args.publish ?? publishPrimaryEvidenceToServing;
  let servingProjectedCount = 0;
  let primaryEvidenceCapturedCount = 0;
  let servingProjectDurationMs = 0;
  let firstError: unknown = null;

  for (const shard of shards) {
    if (shard.pairs.length === 0) continue;
    const shardInput: WritePairsInput = {
      pairs: shard.pairs,
      source: args.source,
      formulaVersion: args.formulaVersion,
      expiresAt: args.expiresAt,
    };
    const shardStartedAt = Date.now();
    // A cycle that fits in one shard keeps the exact pre-sharding envelope id
    // (the caller's own producer-cycle observationId) unchanged -- sharding
    // only introduces a derived per-shard id once a cycle genuinely splits.
    const shardObservationId = shards.length === 1 ? args.observationId : shardEnvelopeId(args.observationId, shard.label);
    try {
      const publication: PrimaryServingPublicationResult = await publish({
        observationId: shardObservationId,
        observedAt: args.observedAt,
        input: shardInput,
      });
      servingProjectedCount += publication.servingProjectedCount;
      primaryEvidenceCapturedCount += publication.primaryEvidenceCapturedCount;
      servingProjectDurationMs += publication.durationMs;
    } catch (error) {
      servingProjectDurationMs += Date.now() - shardStartedAt;
      if (firstError === null) firstError = error;
    }
  }

  if (firstError !== null) {
    throw new MoneyPersistenceBoundaryError("SERVING_PROJECTION", firstError, {
      persistedCount: 0,
      servingProjectedCount,
      primaryPersistDurationMs: 0,
      servingProjectDurationMs,
    });
  }

  let gspWriteStatus: PrimaryPopulationPersistResult["gspWriteStatus"] = "DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX";
  if (args.legacyGspProbe) {
    try {
      await args.legacyGspProbe({
        pairs: combinedPairs,
        source: args.source,
        formulaVersion: args.formulaVersion,
        expiresAt: args.expiresAt,
      });
      gspWriteStatus = "SUCCEEDED_NON_BLOCKING_PROBE";
    } catch {
      gspWriteStatus = "FAILED_NON_FATAL";
    }
  }
  return {
    publicPersistedCount: 0,
    canonicalExtrasProposed: extras.length,
    canonicalExtrasPersistedCount: 0,
    canonicalPersistedCount: 0,
    servingProjectedCount,
    primaryEvidenceCapturedCount,
    primaryPersistDurationMs: 0,
    servingProjectDurationMs,
    gspWriteStatus,
  };
}
