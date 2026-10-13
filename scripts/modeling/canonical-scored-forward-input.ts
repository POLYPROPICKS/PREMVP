// Canonical scored forward-input adapter (fail-closed, pure, research-only).
//
// Edge under construction
//   public.research_evidence_page_rows -> approved scored input -> Candidate V3 -> frozen B2
// without changing the model, the V3 universe gate, the frozen producer, or any threshold.
//
// STATUS: AUTHORITY_UNVERIFIED. This module is pure: no DB, no network, no env, no wall clock.
// It therefore cannot independently know (a) the DB server clock or (b) the two outcome tokens of a
// condition. Anything a caller hands in for those two facts is a caller assertion, and a caller
// assertion is not authority - a string literal, a TypeScript brand or a factory over arbitrary JSON
// can be forged by whoever builds the input. So the adapter never turns such input into an
// ExportRow, never emits top-level BINARY, and never lets a row reach V3 / frozen B2: every row ends
// in an explicit rejection reason and `rows` is always empty. What it does keep is the diagnostic
// value: precise per-row reject reasons and a receipt that binds all input evidence.
//
// The first missing trusted-source edge is named in REQUIRED_SOURCE_INTEGRATION_CONTRACT.

import { sha, stable } from "../../lib/modeling/frozenModelProducerV2Shadow";
import {
  CANDIDATE_V3_UNIVERSE_GATE_VERSION,
  runCandidateV3Selector,
  type CandidateV3SelectorResult,
} from "./candidate-v3-shadow-universe-gate";

export const CANONICAL_SCORED_ADAPTER_VERSION = "CANONICAL_SCORED_FAIL_CLOSED_ADAPTER_V2" as const;

/** The only verdict this module can produce for authority: it has no trusted source. */
export const CANONICAL_SCORED_AUTHORITY_STATUS = "AUTHORITY_UNVERIFIED" as const;

export const CANONICAL_SCORED_AUTHORITY_GAPS: readonly string[] = [
  "AS_OF_NOT_DB_SERVER_VERIFIED",
  "BINARY_TOKEN_PAIR_NOT_MARKET_METADATA_VERIFIED",
];

/**
 * The next source-integration contract needed before any row may be emitted (outside this file pair):
 * a read-only DB reader that, inside ONE snapshot, itself reads (1) the rows with the explicit
 * SELECT column list, (2) the DB server clock as as-of, and (3) the persisted market-metadata
 * outcome-token pair per condition, and that is the only holder of a module-private capability
 * (not caller-supplied JSON) allowed to hand verified values to the emission path.
 */
export const REQUIRED_SOURCE_INTEGRATION_CONTRACT =
  "DB_SNAPSHOT_READER_OWNS_AS_OF_AND_BINARY_TOKEN_PAIR_V1" as const;

/** The only metric_formula_version this adapter accepts. Not configurable by callers. */
export const APPROVED_SCORED_FORMULA_VERSIONS: readonly string[] = ["v2-lite-growth-safe"];

const T90_OFFSET_MS = 90 * 60_000;

/**
 * The exact column list a caller may SELECT from research_evidence_page_rows.
 * signal_result, pre_event_score_num (an alternative score), formula_version and every
 * outcome/settlement/PnL field are deliberately absent. event_title and market_question are absent
 * too: raw free text cannot be proven to be free of result information, and no decision needs it.
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
  | "BINARY_IDENTITY_UNPROVEN"
  | "AUTHORITY_UNVERIFIED";

export interface CanonicalScoredRejection {
  index: number;
  sourceRowKey: string | null;
  /** sha256 over the allowed (SELECT-list) fields of the source row; identity even when keys are missing. */
  sourceRowSha256: string;
  reason: CanonicalScoredRejectionReason;
}

/** Caller assertion of the evaluation instant. NOT authority: nothing here proves a DB server clock. */
export interface UnverifiedAsOfAssertion {
  asOfIso: string;
}

/** Caller assertion of the two outcome tokens of a condition. NOT authority: not market metadata. */
export interface UnverifiedBinaryTokenPairAssertion {
  conditionId: string;
  outcomeTokenIds: readonly string[];
}

export interface CanonicalScoredAdapterInput {
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  unverifiedAsOf: UnverifiedAsOfAssertion;
  unverifiedBinaryTokenPairs?: readonly UnverifiedBinaryTokenPairAssertion[];
}

