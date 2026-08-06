// lib/executor/contractADecisions.ts
//
// AUTHORITATIVE CONTRACT A DECISION CONTRACTS (Commit A).
//
// R1 established that Contract A has no explicit lifecycle artifact: the
// planning selector (CONTRACT_A_PLANNING_V1) only stamps two diagnostics keys
// onto a FireModelCandidate, and the final adapter (CONTRACT_A_V1) hardcodes
// inferred_sport="unknown" / strategic_scope="OTHER", reconstructs
// event_start_iso arithmetically, and exposes rejection evidence only as loose
// strings.
//
// This module owns the two explicit lifecycle artifacts under ONE Contract A
// authority:
//
//   1. ContractAPlanningDecision       — the ~17:00 Minsk planning verdict
//   2. ContractAFinalIdentityDecision  — the T-70..T-3 exact-identity verdict
//
// SCOPE — Commit A is strictly ADDITIVE:
//   * nothing here is wired into Reservation, Rebalance or the Queue;
//   * no route, schema, callback or production selection path is changed;
//   * `buildFireModelCandidates` still emits byte-identical candidates.
// Wiring belongs to Commit B/C.
//
// The transformation logic is decomposed into small pure functions
// (resolveContractA*) so each rule is independently testable. The only
// impure entry points are the two `produceContractA*` adapters, which enter
// through the REAL Contract A producer (`buildFireModelCandidates`) rather
// than hand-constructing a finished decision object.

import {
  buildFireModelCandidates,
  resolveContractASportMetadata,
  type FireModelCandidate,
  type StrategicScope,
  type TimingBucket,
  type UpstreamMarketPolicyDecision,
} from "./buildFireModelCandidates";
import { EXECUTABLE_STAKE_USD } from "./executorQueueTypes";

/** Version stamp of the decision CONTRACT itself, independent of the selector. */
export const CONTRACT_A_DECISION_VERSION = "CONTRACT_A_DECISION_V1" as const;

export type ContractADecisionVersion = typeof CONTRACT_A_DECISION_VERSION;

/** The Contract A stage that owns a given decision artifact. */
export type ContractAVersion = "CONTRACT_A_PLANNING_V1" | "CONTRACT_A_V1";

export type ContractADecisionStage = "PLANNING" | "FINAL_IDENTITY";

/**
 * Every reason a Contract A decision can fail closed. Deliberately a closed
 * union: a new failure mode is a contract change, not a free-text string.
 */
export type ContractARejectionReasonCode =
  // planning
  | "NO_PLANNING_CANDIDATE"
  | "MISSING_PHYSICAL_EVENT_ID"
  | "MISSING_CANONICAL_EVENT_START_ISO"
  | "MALFORMED_CANONICAL_EVENT_START_ISO"
  | "MARKET_POLICY_REJECTED"
  // final identity
  | "NO_FINAL_IDENTITY_CANDIDATE"
  | "MISSING_CONDITION_ID"
  | "MISSING_TOKEN_ID"
  | "MISSING_SIDE"
  | "PHYSICAL_EVENT_ID_MISMATCH"
  | "EVENT_START_ISO_MISMATCH"
  | "FINAL_IDENTITY_NOT_LIVE_ELIGIBLE"
  | "AMBIGUOUS_FINAL_IDENTITY_CANDIDATE";

/**
 * One complete deterministic typed rejection trace, shaped so a later commit
 * can persist it verbatim. Contains no payloads, no secrets and no free-form
 * provider data — only operational identity and the exact reason.
 */
export interface ContractARejectionTrace {
  decision_version: ContractADecisionVersion;
  contract_a_version: ContractAVersion;
  stage: ContractADecisionStage;
  reason_code: ContractARejectionReasonCode;
  /** Short, non-sensitive operational context. Never a provider payload. */
  detail: string | null;
  physical_event_id: string | null;
  source_lineage: ContractASourceLineage | null;
}

/**
 * Canonical source lineage. `generated_signal_pair_id` is preserved EXACTLY as
 * the producer supplied it — a non-UUID legacy id stays lineage data and is
 * never silently nulled (the queue's own UUID-only gate is a separate,
 * downstream concern that Commit A does not touch).
 */
export interface ContractASourceLineage {
  generated_signal_pair_id: string | null;
  generated_signal_pair_id_is_uuid: boolean;
  /** `condition_id::token_id` strict-dedup key — never a row id. */
  observation_id: string | null;
  event_slug: string | null;
  provider_event_key: string | null;
}

