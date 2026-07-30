/**
 * Pure formatter for founder-readable reports on full-match anchor rejections.
 * Accepts the complete bounded evidence report and returns a sorted, deduplicated,
 * completeness-aware summary for Founder classification.
 *
 * No DB client, environment access, filesystem, clock, or business logic.
 * Only reads/sorts/deduplicates the already-decided evidence.
 */

import type { FullmatchRejectionEvidenceReport, FullmatchRejectionCandidateEvidence } from "./fullmatchRejectionEvidence";

export const FOUNDER_REPORT_VERSION = "founder-rejection-report-v1" as const;

export interface FounderRejectionGroup {
  group_number: number;
  physical_event_key_hash: string;
  sport: string | null;
  event_title: string | null;
  candidate_count: number;
  candidate_evidence_count: number;
  evidence_completeness: "COMPLETE" | "TRUNCATED_NEEDS_DRILLDOWN";
  distinct_market_questions: string[];
  market_classes: string[];
  event_scopes: string[];
  reason_codes: string[];
  // For COMPLETE groups: accurate boolean from all candidates
  has_moneyline?: boolean;
  has_spread?: boolean;
  has_total?: boolean;
  has_full_match_candidate?: boolean;
  // For TRUNCATED groups: only based on visible evidence, not complete
  visible_has_moneyline?: boolean;
  visible_has_spread?: boolean;
  visible_has_total?: boolean;
  visible_has_full_match_candidate?: boolean;
}

export interface FounderRejectionReport {
  report_version: typeof FOUNDER_REPORT_VERSION;
  group_count: number;
  groups: FounderRejectionGroup[];
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function extractEventTitle(candidates: FullmatchRejectionCandidateEvidence[]): string | null {
  for (const candidate of candidates) {
    const title = trimOrNull(candidate.event_title);
    if (title !== null) return title;
  }
  return null;
}

function deduplicateStrings(values: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const trimmed = trimOrNull(v);
    if (trimmed !== null) set.add(trimmed);
  }
  return Array.from(set).sort();
}

function checkMarketClass(candidates: FullmatchRejectionCandidateEvidence[], marketClass: string): boolean {
  return candidates.some((c) => trimOrNull(c.market_class) === marketClass);
}

function checkEventScope(candidates: FullmatchRejectionCandidateEvidence[], eventScope: string): boolean {
  return candidates.some((c) => trimOrNull(c.event_scope) === eventScope);
}

/**
 * Transform one evidence group into a founder report group.
 *
 * If evidence_count < candidate_count, mark as TRUNCATED and use visible_has_*
 * fields; otherwise mark as COMPLETE and use has_* fields (which are accurate).
 */
function toFounderGroup(
  groupIndex: number,
  group: {
    physical_event_key_hash: string;
    sport: string | null;
    candidate_count: number;
    candidates: FullmatchRejectionCandidateEvidence[];
  }
): FounderRejectionGroup {
  const evidenceCount = group.candidates.length;
  const isComplete = group.candidate_count <= evidenceCount;

  const base: FounderRejectionGroup = {
    group_number: groupIndex + 1,
    physical_event_key_hash: group.physical_event_key_hash,
    sport: trimOrNull(group.sport),
    event_title: extractEventTitle(group.candidates),
    candidate_count: group.candidate_count,
    candidate_evidence_count: evidenceCount,
    evidence_completeness: isComplete ? "COMPLETE" : "TRUNCATED_NEEDS_DRILLDOWN",
    distinct_market_questions: deduplicateStrings(group.candidates.map((c) => c.provider_market_question)),
    market_classes: deduplicateStrings(group.candidates.map((c) => c.market_class)),
    event_scopes: deduplicateStrings(group.candidates.map((c) => c.event_scope)),
    reason_codes: deduplicateStrings(group.candidates.map((c) => c.reason_code)),
  };

  if (isComplete) {
    return {
      ...base,
      has_moneyline: checkMarketClass(group.candidates, "MONEYLINE"),
      has_spread: checkMarketClass(group.candidates, "SPREAD"),
      has_total: checkMarketClass(group.candidates, "TOTAL"),
      has_full_match_candidate: checkEventScope(group.candidates, "FULL_MATCH"),
    };
  } else {
    return {
      ...base,
      visible_has_moneyline: checkMarketClass(group.candidates, "MONEYLINE"),
      visible_has_spread: checkMarketClass(group.candidates, "SPREAD"),
      visible_has_total: checkMarketClass(group.candidates, "TOTAL"),
      visible_has_full_match_candidate: checkEventScope(group.candidates, "FULL_MATCH"),
    };
  }
}

/**
 * Build a founder-readable report from the complete evidence.
 *
 * Sorts by sport → event_title → physical_event_key_hash for stable, deterministic output.
 * All deduplication is alphabetically sorted.
 */
export function buildFounderRejectionReport(input: FullmatchRejectionEvidenceReport): FounderRejectionReport {
  // Sort by sport (null last), then event_title (null last), then hash
  const sorted = [...input.fullmatch_rejection_evidence].sort((a, b) => {
    const aSport = trimOrNull(a.sport);
    const bSport = trimOrNull(b.sport);
    if (aSport !== bSport) {
      if (aSport === null) return 1;
      if (bSport === null) return -1;
      return aSport < bSport ? -1 : aSport > bSport ? 1 : 0;
    }

    const aTitle = extractEventTitle(a.candidates);
    const bTitle = extractEventTitle(b.candidates);
    if (aTitle !== bTitle) {
      if (aTitle === null) return 1;
      if (bTitle === null) return -1;
      return aTitle < bTitle ? -1 : aTitle > bTitle ? 1 : 0;
    }

    return a.physical_event_key_hash < b.physical_event_key_hash
      ? -1
      : a.physical_event_key_hash > b.physical_event_key_hash
        ? 1
        : 0;
  });

  const groups = sorted.map((group, index) => toFounderGroup(index, group));

  return {
    report_version: FOUNDER_REPORT_VERSION,
    group_count: groups.length,
    groups,
  };
}
