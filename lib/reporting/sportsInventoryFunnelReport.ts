// Read-only production funnel reporter for sports_event_market_inventory.
//
// Pure, deterministic analyzer: given a fixed `now` and a set of already-loaded
// inventory rows, measures how far rows progress through sports confirmation,
// exact physical-occurrence identity, sibling grouping, strict full-event
// market policy, and structural score-input readiness -- WITHOUT scoring any
// market, selecting any outcome, or touching Reservation/Queue/planning data.
// Planning continues to read generated_signal_pairs; this module is a
// measurement instrument only, not a new production path.
//
// No env, no DB, no network, no side effects, no `new Date()` -- every clock
// read comes from the caller-supplied `fixedNow`.

import { resolveMarketAnchorDecision, type MarketAnchorReasonCode } from "@/lib/contur3/taxonomy";

export const REPORT_VERSION = "sports-inventory-funnel-report/1";
export const SOURCE_TABLE = "sports_event_market_inventory";

// ---------------------------------------------------------------------------
// Input row shape -- snake_case, mirrors the production SELECT exactly.
// ---------------------------------------------------------------------------

export interface SportsInventoryFunnelRow {
  provider: string | null;
  provider_event_id: string | null;
  provider_event_slug: string | null;
  provider_market_id: string | null;
  provider_market_slug: string | null;

  event_title: string | null;
  market_question: string | null;
  event_start_iso: string | null;
  market_end_iso: string | null;

  condition_id: string | null;
  clob_token_ids: unknown;
  outcomes: unknown;
  outcome_prices: unknown;

  provider_tags: unknown;
  raw_category: string | null;
  league_hint: string | null;
  sports_market_type: string | null;

  volume_usd: number | null;
  volume_24hr_usd: number | null;

  is_confirmed_sports: boolean | null;
  sports_confirmation_source: string | null;
  sibling_market_count: number | null;

  first_observed_at: string | null;
  last_observed_at: string | null;
  expires_at: string | null;
}

export interface SportsInventoryFunnelOptions {
  fixedNow: string;
  horizonHours: number;
}

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export type FunnelStageVerdict = "PASS" | "WAIT" | "FAIL";

export interface FunnelStageSummary {
  stage: string;
  verdict: FunnelStageVerdict;
  input: number;
  output: number;
  largest_rejection_reason: string | null;
}

export type FieldGapStatus =
  | "AVAILABLE"
  | "DERIVABLE_WITH_ADAPTER"
  | "REQUIRES_LIVE_ENRICHMENT"
  | "REQUIRES_PLANNING_POLICY"
  | "NOT_AVAILABLE";

export interface RescheduleDuplicateSample {
  provider: string;
  provider_event_id: string;
  provider_market_id: string;
  distinct_event_start_iso: string[];
}

export interface SportsInventoryFunnelReport {
  report_version: string;
  fixed_now: string;
  horizon_hours: number;
  DB_AVAILABLE: boolean;
  source_table: string;

  source_counts: {
    rows: number;
    distinct_provider_event_id: number;
    distinct_provider_market_id: number;
  };

  funnel_stages: FunnelStageSummary[];

  rejection_reasons: Record<string, number>;
  taxonomy_reason_counts: Record<string, number>;
  group_policy_counts: Record<string, number>;

  score_readiness: {
    score_input_structurally_ready_rows: number;
    score_input_structurally_ready_strict_groups: number;
    reasons: Record<string, number>;
    label: "STRUCTURAL_ONLY_NOT_SCORED";
  };

  liquidity_metadata: {
    rows_with_volume_usd: number;
    rows_with_volume_24hr_usd: number;
    rows_with_neither: number;
    label: "NON_AUTHORITATIVE_NOT_EXECUTABILITY_PROOF";
  };

  reschedule_duplicates: {
    duplicate_market_identity_count: number;
    affected_provider_event_count: number;
    samples: RescheduleDuplicateSample[];
    reason: "RESCHEDULE_DUPLICATE_OBSERVED";
  };

  sibling_integrity: {
    group_count: number;
    group_size_distribution: Record<string, number>;
    max_stored_group_size: number;
    mismatched_group_count: number;
    reason: "SIBLING_COUNT_MISMATCH";
  };