/** Where the normalized sport metadata on a decision actually came from. */
export type ContractASportMetadataSource = "upstream" | "candidate" | "unresolved";

export interface ContractASportMetadata {
  inferred_sport: string;
  strategic_scope: StrategicScope;
  sport_metadata_source: ContractASportMetadataSource;
  league: string | null;
}

/** Where the canonical event start came from. Never an arithmetic derivation. */
export type ContractAEventStartSource = "source_row_game_start_iso";

export type ContractAEventStartResolution =
  | { ok: true; iso: string; source: ContractAEventStartSource }
  | { ok: false; reason: "MISSING_CANONICAL_EVENT_START_ISO" | "MALFORMED_CANONICAL_EVENT_START_ISO" };

export interface ContractAExecutionWindow {
  stale_after: string | null;
  no_trade_after: string | null;
  timing_bucket: TimingBucket;
}

/** The exact executable identity a later Queue row is built from. */
export interface ContractAExactIdentity {
  condition_id: string;
  token_id: string;
  side: string;
  market_slug: string | null;
  canonical_market_key: string | null;
  event_slug: string | null;
}

/**
 * CONTRACT A PLANNING DECISION.
 *
 * The authoritative ~17:00 Minsk verdict for ONE physical event. It records
 * what was planned and the evidence a later Final Identity Decision needs;
 * it deliberately does NOT assert an executable market identity.
 */
export interface ContractAPlanningDecision {
  decision_version: ContractADecisionVersion;
  contract_a_version: "CONTRACT_A_PLANNING_V1";
  status: "ACCEPTED";
  physical_event_id: string;
  source_lineage: ContractASourceLineage;
  event_start_iso: string;
  event_start_iso_source: ContractAEventStartSource;
  inferred_sport: string;
  strategic_scope: StrategicScope;
  sport_metadata_source: ContractASportMetadataSource;
  league: string | null;
  planning_score: number;
  planning_tier: string;
  planning_rank: number;
  planning_policy_verdict: UpstreamMarketPolicyDecision | null;
  execution_window: ContractAExecutionWindow;
  /** Identity evidence the Final Identity Decision is later checked against. */
  final_identity_evidence: ContractAExactIdentity | null;
  rejection_trace: null;
}

/**
 * CONTRACT A FINAL IDENTITY DECISION.
 *
 * The authoritative T-70..T-3 verdict. Bounded strictly by the physical event
 * its Planning Decision named — it can confirm or fail closed, never
 * substitute a different physical event.
 */
export interface ContractAFinalIdentityDecision {
  decision_version: ContractADecisionVersion;
  contract_a_version: "CONTRACT_A_V1";
  status: "ACCEPTED";
  physical_event_id: string;
  planning_lineage: {
    decision_version: ContractADecisionVersion;
    contract_a_version: "CONTRACT_A_PLANNING_V1";
    physical_event_id: string;
    source_lineage: ContractASourceLineage;
  };
  event_start_iso: string;
  event_start_iso_source: ContractAEventStartSource;
  condition_id: string;
  token_id: string;
  side: string;
  selected_market: ContractAExactIdentity;
  inferred_sport: string;
  strategic_scope: StrategicScope;
  sport_metadata_source: ContractASportMetadataSource;
  price_policy: {
    max_entry_price: number;
    entry_price: number;
    stake_usd: number;
    max_spread: number;
    live_policy_version: string;
    verdict: "ACCEPTED";
  };
  source_lineage: ContractASourceLineage;
  rejection_trace: null;
}

export type ContractADecisionResult<TDecision> =
  | { accepted: true; decision: TDecision }
  | { accepted: false; rejection: ContractARejectionTrace };

// ── Pure functions ────────────────────────────────────────────────────────

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Preserves canonical source lineage. A present-but-non-UUID
 * `generated_signal_pair_id` is kept verbatim and flagged, never dropped:
 * losing it is exactly the lineage hole R1 recorded.
 */
