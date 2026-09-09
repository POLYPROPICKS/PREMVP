import { fetchGammaMarketByConditionId, resolveProviderMarketWinner, type ProviderMarketResolution } from "../feed/resolveSignalOutcome";
import {
  advanceExecutionReconciliationFromTelemetry,
  applyResolvedOutcomeToExecutionReconciliation,
  mergeExecutionReconciliationMeta,
  readExecutionReconciliation,
  type ExecutionReconciliationV1,
} from "./executionReconciliation";
import { readEconomicTelemetry } from "./economicTelemetry";

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
  persistEvent(input: { id: string; idempotency_key: string; clob_order_id: string; executor_meta: Record<string, unknown> }): Promise<void>;
}

export type ExecutionLifecycleResolver = (input: {
  conditionId: string;
}) => Promise<ProviderMarketResolution>;

async function defaultResolver(input: { conditionId: string }): Promise<ProviderMarketResolution> {
  const market = await fetchGammaMarketByConditionId(input.conditionId);
  return resolveProviderMarketWinner(market);
}

/**
 * Bounded, application-owned lifecycle reconciliation. It never submits or
 * re-submits an order: it reads the original event metadata, resolves the
 * execution's own condition against the provider market, and writes back to
 * that same event row guarded by its immutable identity tuple.
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
    // B6: resolution authority is the provider market alone. source_signal_pair_id
    // (if present) is historical lineage only -- it is never read, never a
    // gate, and never a write target for settlement.
    const outcome = await resolver({ conditionId: next.condition_id });
    if (outcome.resolverState !== "resolved_candidate" || !outcome.candidateWinningTokenId) {
      summary.unresolved++;
    } else {
      if (next.winning_token_id && next.winning_token_id !== outcome.candidateWinningTokenId) {
        summary.conflicts++;
        continue;
      }
      const resolvedAt = next.resolved_at ?? new Date().toISOString();
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
