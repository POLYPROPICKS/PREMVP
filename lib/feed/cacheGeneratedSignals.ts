// Cache layer for generated signal pairs
// Handles read/write operations to Supabase generated_signal_pairs and job_runs tables

import { supabaseAdmin } from "@/lib/supabase/server";
import { PremiumSignal, MarketSource, LandingCardDiagnostics, LandingCardPair } from "./types";
import type { WcShadowEntry } from "./discoverSportsMarkets";
import { hasEligibleEventVolume } from "./eventLiquidityGate";
import { hasStructuredScoredSportAuthority } from "./sportScoreOwnership";
import {
  chunkArray,
  SHADOW_DEDUP_QUERY_CHUNK,
  SHADOW_INSERT_CHUNK,
  SHADOW_DEDUP_MAX_QUERIES,
  SHADOW_DEDUP_BUDGET_EXCEEDED,
} from "./writeBatching";
import { projectInsertedRows } from "./currentSignalPairServing";

export interface CachedSignalPair {
  id?: string;
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  marketSources?: MarketSource[];
  diagnostics: LandingCardDiagnostics;
  score?: number;
  createdAt?: string;
  expiresAt?: string;
}

export interface JobRunInput {
  source: string;
  formulaVersion: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "empty" | "error";
  generatedCount: number;
  rejectedCount: number;
  durationMs: number;
  errorMessage?: string;
  diagnostics?: Record<string, unknown>;
}

export interface WritePairsInput {
  pairs: Array<{
    premiumSignal: PremiumSignal;
    marketSource: MarketSource;
    marketSources?: MarketSource[];
    diagnostics: LandingCardDiagnostics;
  }>;
  source: string;
  formulaVersion: string;
  expiresAt: string;
}

export const FIREMODEL1_1_RESEARCH_METRIC_VERSION = "shadow-firemodel1_1_research_v0";

export function buildFireModel1_1ResearchRows(
  pairs: LandingCardPair[],
  defaultExpiresAt: string,
) {
  return pairs.map((pair) => {
    const { premiumSignal: ps, diagnostics: diag } = pair;
    const smartMoneyScore = findMetricValue(
      Array.isArray(ps.metrics) ? ps.metrics : null,
      "smart money",
    );
    const whalePublicScore =
      findMetricValue(Array.isArray(ps.metrics) ? ps.metrics : null, "whale") ??
      findMetricValue(Array.isArray(ps.metrics) ? ps.metrics : null, "public");
    const preEventScore = findMetricValue(
      Array.isArray(ps.metrics) ? ps.metrics : null,
      "pre",
    );
    const entryPriceNum = typeof diag.currentPrice === "number" ? diag.currentPrice : null;
    return {
      source: "polymarket",
      formula_version: FIREMODEL1_1_RESEARCH_METRIC_VERSION,
      event_slug: ps.eventTitle,
      market_slug: pair.marketSource.headline,
      condition_id: diag.conditionId,
      selected_outcome: diag.selectedOutcome,
      premium_signal: ps,
      market_source: pair.marketSource,
      market_sources: null,
      diagnostics: {
        ...diag,
        fireModelAlias: "FireModel1.1",
        entryGate: "score>=50_coverage>=25",
        isResearchCandidate: true,
        researchScore: ps.winProbability,
        researchDataCoverage: diag.dataCoverage,
        smartMoneyScore: smartMoneyScore ?? null,
        gameStartIso: diag.gameStartIso ?? null,
        recentTradeCash: diag.recentTradeCash ?? null,
      },
      score: null,
      expires_at: defaultExpiresAt,
      selected_token_id: diag.selectedTokenId,
      entry_price_num: entryPriceNum,
      signal_confidence_num: ps.winProbability,
      expected_return_pct_num: parsePercentLikeNumber(ps.profit),
      trust_metrics: Array.isArray(ps.metrics) && ps.metrics.length > 0 ? ps.metrics : null,
      smart_money_score_num: typeof smartMoneyScore === "number" ? smartMoneyScore : null,
      whale_public_score_num: typeof whalePublicScore === "number" ? whalePublicScore : null,
      pre_event_score_num: typeof preEventScore === "number" ? preEventScore : null,
      signal_result: null,
      resolved_at: null,
      winning_outcome: null,
      realized_return_pct: null,
      metric_formula_version: FIREMODEL1_1_RESEARCH_METRIC_VERSION,
    };
  });
}