export function resolveContractASourceLineage(
  candidate: Pick<FireModelCandidate, "generated_signal_pair_id" | "signal_id" | "event_slug"> & {
    providerEventKey?: string | null;
  }
): ContractASourceLineage {
  const rowId = nonEmpty(candidate.generated_signal_pair_id);
  return {
    generated_signal_pair_id: rowId,
    generated_signal_pair_id_is_uuid: rowId !== null && UUID_LIKE_RE.test(rowId),
    observation_id: nonEmpty(candidate.signal_id),
    event_slug: nonEmpty(candidate.event_slug),
    provider_event_key: nonEmpty(candidate.providerEventKey ?? null),
  };
}

/**
 * The collision-safe occurrence stamp for a fallback physical event id.
 *
 * The calendar DATE alone is NOT an occurrence: a doubleheader — same event
 * slug, same day, two separate kickoffs — is two distinct physical events, and
 * a date-truncated key silently merged them into one Reservation. The exact
 * start instant is used instead, normalized through `toISOString()` so that
 * `...T21:00:00Z` and `...T21:00:00.000Z` remain ONE identity across runs.
 */
function canonicalOccurrenceStamp(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : iso;
}

/**
 * THE physical event a Contract A decision is about — one identity, owned by
 * Contract A, identical at both stages.
 *
 * This cannot delegate to the producer's own `canonical_event_key`: the
 * planning selector derives a team-pair key (`pair:team-a-vs-team-b:DATE`)
 * while the CONTRACT_A_V1 adapter derives a slug key (`slug:event-slug`) for
 * the SAME physical event, so a decision keyed by the producer would silently
 * fail to bind its own final stage. The canonical identity is therefore built
 * from the two surfaces both stages carry unchanged: the event slug and the
 * exact canonical event start instant (never the calendar date alone — see
 * `canonicalOccurrenceStamp`).
 *
 * Returns null rather than inventing an identity.
 */
export function resolveContractAPhysicalEventId(
  candidate: Pick<FireModelCandidate, "canonical_event_key" | "match_family_key" | "event_slug"> & {
    providerEventKey?: string | null;
  },
  eventStartIso: string | null
): string | null {
  const providerKey = nonEmpty(candidate.providerEventKey ?? null);
  if (providerKey !== null) return `provider:${providerKey.toLowerCase()}`;
  const slug = nonEmpty(candidate.event_slug);
  if (slug !== null && eventStartIso !== null && /^\d{4}-\d{2}-\d{2}T/.test(eventStartIso)) {
    return `event:${slug.trim().toLowerCase()}:${canonicalOccurrenceStamp(eventStartIso)}`;
  }
  return nonEmpty(candidate.canonical_event_key) ?? nonEmpty(candidate.match_family_key);
}

/**
 * Carries the canonical event start from the ONE source that owns it —
 * `diagnostics.gameStartIso` on the provider row. Never reconstructs it from
 * created_at + minutesUntilStart, which is the drift R1 recorded.
 */
export function resolveContractAEventStartIso(
  sourceDiagnostics: Record<string, unknown>
): ContractAEventStartResolution {
  const raw = sourceDiagnostics.gameStartIso;
  if (typeof raw !== "string" || raw.trim() === "" || raw === "null") {
    return { ok: false, reason: "MISSING_CANONICAL_EVENT_START_ISO" };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: "MALFORMED_CANONICAL_EVENT_START_ISO" };
  }
  return { ok: true, iso: raw, source: "source_row_game_start_iso" };
}

/**
 * Preserves real sport metadata. The CONTRACT_A_V1 adapter hardcodes
 * inferred_sport="unknown"/strategic_scope="OTHER"; whenever the source row
 * still carries real upstream metadata, the canonical resolver
 * (`resolveContractASportMetadata` → `resolveModelSport`) wins. There is no
 * second classifier here and no unknown/OTHER substitution when real metadata
 * exists.
 */
