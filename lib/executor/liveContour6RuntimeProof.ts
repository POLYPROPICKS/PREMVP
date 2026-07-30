// lib/executor/liveContour6RuntimeProof.ts
//
// Live Contour 6 runtime-proof analyzer — PURE. No DB client, no environment
// access, no I/O, no clock. Production-shaped Reservation/Queue rows in, one
// structured verdict out, so the same logic is provable under test and reusable
// by the read-only CLI report.
//
// What it proves, from persisted identity fields only (never fuzzy team names):
//   T1 → R1 → Q1   historical occurrence, Reservation, Queue instruction
//   T2 → R2 → Q2   new physical occurrence after the deployment cutoff
//   R1 != R2       one physical occurrence owns exactly one Reservation
//   Q1 unchanged   an already-issued Queue instruction is immutable
//
// Schema facts this analyzer is built on (verified against the migrations):
//   public.night_event_reservations carries physical_event_id + event_start_iso
//   (added by 20260730_live_contour6_reservation_occurrence_identity.sql).
//   public.event_execution_queue has NO event_start_iso column — LC6 deliberately
//   did not alter the Queue — so the Queue-side occurrence start is
//   game_start_iso. Queue start parity is therefore:
//       queue.game_start_iso  ==  reservation.event_start_iso
//   compared as instants, not as raw strings.
//
// Verdict precedence (deterministic, highest first):
//   1 FAIL_HISTORICAL_Q1_MUTATED  — a settled instruction was rewritten: worst case
//   2 FAIL_IDENTITY_DUPLICATE     — canonical occurrence uniqueness broke
//   3 FAIL_QUEUE_REUSES_R1        — new occurrence pinned to the old Reservation
//   4 FAIL_QUEUE_START_MISMATCH   — Queue start drifted from its Reservation
//   5 WAIT_NO_POST_DEPLOY_OCCURRENCE
//   6 WAIT_R2_EXISTS_QUEUE_NOT_DUE
//   7 PASS_RUNTIME_T2_R2_Q2
// Every defect found is listed in `findings`, not only the winning verdict, so
// one report shows the whole picture.

export const ANALYZER_VERSION = "live-contour6-runtime-proof-v1" as const;

export type LiveContour6RuntimeVerdict =
  | "PASS_RUNTIME_T2_R2_Q2"
  | "WAIT_NO_POST_DEPLOY_OCCURRENCE"
  | "WAIT_R2_EXISTS_QUEUE_NOT_DUE"
  | "FAIL_IDENTITY_DUPLICATE"
  | "FAIL_QUEUE_REUSES_R1"
  | "FAIL_QUEUE_START_MISMATCH"
  | "FAIL_HISTORICAL_Q1_MUTATED";

