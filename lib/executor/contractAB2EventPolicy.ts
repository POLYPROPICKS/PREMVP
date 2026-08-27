// lib/executor/contractAB2EventPolicy.ts
//
// PRE-RESERVATION Contract A B2 EVENT-POLICY binding (roadmap step 3/5).
//
// B2 is the selected pre-Reservation Contract A model. Before a Contract A
// Planning Decision can become a Reservation, it must satisfy the B2
// event-policy gates. These gates are the MODEL-AUTHORITY half of the frozen B2
// contract (lib/modeling/frozenModelProducerV2Shadow.ts,
// FROZEN_MODEL_V2_VERSION = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M"):
//
//   * persisted canonical Signal Score  >= 65    (SCORE_THRESHOLD)
//   * entry / signal price               >= 0.30  (PRICE_FLOOR)
//   * eSports excluded
//
// They are HARD pre-Reservation gates, evaluated exactly once, at the single
// pre-Reservation owner (produceContractAPlanningDecisions in
// contractADecisions.ts). That owner is entered only by the Reservation build
// path and the forward-funnel diagnostic — never by Final Identity / Rebalance,
// so post-Reservation model re-evaluation is impossible by construction.
//
// TIMING RULING (roadmap step 3/5): the frozen B2 producer additionally rejects
// OUTSIDE_120M via passesTimingWithin120m (0 <= game_start - created_at < 2h).
// That predicate is the OLD frozen EXECUTION-TIME contour and is deliberately
// NOT reapplied here. The broad 17:00 planning inventory is never rejected
// merely because game_start - planning_now >= 120 minutes, the authoritative
// T-90 market identity is not required to exist at 17:00, and no post-Reservation
// model gate is introduced to preserve the historical <120m predicate.
//
// AS-OF / NON-FUTURE MODEL EVIDENCE: the frozen B2 producer resolves a canonical
// T-90 snapshot per strict observation identity and rejects rows created after
// the as-of boundary (FUTURE_DATA_REJECTED). At 17:00 the authoritative T-90
// snapshot cannot yet exist, so it is NOT required. Instead, when a strict
// observation identity carries more than one persisted snapshot,
// resolveContractAAsOfSnapshots keeps the AS-OF snapshot — the latest snapshot
// whose created_at is at or before the planning cutoff — so a later /
// post-cutoff snapshot can never displace a valid at-or-before-cutoff one and
// can never contaminate the Contract A model decision. A lone snapshot is
// consumed as-is (we never fail closed for the absence of a post-cutoff
// snapshot). The production DB read already applies `.lte(created_at, asOf)`;
// this is the deterministic in-memory guarantee for every entry point.
//
// Pure: no clock, no I/O. The B2 score / eSports text adapters are imported
// verbatim from lib/modeling/historicalFunnelVariants.ts (import-safe: no
// PnL / bankroll dependency graph); the price-floor predicate + threshold are
// re-hosted verbatim from the frozen source cited above.

import { getScoreValue, isEsports } from "@/lib/modeling/historicalFunnelVariants";

/** Frozen B2 thresholds. Verbatim from frozenModelProducerV2Shadow.ts. DO NOT TUNE. */
export const B2_SCORE_THRESHOLD = 65 as const;
export const B2_PRICE_FLOOR = 0.3 as const;

/**
 * Every reason the B2 pre-Reservation event policy can fail closed. A closed
 * union — a new B2 failure mode is a contract change, not a free-text string.
 */
export type ContractAB2RejectionReasonCode =
  | "B2_ESPORTS_EXCLUDED"
  | "B2_SCORE_BELOW_65"
  | "B2_PRICE_BELOW_030"
  | "B2_ASOF_EVIDENCE_UNAVAILABLE";

export type ContractAB2PolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason_code: ContractAB2RejectionReasonCode; detail: string | null };

type Row = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Verbatim port of frozenModelProducerV2Shadow.ts getEntryPriceValue +
 * passesPriceFloor: entry_price_num finite, 0 < v <= 1, and v >= 0.30.
 */
function passesB2PriceFloor(row: Row): boolean {
  const raw = finiteNumber(row.entry_price_num);
  const p = raw !== null && raw > 0 && raw <= 1 ? raw : null;
  return p !== null && p >= B2_PRICE_FLOOR;
}