export function resolveContractASportForDecision(
  candidate: Pick<FireModelCandidate, "inferred_sport" | "strategic_scope" | "market_slug" | "event_slug" | "authoritativeLeague">,
  sourceDiagnostics: Record<string, unknown>
): ContractASportMetadata {
  const league =
    nonEmpty(candidate.authoritativeLeague ?? null) ??
    nonEmpty((sourceDiagnostics.providerEventContext as Record<string, unknown> | undefined)?.league) ??
    null;
  const identityText = `${candidate.event_slug ?? ""} ${candidate.market_slug ?? ""}`.trim();
  const upstream = resolveContractASportMetadata(sourceDiagnostics, identityText);
  if (upstream.hasStructuredSport && upstream.scope !== "UNKNOWN") {
    return {
      inferred_sport: upstream.rawProviderSportCode ?? upstream.scope.toLowerCase(),
      strategic_scope: upstream.scope,
      sport_metadata_source: "upstream",
      league,
    };
  }
  if (candidate.strategic_scope !== "OTHER" && candidate.strategic_scope !== "UNKNOWN") {
    return {
      inferred_sport: candidate.inferred_sport,
      strategic_scope: candidate.strategic_scope,
      sport_metadata_source: "candidate",
      league,
    };
  }
  return {
    inferred_sport: candidate.inferred_sport,
    strategic_scope: candidate.strategic_scope,
    sport_metadata_source: "unresolved",
    league,
  };
}

/** Builds one deterministic typed rejection trace. */
export function buildContractARejectionTrace(input: {
  contract_a_version: ContractAVersion;
  stage: ContractADecisionStage;
  reason_code: ContractARejectionReasonCode;
  detail?: string | null;
  physical_event_id?: string | null;
  source_lineage?: ContractASourceLineage | null;
}): ContractARejectionTrace {
  return {
    decision_version: CONTRACT_A_DECISION_VERSION,
    contract_a_version: input.contract_a_version,
    stage: input.stage,
    reason_code: input.reason_code,
    detail: input.detail ?? null,
    physical_event_id: input.physical_event_id ?? null,
    source_lineage: input.source_lineage ?? null,
  };
}

/**
 * Constructs the Planning Decision for ONE planning candidate, or the exact
 * reason it cannot exist. Pure: no clock, no I/O.
 */
export function buildContractAPlanningDecision(
  candidate: FireModelCandidate,
  sourceDiagnostics: Record<string, unknown>
): ContractADecisionResult<ContractAPlanningDecision> {
  const lineage = resolveContractASourceLineage(candidate);
  const start = resolveContractAEventStartIso(sourceDiagnostics);
  const physicalEventId = resolveContractAPhysicalEventId(candidate, start.ok ? start.iso : null);
  const reject = (reason: ContractARejectionReasonCode, detail?: string) =>
    ({
      accepted: false as const,
      rejection: buildContractARejectionTrace({
        contract_a_version: "CONTRACT_A_PLANNING_V1",
        stage: "PLANNING",
        reason_code: reason,
        detail: detail ?? null,
        physical_event_id: physicalEventId,
        source_lineage: lineage,
      }),
    });

  if (!start.ok) return reject(start.reason);
  if (physicalEventId === null) return reject("MISSING_PHYSICAL_EVENT_ID");

  const policy = candidate.diagnostics.market_policy ?? null;
  if (policy !== null && policy.allowed === false) {
    return reject("MARKET_POLICY_REJECTED", policy.reason_code);
  }

  const sport = resolveContractASportForDecision(candidate, sourceDiagnostics);
  const conditionId = nonEmpty(candidate.condition_id);
  const tokenId = nonEmpty(candidate.token_id);
  const side = nonEmpty(candidate.side);

  return {
    accepted: true,
    decision: {
      decision_version: CONTRACT_A_DECISION_VERSION,
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      status: "ACCEPTED",
      physical_event_id: physicalEventId,
      source_lineage: lineage,
      event_start_iso: start.iso,
      event_start_iso_source: start.source,
      inferred_sport: sport.inferred_sport,
      strategic_scope: sport.strategic_scope,
      sport_metadata_source: sport.sport_metadata_source,
      league: sport.league,
      planning_score: candidate.diagnostics.score,
      planning_tier: candidate.strategy,
      planning_rank: candidate.rank,
      planning_policy_verdict: policy,
      execution_window: {
        stale_after: nonEmpty(candidate.stale_after),
        no_trade_after: nonEmpty(candidate.no_trade_after),
        timing_bucket: candidate.timing_bucket,
      },
      final_identity_evidence:
        conditionId !== null && tokenId !== null && side !== null
          ? {
              condition_id: conditionId,
              token_id: tokenId,
              side,
              market_slug: nonEmpty(candidate.market_slug),
              canonical_market_key: nonEmpty(candidate.canonical_market_key),
              event_slug: nonEmpty(candidate.event_slug),
            }
          : null,
      rejection_trace: null,
    },
  };
}

