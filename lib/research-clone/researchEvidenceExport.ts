/**
 * PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 — pure client contract for the bounded
 * narrow research export.
 *
 * This module is deliberately I/O-free: every function here is deterministic and
 * unit-testable without a production or research-clone credential. The runtime
 * caller (a later mission) supplies the transport; this file fixes the shape,
 * the bound, the cursor and the idempotency key so they cannot drift.
 *
 * Why narrow: a bounded read-only production proof on 2026-09-16 measured the
 * 2026-09-14 Minsk day at 179 envelopes / 26,515 evidence rows, ~5.3 KB per
 * evidence item — ~140 MB of operational JSON for one day, of which the
 * research/model-ready pipeline reads the 18 fields below. The server-side
 * projection (supabase/migrations/20260916140000_research_evidence_page.sql)
 * returns exactly these fields and never returns evidence_rows.
 */

/** Server-side clamp mirrored here so a client can never ask for more. */
export const RESEARCH_EVIDENCE_PAGE_MAX_ENVELOPES = 20;

/** Lowest UUID — the bootstrap tie-breaker for a cursor with no prior position. */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Cursor position: the row-value pair the SQL function compares against. */
export interface EvidenceCursor {
  observedAt: string;
  observationId: string;
}

/** One flattened evidence row as returned by research_evidence_page. */
export interface NarrowEvidenceRow {
  observation_id: string;
  observed_at: string;
  item_observation_id: string;
  condition_id: string | null;
  selected_token_id: string | null;
  metric_formula_version: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  signal_result: string | null;
  formula_version: string | null;
  pre_event_score_num: number | null;
  provider_event_id: string | null;
  provider_sport_code: string | null;
  provider_sport_family: string | null;
  market_family: string | null;
  market_type: string | null;
  game_start_iso: string | null;
  /** Current: diagnostics.parentEventVolume24hr; historical fallback: diagnostics.volumeUsd. */
  volume_usd: number | null;
  /** Which source path supplied volume_usd (see VOLUME_SEMANTIC_*); null when volume_usd is null. */
  volume_semantic: string | null;
  /** Evidence item top-level selected_outcome, verbatim. */
  selected_outcome: string | null;
  /** Decision-time diagnostics.dataCoverage, verbatim. */
  data_coverage: number | null;
}

export const VOLUME_SEMANTIC_PARENT_EVENT_24H =
  "primary_evidence_outbox.evidence_rows[].diagnostics.parentEventVolume24hr";
export const VOLUME_SEMANTIC_LEGACY_VOLUME_USD =
  "primary_evidence_outbox.evidence_rows[].diagnostics.volumeUsd";

/** Clone table + provenance tag written by the runtime consumer. */
export const CLONE_EVIDENCE_TABLE = "research_evidence_page_rows";
export const CLONE_EVIDENCE_SOURCE_KIND = "PRODUCTION_RESEARCH_EVIDENCE_PAGE";

/** Exact argument set for one research_evidence_page call. */
export interface EvidencePageArgs {
  p_after_observed_at: string;
  p_after_observation_id: string;
  p_until: string;
  p_max_envelopes: number;
}

export class ResearchExportContractError extends Error {}

/**
 * Builds the arguments for one bounded page. Enforces, client-side, the same
 * invariants the SQL function enforces server-side, so a violation fails before
 * it ever reaches production rather than being silently clamped.
 */
export function buildEvidencePageArgs(
  cursor: EvidenceCursor,
  untilIso: string,
  maxEnvelopes: number = RESEARCH_EVIDENCE_PAGE_MAX_ENVELOPES,
): EvidencePageArgs {
  if (!untilIso || !Number.isFinite(Date.parse(untilIso))) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_UPPER_TIME_BOUND_REQUIRED");
  }
  if (!Number.isInteger(maxEnvelopes) || maxEnvelopes < 1) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_PAGE_BOUND_INVALID");
  }
  if (maxEnvelopes > RESEARCH_EVIDENCE_PAGE_MAX_ENVELOPES) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_PAGE_BOUND_EXCEEDED");
  }
  if (!Number.isFinite(Date.parse(cursor.observedAt))) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_CURSOR_INVALID");
  }
  return {
    p_after_observed_at: cursor.observedAt,
    p_after_observation_id: cursor.observationId,
    p_until: untilIso,
    p_max_envelopes: maxEnvelopes,
  };
}

/**
 * Bootstrap cursor for a day or an explicit `--since`: one millisecond before
 * the window start, with the lowest UUID, so the first strictly-greater
 * comparison includes a row sitting exactly on the boundary. This is the
 * explicit start authority that replaces "a watermark must already exist".
 */
export function bootstrapCursor(sinceIso: string): EvidenceCursor {
  const ms = Date.parse(sinceIso);
  if (!Number.isFinite(ms)) throw new ResearchExportContractError("RESEARCH_EXPORT_SINCE_INVALID");
  return { observedAt: new Date(ms - 1).toISOString(), observationId: ZERO_UUID };
}

/**
 * Cursor after a page. Deterministic: the page is already ordered by
 * (observed_at, observation_id), so the last row is the greatest position. An
 * empty page never moves the cursor.
 */
export function nextCursor(rows: readonly NarrowEvidenceRow[], current: EvidenceCursor): EvidenceCursor {
  if (rows.length === 0) return current;
  const last = rows[rows.length - 1];
  return { observedAt: last.observed_at, observationId: last.observation_id };
}