  field_gap_matrix: Record<string, FieldGapStatus>;
  bounded_samples: Record<string, unknown[]>;
  mermaid: string;
  limitations: string[];
  verdict: string;
  next_action: string;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

const MAX_SAMPLES_PER_REASON = 5;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function normalizedIso(value: string | null): string | null {
  if (!isNonEmptyString(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function pushSample(samples: Record<string, unknown[]>, reason: string, sample: unknown): void {
  const list = samples[reason] ?? (samples[reason] = []);
  if (list.length < MAX_SAMPLES_PER_REASON) list.push(sample);
}

function sortedRecord(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

function largestReason(map: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const key of Object.keys(map).sort()) {
    const count = map[key];
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function rowIdentity(row: SportsInventoryFunnelRow): string {
  return `${row.provider ?? ""}::${row.provider_event_id ?? ""}::${row.provider_market_id ?? ""}::${row.event_start_iso ?? ""}`;
}

function toArrayOrNull(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

export function analyzeSportsInventoryFunnel(
  rows: SportsInventoryFunnelRow[],
  options: SportsInventoryFunnelOptions,
): SportsInventoryFunnelReport {
  const fixedNowMs = Date.parse(options.fixedNow);
  const horizonMs = options.horizonHours * 60 * 60 * 1000;
  const horizonEndMs = fixedNowMs + horizonMs;

  const rejectionReasons: Record<string, number> = {};
  const taxonomyReasonCounts: Record<string, number> = {};
  const groupPolicyCounts: Record<string, number> = {};
  const boundedSamples: Record<string, unknown[]> = {};

  // ---- Stage 0: RAW INVENTORY ----
  const distinctEventIds = new Set<string>();
  const distinctMarketIds = new Set<string>();
  for (const row of rows) {
    if (isNonEmptyString(row.provider_event_id)) distinctEventIds.add(row.provider_event_id);
    if (isNonEmptyString(row.provider_market_id)) distinctMarketIds.add(row.provider_market_id);
  }
  const sourceCounts = {
    rows: rows.length,
    distinct_provider_event_id: distinctEventIds.size,
    distinct_provider_market_id: distinctMarketIds.size,
  };

  // ---- Stage 1: UPCOMING HORIZON ----
  const stage1: SportsInventoryFunnelRow[] = [];
  for (const row of rows) {
    const iso = normalizedIso(row.event_start_iso);
    if (iso === null) {
      bump(rejectionReasons, "INVALID_EVENT_START");
      pushSample(boundedSamples, "INVALID_EVENT_START", rowIdentity(row));
      continue;
    }
    const startMs = Date.parse(iso);
    if (startMs < fixedNowMs || startMs > horizonEndMs) {
      bump(rejectionReasons, "OUTSIDE_REPORT_HORIZON");
      pushSample(boundedSamples, "OUTSIDE_REPORT_HORIZON", rowIdentity(row));
      continue;
    }
    stage1.push(row);
  }

  // ---- Stage 2: SPORTS CONFIRMATION ----
  // Metadata consistency is measured across the whole horizon population, but
  // never used to silently repair the gate decision.
  let metadataInconsistentCount = 0;
  for (const row of stage1) {
    const source = row.sports_confirmation_source;
    const confirmed = row.is_confirmed_sports === true;
    const expectedConfirmed = source === "specific_sports_tag";
    if (confirmed !== expectedConfirmed) {
      metadataInconsistentCount += 1;
      bump(rejectionReasons, "SPORT_CONFIRMATION_METADATA_INCONSISTENT");
      pushSample(boundedSamples, "SPORT_CONFIRMATION_METADATA_INCONSISTENT", rowIdentity(row));
    }
  }

  const stage2: SportsInventoryFunnelRow[] = [];
  for (const row of stage1) {
    if (row.is_confirmed_sports === true) {
      stage2.push(row);
    } else {
      bump(rejectionReasons, "SPORTS_NOT_CONFIRMED");
      pushSample(boundedSamples, "SPORTS_NOT_CONFIRMED", rowIdentity(row));
    }
  }

  // ---- Stage 3: EXACT IDENTITY ----
  interface ExactRow {
    row: SportsInventoryFunnelRow;
    provider: string;
    providerEventId: string;
    providerMarketId: string;
    eventStartIso: string;
    exactKey: string;
  }
  const stage3: ExactRow[] = [];
  for (const row of stage2) {
    if (!isNonEmptyString(row.provider)) {
      bump(rejectionReasons, "PROVIDER_MISSING");
      pushSample(boundedSamples, "PROVIDER_MISSING", rowIdentity(row));
      continue;
    }
    if (!isNonEmptyString(row.provider_event_id)) {
      bump(rejectionReasons, "PROVIDER_EVENT_ID_MISSING");
      pushSample(boundedSamples, "PROVIDER_EVENT_ID_MISSING", rowIdentity(row));
      continue;
    }
    if (!isNonEmptyString(row.provider_market_id)) {
      bump(rejectionReasons, "PROVIDER_MARKET_ID_MISSING");
      pushSample(boundedSamples, "PROVIDER_MARKET_ID_MISSING", rowIdentity(row));
      continue;
    }
    const eventStartIso = normalizedIso(row.event_start_iso);
    if (eventStartIso === null) {
      bump(rejectionReasons, "INVALID_EVENT_START");
      pushSample(boundedSamples, "INVALID_EVENT_START", rowIdentity(row));
      continue;
    }
    const provider = row.provider as string;
    const providerEventId = row.provider_event_id as string;
    const providerMarketId = row.provider_market_id as string;
    stage3.push({
      row,
      provider,
      providerEventId,
      providerMarketId,
      eventStartIso,
      exactKey: `${provider}::${providerEventId}::${eventStartIso}`,
    });
  }

  // ---- Stage 4: RESCHEDULE DUPLICATES (measured, never reconciled) ----
  const marketIdentityMap = new Map<string, Map<string, ExactRow[]>>();
  for (const er of stage3) {
    const identityKey = `${er.provider}::${er.providerEventId}::${er.providerMarketId}`;
    const byStart = marketIdentityMap.get(identityKey) ?? new Map<string, ExactRow[]>();
    const bucket = byStart.get(er.eventStartIso) ?? [];
    bucket.push(er);
    byStart.set(er.eventStartIso, bucket);
    marketIdentityMap.set(identityKey, byStart);
  }
  const rescheduleSamples: RescheduleDuplicateSample[] = [];
  const affectedEvents = new Set<string>();
  let duplicateMarketIdentityCount = 0;
  for (const [identityKey, byStart] of [...marketIdentityMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (byStart.size > 1) {
      duplicateMarketIdentityCount += 1;
      const [provider, providerEventId, providerMarketId] = identityKey.split("::");
      affectedEvents.add(`${provider}::${providerEventId}`);
      bump(rejectionReasons, "RESCHEDULE_DUPLICATE_OBSERVED");
      if (rescheduleSamples.length < MAX_SAMPLES_PER_REASON) {
        rescheduleSamples.push({
          provider,
          provider_event_id: providerEventId,
          provider_market_id: providerMarketId,
          distinct_event_start_iso: [...byStart.keys()].sort(),
        });
      }
    }
  }

  // ---- Stage 5: PHYSICAL OCCURRENCE GROUPING ----
  const groupMap = new Map<string, ExactRow[]>();
  for (const er of stage3) {
    const groupKey = `${er.provider}::${er.providerEventId}::${er.eventStartIso}`;
    const bucket = groupMap.get(groupKey) ?? [];
    bucket.push(er);
    groupMap.set(groupKey, bucket);
  }
  const groups = [...groupMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const groupSizeDistribution: Record<string, number> = {};
  let maxStoredGroupSize = 0;
  let mismatchedGroupCount = 0;
  for (const [groupKey, members] of groups) {
    const size = members.length;
    bump(groupSizeDistribution, String(size));
    maxStoredGroupSize = Math.max(maxStoredGroupSize, size);
    const maxSiblingStored = members.reduce((max, m) => {
      const v = m.row.sibling_market_count;
      return typeof v === "number" && Number.isFinite(v) ? Math.max(max, v) : max;
    }, 0);
    if (maxSiblingStored > 0 && maxSiblingStored !== size) {
      mismatchedGroupCount += 1;
      bump(rejectionReasons, "SIBLING_COUNT_MISMATCH");
      pushSample(boundedSamples, "SIBLING_COUNT_MISMATCH", groupKey);
    }
  }

  // ---- Stage 6: STRICT MARKET POLICY ----
  interface RowDecision {
    er: ExactRow;
    allowed: boolean;
    reasonCode: MarketAnchorReasonCode | null;
  }
  const decisionsByGroup = new Map<string, RowDecision[]>();
  for (const [groupKey, members] of groups) {
    const decisions: RowDecision[] = members.map((er) => {
      const decision = resolveMarketAnchorDecision({
        providerMarketQuestion: er.row.market_question,
        marketTitle: er.row.market_question,
        eventTitle: er.row.event_title,
        marketSlug: er.row.provider_market_slug,
        eventSlug: er.row.provider_event_slug,
      });
      const taxonomyKey = decision.allowed ? `ALLOWED_${decision.market_class}` : (decision.reason_code as string);
      bump(taxonomyReasonCounts, taxonomyKey);
      return { er, allowed: decision.allowed, reasonCode: decision.reason_code };
    });
    decisionsByGroup.set(groupKey, decisions);
  }

  let groupsWithAnyAllowedFullEventAnchor = 0;
  let groupsStrictlyPureFullEvent = 0;
  const strictPassGroupKeys = new Set<string>();
  for (const [groupKey, decisions] of decisionsByGroup) {
    const anyAllowed = decisions.some((d) => d.allowed);
    if (anyAllowed) groupsWithAnyAllowedFullEventAnchor += 1;

    let groupReason: string;
    if (!anyAllowed) {
      groupReason = "GROUP_NO_ALLOWED_FULL_EVENT_MARKET";
    } else if (decisions.some((d) => !d.allowed && (d.reasonCode === "PARTIAL_EVENT_SCOPE" || d.reasonCode === "FORBIDDEN_MARKET_CLASS" || d.reasonCode === "ACTIVITY_LABEL"))) {
      groupReason = "GROUP_CONTAINS_PARTIAL_OR_PROP";
    } else if (decisions.some((d) => !d.allowed && d.reasonCode === "UNKNOWN_MARKET_CLASS")) {
      groupReason = "GROUP_CONTAINS_UNKNOWN_MARKET";
    } else if (decisions.some((d) => !d.allowed && d.reasonCode === "ESPORTS_NON_POLICY")) {
      groupReason = "GROUP_CONTAINS_ESPORTS_NON_POLICY";
    } else {
      groupReason = "GROUP_STRICT_FULL_EVENT_PASS";
      groupsStrictlyPureFullEvent += 1;
      strictPassGroupKeys.add(groupKey);
    }
    bump(groupPolicyCounts, groupReason);
    if (groupReason !== "GROUP_STRICT_FULL_EVENT_PASS") pushSample(boundedSamples, groupReason, groupKey);
  }

  // ---- Stage 7: STRUCTURAL SCORE READINESS ----
  const scoreReadinessReasons: Record<string, number> = {};
  const structurallyReadyRowKeys = new Set<string>();
  for (const er of stage3) {
    const row = er.row;
    if (!isNonEmptyString(row.condition_id)) {
      bump(scoreReadinessReasons, "CONDITION_ID_MISSING");
      continue;
    }
    const outcomes = toArrayOrNull(row.outcomes);
    if (!outcomes || outcomes.length < 2) {
      bump(scoreReadinessReasons, "OUTCOMES_INVALID");
      continue;
    }
    const tokens = toArrayOrNull(row.clob_token_ids);
    if (!tokens || tokens.length !== outcomes.length) {
      bump(scoreReadinessReasons, "TOKEN_ARRAY_INVALID");
      continue;
    }
    const prices = toArrayOrNull(row.outcome_prices);
    if (!prices || prices.length !== outcomes.length) {
      bump(scoreReadinessReasons, "PRICE_ARRAY_INVALID");
      continue;
    }
    const hasValidPrice = prices.some((p) => {
      const n = toFiniteNumber(p);
      return n !== null && n > 0 && n < 1;
    });
    if (!hasValidPrice) {
      bump(scoreReadinessReasons, "NO_VALID_ENTRY_PRICE");
      continue;
    }
    structurallyReadyRowKeys.add(er.exactKey);
  }

  const readyGroupKeys = new Set<string>();
  for (const [groupKey, members] of groups) {
    if (members.some((m) => structurallyReadyRowKeys.has(m.exactKey))) {
      readyGroupKeys.add(groupKey);
    }
  }

  // ---- Stage 8: LIQUIDITY METADATA READINESS ----
  let rowsWithVolumeUsd = 0;
  let rowsWithVolume24hr = 0;
  let rowsWithNeither = 0;
  for (const er of stage3) {
    const hasVolumeUsd = typeof er.row.volume_usd === "number" && Number.isFinite(er.row.volume_usd);
    const hasVolume24hr = typeof er.row.volume_24hr_usd === "number" && Number.isFinite(er.row.volume_24hr_usd);
    if (hasVolumeUsd) rowsWithVolumeUsd += 1;
    if (hasVolume24hr) rowsWithVolume24hr += 1;
    if (!hasVolumeUsd && !hasVolume24hr) {
      rowsWithNeither += 1;
      bump(rejectionReasons, "STATIC_VOLUME_METADATA_MISSING");
    }
  }

  // ---- Stage 9: PRE-SCORE CANDIDATE GROUPS ----
  let preScoreCandidateGroups = 0;
  for (const groupKey of strictPassGroupKeys) {
    if (readyGroupKeys.has(groupKey)) preScoreCandidateGroups += 1;
  }
  groupPolicyCounts["pre_score_candidate_groups"] = preScoreCandidateGroups;
  groupPolicyCounts["groups_with_any_allowed_full_event_anchor"] = groupsWithAnyAllowedFullEventAnchor;
  groupPolicyCounts["groups_strictly_pure_full_event"] = groupsStrictlyPureFullEvent;

  // ---- Funnel stage summaries + mermaid ----
  const funnelStages: FunnelStageSummary[] = [];
  const stageEntry = (
    stage: string,
    input: number,
    output: number,
    reasonMap: Record<string, number>,
  ): FunnelStageSummary => ({
    stage,
    verdict: output > 0 ? "PASS" : input > 0 ? "FAIL" : "WAIT",
    input,
    output,
    largest_rejection_reason: largestReason(reasonMap),
  });

  const horizonRejects = { OUTSIDE_REPORT_HORIZON: rejectionReasons.OUTSIDE_REPORT_HORIZON ?? 0, INVALID_EVENT_START: rejectionReasons.INVALID_EVENT_START ?? 0 };
  const sportsRejects = { SPORTS_NOT_CONFIRMED: rejectionReasons.SPORTS_NOT_CONFIRMED ?? 0 };
  const identityRejects = {
    PROVIDER_MISSING: rejectionReasons.PROVIDER_MISSING ?? 0,
    PROVIDER_EVENT_ID_MISSING: rejectionReasons.PROVIDER_EVENT_ID_MISSING ?? 0,
    PROVIDER_MARKET_ID_MISSING: rejectionReasons.PROVIDER_MARKET_ID_MISSING ?? 0,
  };

  funnelStages.push(stageEntry("RAW_INVENTORY", rows.length, rows.length, {}));
  funnelStages.push(stageEntry("UPCOMING_HORIZON", rows.length, stage1.length, horizonRejects));
  funnelStages.push(stageEntry("CONFIRMED_SPORTS", stage1.length, stage2.length, sportsRejects));
  funnelStages.push(stageEntry("EXACT_IDENTITY", stage2.length, stage3.length, identityRejects));
  funnelStages.push(stageEntry("PHYSICAL_GROUPS", stage3.length, groups.length, {}));
  const groupRejectReasons = {
    GROUP_NO_ALLOWED_FULL_EVENT_MARKET: groupPolicyCounts.GROUP_NO_ALLOWED_FULL_EVENT_MARKET ?? 0,
    GROUP_CONTAINS_PARTIAL_OR_PROP: groupPolicyCounts.GROUP_CONTAINS_PARTIAL_OR_PROP ?? 0,
    GROUP_CONTAINS_UNKNOWN_MARKET: groupPolicyCounts.GROUP_CONTAINS_UNKNOWN_MARKET ?? 0,
    GROUP_CONTAINS_ESPORTS_NON_POLICY: groupPolicyCounts.GROUP_CONTAINS_ESPORTS_NON_POLICY ?? 0,
  };
  funnelStages.push(
    stageEntry("STRICT_MARKET_POLICY", groups.length, groupsStrictlyPureFullEvent, groupRejectReasons),
  );
  funnelStages.push(
    stageEntry(
      "STRUCTURAL_SCORE_READINESS",
      groupsStrictlyPureFullEvent,
      [...strictPassGroupKeys].filter((k) => readyGroupKeys.has(k)).length,
      scoreReadinessReasons,
    ),
  );
  funnelStages.push(stageEntry("PRE_SCORE_CANDIDATE_GROUPS", groupsStrictlyPureFullEvent, preScoreCandidateGroups, {}));

  const mermaidLines = ["flowchart TD"];
  const nodeIds = [
    "RAW_INVENTORY",
    "UPCOMING_HORIZON",
    "CONFIRMED_SPORTS",
    "EXACT_IDENTITY",
    "PHYSICAL_GROUPS",
    "STRICT_MARKET_POLICY",
    "STRUCTURAL_SCORE_READINESS",
    "PRE_SCORE_CANDIDATE_GROUPS",
  ];
  for (let i = 0; i < funnelStages.length; i++) {
    const s = funnelStages[i];
    const reason = s.largest_rejection_reason ?? "NONE";
    mermaidLines.push(
      `  ${nodeIds[i]}["${s.stage}\\n${s.verdict} | in:${s.input} out:${s.output}\\nlargest: ${reason}"]`,
    );
    if (i > 0) mermaidLines.push(`  ${nodeIds[i - 1]} --> ${nodeIds[i]}`);
  }
  const mermaid = mermaidLines.join("\n");

  const fieldGapMatrix: Record<string, FieldGapStatus> = {
    selected_outcome: "REQUIRES_PLANNING_POLICY",
    selected_token: "REQUIRES_PLANNING_POLICY",
    opposing_token: "REQUIRES_PLANNING_POLICY",
    entry_price: "REQUIRES_LIVE_ENRICHMENT",
    score: "REQUIRES_PLANNING_POLICY",
    confidence: "REQUIRES_PLANNING_POLICY",
    data_coverage: "DERIVABLE_WITH_ADAPTER",
    live_liquidity: "REQUIRES_LIVE_ENRICHMENT",
    signal_id: "NOT_AVAILABLE",
    model_rule_id: "NOT_AVAILABLE",
    live_policy_version: "NOT_AVAILABLE",
    idempotency_key: "NOT_AVAILABLE",
  };

  const boundedSamplesSorted: Record<string, unknown[]> = {};
  for (const key of Object.keys(boundedSamples).sort()) boundedSamplesSorted[key] = boundedSamples[key];

  const limitations = [
    "STRUCTURAL_ONLY_NOT_SCORED: structural score readiness never selects an outcome, token, or price -- it only proves the row's arrays are shaped correctly.",
    "NON_AUTHORITATIVE_NOT_EXECUTABILITY_PROOF: stored volume_usd / volume_24hr_usd is static capture-time metadata, never a live CLOB read.",
    "pre_score_candidate_groups must never be read as a synonym for a planning-stage candidate, a Reservation-stage candidate, or a live-tradeable listing -- planning continues to read generated_signal_pairs.",
    `metadata inconsistency observed on ${metadataInconsistentCount} row(s) inside the horizon window; the gate still trusts is_confirmed_sports verbatim and does not repair it.`,
  ];

  return {
    report_version: REPORT_VERSION,
    fixed_now: new Date(fixedNowMs).toISOString(),
    horizon_hours: options.horizonHours,
    DB_AVAILABLE: true,
    source_table: SOURCE_TABLE,
    source_counts: sourceCounts,
    funnel_stages: funnelStages,
    rejection_reasons: sortedRecord(rejectionReasons),
    taxonomy_reason_counts: sortedRecord(taxonomyReasonCounts),
    group_policy_counts: sortedRecord(groupPolicyCounts),
    score_readiness: {
      score_input_structurally_ready_rows: structurallyReadyRowKeys.size,
      score_input_structurally_ready_strict_groups: [...strictPassGroupKeys].filter((k) => readyGroupKeys.has(k))
        .length,
      reasons: sortedRecord(scoreReadinessReasons),
      label: "STRUCTURAL_ONLY_NOT_SCORED",
    },
    liquidity_metadata: {
      rows_with_volume_usd: rowsWithVolumeUsd,
      rows_with_volume_24hr_usd: rowsWithVolume24hr,
      rows_with_neither: rowsWithNeither,
      label: "NON_AUTHORITATIVE_NOT_EXECUTABILITY_PROOF",
    },
    reschedule_duplicates: {
      duplicate_market_identity_count: duplicateMarketIdentityCount,
      affected_provider_event_count: affectedEvents.size,
      samples: rescheduleSamples,
      reason: "RESCHEDULE_DUPLICATE_OBSERVED",
    },
    sibling_integrity: {
      group_count: groups.length,
      group_size_distribution: sortedRecord(groupSizeDistribution),
      max_stored_group_size: maxStoredGroupSize,
      mismatched_group_count: mismatchedGroupCount,
      reason: "SIBLING_COUNT_MISMATCH",
    },
    field_gap_matrix: fieldGapMatrix,
    bounded_samples: boundedSamplesSorted,
    mermaid,
    limitations,
    verdict: "PASS_FUNNEL_BASELINE_READY",
    next_action: "RUN_LOCAL_PRODUCTION_FUNNEL_REPORT",
  };
}

// ---------------------------------------------------------------------------
// Read-only paginated loader
//
// SELECT-only by construction: the caller supplies a `reader` that performs
// exactly one range-bounded read per page. No caller of this function can
// smuggle in a write -- there is no code path here that calls anything but
// `reader`. The injected reader lets tests exercise pagination and the hard
// cap without a live Supabase connection.
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_HARD_CAP = 100_000;

export interface SportsInventoryPageResult {
  data: SportsInventoryFunnelRow[] | null;
  error: { message: string } | null;
}

export type SportsInventoryPageReader = (range: {
  from: number;
  to: number;
}) => Promise<SportsInventoryPageResult>;

export interface LoadSportsInventoryRowsResult {
  rows: SportsInventoryFunnelRow[];
  pagesRead: number;
  truncated: boolean;
}

export class SportsInventoryRowReadError extends Error {
  constructor(
    message: string,
    public readonly page: number,
  ) {
    super(message);
    this.name = "SportsInventoryRowReadError";
  }
}

export async function loadSportsInventoryFunnelRows(
  reader: SportsInventoryPageReader,
  opts: { pageSize?: number; hardCap?: number } = {},
): Promise<LoadSportsInventoryRowsResult> {
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
  const hardCap = opts.hardCap ?? DEFAULT_HARD_CAP;

  const rows: SportsInventoryFunnelRow[] = [];
  let from = 0;
  let pagesRead = 0;
  let truncated = false;

  for (;;) {
    pagesRead += 1;
    const to = from + pageSize - 1;
    const { data, error } = await reader({ from, to });
    if (error) {
      throw new SportsInventoryRowReadError(
        `FUNNEL_REPORT_ROW_READ_FAILED: ${error.message}`,
        pagesRead,
      );
    }
    const batch = data ?? [];
    rows.push(...batch);

    const reachedCap = rows.length >= hardCap;
    const shortPage = batch.length < pageSize;

    if (reachedCap) {
      // A full final page right at the cap means more rows may exist beyond
      // it -- that must fail closed, never report a misleading partial PASS.
      truncated = !shortPage;
      break;
    }
    if (shortPage) break;
    from += pageSize;
  }

  return { rows: rows.slice(0, hardCap), pagesRead, truncated };
}
