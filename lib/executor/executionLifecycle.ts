import { fetchGammaMarketByConditionId, resolveSignalOutcome, type ResolvedSignalOutcome } from "../feed/resolveSignalOutcome";
import {
  advanceExecutionReconciliationFromTelemetry,
  applyResolvedOutcomeToExecutionReconciliation,
  mergeExecutionReconciliationMeta,
  readExecutionReconciliation,
  type ExecutionReconciliationV1,
} from "./executionReconciliation";
import { readEconomicTelemetry } from "./economicTelemetry";

export interface ReconciliationSourceSignalPair {
  id: string;
  condition_id: string | null;
  selected_token_id: string | null;
  selected_outcome: string | null;
  diagnostics: Record<string, unknown> | null;
  resolved_at?: string | null;
  signal_result?: string | null;
  winning_outcome?: string | null;
  entry_price_num?: number | null;
}

function sourceProviderEventId(diagnostics: Record<string, unknown> | null): string | null {
  if (!diagnostics) return null;
  const direct = diagnostics.provider_event_id ?? diagnostics.providerEventId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const lineage = diagnostics.source_lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const nested = (lineage as Record<string, unknown>).provider_event_id ?? (lineage as Record<string, unknown>).providerEventId;
  return typeof nested === "string" && nested.length > 0 ? nested : null;
}

/**
 * Economic settlement is only allowed against the signal pair carried by the
 * originating Queue instruction. A condition may contain multiple pairs, so
 * condition/token matching is supplementary validation, never selection.
 */
export function validateReconciliationSourceSignalPair(
  reconciliation: ExecutionReconciliationV1,
  source: ReconciliationSourceSignalPair,
): void {
  if (
    source.id !== reconciliation.source_signal_pair_id ||
    source.condition_id !== reconciliation.condition_id ||
    source.selected_token_id !== reconciliation.token_id ||
    source.selected_outcome !== reconciliation.side
  ) {
    throw new Error("EXECUTION_RECONCILIATION_SOURCE_SIGNAL_PAIR_IDENTITY_CONFLICT");
  }
  const sourceProviderId = sourceProviderEventId(source.diagnostics);
  if (reconciliation.provider_event_id && sourceProviderId && reconciliation.provider_event_id !== sourceProviderId) {
    throw new Error("EXECUTION_RECONCILIATION_SOURCE_PROVIDER_IDENTITY_CONFLICT");
  }
}

export interface ExecutionLifecycleReconciliationOptions {
  writeMode: boolean;
  eventIds?: string[];
  limit?: number;
}

export interface ExecutionLifecycleReconciliationSummary {
  loaded: number;
  eligible: number;
  updated: number;
  unresolved: number;
  conflicts: number;
  would_update: number;
}

export interface ExecutionLifecycleEventRow {
  id: string;
  executor_meta: Record<string, unknown> | null;
}

export interface ExecutionLifecycleDbPort {
  loadEvents(options: { eventIds?: string[]; limit: number }): Promise<ExecutionLifecycleEventRow[]>;
  loadSource(id: string): Promise<ReconciliationSourceSignalPair | null>;
  persistSourceResolution(input: {
    identity: Pick<ReconciliationSourceSignalPair, "id" | "condition_id" | "selected_token_id" | "selected_outcome">;
    signal_result: "won" | "lost";
    winning_outcome: string | null;
    realized_return_pct: number | null;
    resolved_at: string;
  }): Promise<void>;
  persistEvent(input: { id: string; idempotency_key: string; clob_order_id: string; executor_meta: Record<string, unknown> }): Promise<void>;
}

export type ExecutionLifecycleResolver = (input: {
  conditionId: string;
  selectedTokenId: string;
  entryPriceNum: number | null;
}) => Promise<Pick<ResolvedSignalOutcome, "resolverState" | "signalResult" | "candidateWinningOutcome" | "candidateWinningTokenId" | "realizedReturnPct">>;

async function defaultResolver(input: { conditionId: string; selectedTokenId: string; entryPriceNum: number | null }): Promise<ResolvedSignalOutcome> {
  const market = await fetchGammaMarketByConditionId(input.conditionId);
  return resolveSignalOutcome({ ...input, market });
}

