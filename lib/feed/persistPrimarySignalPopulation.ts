import type { LandingCardPair } from "./types";
import { selectCanonicalPrimaryExtras } from "./buildLandingCards";
import { MoneyPersistenceBoundaryError, type WritePairsInput } from "./cacheGeneratedSignals";
import { publishPrimaryEvidenceToServing, type PrimaryServingPublicationResult } from "./primaryEvidenceServing";

type WriteInputPair = WritePairsInput["pairs"][number];

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

/** Atomically captures the exact primary payload and publishes Serving. */
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
  const input: WritePairsInput = {
    pairs: [...extras, ...args.publicPairsToCache].map(toWriteInputPair),
    source: args.source,
    formulaVersion: args.formulaVersion,
    expiresAt: args.expiresAt,
  };
  let publication: PrimaryServingPublicationResult;
  const startedAt = Date.now();
  try {
    publication = await (args.publish ?? publishPrimaryEvidenceToServing)({
      observationId: args.observationId,
      observedAt: args.observedAt,
      input,
    });
  } catch (error) {
    throw new MoneyPersistenceBoundaryError("SERVING_PROJECTION", error, {
      persistedCount: 0,
      servingProjectedCount: 0,
      primaryPersistDurationMs: 0,
      servingProjectDurationMs: Date.now() - startedAt,
    });
  }
  let gspWriteStatus: PrimaryPopulationPersistResult["gspWriteStatus"] = "DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX";
  if (args.legacyGspProbe) {
    try {
      await args.legacyGspProbe(input);
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
    servingProjectedCount: publication.servingProjectedCount,
    primaryEvidenceCapturedCount: publication.primaryEvidenceCapturedCount,
    primaryPersistDurationMs: 0,
    servingProjectDurationMs: publication.durationMs,
    gspWriteStatus,
  };
}
