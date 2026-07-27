import { createHash } from "node:crypto";

import type { MarketAnchorDecision, MarketAnchorInput } from "../contur3/taxonomy";

/**
 * R0I — bounded, safe evidence for physical-event groups rejected by the
 * full-match anchor gate.
 *
 * Production run night-plan:2026-07-27 reported first_zero_stage =
 * FULLMATCH_ANCHOR_ELIGIBLE with NO_FULLMATCH_ANCHOR = 30 and
 * rejected_partial_count = 258, but the persisted diagnostic report carried only
 * aggregate counts: a recursive extraction over it found zero evidence objects.
 * There was therefore no way to tell whether 30 genuine partial-only events were
 * correctly rejected, or whether the classifier was reading the wrong surface.
 *
 * This module is DIAGNOSTICS ONLY. It never classifies anything: it records the
 * decision buildReservationPlan already made, together with the exact surfaces
 * that decision was read from. It cannot change admission, ranking, scope
 * precedence or `allowed`.
 *
 * Safety contract:
 *   - only the six MarketAnchorInput surfaces the classifier actually consumed;
 *   - never full source rows or raw provider payloads;
 *   - never condition ids, token ids, secrets, headers, env values or credentials;
 *   - the physical-event key is hashed, never emitted verbatim;
 *   - hard-bounded and deterministically ordered, so a pathological run cannot
 *     produce an unbounded report.
 */

/** At most this many rejected groups are reported. */
export const FULLMATCH_EVIDENCE_MAX_GROUPS = 30;
/** At most this many candidate representations per reported group. */
export const FULLMATCH_EVIDENCE_MAX_CANDIDATES_PER_GROUP = 10;
/** The force-rebuild HTTP response carries only this much. */
export const FULLMATCH_EVIDENCE_PREVIEW_GROUPS = 3;
export const FULLMATCH_EVIDENCE_PREVIEW_CANDIDATES = 3;

export interface FullmatchRejectionCandidateEvidence {
  provider_market_question: string | null;
  market_title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  match_family_key: string | null;
  market_class: string;
  event_scope: string;
  evidence_source: string;
  reason_code: string;
  allowed: boolean;
}

export interface FullmatchRejectionGroupEvidence {
  physical_event_key_hash: string;
  sport: string | null;
  candidate_count: number;
  candidates: FullmatchRejectionCandidateEvidence[];
}

export interface FullmatchRejectionEvidenceReport {
  fullmatch_rejection_groups_total: number;
  fullmatch_rejection_groups_reported: number;
  fullmatch_rejection_candidates_total: number;
  fullmatch_rejection_candidates_reported: number;
  fullmatch_rejection_evidence_truncated: boolean;
  fullmatch_rejection_evidence: FullmatchRejectionGroupEvidence[];
}

/** What the planner buffers per candidate while it is already classifying. */
export interface FullmatchRejectionCandidateCapture {
  anchorInput: MarketAnchorInput;
  decision: MarketAnchorDecision;
}

export interface FullmatchRejectionGroupCapture {
  physicalEventKey: string;
  sport: string | null;
  candidates: FullmatchRejectionCandidateCapture[];
}

/**
 * Stable, non-reversible identifier for a physical event. The compound internal
 * key can embed team/date structure, so it is never emitted verbatim; 16 hex
 * chars is ample to correlate groups within one run's report.
 */
export function hashPhysicalEventKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Project one already-made decision, together with the exact (post-normalization)
 * surfaces it was read from. Nothing here re-derives or re-classifies.
 */
function candidateEvidence(
  capture: FullmatchRejectionCandidateCapture
): FullmatchRejectionCandidateEvidence {
  const { anchorInput, decision } = capture;
  return {
    provider_market_question: trimOrNull(anchorInput.providerMarketQuestion),
    market_title: trimOrNull(anchorInput.marketTitle),
    event_title: trimOrNull(anchorInput.eventTitle),
    market_slug: trimOrNull(anchorInput.marketSlug),
    event_slug: trimOrNull(anchorInput.eventSlug),
    match_family_key: trimOrNull(anchorInput.matchFamilyKey),
    market_class: decision.market_class,
    event_scope: decision.event_scope,
    evidence_source: decision.evidence_source,
    // A rejected candidate always carries a reason; the fallback keeps the field
    // total so a consumer never has to handle a missing key.
    reason_code: decision.reason_code ?? "UNSPECIFIED",
    allowed: decision.allowed,
  };
}

/**
 * Build the bounded report from every group the full-match gate rejected.
 *
 * Groups are ordered by their key hash so the output is deterministic and
 * independent of upstream map iteration order; candidates keep the planner's
 * own ranked order, so the first entry is the representative the gate judged.
 */
export function buildFullmatchRejectionEvidence(
  groups: FullmatchRejectionGroupCapture[]
): FullmatchRejectionEvidenceReport {
  const groupsTotal = groups.length;
  const candidatesTotal = groups.reduce((sum, group) => sum + group.candidates.length, 0);

  const ordered = groups
    .map((group) => ({ group, hash: hashPhysicalEventKey(group.physicalEventKey) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const reported = ordered.slice(0, FULLMATCH_EVIDENCE_MAX_GROUPS).map(({ group, hash }) => ({
    physical_event_key_hash: hash,
    sport: group.sport,
    // The true size of the group, even when the candidate list below is capped.
    candidate_count: group.candidates.length,
    candidates: group.candidates
      .slice(0, FULLMATCH_EVIDENCE_MAX_CANDIDATES_PER_GROUP)
      .map(candidateEvidence),
  }));

  const candidatesReported = reported.reduce((sum, group) => sum + group.candidates.length, 0);

  return {
    fullmatch_rejection_groups_total: groupsTotal,
    fullmatch_rejection_groups_reported: reported.length,
    fullmatch_rejection_candidates_total: candidatesTotal,
    fullmatch_rejection_candidates_reported: candidatesReported,
    fullmatch_rejection_evidence_truncated:
      reported.length < groupsTotal || candidatesReported < candidatesTotal,
    fullmatch_rejection_evidence: reported,
  };
}

/**
 * The strictly smaller slice safe to carry in job_runs.diagnostics and the
 * force-rebuild HTTP response. The complete bounded evidence stays in the
 * filesystem diagnostic report so the JSONB column is not enlarged.
 */
export function buildFullmatchRejectionPreview(
  report: FullmatchRejectionEvidenceReport
): FullmatchRejectionGroupEvidence[] {
  return report.fullmatch_rejection_evidence
    .slice(0, FULLMATCH_EVIDENCE_PREVIEW_GROUPS)
    .map((group) => ({
      ...group,
      candidates: group.candidates.slice(0, FULLMATCH_EVIDENCE_PREVIEW_CANDIDATES),
    }));
}