export interface CanonicalScoredAdapterResult {
  adapterVersion: typeof CANONICAL_SCORED_ADAPTER_VERSION;
  authorityStatus: typeof CANONICAL_SCORED_AUTHORITY_STATUS;
  authorityGaps: readonly string[];
  requiredSourceIntegrationContract: typeof REQUIRED_SOURCE_INTEGRATION_CONTRACT;
  /** Normalized caller-asserted as-of (unverified). */
  unverifiedAsOfIso: string;
  inputCount: number;
  /** Always empty: no trusted source exists in this module, so nothing may reach V3 / B2. */
  rows: readonly never[];
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceRowKey(row: Readonly<Record<string, unknown>>): string | null {
  const observationId = nonEmptyString(row.observation_id);
  const itemId = nonEmptyString(row.item_observation_id);
  return observationId !== null && itemId !== null ? `${observationId}::${itemId}` : null;
}

const CANONICAL_MAX_DEPTH = 8;

/**
 * Type-tagged canonical form so 70 / "70" / null / absent / Date / bigint remain distinguishable
 * where they differ. JSON.stringify collapses Date -> {} and throws on bigint, which would let two
 * different rows share a digest, so every non-JSON-safe type is tagged explicitly.
 */
function canonicalFieldValue(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return { s: value };
  if (typeof value === "number") return { n: Number.isFinite(value) ? value : String(value) };
  if (typeof value === "boolean") return { b: value };
  if (typeof value === "bigint") return { bi: value.toString() };
  if (value instanceof Date) return { d: Number.isNaN(value.getTime()) ? "INVALID_DATE" : value.toISOString() };
  if (typeof value === "symbol" || typeof value === "function") return { t: typeof value };
  if (depth >= CANONICAL_MAX_DEPTH) return { o: "DEPTH_LIMIT" };
  if (Array.isArray(value)) return { a: value.map((item) => canonicalFieldValue(item, depth + 1)) };
  const record = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) fields[key] = canonicalFieldValue(record[key], depth + 1);
  return { o: fields };
}

/**
 * Identity of a source row over the SELECT-list fields only (all rows, accepted or rejected).
 * Columns outside the list - outcome, settlement, PnL, raw titles - are never read here.
 */
export function canonicalSourceRowSha256(row: unknown): string {
  const fields: Record<string, unknown> = {};
  if (isRecord(row)) {
    for (const column of CANONICAL_SCORED_SELECT_COLUMNS) fields[column] = canonicalFieldValue(row[column]);
  }
  return sha(stable({ record: isRecord(row), fields }));
}

export function normalizeUnverifiedAsOf(asOf: UnverifiedAsOfAssertion): string {
  const ms = isRecord(asOf) ? parseInstantMs(asOf.asOfIso) : null;
  if (ms === null) throw new Error("CANONICAL_SCORED_AS_OF_INVALID");
  return new Date(ms).toISOString();
}

// ---- per-row gates --------------------------------------------------------------------------

interface Prepared {
  index: number;
  key: string | null;
  sha: string;
  conditionId: string;
  tokenId: string;
  ingestedMs: number;
  gameStartMs: number;
  marketType: string | null;
  providerEventId: string | null;
  sportFamily: string | null;
}

type Rejected = { index: number; key: string | null; sha: string; reason: CanonicalScoredRejectionReason };

