// Canonical scored forward-input adapter (fail-closed, pure, research-only).
//
// Closes the edge
//   public.research_evidence_page_rows -> approved scored input -> Candidate V3 -> frozen B2
// without changing the model, the V3 universe gate, the frozen producer, or any threshold.
//
// What it does: maps typed research_evidence_page_rows columns onto the ExportRow shape
// that runCandidateV3Selector / produceFrozenModelV2ShadowDecisions already consume.
// What it never does: invent a score, a market type, a BINARY label, an event identity or an
// availability time; read outcome/settlement/PnL fields; or re-rank/re-threshold anything.
// Every row that cannot be mapped with proof is returned with an explicit reason code.
//
// No DB, no network, no env, no wall clock: the authoritative server as-of is an input.

import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import { sha, stable } from "../../lib/modeling/frozenModelProducerV2Shadow";
import {
  CANDIDATE_V3_UNIVERSE_GATE_VERSION,
  runCandidateV3Selector,
  type CandidateV3SelectorResult,
} from "./candidate-v3-shadow-universe-gate";

export const CANONICAL_SCORED_ADAPTER_VERSION = "CANONICAL_SCORED_FAIL_CLOSED_ADAPTER_V1" as const;

/** The only metric_formula_version this adapter accepts. Not configurable by callers. */
export const APPROVED_SCORED_FORMULA_VERSIONS: readonly string[] = ["v2-lite-growth-safe"];

const T90_OFFSET_MS = 90 * 60_000;

/**
 * The exact column list a caller may SELECT from research_evidence_page_rows.
 * signal_result, pre_event_score_num (an alternative score), formula_version and every
 * outcome/settlement/PnL field are deliberately absent.
 */
export const CANONICAL_SCORED_SELECT_COLUMNS: readonly string[] = [
  "observation_id",
  "item_observation_id",
  "observed_at",
  "ingested_at",
  "condition_id",
  "selected_token_id",
  "selected_outcome",
  "metric_formula_version",
  "entry_price_num",
  "signal_confidence_num",
  "provider_event_id",
  "provider_sport_family",
  "market_family",
  "market_type",
  "game_start_iso",
  "event_title",
  "market_question",
];

/** Key names that must never appear on an input row (presence check only; values are never read). */
const OUTCOME_KEY_RE = /(^|_)(signal_result|winning_outcome|outcome_status|pnl|settle|settled|settlement|payout|realized|resolution|resolved)(_|$)|^result$/i;

export function isOutcomeFieldName(name: string): boolean {
  return OUTCOME_KEY_RE.test(name);
}

export type CanonicalScoredRejectionReason =
  | "OUTCOME_FIELD_PRESENT"
  | "FORMULA_VERSION_NOT_APPROVED"
  | "SCORE_MISSING"
  | "ENTRY_PRICE_MISSING"
  | "IDENTITY_MISSING"
  | "OBSERVED_AT_INVALID"
  | "INGESTED_AT_INVALID"
  | "INGESTION_PRECEDES_OBSERVATION"
  | "FUTURE_OBSERVATION"
  | "FUTURE_INGESTION"
  | "GAME_START_INVALID"
  | "T90_VIOLATION"
  | "MARKET_TYPE_MISSING"
  | "EVENT_GROUP_UNPROVEN"
  | "BINARY_IDENTITY_UNPROVEN";

export interface CanonicalScoredRejection {
  index: number;
  sourceRowKey: string | null;
  reason: CanonicalScoredRejectionReason;
}

/** Authoritative evaluation instant. Must come from the DB server clock, never a local clock. */
export interface ServerAsOf {
  asOfIso: string;
  authority: "DB_SERVER_CLOCK_TIMESTAMP";
}

/**
 * Positive binary identity for one condition, supplied by an independent market-metadata
 * authority: exactly two distinct outcome tokens, one of which is the row's selected token.
 * research_evidence_page_rows itself carries no such proof.
 */
export interface BinaryIdentityProof {
  conditionId: string;
  outcomeTokenIds: readonly string[];
  authority: "CLOB_MARKET_OUTCOME_TOKENS";
}

export interface CanonicalScoredAdapterInput {
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  serverAsOf: ServerAsOf;
  binaryIdentityProofs?: readonly BinaryIdentityProof[];
}