/**
 * Read latest non-expired generated signal pairs from cache
 */
export async function readLatestGeneratedSignalPairs(
  limit: number
): Promise<CachedSignalPair[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id, premium_signal, market_source, diagnostics, score, created_at, expires_at")
    .gt("expires_at", new Date().toISOString())
    // Exclude shadow research rows (metric_formula_version LIKE 'shadow-%').
    // OR preserves legacy production rows where metric_formula_version IS NULL.
    .or("metric_formula_version.is.null,metric_formula_version.not.like.shadow-%")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read cached signal pairs: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row) => ({
    id: row.id,
    premiumSignal: row.premium_signal as PremiumSignal,
    marketSource: row.market_source as MarketSource,
    diagnostics: row.diagnostics as LandingCardDiagnostics,
    score: row.score ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

// Parses a percent string like "+38%" or "-5.5%" to a number (38, -5.5).
// Returns null for unparseable input.
function parsePercentLikeNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const match = raw.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return isNaN(n) ? null : n;
}

// Returns the numeric value of the first metric whose label contains `keyword` (case-insensitive).
function findMetricValue(
  metrics: Array<{ label: string; value: number }> | undefined | null,
  keyword: string
): number | null {
  if (!metrics) return null;
  const kw = keyword.toLowerCase();
  const found = metrics.find((m) => m.label.toLowerCase().includes(kw));
  return found != null ? found.value : null;
}

/**
 * Write generated signal pairs to cache
 */
export async function writeGeneratedSignalPairs(
  input: WritePairsInput
): Promise<number> {
  const rows = input.pairs.map((pair) => {
    const { premiumSignal: ps, diagnostics: diag } = pair;

    // --- immutable point-in-time performance snapshot ---
    const selectedTokenId = diag.selectedTokenId ?? null;
    const entryPriceNum =
      typeof diag.currentPrice === "number" ? diag.currentPrice : null;
    const signalConfidenceNum =
      typeof ps.winProbability === "number" ? ps.winProbability : null;
    const expectedReturnPctNum = parsePercentLikeNumber(ps.profit);
    const trustMetrics =
      Array.isArray(ps.metrics) && ps.metrics.length > 0 ? ps.metrics : null;
    const smartMoneyScoreNum = findMetricValue(ps.metrics, "smart money");
    const whalePublicScoreNum =
      findMetricValue(ps.metrics, "whale") ??
      findMetricValue(ps.metrics, "public");
    const preEventScoreNum = findMetricValue(ps.metrics, "pre");

    return {
      source: input.source,
      formula_version: input.formulaVersion,
      event_slug: ps.eventTitle,
      market_slug: pair.marketSource.headline,
      condition_id: diag.conditionId,
      selected_outcome: diag.selectedOutcome,
      premium_signal: ps,
      market_source: pair.marketSource,
      market_sources: pair.marketSources ?? null,
      diagnostics: diag,
      score: null, // score field doesn't exist on diagnostics
      expires_at: input.expiresAt,
      // performance snapshot columns
      selected_token_id: selectedTokenId,
      entry_price_num: entryPriceNum,
      signal_confidence_num: signalConfidenceNum,
      expected_return_pct_num: expectedReturnPctNum,
      trust_metrics: trustMetrics,
      smart_money_score_num: smartMoneyScoreNum,
      whale_public_score_num: whalePublicScoreNum,
      pre_event_score_num: preEventScoreNum,
      // result columns — unpopulated; filled by future resolver
      signal_result: null,
      resolved_at: null,
      winning_outcome: null,
      realized_return_pct: null,
      metric_formula_version: "v2-lite-growth-safe",
    };
  });

  const insertQuery = supabaseAdmin.from("generated_signal_pairs").insert(rows) as any;
  const { data, error, count } = typeof insertQuery.select === "function"
    ? await insertQuery.select("id")
    : await insertQuery;

  if (error) {
    throw new Error(`Failed to write signal pairs: ${error.message}`);
  }

  await projectInsertedRows(data, rows.length);
  return count ?? rows.length;
}

/**
 * Write WC shadow candidates as shadow rows in generated_signal_pairs.
 * Deduplicates by (condition_id, selected_token_id) against existing shadow rows.
 * Returns the count of newly inserted rows. Throws on DB error (caller wraps in fail-open try/catch).
 *
 * Both the dedup read and the insert are chunked, so a large batch degrades
 * into many bounded requests instead of one oversized request that fails
 * wholesale. A mid-batch insert failure keeps the rows already committed and
 * surfaces the error to the caller rather than discarding the whole run.
 */
export interface StrategicShadowMaterializationRecord {
  providerEventId: string | null;
  conditionId: string;
  sportCode: string | null;
  outcome: "MATERIALIZED" | "PREEXISTING_DEDUP";
}

/**
 * Row-level writer conservation ledger.
 *
 * Every proposed candidate lands in exactly one terminal bucket:
 *   rowsProposed === rowsInserted + rowsDeduped + rowsExplicitlyRejected
 * (when `writeFailed` is false). Nothing may silently disappear between the
 * producer and `generated_signal_pairs`.
 */
export interface StrategicShadowWriteConservation {
  rowsProposed: number;
  rowsInserted: number;
  /** Collapsed as exact conditionId::tokenId duplicates (intra-batch + preexisting). */
  rowsDeduped: number;
  /** Dropped for a named, attributable reason. */
  rowsExplicitlyRejected: number;
  rejectionsByReason: Record<string, number>;
  writeFailed: boolean;
  conservationOk: boolean;
  /** Rows emitted WITHOUT a complete exact provider event identity. */
  rowsMissingProviderEventContext: number;
}

export interface StrategicShadowWriteDetail {
  inserted: number;
  materializationRecords: StrategicShadowMaterializationRecord[];
  conservation: StrategicShadowWriteConservation;
}

/**
 * THE exact provider event identity carried on every emitted shadow row.
 *
 * Downstream (`exactProviderEventIdentity` in lib/executor/contractADecisions.ts,
 * `providerContextOf` in lib/executor/buildFireModelCandidates.ts) accepts ONLY
 * this structured object — a flat `providerEventId` field is invisible to it.
 * Emitting the flat field alone is exactly how broad structured-sports rows lost
 * their provider lineage and fell back to slug identity.
 *
 * Returns null rather than inventing an identity: the contract requires a real
 * provider event ID plus a parseable authoritative start. Title and slug are
 * carried as context only and are NEVER the identity authority.
 */
export function buildShadowProviderEventContext(
  entry: WcShadowEntry,
): NonNullable<LandingCardDiagnostics["providerEventContext"]> | null {
  const eventId = typeof entry.providerEventId === "string" ? entry.providerEventId.trim() : "";
  const startIso = typeof entry.gameStartIso === "string" ? entry.gameStartIso.trim() : "";
  if (!eventId || !startIso || !Number.isFinite(Date.parse(startIso))) return null;

  const sportFamily = typeof entry.providerSportFamily === "string" ? entry.providerSportFamily.trim() : "";
  const league = typeof entry.providerSportCode === "string" ? entry.providerSportCode.trim() : "";
  const eventSlug = typeof entry.eventSlug === "string" ? entry.eventSlug.trim() : "";
  const eventTitle = typeof entry.eventTitle === "string" ? entry.eventTitle.trim() : "";
  const marketQuestion = typeof entry.marketQuestion === "string" ? entry.marketQuestion.trim() : "";
  const providerMarketId = typeof entry.providerMarketId === "string" ? entry.providerMarketId.trim() : "";
  const marketType = typeof entry.marketType === "string" ? entry.marketType.trim().toLowerCase() : "";
  const gameId = typeof entry.gameId === "string" ? entry.gameId.trim() : "";
  const teamAId = typeof entry.teamAId === "string" ? entry.teamAId.trim() : "";
  const teamBId = typeof entry.teamBId === "string" ? entry.teamBId.trim() : "";

  return {
    v: "v1",
    provider: "polymarket",
    eventId,
    eventStartIso: startIso,
    ...(eventSlug ? { eventSlug } : {}),
    ...(eventTitle ? { eventTitle } : {}),
    ...(marketQuestion ? { marketQuestion } : {}),
    ...(sportFamily ? { sportFamily } : {}),
    ...(league ? { league } : {}),
    ...(providerMarketId ? { providerMarketId } : {}),
    ...(marketType ? { marketType } : {}),
    ...(gameId ? { gameId } : {}),
    ...(teamAId ? { teamAId } : {}),
    ...(teamBId ? { teamBId } : {}),
    ...(entry.providerSportTagIds?.length ? { sportTagIds: [...entry.providerSportTagIds] } : {}),
    ...(entry.providerSeriesIds?.length ? { seriesIds: [...entry.providerSeriesIds] } : {}),
  };
}

function hasMatchingStructuredSportCarrier(diagnostics: unknown, entry: WcShadowEntry): boolean {
  if (!diagnostics || typeof diagnostics !== "object") return false;
  const diag = diagnostics as Record<string, unknown>;
  const context = diag.providerEventContext;
  if (!context || typeof context !== "object") return false;
  const providerContext = context as Record<string, unknown>;
  const normalize = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const expectedCode = normalize(entry.providerSportCode);
  const expectedFamily = normalize(entry.providerSportFamily);
  return normalize(diag.providerSportCode) === expectedCode &&
    normalize(diag.providerSportFamily) === expectedFamily &&
    normalize(diag.providerEventId) === normalize(entry.providerEventId) &&
    normalize(diag.providerMarketId) === normalize(entry.providerMarketId) &&
    normalize(providerContext.eventId) === normalize(entry.providerEventId) &&
    normalize(providerContext.providerMarketId) === normalize(entry.providerMarketId) &&
    normalize(providerContext.sportFamily) === expectedFamily &&
    normalize(providerContext.league) === expectedCode;
}

export function writeStrategicShadowPairs(
  candidates: WcShadowEntry[],
  defaultExpiresAt: string,
): Promise<number>;
export function writeStrategicShadowPairs(
  candidates: WcShadowEntry[],
  defaultExpiresAt: string,
  options: { detailed: true },
): Promise<StrategicShadowWriteDetail>;
export async function writeStrategicShadowPairs(
  candidates: WcShadowEntry[],
  defaultExpiresAt: string,
  options?: { detailed: true },
): Promise<number | StrategicShadowWriteDetail> {
  const rejectionsByReason: Record<string, number> = {};
  let rowsMissingProviderEventContext = 0;
  const rejectRows = (reason: string, n: number) => {
    if (n > 0) rejectionsByReason[reason] = (rejectionsByReason[reason] ?? 0) + n;
  };
  const detail = (
    inserted: number,
    materializationRecords: StrategicShadowMaterializationRecord[],
    deduped: number,
    writeFailed = false,
  ) => {
    const rowsExplicitlyRejected = Object.values(rejectionsByReason).reduce((a, b) => a + b, 0);
    const conservation: StrategicShadowWriteConservation = {
      rowsProposed: candidates.length,
      rowsInserted: inserted,
      rowsDeduped: deduped,
      rowsExplicitlyRejected,
      rejectionsByReason,
      writeFailed,
      conservationOk:
        writeFailed || candidates.length === inserted + deduped + rowsExplicitlyRejected,
      rowsMissingProviderEventContext,
    };
    return options?.detailed ? { inserted, materializationRecords, conservation } : inserted;
  };
  if (candidates.length === 0) return detail(0, [], 0);

  const liquidityEligibleCandidates = candidates.filter((candidate) => {
    const volume = candidate.eventVolumeUsd;
    const eligible = hasEligibleEventVolume(volume);
    if (!eligible) rejectRows(volume == null ? "EVENT_VOLUME_UNKNOWN" : "EVENT_VOLUME_BELOW_MINIMUM", 1);
    return eligible;
  });
  if (liquidityEligibleCandidates.length === 0) return detail(0, [], 0);

  // Intra-batch dedup: collapse duplicates within the candidates array itself.
  // Collectors may return the same conditionId::selectedTokenId multiple times
  // (e.g., same event appearing in both series and game_id sub-event responses).
  const batchKeys = new Set<string>();
  const uniqueCandidates = liquidityEligibleCandidates.filter((c) => {
    const k = `${c.conditionId}::${c.selectedTokenId}`;
    if (batchKeys.has(k)) return false;
    batchKeys.add(k);
    return true;
  });

  // Read-before-write dedup: suppress only identities that are currently
  // serving. Historical generated rows are lineage, not producer authority.
  // The condition-id list is chunked: a broad structured-sports batch carries
  // tens of thousands of distinct condition IDs, and a single .in() over all of
  // them serialises into a multi-megabyte query string that the PostgREST
  // endpoint rejects outright — which silently failed the whole write and left
  // zero broad rows persisted. Chunking keeps every request inside a sane URL
  // budget while preserving exact-ID dedup semantics.
  const conditionIds = [...new Set(uniqueCandidates.map((c) => c.conditionId))];
  const dedupChunks = chunkArray(conditionIds, SHADOW_DEDUP_QUERY_CHUNK);
  if (dedupChunks.length > SHADOW_DEDUP_MAX_QUERIES) {
    // Fail closed and fast if the producer outgrows the indexed request
    // budget; writing a half-deduplicated batch would corrupt the shadow set.
    // See writeBatching.ts for the measured budget and exact index.
    throw new Error(
      `${SHADOW_DEDUP_BUDGET_EXCEEDED}: ${conditionIds.length} condition ids need ` +
        `${dedupChunks.length} dedup queries (budget ${SHADOW_DEDUP_MAX_QUERIES}); ` +
        `current_signal_pair_serving needs its primary identity index on ` +
        `(condition_id, selected_token_id, metric_formula_version)`,
    );
  }

  const candidateByKey = new Map(
    uniqueCandidates.map((candidate) => [
      `${candidate.conditionId}::${candidate.selectedTokenId}::shadow-strategic-sports-v1`,
      candidate,
    ]),
  );
  const existingKeys = new Set<string>();
  for (const chunk of dedupChunks) {
    const { data: existing, error: dedupError } = await supabaseAdmin
      .from("current_signal_pair_serving")
      .select("condition_id, selected_token_id, metric_formula_version, diagnostics")
      .in("condition_id", chunk)
      .eq("metric_formula_version", "shadow-strategic-sports-v1")
      .eq("projection_status", "ACTIVE")
      .is("signal_result", null)
      .gt("expires_at", new Date().toISOString());

    if (dedupError) {
      throw new Error(`Failed to read current serving shadow pairs: ${dedupError.message}`);
    }
    for (const r of existing ?? []) {
      const key = `${r.condition_id}::${r.selected_token_id}::${r.metric_formula_version}`;
      const candidate = candidateByKey.get(key);
      if (candidate && hasMatchingStructuredSportCarrier(r.diagnostics, candidate)) {
        existingKeys.add(key);
      }
    }
  }

  const dedupedCandidates = uniqueCandidates.filter(
    (c) => !existingKeys.has(`${c.conditionId}::${c.selectedTokenId}::shadow-strategic-sports-v1`)
  );
  // Never fabricate a side for the broad structured-sports path: it always
  // sets selectedOutcome from a real provider outcome index, so a null here
  // means the tuple was malformed and must not be silently defaulted to
  // "Yes". Legacy targeted collectors (WC2026/ESPORT/NBA/NHL) keep their
  // pre-existing "Yes" fallback below -- unchanged, to avoid breaking their
  // established contract.
  const newCandidates = dedupedCandidates.filter(
    (c) => c.shadowReason !== "BROAD_STRUCTURED_SPORTS_V1" || c.selectedOutcome != null
  );
  // Attributable terminal outcome for every candidate that does NOT reach the
  // insert: intra-batch duplicate, preexisting row, or named rejection. A
  // dropped-and-uncounted candidate is exactly the silent producer loss this
  // ledger exists to make impossible.
  const rowsDeduped =
    (liquidityEligibleCandidates.length - uniqueCandidates.length) +
    (uniqueCandidates.length - dedupedCandidates.length);
  rejectRows("MALFORMED_OUTCOME_TUPLE", dedupedCandidates.length - newCandidates.length);
  const materializationRecords: StrategicShadowMaterializationRecord[] = [
    ...uniqueCandidates
      .filter((c) => existingKeys.has(`${c.conditionId}::${c.selectedTokenId}::shadow-strategic-sports-v1`))
      .map((c) => ({
        providerEventId: c.providerEventId ?? null,
        conditionId: c.conditionId,
        sportCode: c.providerSportCode ?? null,
        outcome: "PREEXISTING_DEDUP" as const,
      })),
  ];
  if (newCandidates.length === 0) return detail(0, materializationRecords, rowsDeduped);

  const rows = newCandidates.map((entry) => {
    // Per-row expiry: game endDate + 48h buffer so resolver can process it after settlement.
    // Falls back to defaultExpiresAt (30d) when endDate is unavailable.
    const providerEventContext = buildShadowProviderEventContext(entry);
    if (!providerEventContext) rowsMissingProviderEventContext += 1;
    const rowExpiresAt = entry.eventEndIso
      ? new Date(new Date(entry.eventEndIso).getTime() + 48 * 3600 * 1000).toISOString()
      : defaultExpiresAt;
    return {
      source: "polymarket",
      formula_version: "shadow-strategic-sports-v1",
      event_slug: entry.eventTitle,
      market_slug: entry.marketQuestion,
      condition_id: entry.conditionId,
      selected_outcome:
        entry.shadowReason === "BROAD_STRUCTURED_SPORTS_V1" ? entry.selectedOutcome : (entry.selectedOutcome ?? "Yes"),
      premium_signal: {
        eventTitle: entry.eventTitle,
        marketQuestion: entry.marketQuestion,
        winProbability: entry.entryPriceNum,
      },
      market_source: {
        headline: entry.marketQuestion,
        type: "sports",
      },
      market_sources: null,
      diagnostics: {
        conditionId: entry.conditionId,
        selectedTokenId: entry.selectedTokenId,
        // Exact provider event identity, structured. This is the ONLY shape
        // downstream Contract A / candidate building reads; the flat
        // `providerEventId` below is diagnostics, not identity.
        providerEventContext,
        isShadow: true,
        shadowScope: entry.shadowScope,
        shadowReason: entry.shadowReason,
        marketType: entry.marketType ?? null,
        marketSlug: entry.marketSlug ?? null,
        marketTitle: entry.marketTitle ?? null,
        entryPrice: entry.entryPriceNum,
        tier: entry.tier,
        outcomeName: entry.outcomeName ?? null,
        tokenIndex: entry.tokenIndex ?? null,
        priceBucket: entry.priceBucket ?? null,
        volumeUsd: entry.volumeUsd ?? null,
        eventVolumeUsd: entry.eventVolumeUsd ?? null,
        v1EligibilityReason: entry.v1EligibilityReason ?? null,
        marketFamily: entry.marketFamily ?? null,
        gameStartIso: entry.gameStartIso ?? null,
        // Structured provider-sport contract (commit 1). Raw and open --
        // never normalized/aliased here; model-boundary normalization is a
        // separate, later commit.
        providerSportCode: entry.providerSportCode ?? null,
        providerSportFamily: entry.providerSportFamily ?? null,
        providerSportSource: entry.providerSportSource ?? null,
        providerSportTagIds: entry.providerSportTagIds ?? null,
        providerSeriesIds: entry.providerSeriesIds ?? null,
        providerEventId: entry.providerEventId ?? null,
        producerRunId: entry.producerRunId ?? null,
        providerMarketId: entry.providerMarketId ?? null,
        gameId: entry.gameId ?? null,
        teamAId: entry.teamAId ?? null,
        teamBId: entry.teamBId ?? null,
        ambiguousSport: entry.ambiguousSport ?? null,
        tokenSelectionMethod: entry.tokenSelectionMethod ?? null,
      },
      score: null,
      expires_at: rowExpiresAt,
      selected_token_id: entry.selectedTokenId,
      entry_price_num: entry.entryPriceNum,
      signal_confidence_num: null,
      expected_return_pct_num: null,
      trust_metrics: null,
      smart_money_score_num: null,
      whale_public_score_num: null,
      pre_event_score_num: null,
      signal_result: null,
      resolved_at: null,
      winning_outcome: null,
      realized_return_pct: null,
      metric_formula_version: "shadow-strategic-sports-v1",
    };
  });

  let inserted = 0;
  for (const chunk of chunkArray(rows, SHADOW_INSERT_CHUNK)) {
    const insertQuery = supabaseAdmin.from("generated_signal_pairs").insert(chunk) as any;
    const { data, error, count } = typeof insertQuery.select === "function"
      ? await insertQuery.select("id")
      : await insertQuery;

    if (error) {
      // WRITE_FAILED is a terminal, attributable outcome for the remaining
      // rows -- the ledger records it rather than losing them silently.
      rejectRows("WRITE_FAILED", rows.length - inserted);
      throw new Error(
        `Failed to write shadow pairs: ${error.message} (after ${inserted} of ${rows.length} rows)`,
      );
    }
    await projectInsertedRows(data, chunk.length);
    inserted += count ?? chunk.length;
  }

  materializationRecords.push(...newCandidates.map((c) => ({
    providerEventId: c.providerEventId ?? null,
    conditionId: c.conditionId,
    sportCode: c.providerSportCode ?? null,
    outcome: "MATERIALIZED" as const,
  })));
  return detail(inserted, materializationRecords, rowsDeduped);
}

/**
 * Write FireModel1.1 lower-gate research candidates to generated_signal_pairs.
 * These rows have dataCoverage in [25, minDataCoverage) and score >= 50 but are
 * EXCLUDED from the public feed. metric_formula_version='shadow-firemodel1_1_research_v0'.
 * Deduplicates by (condition_id, selected_token_id) against existing research rows.
 * Throws on DB error (caller wraps in fail-open try/catch).
 */
export async function writeFireModel1_1ResearchPairs(
  pairs: LandingCardPair[],
  defaultExpiresAt: string,
): Promise<number> {
  if (pairs.length === 0) return 0;

  const validPairs = pairs.filter(
    (p) => p.diagnostics.conditionId && p.diagnostics.selectedTokenId,
  );
  if (validPairs.length === 0) return 0;

  // Read-before-write dedup: suppress only identities that are currently
  // serving. Historical generated rows remain append-only lineage.
  const conditionIds = validPairs.map((p) => p.diagnostics.conditionId as string);
  const { data: existing } = await supabaseAdmin
    .from("current_signal_pair_serving")
    .select("condition_id, selected_token_id, diagnostics")
    .in("condition_id", conditionIds)
    .eq("metric_formula_version", FIREMODEL1_1_RESEARCH_METRIC_VERSION)
    .eq("projection_status", "ACTIVE")
    .is("signal_result", null)
    .gt("expires_at", new Date().toISOString());

  const existingKeys = new Set<string>(
    (existing ?? [])
      .filter((row) => hasStructuredScoredSportAuthority(row.diagnostics))
      .map((r) => `${r.condition_id}::${r.selected_token_id}`),
  );

  const newPairs = validPairs.filter(
    (p) => !existingKeys.has(`${p.diagnostics.conditionId}::${p.diagnostics.selectedTokenId}`),
  );
  if (newPairs.length === 0) return 0;

  const rows = buildFireModel1_1ResearchRows(newPairs, defaultExpiresAt);

  const insertQuery = supabaseAdmin.from("generated_signal_pairs").insert(rows) as any;
  const { data, error, count } = typeof insertQuery.select === "function"
    ? await insertQuery.select("id")
    : await insertQuery;

  if (error) {
    throw new Error(`Failed to write FireModel1.1 research pairs: ${error.message}`);
  }

  await projectInsertedRows(data, rows.length);
  return count ?? rows.length;
}

/**
 * Write job run record to track generation attempts
 */
export async function writeJobRun(input: JobRunInput): Promise<void> {
  const { error } = await supabaseAdmin.from("job_runs").insert({
    source: input.source,
    formula_version: input.formulaVersion,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    status: input.status,
    generated_count: input.generatedCount,
    rejected_count: input.rejectedCount,
    duration_ms: input.durationMs,
    error_message: input.errorMessage ?? null,
    diagnostics: input.diagnostics ?? null,
  });

  if (error) {
    throw new Error(`Failed to write job run: ${error.message}`);
  }
}