/**
 * Strict observation identity for as-of snapshot resolution: condition_id +
 * selected_token_id — the exact generated_signal_pairs identity Contur3 dedups
 * planning candidates by in buildFireModelCandidates.
 */
export function contractAObservationIdentity(row: Row): string | null {
  const conditionId =
    typeof row.condition_id === "string" && row.condition_id.trim() !== "" ? row.condition_id.trim() : null;
  const tokenId =
    typeof row.selected_token_id === "string" && row.selected_token_id.trim() !== ""
      ? row.selected_token_id.trim()
      : null;
  return conditionId !== null && tokenId !== null ? `${conditionId}::${tokenId}` : null;
}

function createdMs(row: Row): number | null {
  const ms = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Collapse the supplied planning source rows to the AS-OF snapshot per strict
 * observation identity, relative to the planning cutoff `nowMs`.
 *
 * For an identity carrying 2+ snapshots: keep the latest snapshot with
 * created_at <= nowMs; if none qualifies, keep the earliest snapshot
 * (lone-future tolerance — a post-cutoff snapshot is never REQUIRED at planning
 * time). Deterministic: ties on created_at break by the row's own id ascending.
 *
 * Rows with no strict identity, and identities with a single snapshot, are
 * returned unchanged and in their original position — so this is a no-op for
 * the overwhelmingly common single-snapshot-per-identity universe and cannot
 * perturb candidate ordering, ranking or dedup there.
 */
export function resolveContractAAsOfSnapshots(rows: readonly Row[], nowMs: number): Row[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const id = contractAObservationIdentity(row);
    if (id === null) continue;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }

  const dropped = new Set<Row>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const dated = bucket
      .map((row) => ({ row, created: createdMs(row) }))
      .filter((entry): entry is { row: Row; created: number } => entry.created !== null);
    if (dated.length === 0) continue; // no usable timestamps — keep the bucket intact
    const atOrBefore = dated.filter((entry) => entry.created <= nowMs);
    const pool = atOrBefore.length > 0 ? atOrBefore : dated;
    const pickLatest = atOrBefore.length > 0;
    pool.sort((a, b) => {
      if (a.created !== b.created) return pickLatest ? b.created - a.created : a.created - b.created;
      return String(a.row.id ?? "").localeCompare(String(b.row.id ?? ""));
    });
    const winner = pool[0].row;
    for (const entry of dated) if (entry.row !== winner) dropped.add(entry.row);
  }

  if (dropped.size === 0) return rows.slice();
  return rows.filter((row) => !dropped.has(row));
}

/**
 * The hard B2 event-policy verdict for one persisted planning source row and
 * the strategic scope Contract A already resolved for it. Score / price /
 * eSports only — never timing, never a post-cutoff snapshot.
 *
 * eSports is checked first (matching the frozen B2 producer's gate order), on
 * BOTH the canonical resolved scope and the B2 text adapter, so a
 * diagnostics-only esports signal that never reaches the flat row text is still
 * excluded. Score is the PERSISTED canonical Signal Score
 * (signal_confidence_num first, via getScoreValue): a row with no persisted
 * canonical score cannot satisfy "persisted canonical Signal Score >= 65".
 */
export function evaluateContractAB2EventPolicy(
  row: Row | null | undefined,
  strategicScope: string | null | undefined
): ContractAB2PolicyVerdict {
  if (!row || typeof row !== "object") {
    return { allowed: false, reason_code: "B2_ASOF_EVIDENCE_UNAVAILABLE", detail: null };
  }

  if (strategicScope === "ESPORT" || isEsports(row)) {
    return { allowed: false, reason_code: "B2_ESPORTS_EXCLUDED", detail: strategicScope ?? null };
  }

  const score = getScoreValue(row);
  if (score === null || score < B2_SCORE_THRESHOLD) {
    return {
      allowed: false,
      reason_code: "B2_SCORE_BELOW_65",
      detail: score === null ? "null" : String(score),
    };
  }

  if (!passesB2PriceFloor(row)) {
    const raw = finiteNumber(row.entry_price_num);
    return { allowed: false, reason_code: "B2_PRICE_BELOW_030", detail: raw === null ? "null" : String(raw) };
  }

  return { allowed: true };
}
