/**
 * FORWARD_RICH_CAPTURE_V1 — daily research materializer input/output contract.
 *
 * Deterministic, no-LLM, append/cutoff based. The materializer NEVER reads the
 * database directly and NEVER rewrites accepted historical research rows: the
 * caller supplies already-normalized immutable observations and the pure core
 * derives forward-only feature rows from them.
 *
 * Time contract — four explicit instants, never conflated:
 *   DECISION_AT        the signal decision timestamp (from generated_signal_pairs)
 *   FEATURE_OBSERVED_AT the snapshot instant a feature value was observed (GSRS)
 *   SOURCE_CREATED_AT  the immutable source row's own creation instant
 *   MATERIALIZED_AT    when this materializer produced the row
 *
 * Point-in-time rule: only observations with
 *   FEATURE_OBSERVED_AT <= DECISION_AT
 * may become model features. No post-decision leakage. No current-value backfill.
 */

/** One immutable GSRS observation, normalized by the caller. */
export interface ForwardRichSnapshotObservation {
  conditionId: string;
  selectedTokenId: string;
  /** FEATURE_OBSERVED_AT — GSRS snapshot_at (ISO 8601 UTC). */
  snapshotAt: string;
  /** SOURCE_CREATED_AT — GSRS created_at (ISO 8601 UTC). Falls back to snapshotAt. */
  sourceCreatedAt?: string | null;
  snapshotRunId?: string | null;

  /** From diagnostics.scoreObservation.scoreValue. */
  scoreValue: number | null;
  /** From diagnostics.scoreObservation.metricFormulaVersion. */
  scoreMetricFormulaVersion?: string | null;

  /** GSRS selected_price_num. */
  selectedPriceNum: number | null;
  /** GSRS opposing_price_num. */
  opposingPriceNum?: number | null;

  /** GSRS event_id / provider event id where available. */
  providerEventId?: string | null;
  /** GSRS game_start_iso. */
  gameStartIso?: string | null;
  dataCoverageNum?: number | null;
}

/** One immutable generated_signal_pairs decision row, normalized by the caller. */
export interface ForwardRichSignalPair {
  conditionId: string;
  selectedTokenId: string;
  /** DECISION_AT — generated_signal_pairs decision/source timestamp (ISO 8601 UTC). */
  decisionAt: string;
  /** SOURCE_CREATED_AT for the volume/entry semantics — GSP row created_at. */
  sourceCreatedAt: string;

  entryPriceNum: number | null;
  /** diagnostics.volumeUsd — immutable at GSP insert. Never merged with rolling inventory volume. */
  volumeUsd: number | null;

  eventStartIso?: string | null;
  providerEventId?: string | null;

  /** Exact signal-side classification — reused verbatim, never re-derived. */
  marketTypeRaw?: string | null;
  marketFamily?: string | null;
  providerSportCode?: string | null;
  providerSportFamily?: string | null;

  formulaVersion?: string | null;
}

export interface MaterializeForwardRichInput {
  observations: ForwardRichSnapshotObservation[];
  signalPairs: ForwardRichSignalPair[];
  /**
   * Append/cutoff boundary (ISO 8601 UTC). Only identities whose DECISION_AT is
   * strictly after this instant are materialized. Accepted historical rows at or
   * before the cutoff are never touched.
   */
  sinceCutoff: string;
  /** MATERIALIZED_AT — supplied by the caller so the pure core stays clock-free. */
  materializedAt: string;
}

/** A derived feature with its exact observation lineage retained. */
export interface DerivedSeries {
  observationCount: number;
  firstEligibleValue: number | null;
  firstEligibleObservedAt: string | null;
  lastEligibleValue: number | null;
  lastEligibleObservedAt: string | null;
  /** Only present when observationCount >= 2. */
  delta: number | null;
}

export interface ForwardRichResearchRow {
  // ── identity ──────────────────────────────────────────────────────────────
  conditionId: string;
  selectedTokenId: string;
  providerEventId: string | null;

  // ── time contract ────────────────────────────────────────────────────────
  decisionAt: string;
  sourceCreatedAt: string;
  materializedAt: string;

  // ── BASE ─────────────────────────────────────────────────────────────────
  entryPrice: number | null;
  eventStart: string | null;
  leadTimeHours: number | null;
  sport: string | null;
  formulaVersion: string | null;

  // ── RICH: score ──────────────────────────────────────────────────────────
  scoreMetricFormulaVersion: string | null;
  score: DerivedSeries;

  // ── RICH: volume (immutable GSP semantic) ────────────────────────────────
  volumeUsd: number | null;
  volumeSemantic: "generated_signal_pairs.diagnostics.volumeUsd";
  volumeSourceCreatedAt: string;

  // ── RICH: price movement (immutable GSRS observations) ───────────────────
  selectedPrice: DerivedSeries;

  // ── classification (exact signal-side, verbatim) ────────────────────────
  marketTypeRaw: string | null;
  marketFamily: string | null;
  providerSportCode: string | null;
  providerSportFamily: string | null;
  dataCoverage: number | null;

  // ── point-in-time accounting ────────────────────────────────────────────
  eligibleObservationWindowEnd: string;
  totalObservationsSeen: number;
  eligibleObservationsUsed: number;
}