/**
 * Constructs the Final Identity Decision for ONE planning decision and ONE
 * final candidate, or the exact reason it cannot exist. Fail-closed: the
 * physical event and the canonical event start must match the Planning
 * Decision exactly, and the executable identity must be complete. Pure.
 */
export function buildContractAFinalIdentityDecision(
  planning: ContractAPlanningDecision,
  candidate: FireModelCandidate,
  sourceDiagnostics: Record<string, unknown>
): ContractADecisionResult<ContractAFinalIdentityDecision> {
  const lineage = resolveContractASourceLineage(candidate);
  const reject = (reason: ContractARejectionReasonCode, detail?: string) =>
    ({
      accepted: false as const,
      rejection: buildContractARejectionTrace({
        contract_a_version: "CONTRACT_A_V1",
        stage: "FINAL_IDENTITY",
        reason_code: reason,
        detail: detail ?? null,
        physical_event_id: planning.physical_event_id,
        source_lineage: lineage,
      }),
    });

  const start = resolveContractAEventStartIso(sourceDiagnostics);
  if (!start.ok) return reject("EVENT_START_ISO_MISMATCH", start.reason);
  if (start.iso !== planning.event_start_iso) return reject("EVENT_START_ISO_MISMATCH");

  const candidatePhysicalEventId = resolveContractAPhysicalEventId(candidate, start.iso);
  if (candidatePhysicalEventId !== planning.physical_event_id) {
    return reject("PHYSICAL_EVENT_ID_MISMATCH", candidatePhysicalEventId ?? "null");
  }

  const conditionId = nonEmpty(candidate.condition_id);
  if (conditionId === null) return reject("MISSING_CONDITION_ID");
  const tokenId = nonEmpty(candidate.token_id);
  if (tokenId === null) return reject("MISSING_TOKEN_ID");
  const side = nonEmpty(candidate.side);
  if (side === null) return reject("MISSING_SIDE");
  // `live_eligible` is the Frozen V2 producer verdict.  A Reservation already
  // owns an accepted Planning Decision, so replaying that verdict here would
  // revoke Planning through a second universe selector.  Current execution
  // timing, price, stake, spread, depth and exact-token checks run downstream
  // in the rebalance path against the same exact candidate.

  const sport = resolveContractASportForDecision(candidate, sourceDiagnostics);

  return {
    accepted: true,
    decision: {
      decision_version: CONTRACT_A_DECISION_VERSION,
      contract_a_version: "CONTRACT_A_V1",
      status: "ACCEPTED",
      physical_event_id: planning.physical_event_id,
      planning_lineage: {
        decision_version: planning.decision_version,
        contract_a_version: planning.contract_a_version,
        physical_event_id: planning.physical_event_id,
        source_lineage: planning.source_lineage,
      },
      event_start_iso: planning.event_start_iso,
      event_start_iso_source: planning.event_start_iso_source,
      condition_id: conditionId,
      token_id: tokenId,
      side,
      selected_market: {
        condition_id: conditionId,
        token_id: tokenId,
        side,
        market_slug: nonEmpty(candidate.market_slug),
        canonical_market_key: nonEmpty(candidate.canonical_market_key),
        event_slug: nonEmpty(candidate.event_slug),
      },
      inferred_sport: sport.inferred_sport,
      strategic_scope: sport.strategic_scope,
      sport_metadata_source: sport.sport_metadata_source,
      price_policy: {
        max_entry_price: candidate.max_entry_price,
        entry_price: candidate.diagnostics.entry_price,
        // The broad Planning candidate proves only the already-reserved exact
        // identity. Queue stake remains the immutable execution policy.
        stake_usd: EXECUTABLE_STAKE_USD,
        max_spread: candidate.max_spread,
        live_policy_version: candidate.live_policy_version,
        verdict: "ACCEPTED",
      },
      source_lineage: lineage,
      rejection_trace: null,
    },
  };
}

// ── Producer adapters (the only impure entry points) ──────────────────────

function diagnosticsOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  const diag = row?.diagnostics;
  return diag && typeof diag === "object" ? (diag as Record<string, unknown>) : {};
}

/**
 * Indexes the supplied source rows by the identity the producer's candidates
 * expose, so a decision can be joined back to the exact row it came from.
 */
function indexSourceRows(
  rows: readonly Record<string, unknown>[]
): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = nonEmpty(row.id);
    if (id !== null && !byId.has(id)) byId.set(id, row);
  }
  return byId;
}