/** Strict ordering comparison on the (observed_at, observation_id) pair. */
export function compareCursor(left: EvidenceCursor, right: EvidenceCursor): -1 | 0 | 1 {
  const byTime = left.observedAt.localeCompare(right.observedAt);
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  const byId = left.observationId.localeCompare(right.observationId);
  if (byId !== 0) return byId < 0 ? -1 : 1;
  return 0;
}

/** True when a page advanced strictly past the position it was fetched from. */
export function cursorAdvanced(before: EvidenceCursor, after: EvidenceCursor): boolean {
  return compareCursor(after, before) > 0;
}

/**
 * Idempotency key for clone ingestion. An evidence item is uniquely identified
 * by its envelope plus its own observation id — replaying a page upserts the
 * same keys and can never create a semantic duplicate.
 */
export const CLONE_EVIDENCE_CONFLICT_KEY = "observation_id,item_observation_id";

export function narrowRowKey(row: NarrowEvidenceRow): string {
  return `${row.observation_id}::${row.item_observation_id}`;
}

/**
 * Collapses a page onto its idempotency key, last write winning. Applied before
 * an upsert so a single statement can never carry the same key twice (which
 * PostgreSQL rejects with "cannot affect row a second time").
 */
export function dedupeNarrowRows(rows: readonly NarrowEvidenceRow[]): NarrowEvidenceRow[] {
  const byKey = new Map<string, NarrowEvidenceRow>();
  for (const row of rows) byKey.set(narrowRowKey(row), row);
  return [...byKey.values()];
}

/** Distinct evidence identities in a page — a denominator, never pooled with row counts. */
export function distinctEvidenceIdentities(rows: readonly NarrowEvidenceRow[]): number {
  return new Set(
    rows
      .filter((r) => r.condition_id && r.selected_token_id)
      .map((r) => `${r.condition_id}::${r.selected_token_id}::${r.metric_formula_version ?? ""}`),
  ).size;
}

/** Distinct physical events in a page — a separate denominator. */
export function distinctPhysicalEvents(rows: readonly NarrowEvidenceRow[]): number {
  return new Set(rows.map((r) => r.provider_event_id).filter((v): v is string => !!v)).size;
}

// ── v3: ITEM-LEVEL cursor ────────────────────────────────────────────────────
// research_evidence_page_v3 returns FLATTENED item rows bounded by a ROW count.
// An envelope-level cursor cannot safely paginate a flattened result (a page
// that ends inside an envelope would skip that envelope's remaining items), so
// the v3 cursor is the full (observed_at, observation_id, item_observation_id)
// triplet and always advances to the exact last item returned.

/** Server-side flattened-row clamp mirrored here. */
export const RESEARCH_EVIDENCE_V3_MAX_ROWS = 500;

export interface EvidenceItemCursor extends EvidenceCursor {
  itemObservationId: string;
}

export interface EvidencePageV3Args {
  p_after_observed_at: string;
  p_after_observation_id: string;
  p_after_item_observation_id: string;
  p_until: string;
  p_max_rows: number;
}

export function buildEvidencePageV3Args(
  cursor: EvidenceItemCursor,
  untilIso: string,
  maxRows: number = RESEARCH_EVIDENCE_V3_MAX_ROWS,
): EvidencePageV3Args {
  if (!untilIso || !Number.isFinite(Date.parse(untilIso))) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_UPPER_TIME_BOUND_REQUIRED");
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_PAGE_BOUND_INVALID");
  }
  if (maxRows > RESEARCH_EVIDENCE_V3_MAX_ROWS) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_PAGE_BOUND_EXCEEDED");
  }
  if (!Number.isFinite(Date.parse(cursor.observedAt))) {
    throw new ResearchExportContractError("RESEARCH_EXPORT_CURSOR_INVALID");
  }
  return {
    p_after_observed_at: cursor.observedAt,
    p_after_observation_id: cursor.observationId,
    p_after_item_observation_id: cursor.itemObservationId,
    p_until: untilIso,
    p_max_rows: maxRows,
  };
}

/** One millisecond before the window with the lowest envelope and item UUIDs. */
export function bootstrapItemCursor(sinceIso: string): EvidenceItemCursor {
  const base = bootstrapCursor(sinceIso);
  return { ...base, itemObservationId: ZERO_UUID };
}

/** Advances to the EXACT last item returned; an empty page never moves the cursor. */
export function nextItemCursor(rows: readonly NarrowEvidenceRow[], current: EvidenceItemCursor): EvidenceItemCursor {
  if (rows.length === 0) return current;
  const last = rows[rows.length - 1];
  return {
    observedAt: last.observed_at,
    observationId: last.observation_id,
    itemObservationId: last.item_observation_id,
  };
}

export function compareItemCursor(left: EvidenceItemCursor, right: EvidenceItemCursor): -1 | 0 | 1 {
  const byTime = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  const byEnvelope = left.observationId.localeCompare(right.observationId);
  if (byEnvelope !== 0) return byEnvelope < 0 ? -1 : 1;
  const byItem = left.itemObservationId.localeCompare(right.itemObservationId);
  if (byItem !== 0) return byItem < 0 ? -1 : 1;
  return 0;
}

export function itemCursorAdvanced(before: EvidenceItemCursor, after: EvidenceItemCursor): boolean {
  return compareItemCursor(after, before) > 0;
}