export interface CanonicalScoredAdapterResult {
  adapterVersion: typeof CANONICAL_SCORED_ADAPTER_VERSION;
  asOfIso: string;
  inputCount: number;
  rows: ExportRow[];
  /** Source index of each emitted row, parallel to `rows`. */
  sourceIndexByOutputRow: number[];
  rejections: CanonicalScoredRejection[];
  rejectionCounts: Record<string, number>;
}

// ---- scalar helpers -------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Strict instant parser: an explicit UTC offset is mandatory, so no local-time guessing. */
function parseInstantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = INSTANT_RE.exec(value.trim());
  if (match === null) return null;
  let offset = match[3];
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2) : "00"}`;
  }
  const ms = Date.parse(`${match[1]}T${match[2]}${offset}`);
  return Number.isFinite(ms) ? ms : null;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceRowKey(row: Readonly<Record<string, unknown>>): string | null {
  const observationId = nonEmptyString(row.observation_id);
  const itemId = nonEmptyString(row.item_observation_id);
  return observationId !== null && itemId !== null ? `${observationId}::${itemId}` : null;
}

export function normalizeServerAsOf(asOf: ServerAsOf): string {
  if (asOf === null || typeof asOf !== "object" || asOf.authority !== "DB_SERVER_CLOCK_TIMESTAMP") {
    throw new Error("CANONICAL_SCORED_AS_OF_AUTHORITY_UNPROVEN");
  }
  const ms = parseInstantMs(asOf.asOfIso);
  if (ms === null) throw new Error("CANONICAL_SCORED_AS_OF_INVALID");
  return new Date(ms).toISOString();
}

// ---- per-row gates --------------------------------------------------------------------------

interface Prepared {
  index: number;
  key: string | null;
  conditionId: string;
  tokenId: string;
  selectedOutcome: string;
  score: number;
  entryPrice: number;
  formulaVersion: string;
  observedMs: number;
  ingestedMs: number;
  gameStartMs: number;
  marketType: string | null;
  providerEventId: string | null;
  sportFamily: string | null;
  source: Readonly<Record<string, unknown>>;
}

function prepareRow(
  source: Readonly<Record<string, unknown>>,
  index: number,
  asOfMs: number,
): Prepared | { index: number; key: string | null; reason: CanonicalScoredRejectionReason } {
  const key = sourceRowKey(source);
  const fail = (reason: CanonicalScoredRejectionReason) => ({ index, key, reason });

  // Leak guard first: only key NAMES are inspected; no outcome value is ever read or copied.
  if (Object.keys(source).some(isOutcomeFieldName)) return fail("OUTCOME_FIELD_PRESENT");

  const formulaVersion = nonEmptyString(source.metric_formula_version);
  if (formulaVersion === null || !APPROVED_SCORED_FORMULA_VERSIONS.includes(formulaVersion)) {
    return fail("FORMULA_VERSION_NOT_APPROVED");
  }
  const score = finiteNumber(source.signal_confidence_num);
  if (score === null) return fail("SCORE_MISSING");
  const entryPrice = finiteNumber(source.entry_price_num);
  if (entryPrice === null) return fail("ENTRY_PRICE_MISSING");

  const conditionId = nonEmptyString(source.condition_id);
  const tokenId = nonEmptyString(source.selected_token_id);
  const selectedOutcome = nonEmptyString(source.selected_outcome);
  if (conditionId === null || tokenId === null || selectedOutcome === null) return fail("IDENTITY_MISSING");

  const observedMs = parseInstantMs(source.observed_at);
  if (observedMs === null) return fail("OBSERVED_AT_INVALID");
  const ingestedMs = parseInstantMs(source.ingested_at);
  if (ingestedMs === null) return fail("INGESTED_AT_INVALID");
  // DBClone cannot have held a row before it was observed.
  if (ingestedMs < observedMs) return fail("INGESTION_PRECEDES_OBSERVATION");
  if (observedMs > asOfMs) return fail("FUTURE_OBSERVATION");
  if (ingestedMs > asOfMs) return fail("FUTURE_INGESTION");

  const gameStartMs = parseInstantMs(source.game_start_iso);
  if (gameStartMs === null) return fail("GAME_START_INVALID");

  return {
    index,
    key,
    conditionId,
    tokenId,
    selectedOutcome,
    score,
    entryPrice,
    formulaVersion,
    observedMs,
    ingestedMs,
    gameStartMs,
    marketType: nonEmptyString(source.market_type),
    providerEventId: nonEmptyString(source.provider_event_id),
    sportFamily: nonEmptyString(source.provider_sport_family),
    source,
  };
}

function isPrepared(value: ReturnType<typeof prepareRow>): value is Prepared {
  return !("reason" in value);
}

/**
 * provider_event_id is only used as the physical-event key when the batch is internally
 * consistent for it (necessary conditions, evaluated on rows already available at as-of):
 *   - one start instant and one sport family per provider_event_id;
 *   - one provider_event_id per condition_id.
 * Anything else, or a missing provider_event_id, is EVENT_GROUP_UNPROVEN.
 */
function findUnprovenEventRows(prepared: readonly Prepared[]): Set<Prepared> {
  const startsByEvent = new Map<string, Set<number>>();
  const sportsByEvent = new Map<string, Set<string>>();
  const eventsByCondition = new Map<string, Set<string>>();
  const addTo = <T>(map: Map<string, Set<T>>, key: string, value: T): void => {
    const bucket = map.get(key);
    if (bucket) bucket.add(value);
    else map.set(key, new Set([value]));
  };
  for (const p of prepared) {
    if (p.providerEventId === null) continue;
    addTo(startsByEvent, p.providerEventId, p.gameStartMs);
    addTo(sportsByEvent, p.providerEventId, p.sportFamily ?? "");
    addTo(eventsByCondition, p.conditionId, p.providerEventId);
  }
  const unproven = new Set<Prepared>();
  for (const p of prepared) {
    const id = p.providerEventId;
    if (
      id === null ||
      (startsByEvent.get(id)?.size ?? 0) > 1 ||
      (sportsByEvent.get(id)?.size ?? 0) > 1 ||
      (eventsByCondition.get(p.conditionId)?.size ?? 0) > 1
    ) {
      unproven.add(p);
    }
  }
  return unproven;
}

function buildBinaryProofIndex(proofs: readonly BinaryIdentityProof[] | undefined): Map<string, ReadonlySet<string> | null> {
  const index = new Map<string, ReadonlySet<string> | null>();
  for (const proof of proofs ?? []) {
    const conditionId = nonEmptyString(proof?.conditionId);
    if (conditionId === null || proof.authority !== "CLOB_MARKET_OUTCOME_TOKENS" || !Array.isArray(proof.outcomeTokenIds)) continue;
    const tokens = new Set(proof.outcomeTokenIds.map(nonEmptyString).filter((t): t is string => t !== null));
    // Exactly two distinct tokens. A conflicting second proof for the same condition voids both.
    const valid = tokens.size === 2 && tokens.size === proof.outcomeTokenIds.length ? tokens : null;
    if (index.has(conditionId)) {
      const previous = index.get(conditionId);
      const same = previous !== null && previous !== undefined && valid !== null && [...valid].every((t) => previous.has(t));
      if (!same) index.set(conditionId, null);
    } else {
      index.set(conditionId, valid);
    }
  }
  return index;
}

// ---- adapter --------------------------------------------------------------------------------

export function adaptCanonicalScoredRows(input: CanonicalScoredAdapterInput): CanonicalScoredAdapterResult {
  const asOfIso = normalizeServerAsOf(input.serverAsOf);
  const asOfMs = Date.parse(asOfIso);
  const rejections: CanonicalScoredRejection[] = [];

  const prepared: Prepared[] = [];
  input.rows.forEach((source, index) => {
    const result = prepareRow(source, index, asOfMs);
    if (isPrepared(result)) prepared.push(result);
    else rejections.push({ index: result.index, sourceRowKey: result.key, reason: result.reason });
  });

  const unprovenEvent = findUnprovenEventRows(prepared);
  const binaryProofs = buildBinaryProofIndex(input.binaryIdentityProofs);

  const emitted: Array<{ index: number; row: ExportRow }> = [];
  for (const p of prepared) {
    const reject = (reason: CanonicalScoredRejectionReason) => rejections.push({ index: p.index, sourceRowKey: p.key, reason });

    // T-90 is measured from confirmed DBClone availability (ingested_at), not from observed_at.
    if (p.ingestedMs > p.gameStartMs - T90_OFFSET_MS) { reject("T90_VIOLATION"); continue; }
    if (p.marketType === null) { reject("MARKET_TYPE_MISSING"); continue; }
    if (unprovenEvent.has(p)) { reject("EVENT_GROUP_UNPROVEN"); continue; }
    const proof = binaryProofs.get(p.conditionId);
    if (proof === undefined || proof === null || !proof.has(p.tokenId)) { reject("BINARY_IDENTITY_UNPROVEN"); continue; }

    const eventTitle = nonEmptyString(p.source.event_title);
    const marketQuestion = nonEmptyString(p.source.market_question);
    emitted.push({
      index: p.index,
      row: {
        condition_id: p.conditionId,
        selected_token_id: p.tokenId,
        selected_outcome: p.selectedOutcome,
        // Source score, verbatim. No alternative score field is read.
        signal_confidence_num: p.score,
        entry_price_num: p.entryPrice,
        metric_formula_version: p.formulaVersion,
        // Availability instant for the as-of and T-90 gates downstream; never observed_at.
        created_at: new Date(p.ingestedMs).toISOString(),
        // Positive binary identity was proven above; this is not inferred from market text.
        market_type: "BINARY",
        canonical_event_key: `provider_event:${p.providerEventId}`,
        ...(eventTitle !== null ? { event_title: eventTitle } : {}),
        ...(marketQuestion !== null ? { market_title: marketQuestion } : {}),
        diagnostics: {
          gameStartIso: new Date(p.gameStartMs).toISOString(),
          // Source market type carried verbatim; classification stays with the V3 gate.
          marketType: p.marketType,
          ...(p.sportFamily !== null ? { providerSportFamily: p.sportFamily } : {}),
          ...(nonEmptyString(p.source.market_family) !== null ? { marketFamily: nonEmptyString(p.source.market_family) } : {}),
          providerEventId: p.providerEventId,
          sourceRowKey: p.key,
          availability: {
            basis: "DBCLONE_INGESTED_AT",
            observedAtIso: new Date(p.observedMs).toISOString(),
            ingestedAtIso: new Date(p.ingestedMs).toISOString(),
          },
        },
      },
    });
  }

  emitted.sort((a, b) => a.index - b.index);
  rejections.sort((a, b) => a.index - b.index);
  const rejectionCounts: Record<string, number> = {};
  for (const rejection of rejections) increment(rejectionCounts, rejection.reason);

  return {
    adapterVersion: CANONICAL_SCORED_ADAPTER_VERSION,
    asOfIso,
    inputCount: input.rows.length,
    rows: emitted.map((e) => e.row),
    sourceIndexByOutputRow: emitted.map((e) => e.index),
    rejections,
    rejectionCounts: sortedCounts(rejectionCounts),
  };
}

// ---- adapter -> V3 -> frozen B2, with deterministic receipt ---------------------------------

export interface CanonicalScoredForwardReceipt {
  adapterVersion: typeof CANONICAL_SCORED_ADAPTER_VERSION;
  universeGateVersion: typeof CANDIDATE_V3_UNIVERSE_GATE_VERSION;
  asOfIso: string;
  inputCount: number;
  adapterEmittedCount: number;
  adapterRejectionCounts: Record<string, number>;
  adapterOutputDigest: string;
  selector: CandidateV3SelectorResult;
  /** sha256 over the canonical receipt body; contains no wall-clock value. */
  receiptSha256: string;
}

export function runCanonicalScoredForwardV3(input: CanonicalScoredAdapterInput): {
  adapter: CanonicalScoredAdapterResult;
  receipt: CanonicalScoredForwardReceipt;
} {
  const adapter = adaptCanonicalScoredRows(input);
  const selector = runCandidateV3Selector(adapter.rows, adapter.asOfIso);
  const adapterOutputDigest = sha(
    stable(
      adapter.rows
        .map((row) => `${(row.diagnostics as Record<string, unknown>).sourceRowKey}|${row.created_at}`)
        .sort(),
    ),
  );
  const body = {
    adapterVersion: adapter.adapterVersion,
    universeGateVersion: CANDIDATE_V3_UNIVERSE_GATE_VERSION,
    asOfIso: adapter.asOfIso,
    inputCount: adapter.inputCount,
    adapterEmittedCount: adapter.rows.length,
    adapterRejectionCounts: adapter.rejectionCounts,
    adapterOutputDigest,
    selector,
  };
  return { adapter, receipt: { ...body, receiptSha256: sha(stable(body)) } };
}