function sourceRowFor(
  candidate: FireModelCandidate,
  byId: Map<string, Record<string, unknown>>,
  rows: readonly Record<string, unknown>[]
): Record<string, unknown> | undefined {
  const id = nonEmpty(candidate.generated_signal_pair_id);
  if (id !== null && byId.has(id)) return byId.get(id);
  return rows.find(
    (row) => nonEmpty(row.condition_id) === nonEmpty(candidate.condition_id)
  );
}

/**
 * Enters the REAL Contract A planning producer and returns one authoritative
 * Planning Decision result per emitted candidate. Additive: it neither mutates
 * the candidates nor changes what the producer emits.
 */
export async function produceContractAPlanningDecisions(
  rows: readonly Record<string, unknown>[],
  limit = 100_000
): Promise<ContractADecisionResult<ContractAPlanningDecision>[]> {
  const { candidates } = await buildFireModelCandidates(limit, "all", true, rows, "CONTRACT_A_PLANNING_V1");
  const byId = indexSourceRows(rows);
  return candidates.map((candidate) =>
    buildContractAPlanningDecision(candidate, diagnosticsOf(sourceRowFor(candidate, byId, rows)))
  );
}

/**
 * Enters the REAL Contract A final producer, bounded by the physical event the
 * Planning Decision named, and returns the authoritative Final Identity
 * Decision or the exact reason it cannot exist. It never widens the universe
 * beyond the supplied rows and never substitutes a different physical event.
 *
 * Structured boundary log only on the fail-closed path: stage, reason code,
 * decision version and the (non-sensitive) physical event id — never a
 * provider payload, token or env value.
 */
export async function produceContractAFinalIdentityDecision(
  planning: ContractAPlanningDecision,
  rows: readonly Record<string, unknown>[],
  limit = 100_000,
  nowMs = Date.now()
): Promise<ContractADecisionResult<ContractAFinalIdentityDecision>> {
  // A Reservation is created only from an accepted Planning Decision.  Its
  // persisted source lineage is therefore the bounded universe for Final
  // Identity: re-applying Frozen V2 here would silently revoke that earlier
  // acceptance.  Re-enter the real Planning candidate producer with only the
  // supplied exact rows; the checks below still require one exact physical
  // event/start/identity match and the downstream live guards remain intact.
  const { candidates } = await buildFireModelCandidates(
    limit,
    "all",
    true,
    rows,
    "CONTRACT_A_PLANNING_V1",
    nowMs
  );
  const byId = indexSourceRows(rows);
  const matches = candidates.filter((candidate) => {
    const start = resolveContractAEventStartIso(diagnosticsOf(sourceRowFor(candidate, byId, rows)));
    const sameLineage =
      planning.source_lineage.generated_signal_pair_id !== null &&
      candidate.generated_signal_pair_id === planning.source_lineage.generated_signal_pair_id;
    const evidence = planning.final_identity_evidence;
    const samePersistedIdentity =
      evidence === null ||
      (candidate.condition_id === evidence.condition_id &&
        candidate.token_id === evidence.token_id &&
        candidate.side === evidence.side);
    return (
      start.ok &&
      start.iso === planning.event_start_iso &&
      resolveContractAPhysicalEventId(candidate, start.iso) === planning.physical_event_id &&
      sameLineage &&
      samePersistedIdentity
    );
  });
  if (matches.length !== 1) {
    const reason_code = matches.length === 0 ? "NO_FINAL_IDENTITY_CANDIDATE" : "AMBIGUOUS_FINAL_IDENTITY_CANDIDATE";
    const rejection = buildContractARejectionTrace({
      contract_a_version: "CONTRACT_A_V1",
      stage: "FINAL_IDENTITY",
      reason_code,
      physical_event_id: planning.physical_event_id,
      source_lineage: planning.source_lineage,
    });
    console.log(
      "[contract-a] final_identity fail_closed",
      JSON.stringify({
        stage: rejection.stage,
        reason_code: rejection.reason_code,
        decision_version: rejection.decision_version,
        physical_event_id: rejection.physical_event_id,
      })
    );
    return { accepted: false, rejection };
  }
  const match = matches[0];
  return buildContractAFinalIdentityDecision(
    planning,
    match,
    diagnosticsOf(sourceRowFor(match, byId, rows))
  );
}
