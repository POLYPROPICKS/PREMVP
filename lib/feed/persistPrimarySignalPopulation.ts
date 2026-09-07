// Canonical PRIMARY signal-population persistence.
//
// The public landing feed is bounded to a presentation limit (<=15). The
// canonical GSP / current_signal_pair_serving population consumed by Contract A
// / B2 must NOT inherit that bound: every semantically-qualified primary
// outcome — including those beyond public rank `limit` — is a valid downstream
// candidate. This module wires the already-implemented full primary-qualified
// population (buildLandingCards({ evaluateFullPrimaryPopulation: true }) ->
// `primaryQualifiedPairs`) into the EXISTING generated_signal_pairs writer,
// without changing scoring, thresholds, the 254 population ceiling, the 360s
// primary-loop guard, or the public feed.

import type { LandingCardPair } from "./types";
import { selectCanonicalPrimaryExtras } from "./buildLandingCards";
import {
  writeGeneratedSignalPairs,
  writeGeneratedSignalPairsWithTelemetry,
  MoneyPersistenceBoundaryError,
  type WritePairsInput,
  type WritePairsTelemetryResult,
} from "./cacheGeneratedSignals";

type WriteInputPair = WritePairsInput["pairs"][number];

/** Same normalization the producer already applied to the public batch. */
function toWriteInputPair(p: LandingCardPair): WriteInputPair {
  const metrics = Array.isArray(p.premiumSignal?.metrics) ? p.premiumSignal.metrics : [];
  return {
    premiumSignal: {
      ...p.premiumSignal,
      metrics: metrics.map((m) => ({
        ...m,
        value: typeof m.value === "number" ? m.value : parseFloat(String(m.value)) || 0,
      })),
    },
    marketSource: p.marketSource,
    marketSources: p.marketSources,
    diagnostics: p.diagnostics,
  };
}

export interface PrimaryPopulationPersistResult {
  /** Rows written through the public path — unchanged from before this wiring. */
  publicPersistedCount: number;
  /** Qualified primary outcomes beyond the public selection, offered to the writer. */
  canonicalExtrasProposed: number;
  /** Of those, actually inserted. */
  canonicalExtrasPersistedCount: number;
  /** Total canonical generated_signal_pairs rows for this producer cycle. */
  canonicalPersistedCount: number;
  servingProjectedCount: number;
  primaryPersistDurationMs: number;
  servingProjectDurationMs: number;
}

/**
 * Persist the canonical PRIMARY signal population through the existing GSP
 * writer.
 *
 * `publicPairsToCache` — the existing <=15 public landing-card selection,
 * written UNCHANGED. `primaryQualifiedPairs` — the full semantically-qualified
 * primary population from
 * `buildLandingCards({ evaluateFullPrimaryPopulation: true })`.
 *
 * Ordering: the extra canonical rows are written FIRST, so the public rows keep
 * the newer `created_at` and `readLatestGeneratedSignalPairs(<=limit)` — the
 * public feed — is byte-identical.
 *
 * Dedupe: `selectCanonicalPrimaryExtras` removes every candidate whose canonical
 * `conditionId::selectedTokenId` identity is already in the public selection, so
 * writing public + extras never produces a duplicate canonical row.
 */
export async function persistCanonicalPrimarySignalPopulation(args: {
  primaryQualifiedPairs: readonly LandingCardPair[];
  publicPairsToCache: readonly LandingCardPair[];
  source: string;
  formulaVersion: string;
  expiresAt: string;
  /** Injectable for tests; defaults to the real canonical writer. */
  write?: typeof writeGeneratedSignalPairs;
  writeWithTelemetry?: typeof writeGeneratedSignalPairsWithTelemetry;
}): Promise<PrimaryPopulationPersistResult> {
  const write = args.writeWithTelemetry ?? (args.write
    ? async (input: WritePairsInput): Promise<WritePairsTelemetryResult> => {
        const persistedCount = await args.write!(input);
        return {
          persistedCount,
          servingProjectedCount: persistedCount,
          primaryPersistDurationMs: 0,
          servingProjectDurationMs: 0,
        };
      }
    : writeGeneratedSignalPairsWithTelemetry);

  const extras = selectCanonicalPrimaryExtras(
    args.primaryQualifiedPairs,
    args.publicPairsToCache,
  );

  let canonicalExtrasPersistedCount = 0;
  let servingProjectedCount = 0;
  let primaryPersistDurationMs = 0;
  let servingProjectDurationMs = 0;
  const writeBatch = async (input: WritePairsInput): Promise<WritePairsTelemetryResult> => {
    try {
      return await write(input);
    } catch (error) {
      if (error instanceof MoneyPersistenceBoundaryError) {
        throw new MoneyPersistenceBoundaryError(error.phase, error, {
          persistedCount: canonicalExtrasPersistedCount + error.evidence.persistedCount,
          servingProjectedCount: servingProjectedCount + error.evidence.servingProjectedCount,
          primaryPersistDurationMs: primaryPersistDurationMs + error.evidence.primaryPersistDurationMs,
          servingProjectDurationMs: servingProjectDurationMs + error.evidence.servingProjectDurationMs,
        });
      }
      throw error;
    }
  };
  if (extras.length > 0) {
    const extraWrite = await writeBatch({
      pairs: extras.map(toWriteInputPair),
      source: args.source,
      formulaVersion: args.formulaVersion,
      expiresAt: args.expiresAt,
    });
    canonicalExtrasPersistedCount = extraWrite.persistedCount;
    servingProjectedCount += extraWrite.servingProjectedCount;
    primaryPersistDurationMs += extraWrite.primaryPersistDurationMs;
    servingProjectDurationMs += extraWrite.servingProjectDurationMs;
  }

  const publicWrite = await writeBatch({
    pairs: args.publicPairsToCache.map(toWriteInputPair),
    source: args.source,
    formulaVersion: args.formulaVersion,
    expiresAt: args.expiresAt,
  });
  const publicPersistedCount = publicWrite.persistedCount;
  servingProjectedCount += publicWrite.servingProjectedCount;
  primaryPersistDurationMs += publicWrite.primaryPersistDurationMs;
  servingProjectDurationMs += publicWrite.servingProjectDurationMs;

  return {
    publicPersistedCount,
    canonicalExtrasProposed: extras.length,
    canonicalExtrasPersistedCount,
    canonicalPersistedCount: publicPersistedCount + canonicalExtrasPersistedCount,
    servingProjectedCount,
    primaryPersistDurationMs,
    servingProjectDurationMs,
  };
}