/**
 * Bounded, application-owned lifecycle reconciliation. It never submits or
 * re-submits an order: it reads the original event metadata, resolves only
 * its carried source pair, and writes back to that same event row guarded by
 * its immutable identity tuple.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconcileExecutionLifecycleWithPort(
  port: ExecutionLifecycleDbPort,
  options: ExecutionLifecycleReconciliationOptions & { resolver?: ExecutionLifecycleResolver },
): Promise<ExecutionLifecycleReconciliationSummary> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200);
  const eventRows = await port.loadEvents({ eventIds: options.eventIds, limit });
  const summary: ExecutionLifecycleReconciliationSummary = { loaded: eventRows.length, eligible: 0, updated: 0, unresolved: 0, conflicts: 0, would_update: 0 };
  const resolver = options.resolver ?? defaultResolver;
  for (const row of eventRows) {
    const prior = readExecutionReconciliation(row.executor_meta);
    if (!prior || prior.settlement_status === "SETTLED_RECONCILED") continue;
    summary.eligible++;
    let next: ExecutionReconciliationV1;
    try {
      next = advanceExecutionReconciliationFromTelemetry(prior, readEconomicTelemetry(row.executor_meta));
    } catch {
      summary.conflicts++;
      continue;
    }
    if (!next.source_signal_pair_id) {
      summary.unresolved++;
      if (JSON.stringify(next) === JSON.stringify(prior)) continue;
      if (!options.writeMode) { summary.would_update++; continue; }
      await port.persistEvent({ id: row.id, idempotency_key: prior.idempotency_key, clob_order_id: prior.clob_order_id, executor_meta: mergeExecutionReconciliationMeta(row.executor_meta, next) });
      summary.updated++;
      continue;
    }
    const source = await port.loadSource(next.source_signal_pair_id);
    if (!source) {
      summary.unresolved++;
      if (JSON.stringify(next) === JSON.stringify(prior)) continue;
      if (!options.writeMode) { summary.would_update++; continue; }
      await port.persistEvent({ id: row.id, idempotency_key: prior.idempotency_key, clob_order_id: prior.clob_order_id, executor_meta: mergeExecutionReconciliationMeta(row.executor_meta, next) });
      summary.updated++;
      continue;
    }
    try {
      validateReconciliationSourceSignalPair(next, source);
    } catch {
      summary.conflicts++;
      continue;
    }
    const outcome = await resolver({
      conditionId: next.condition_id,
      selectedTokenId: next.token_id,
      entryPriceNum: typeof source.entry_price_num === "number" ? source.entry_price_num : null,
    });
    if (outcome.resolverState !== "resolved_candidate" || !outcome.signalResult || !outcome.candidateWinningTokenId) {
      summary.unresolved++;
    } else {
      if (source.signal_result && source.signal_result !== outcome.signalResult) {
        summary.conflicts++;
        continue;
      }
      const resolvedAt = source.resolved_at ?? new Date().toISOString();
      if (!source.resolved_at || !source.signal_result) {
        if (options.writeMode) {
          await port.persistSourceResolution({
            identity: { id: source.id, condition_id: next.condition_id, selected_token_id: next.token_id, selected_outcome: next.side },
            signal_result: outcome.signalResult,
            winning_outcome: outcome.candidateWinningOutcome,
            realized_return_pct: outcome.realizedReturnPct,
            resolved_at: resolvedAt,
          });
        }
      }
      next = applyResolvedOutcomeToExecutionReconciliation(next, {
        resolved_at: resolvedAt,
        winning_outcome: outcome.candidateWinningOutcome,
        winning_token_id: outcome.candidateWinningTokenId,
      });
    }
    if (JSON.stringify(next) === JSON.stringify(prior)) continue;
    if (!options.writeMode) { summary.would_update++; continue; }
    await port.persistEvent({
      id: row.id,
      idempotency_key: prior.idempotency_key,
      clob_order_id: prior.clob_order_id,
      executor_meta: mergeExecutionReconciliationMeta(row.executor_meta, next),
    });
    summary.updated++;
  }
  return summary;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSupabaseExecutionLifecyclePort(supabase: any): ExecutionLifecycleDbPort {
  return {
    async loadEvents({ eventIds, limit }) {
      let query = supabase.from("executor_order_events").select("id,created_at,clob_order_id,idempotency_key,executor_meta").not("clob_order_id", "is", null).order("created_at", { ascending: true }).limit(limit);
      query = eventIds?.length ? query.in("id", eventIds) : query.gte("created_at", new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
      const { data, error } = await query;
      if (error) throw new Error(`EXECUTION_RECONCILIATION_READ_FAILED: ${error.message}`);
      return (data ?? []) as ExecutionLifecycleEventRow[];
    },
    async loadSource(id) {
      const { data, error } = await supabase.from("generated_signal_pairs").select("id,condition_id,selected_token_id,selected_outcome,diagnostics,resolved_at,signal_result,winning_outcome,entry_price_num").eq("id", id).maybeSingle();
      if (error) throw new Error(`EXECUTION_RECONCILIATION_SIGNAL_READ_FAILED: ${error.message}`);
      return data as ReconciliationSourceSignalPair | null;
    },
    async persistSourceResolution(input) {
      const { data, error } = await supabase.from("generated_signal_pairs").update({ signal_result: input.signal_result, resolved_at: input.resolved_at, winning_outcome: input.winning_outcome, realized_return_pct: input.realized_return_pct }).eq("id", input.identity.id).eq("condition_id", input.identity.condition_id).eq("selected_token_id", input.identity.selected_token_id).eq("selected_outcome", input.identity.selected_outcome).is("signal_result", null).select("id").single();
      if (error || !data) throw new Error("EXECUTION_RECONCILIATION_SOURCE_RESOLUTION_UPDATE_FAILED");
    },
    async persistEvent(input) {
      const { data, error } = await supabase.from("executor_order_events").update({ executor_meta: input.executor_meta }).eq("id", input.id).eq("idempotency_key", input.idempotency_key).eq("clob_order_id", input.clob_order_id).select("id").single();
      if (error || !data) throw new Error("EXECUTION_RECONCILIATION_UPDATE_FAILED");
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconcileExecutionLifecycle(supabase: any, options: ExecutionLifecycleReconciliationOptions): Promise<ExecutionLifecycleReconciliationSummary> {
  return reconcileExecutionLifecycleWithPort(createSupabaseExecutionLifecyclePort(supabase), options);
}