function prepareRow(source: unknown, index: number, asOfMs: number): Prepared | Rejected {
  const rowSha = canonicalSourceRowSha256(source);
  if (!isRecord(source)) return { index, key: null, sha: rowSha, reason: "IDENTITY_MISSING" };
  const key = sourceRowKey(source);
  const fail = (reason: CanonicalScoredRejectionReason): Rejected => ({ index, key, sha: rowSha, reason });

  // Leak guard first: only key NAMES are inspected; no outcome value is ever read or copied.
  if (Object.keys(source).some(isOutcomeFieldName)) return fail("OUTCOME_FIELD_PRESENT");

  const formulaVersion = nonEmptyString(source.metric_formula_version);
  if (formulaVersion === null || !APPROVED_SCORED_FORMULA_VERSIONS.includes(formulaVersion)) {
    return fail("FORMULA_VERSION_NOT_APPROVED");
  }
  if (finiteNumber(source.signal_confidence_num) === null) return fail("SCORE_MISSING");
  if (finiteNumber(source.entry_price_num) === null) return fail("ENTRY_PRICE_MISSING");

  const conditionId = nonEmptyString(source.condition_id);
  const tokenId = nonEmptyString(source.selected_token_id);
  if (conditionId === null || tokenId === null || nonEmptyString(source.selected_outcome) === null) {
    return fail("IDENTITY_MISSING");
  }

  const observedMs = parseInstantMs(source.observed_at);
  if (observedMs === null) return fail("OBSERVED_AT_INVALID");
  const ingestedMs = parseInstantMs(source.ingested_at);
  if (ingestedMs === null) return fail("INGESTED_AT_INVALID");
  // DBClone cannot have held a row before it was observed.
  if (ingestedMs < observedMs) return fail("INGESTION_PRECEDES_OBSERVATION");
  // Relative to the caller-asserted as-of only; that instant is itself unverified.
  if (observedMs > asOfMs) return fail("FUTURE_OBSERVATION");
  if (ingestedMs > asOfMs) return fail("FUTURE_INGESTION");

  const gameStartMs = parseInstantMs(source.game_start_iso);
  if (gameStartMs === null) return fail("GAME_START_INVALID");

  return {
    index,
    key,
    sha: rowSha,
    conditionId,
    tokenId,
    ingestedMs,
    gameStartMs,
    marketType: nonEmptyString(source.market_type),
    providerEventId: nonEmptyString(source.provider_event_id),
    sportFamily: nonEmptyString(source.provider_sport_family),
  };
}

