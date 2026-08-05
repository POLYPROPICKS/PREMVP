export const SPORT_FUNNEL_VERSION = "sport_funnel_v1" as const;

export type SportFunnelStage = "official_events" | "inventory_events" | "signal_pair_considered" | "signal_pair_materialized";

export interface SportFunnelRecord {
  providerEventId: string | null | undefined;
  conditionId?: string | null;
  sportCode?: string | null;
}

export interface SportFunnelStageCounts {
  rows: number;
  conditions: number;
  provider_events: number;
  by_sport: Record<string, { rows: number; conditions: number; provider_events: number }>;
}

const sportBucket = (record: SportFunnelRecord) =>
  typeof record.providerEventId !== "string" || !record.providerEventId.trim()
    ? "UNKNOWN_IDENTITY"
    : typeof record.sportCode !== "string" || !record.sportCode.trim()
      ? "UNKNOWN_SPORT"
      : record.sportCode;

export function countSportFunnelStage(records: readonly SportFunnelRecord[]): SportFunnelStageCounts {
  const bySport: SportFunnelStageCounts["by_sport"] = {};
  for (const record of records) {
    const bucket = sportBucket(record);
    const current = bySport[bucket] ?? (bySport[bucket] = { rows: 0, conditions: 0, provider_events: 0 });
    current.rows += 1;
  }
  for (const bucket of Object.keys(bySport)) {
    const rows = records.filter((record) => sportBucket(record) === bucket);
    bySport[bucket].conditions = new Set(rows.map((record) => record.conditionId).filter((id): id is string => typeof id === "string" && id.trim() !== "")).size;
    bySport[bucket].provider_events = new Set(rows.map((record) => record.providerEventId).filter((id): id is string => typeof id === "string" && id.trim() !== "")).size;
  }
  return {
    rows: records.length,
    conditions: new Set(records.map((record) => record.conditionId).filter((id): id is string => typeof id === "string" && id.trim() !== "")).size,
    provider_events: new Set(records.map((record) => record.providerEventId).filter((id): id is string => typeof id === "string" && id.trim() !== "")).size,
    by_sport: bySport,
  };
}

export function buildSportFunnelV1(input: {
  producerRunId: string;
  asOf: string;
  createdAt: string;
  sourceGitSha?: string | null;
  officialEvents: readonly SportFunnelRecord[];
  inventoryEvents: readonly SportFunnelRecord[];
  considered: readonly SportFunnelRecord[];
  materialized: readonly SportFunnelRecord[];
  firstLosses: readonly (SportFunnelRecord & { reason: string })[];
}) {
  const stages = {
    official_events: countSportFunnelStage(input.officialEvents),
    inventory_events: countSportFunnelStage(input.inventoryEvents),
    signal_pair_considered: countSportFunnelStage(input.considered),
    signal_pair_materialized: countSportFunnelStage(input.materialized),
  };
  const first_loss_by_sport: Record<string, Record<string, number>> = {};
  for (const loss of input.firstLosses) {
    const bucket = sportBucket(loss);
    const reasons = first_loss_by_sport[bucket] ?? (first_loss_by_sport[bucket] = {});
    reasons[loss.reason] = (reasons[loss.reason] ?? 0) + 1;
  }
  const terminalEvents = new Set([...input.materialized, ...input.firstLosses].map((record) => record.providerEventId).filter((id): id is string => typeof id === "string" && id.trim() !== ""));
  return {
    diagnostics_version: SPORT_FUNNEL_VERSION,
    producer_run_id: input.producerRunId,
    run_type: "signal_generation" as const,
    as_of: input.asOf,
    source_git_sha: input.sourceGitSha ?? null,
    structured_sport_source_version: "official_sports_tag_v1",
    stages,
    first_loss_by_sport,
    conservation: {
      considered_provider_events: stages.signal_pair_considered.provider_events,
      terminal_provider_events: terminalEvents.size,
      provider_event_conservation_ok: stages.signal_pair_considered.provider_events === terminalEvents.size,
    },
    created_at: input.createdAt,
  };
}