/** Projection of public.night_event_reservations needed for the proof. */
export interface ProofReservationRow {
  id: string;
  physical_event_id: string | null;
  event_start_iso: string | null;
  plan_run_id: string | null;
  match_family_key: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Projection of public.event_execution_queue needed for the proof.
 * `game_start_iso` is the schema equivalent of the Reservation's event_start_iso.
 */
export interface ProofQueueRow {
  id: string;
  reservation_id: string | null;
  selection_rank: number | null;
  game_start_iso: string | null;
  status: string | null;
  plan_run_id: string | null;
  match_family_key: string | null;
  condition_id: string | null;
  token_id: string | null;
  side: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The already-proven historical Queue instruction that must stay immutable. */
export interface HistoricalQueueExpectation {
  queue_id: string;
  reservation_id: string;
  event_start_iso: string;
}

export interface LiveContour6ProofInput {
  /** Deployment cutoff — rows at or after this instant are post-deploy. */
  sinceIso: string;
  /** Caller-supplied fixed clock, echoed into the result for reproducibility. */
  fixedNowIso: string;
  reservations: ProofReservationRow[];
  queueRows: ProofQueueRow[];
  historicalExpectation: HistoricalQueueExpectation;
  historicalQueueRow: ProofQueueRow | null;
}

export interface SelectedReservation {
  reservation_id: string;
  physical_event_id: string | null;
  event_start_iso: string | null;
  plan_run_id: string | null;
  match_family_key: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  selection_basis: string;
}

export interface CanonicalUniquenessGroup {
  physical_event_id: string;
  reservation_count: number;
  reservation_ids: string[];
  unique: boolean;
}

export interface IdentitySeparation {
  reservation_ids_distinct: boolean;
  physical_event_ids_distinct: boolean;
  basis: string;
}

export interface QueueLinkage {
  queue_id: string;
  reservation_id: string | null;
  selection_rank: number | null;
  game_start_iso: string | null;
  status: string | null;
  plan_run_id: string | null;
  match_family_key: string | null;
  condition_id: string | null;
  token_id: string | null;
  side: string | null;
  created_at: string | null;
  updated_at: string | null;
  links_to_selected_r2: boolean;
}

export interface QueueStartParity {
  checked: boolean;
  match: boolean | null;
  reservation_event_start_iso: string | null;
  queue_game_start_iso: string | null;
  note: string;
}

export interface HistoricalQ1Result {
  status: "UNCHANGED" | "MUTATED" | "NOT_FOUND";
  expected_queue_id: string;
  expected_reservation_id: string;
  expected_event_start_iso: string;
  observed_reservation_id: string | null;
  observed_game_start_iso: string | null;
  queue_id_matches: boolean;
  reservation_id_matches: boolean;
  event_start_matches: boolean;
  linked_to_r2: boolean;
  selection_identity: {
    selection_rank: number | null;
    plan_run_id: string | null;
    match_family_key: string | null;
    condition_id: string | null;
    token_id: string | null;
    side: string | null;
    status: string | null;
    created_at: string | null;
    updated_at: string | null;
  } | null;
}

export interface LiveContour6ProofResult {
  analyzer_version: typeof ANALYZER_VERSION;
  verdict: LiveContour6RuntimeVerdict;
  fixed_now: string;
  window_start: string;
  post_deploy_reservations: ProofReservationRow[];
  canonical_uniqueness: CanonicalUniquenessGroup[];
  selected_T1_R1: SelectedReservation | null;
  selected_T2_R2: SelectedReservation | null;
  identity_separation: IdentitySeparation;
  queue_Q2: QueueLinkage | null;
  queue_start_parity: QueueStartParity;
  historical_Q1: HistoricalQ1Result;
  findings: string[];
  limitations: string[];
}

/**
 * Deterministic instant normalization. Accepts the wire formats this pipeline
 * actually produces — `...Z`, `...+00:00`, and the PostgREST/Postgres
 * space-separated `YYYY-MM-DD HH:MM:SS+00` — and collapses them to epoch ms so
 * equivalent instants never read as a mismatch. Returns null when unparseable.
 */
export function normalizeInstantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  text = text.replace(" ", "T");
  // "+00" / "-05" offsets are not valid ISO 8601 on their own; widen to "+00:00".
  if (/T\d{2}:\d{2}/.test(text)) {
    text = text.replace(/([+-]\d{2})$/, "$1:00");
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function latestTouchMs(row: { created_at: string | null; updated_at: string | null }): number | null {
  const created = normalizeInstantMs(row.created_at);
  const changed = normalizeInstantMs(row.updated_at);
  if (created === null) return changed;
  if (changed === null) return created;
  return Math.max(created, changed);
}

function isAtOrAfter(row: { created_at: string | null; updated_at: string | null }, sinceMs: number | null): boolean {
  if (sinceMs === null) return false;
  const touch = latestTouchMs(row);
  return touch !== null && touch >= sinceMs;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function hasCompleteIdentity(row: ProofReservationRow): boolean {
  return trimmedOrNull(row.physical_event_id) !== null && normalizeInstantMs(row.event_start_iso) !== null;
}

function describeIdentityGap(row: ProofReservationRow): string {
  const missing: string[] = [];
  if (trimmedOrNull(row.physical_event_id) === null) missing.push("physical_event_id");
  if (normalizeInstantMs(row.event_start_iso) === null) missing.push("event_start_iso");
  return `identity_incomplete: reservation_id=${row.id} missing=${missing.join("+")}`;
}

/** Newest first by (created_at|updated_at), tie-broken by id for determinism. */
function byNewestThenId(a: ProofReservationRow, b: ProofReservationRow): number {
  const aMs = latestTouchMs(a) ?? Number.NEGATIVE_INFINITY;
  const bMs = latestTouchMs(b) ?? Number.NEGATIVE_INFINITY;
  if (aMs !== bMs) return bMs - aMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toSelected(row: ProofReservationRow, basis: string): SelectedReservation {
  return {
    reservation_id: row.id,
    physical_event_id: row.physical_event_id,
    event_start_iso: row.event_start_iso,
    plan_run_id: row.plan_run_id,
    match_family_key: row.match_family_key,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    selection_basis: basis,
  };
}

function toLinkage(row: ProofQueueRow, linksToR2: boolean): QueueLinkage {
  return {
    queue_id: row.id,
    reservation_id: row.reservation_id,
    selection_rank: row.selection_rank,
    game_start_iso: row.game_start_iso,
    status: row.status,
    plan_run_id: row.plan_run_id,
    match_family_key: row.match_family_key,
    condition_id: row.condition_id,
    token_id: row.token_id,
    side: row.side,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links_to_selected_r2: linksToR2,
  };
}

export function analyzeLiveContour6Runtime(input: LiveContour6ProofInput): LiveContour6ProofResult {
  const findings: string[] = [];
  const limitations: string[] = [];

  const sinceMs = normalizeInstantMs(input.sinceIso);
  if (sinceMs === null) {
    limitations.push(`window_start_unparseable: sinceIso=${input.sinceIso} — no row can be classified as post-deploy`);
  }

  // ── 1. Post-deploy canonical Reservations ─────────────────────────────────
  const postDeploy = input.reservations.filter((row) => isAtOrAfter(row, sinceMs));
  const postDeployCanonical: ProofReservationRow[] = [];
  for (const row of postDeploy) {
    if (hasCompleteIdentity(row)) postDeployCanonical.push(row);
    else limitations.push(describeIdentityGap(row));
  }

  // ── 2. Canonical uniqueness per physical_event_id ─────────────────────────
  const byPhysical = new Map<string, ProofReservationRow[]>();
  for (const row of postDeployCanonical) {
    const key = trimmedOrNull(row.physical_event_id);
    if (key === null) continue;
    const bucket = byPhysical.get(key);
    if (bucket) bucket.push(row);
    else byPhysical.set(key, [row]);
  }
  const canonicalUniqueness: CanonicalUniquenessGroup[] = [...byPhysical.entries()]
    .map(([physicalEventId, rows]) => ({
      physical_event_id: physicalEventId,
      reservation_count: rows.length,
      reservation_ids: rows.map((r) => r.id).sort(),
      unique: rows.length === 1,
    }))
    .sort((a, b) => (a.physical_event_id < b.physical_event_id ? -1 : 1));

  const duplicateGroups = canonicalUniqueness.filter((group) => !group.unique);
  for (const group of duplicateGroups) {
    findings.push(
      `FAIL_IDENTITY_DUPLICATE: physical_event_id=${group.physical_event_id} ` +
        `reservation_count=${group.reservation_count} reservation_ids=[${group.reservation_ids.join(",")}]`
    );
  }

  // ── 3. Select R2, preferring an occurrence whose Queue row already exists ──
  const historicalQueueId = input.historicalExpectation.queue_id;
  const postDeployQueue = input.queueRows.filter(
    (row) => row.id !== historicalQueueId && isAtOrAfter(row, sinceMs)
  );
  const queuedReservationIds = new Set(
    postDeployQueue.map((row) => trimmedOrNull(row.reservation_id)).filter((id): id is string => id !== null)
  );

  const orderedCandidates = [...postDeployCanonical].sort(byNewestThenId);
  const withQueue = orderedCandidates.filter((row) => queuedReservationIds.has(row.id));
  const r2Row = withQueue[0] ?? orderedCandidates[0] ?? null;
  const selectedR2 = r2Row
    ? toSelected(
        r2Row,
        withQueue[0] ? "post_deploy_canonical_with_queue_row" : "newest_post_deploy_canonical"
      )
    : null;

  // ── 4. Select T1/R1 through a persisted link, never a name heuristic ──────
  const historicalReservationId = input.historicalExpectation.reservation_id;
  const linkedR1 = input.reservations.find((row) => row.id === historicalReservationId) ?? null;
  let r1Row: ProofReservationRow | null = linkedR1;
  let r1Basis = "historical_queue_reservation_link";
  if (!r1Row) {
    const priorRows = input.reservations
      .filter((row) => !isAtOrAfter(row, sinceMs) && row.id !== r2Row?.id)
      .sort(byNewestThenId);
    r1Row = priorRows.find(hasCompleteIdentity) ?? priorRows[0] ?? null;
    r1Basis = "newest_pre_cutoff_reservation";
  }
  const selectedR1 = r1Row ? toSelected(r1Row, r1Basis) : null;
  if (!selectedR1) {
    limitations.push(
      "t1_r1_comparison_unavailable: no historical Reservation row was supplied, so R1 != R2 is unproven"
    );
  }

  // ── 5. Identity separation from persisted ids only ────────────────────────
  const r1Physical = trimmedOrNull(r1Row?.physical_event_id);
  const r2Physical = trimmedOrNull(r2Row?.physical_event_id);
  let physicalDistinct = false;
  let separationBasis = "not_evaluated";
  if (r1Row && r2Row) {
    if (r1Physical === null && r2Physical !== null) {
      // Pre-LC6 rows carry no canonical identity; that is itself a distinction.
      physicalDistinct = true;
      separationBasis = "legacy_null_vs_canonical";
    } else if (r1Physical !== null && r2Physical !== null) {
      physicalDistinct = r1Physical !== r2Physical;
      separationBasis = "canonical_physical_event_id";
    } else {
      separationBasis = "r2_identity_missing";
    }
  }
  const identitySeparation: IdentitySeparation = {
    reservation_ids_distinct: Boolean(r1Row && r2Row && r1Row.id !== r2Row.id),
    physical_event_ids_distinct: physicalDistinct,
    basis: separationBasis,
  };

  // ── 6. Q2 linkage ─────────────────────────────────────────────────────────
  let queueQ2: QueueLinkage | null = null;
  if (r2Row) {
    const linked = postDeployQueue.find((row) => trimmedOrNull(row.reservation_id) === r2Row.id) ?? null;
    if (linked) {
      queueQ2 = toLinkage(linked, true);
    } else if (r1Row) {
      const reusing = postDeployQueue.find((row) => trimmedOrNull(row.reservation_id) === r1Row.id) ?? null;
      if (reusing) {
        queueQ2 = toLinkage(reusing, false);
        findings.push(
          `FAIL_QUEUE_REUSES_R1: queue_id=${reusing.id} reservation_id=${reusing.reservation_id} ` +
            `expected_reservation_id=${r2Row.id}`
        );
      }
    }
  }

  // ── 7. Queue start parity (queue.game_start_iso vs reservation.event_start_iso)
  const parityNote =
    "event_execution_queue has no event_start_iso column; game_start_iso is its schema equivalent";
  let queueStartParity: QueueStartParity = {
    checked: false,
    match: null,
    reservation_event_start_iso: r2Row?.event_start_iso ?? null,
    queue_game_start_iso: null,
    note: parityNote,
  };
  if (queueQ2 && r2Row) {
    const reservationMs = normalizeInstantMs(r2Row.event_start_iso);
    const queueMs = normalizeInstantMs(queueQ2.game_start_iso);
    const match = reservationMs !== null && queueMs !== null && reservationMs === queueMs;
    queueStartParity = {
      checked: true,
      match,
      reservation_event_start_iso: r2Row.event_start_iso,
      queue_game_start_iso: queueQ2.game_start_iso,
      note: parityNote,
    };
    if (!match) {
      findings.push(
        `FAIL_QUEUE_START_MISMATCH: queue_id=${queueQ2.queue_id} queue_game_start_iso=${queueQ2.game_start_iso} ` +
          `reservation_id=${r2Row.id} reservation_event_start_iso=${r2Row.event_start_iso}`
      );
    }
  }

  // ── 8. Historical Q1 immutability ─────────────────────────────────────────
  const expectation = input.historicalExpectation;
  const observed = input.historicalQueueRow;
  let historicalQ1: HistoricalQ1Result;
  if (!observed) {
    historicalQ1 = {
      status: "NOT_FOUND",
      expected_queue_id: expectation.queue_id,
      expected_reservation_id: expectation.reservation_id,
      expected_event_start_iso: expectation.event_start_iso,
      observed_reservation_id: null,
      observed_game_start_iso: null,
      queue_id_matches: false,
      reservation_id_matches: false,
      event_start_matches: false,
      linked_to_r2: false,
      selection_identity: null,
    };
    findings.push(`FAIL_HISTORICAL_Q1_MUTATED: queue_id=${expectation.queue_id} not found`);
    limitations.push(
      `historical_queue_id_not_found: a wrong --historical-queue-id produces this same symptom; ` +
        `confirm ${expectation.queue_id} before reading it as corruption`
    );
  } else {
    const queueIdMatches = observed.id === expectation.queue_id;
    const reservationMatches = trimmedOrNull(observed.reservation_id) === expectation.reservation_id;
    const expectedStartMs = normalizeInstantMs(expectation.event_start_iso);
    const observedStartMs = normalizeInstantMs(observed.game_start_iso);
    const startMatches = expectedStartMs !== null && observedStartMs !== null && expectedStartMs === observedStartMs;
    const linkedToR2 = Boolean(r2Row && trimmedOrNull(observed.reservation_id) === r2Row.id);
    const unchanged = queueIdMatches && reservationMatches && startMatches && !linkedToR2;
    historicalQ1 = {
      status: unchanged ? "UNCHANGED" : "MUTATED",
      expected_queue_id: expectation.queue_id,
      expected_reservation_id: expectation.reservation_id,
      expected_event_start_iso: expectation.event_start_iso,
      observed_reservation_id: observed.reservation_id,
      observed_game_start_iso: observed.game_start_iso,
      queue_id_matches: queueIdMatches,
      reservation_id_matches: reservationMatches,
      event_start_matches: startMatches,
      linked_to_r2: linkedToR2,
      selection_identity: {
        selection_rank: observed.selection_rank,
        plan_run_id: observed.plan_run_id,
        match_family_key: observed.match_family_key,
        condition_id: observed.condition_id,
        token_id: observed.token_id,
        side: observed.side,
        status: observed.status,
        created_at: observed.created_at,
        updated_at: observed.updated_at,
      },
    };
    if (!unchanged) {
      findings.push(
        `FAIL_HISTORICAL_Q1_MUTATED: queue_id=${observed.id} ` +
          `reservation_id=${observed.reservation_id} (expected ${expectation.reservation_id}) ` +
          `game_start_iso=${observed.game_start_iso} (expected ${expectation.event_start_iso}) ` +
          `linked_to_r2=${linkedToR2}`
      );
    }
  }

  // ── 9. Verdict precedence ─────────────────────────────────────────────────
  let verdict: LiveContour6RuntimeVerdict;
  if (historicalQ1.status !== "UNCHANGED") {
    verdict = "FAIL_HISTORICAL_Q1_MUTATED";
  } else if (duplicateGroups.length > 0) {
    verdict = "FAIL_IDENTITY_DUPLICATE";
  } else if (queueQ2 && !queueQ2.links_to_selected_r2) {
    verdict = "FAIL_QUEUE_REUSES_R1";
  } else if (queueStartParity.checked && queueStartParity.match === false) {
    verdict = "FAIL_QUEUE_START_MISMATCH";
  } else if (postDeployCanonical.length === 0) {
    verdict = "WAIT_NO_POST_DEPLOY_OCCURRENCE";
  } else if (!queueQ2) {
    verdict = "WAIT_R2_EXISTS_QUEUE_NOT_DUE";
  } else {
    verdict = "PASS_RUNTIME_T2_R2_Q2";
  }

  return {
    analyzer_version: ANALYZER_VERSION,
    verdict,
    fixed_now: input.fixedNowIso,
    window_start: input.sinceIso,
    post_deploy_reservations: postDeployCanonical,
    canonical_uniqueness: canonicalUniqueness,
    selected_T1_R1: selectedR1,
    selected_T2_R2: selectedR2,
    identity_separation: identitySeparation,
    queue_Q2: queueQ2,
    queue_start_parity: queueStartParity,
    historical_Q1: historicalQ1,
    findings,
    limitations,
  };
}