function isPrepared(value: Prepared | Rejected): value is Prepared {
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

/** Well-formedness of caller assertions only. A well-formed assertion is still NOT authority. */
function buildTokenPairAssertionIndex(
  pairs: readonly UnverifiedBinaryTokenPairAssertion[] | undefined,
): Map<string, ReadonlySet<string> | null> {
  const index = new Map<string, ReadonlySet<string> | null>();
  for (const pair of pairs ?? []) {
    const conditionId = nonEmptyString(pair?.conditionId);
    if (conditionId === null || !Array.isArray(pair.outcomeTokenIds)) continue;
    const tokens = new Set(pair.outcomeTokenIds.map(nonEmptyString).filter((t): t is string => t !== null));
    // Exactly two distinct tokens. A conflicting second assertion for the same condition voids both.
    const valid = tokens.size === 2 && tokens.size === pair.outcomeTokenIds.length ? tokens : null;
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

/**
 * Canonical, order-independent form of every caller token-pair assertion (valid or not), so the
 * receipt binds the exact pair and its condition identity. Tokens are ids, never outcomes.
 */
function canonicalTokenPairAssertions(
  pairs: readonly UnverifiedBinaryTokenPairAssertion[] | undefined,
): Array<{ conditionId: string | null; rawConditionId: unknown; tokenIds: string[] | null }> {
  const entries = (pairs ?? []).map((pair) => ({
    conditionId: nonEmptyString(pair?.conditionId),
    // A non-string / blank token keeps its own typed form, so replacing it still changes the receipt.
    // Raw (untrimmed) conditionId is bound too, so a malformed condition identity cannot collide.
    rawConditionId: canonicalFieldValue(pair?.conditionId),
    tokenIds: Array.isArray(pair?.outcomeTokenIds)
      ? pair.outcomeTokenIds.map((t) => stable(canonicalFieldValue(t))).sort()
      : null,
  }));
  return entries.sort((a, b) => stable(a).localeCompare(stable(b)));
}

// ---- adapter --------------------------------------------------------------------------------

export function adaptCanonicalScoredRows(input: CanonicalScoredAdapterInput): CanonicalScoredAdapterResult {
  const asOfIso = normalizeUnverifiedAsOf(input.unverifiedAsOf);
  const asOfMs = Date.parse(asOfIso);
  const rejections: CanonicalScoredRejection[] = [];
  const addRejection = (r: Rejected) =>
    rejections.push({ index: r.index, sourceRowKey: r.key, sourceRowSha256: r.sha, reason: r.reason });

  const prepared: Prepared[] = [];
  input.rows.forEach((source, index) => {
    const result = prepareRow(source, index, asOfMs);
    if (isPrepared(result)) prepared.push(result);
    else addRejection(result);
  });

  const unprovenEvent = findUnprovenEventRows(prepared);
  const tokenPairs = buildTokenPairAssertionIndex(input.unverifiedBinaryTokenPairs);

  for (const p of prepared) {
    const reject = (reason: CanonicalScoredRejectionReason) =>
      addRejection({ index: p.index, key: p.key, sha: p.sha, reason });

    // T-90 is measured from asserted DBClone availability (ingested_at), not from observed_at.
    if (p.ingestedMs > p.gameStartMs - T90_OFFSET_MS) { reject("T90_VIOLATION"); continue; }
    if (p.marketType === null) { reject("MARKET_TYPE_MISSING"); continue; }
    if (unprovenEvent.has(p)) { reject("EVENT_GROUP_UNPROVEN"); continue; }
    const assertion = tokenPairs.get(p.conditionId);
    if (assertion === undefined || assertion === null || !assertion.has(p.tokenId)) { reject("BINARY_IDENTITY_UNPROVEN"); continue; }
    // Every structural gate passed, but the as-of and the token pair are caller assertions. There is
    // no trusted source in this module, so the row stops here: no ExportRow, no BINARY, no V3, no B2.
    reject("AUTHORITY_UNVERIFIED");
  }

  rejections.sort((a, b) => a.index - b.index);
  const rejectionCounts: Record<string, number> = {};
  for (const rejection of rejections) increment(rejectionCounts, rejection.reason);

  return {
    adapterVersion: CANONICAL_SCORED_ADAPTER_VERSION,
    authorityStatus: CANONICAL_SCORED_AUTHORITY_STATUS,
    authorityGaps: CANONICAL_SCORED_AUTHORITY_GAPS,
    requiredSourceIntegrationContract: REQUIRED_SOURCE_INTEGRATION_CONTRACT,
    unverifiedAsOfIso: asOfIso,
    inputCount: input.rows.length,
    rows: [],
    rejections,
    rejectionCounts: sortedCounts(rejectionCounts),
  };
}

// ---- adapter -> V3 -> frozen B2, with deterministic evidence-binding receipt ----------------

export interface CanonicalScoredForwardReceipt {
  adapterVersion: typeof CANONICAL_SCORED_ADAPTER_VERSION;
  universeGateVersion: typeof CANDIDATE_V3_UNIVERSE_GATE_VERSION;
  authorityStatus: typeof CANONICAL_SCORED_AUTHORITY_STATUS;
  authorityGaps: readonly string[];
  requiredSourceIntegrationContract: typeof REQUIRED_SOURCE_INTEGRATION_CONTRACT;
  unverifiedAsOfIso: string;
  inputCount: number;
  adapterEmittedCount: number;
  adapterRejectionCounts: Record<string, number>;
  /** sha256 over the per-row source digests in source order (accepted and rejected rows alike). */
  inputRowsSha256: string;
  /** Full rejection list: source index, source-row identity, reason. */
  rejections: CanonicalScoredRejection[];
  /** Canonical caller token-pair assertions (condition identity + sorted token pair). Unverified. */
  unverifiedBinaryTokenPairs: Array<{ conditionId: string | null; rawConditionId: unknown; tokenIds: string[] | null }>;
  selector: CandidateV3SelectorResult;
  /** sha256 over the canonical receipt body; contains no wall-clock value and no outcome value. */
  receiptSha256: string;
}

export function runCanonicalScoredForwardV3(input: CanonicalScoredAdapterInput): {
  adapter: CanonicalScoredAdapterResult;
  receipt: CanonicalScoredForwardReceipt;
} {
  const adapter = adaptCanonicalScoredRows(input);
  // The adapter emits nothing, so V3 / frozen B2 are handed an empty set and cannot accept a BET.
  const selector = runCandidateV3Selector(adapter.rows, adapter.unverifiedAsOfIso);
  const body = {
    adapterVersion: adapter.adapterVersion,
    universeGateVersion: CANDIDATE_V3_UNIVERSE_GATE_VERSION,
    authorityStatus: adapter.authorityStatus,
    authorityGaps: adapter.authorityGaps,
    requiredSourceIntegrationContract: adapter.requiredSourceIntegrationContract,
    unverifiedAsOfIso: adapter.unverifiedAsOfIso,
    inputCount: adapter.inputCount,
    adapterEmittedCount: adapter.rows.length,
    adapterRejectionCounts: adapter.rejectionCounts,
    inputRowsSha256: sha(stable(input.rows.map((row) => canonicalSourceRowSha256(row)))),
    rejections: adapter.rejections,
    unverifiedBinaryTokenPairs: canonicalTokenPairAssertions(input.unverifiedBinaryTokenPairs),
    selector,
  };
  return { adapter, receipt: { ...body, receiptSha256: sha(stable(body)) } };
}
