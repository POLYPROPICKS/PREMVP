import { fetchGammaMarketByConditionId, resolveSignalOutcome } from "../feed/resolveSignalOutcome";
import {
  applyResolvedOutcomeToExecutionReconciliation,
  mergeExecutionReconciliationMeta,
  readExecutionReconciliation,
  type ExecutionReconciliationV1,
} from "./executionReconciliation";

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
}

/**
 * Bounded, application-owned lifecycle reconciliation. It never submits or
 * re-submits an order: it reads the original event metadata, resolves only
 * its carried source pair, and writes back to that same event row guarded by
 * its immutable identity tuple.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconcileExecutionLifecycle(supabase: any, options: ExecutionLifecycleReconciliationOptions): Promise<ExecutionLifecycleReconciliationSummary> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200);
  let eventQuery = supabase
    .from("executor_order_events")
    .select("id,created_at,clob_order_id,idempotency_key,executor_meta")
    .not("clob_order_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.eventIds?.length) eventQuery = eventQuery.in("id", options.eventIds);
  else eventQuery = eventQuery.gte("created_at", new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
  const { data: eventRows, error: eventError } = await eventQuery;
  if (eventError) throw new Error(`EXECUTION_RECONCILIATION_READ_FAILED: ${eventError.message}`);

  const summary: ExecutionLifecycleReconciliationSummary = { loaded: eventRows?.length ?? 0, eligible: 0, updated: 0, unresolved: 0, conflicts: 0 };
  for (const row of (eventRows ?? []) as Array<Record<string, unknown>>) {
    const prior = readExecutionReconciliation(row.executor_meta);
    if (!prior || prior.settlement_status === "SETTLED_RECONCILED" || !prior.source_signal_pair_id) continue;
    summary.eligible++;
    const { data: source, error: sourceError } = await supabase
      .from("generated_signal_pairs")
      .select("id,condition_id,selected_token_id,selected_outcome,diagnostics,resolved_at,signal_result,winning_outcome,entry_price_num")
      .eq("id", prior.source_signal_pair_id)
      .maybeSingle();
    if (sourceError) throw new Error(`EXECUTION_RECONCILIATION_SIGNAL_READ_FAILED: ${sourceError.message}`);
    if (!source) { summary.conflicts++; continue; }
    try {
      validateReconciliationSourceSignalPair(prior, source as ReconciliationSourceSignalPair);
    } catch {
      summary.conflicts++;
      continue;
    }
    if (!source.resolved_at || (source.signal_result !== "won" && source.signal_result !== "lost")) {
      summary.unresolved++;
      continue;
    }
    const market = await fetchGammaMarketByConditionId(prior.condition_id);
    const outcome = resolveSignalOutcome({
      conditionId: prior.condition_id,
      selectedTokenId: prior.token_id,
      entryPriceNum: typeof source.entry_price_num === "number" ? source.entry_price_num : null,
      market,
    });
    if (outcome.resolverState !== "resolved_candidate" || outcome.signalResult !== source.signal_result || !outcome.candidateWinningTokenId) {
      summary.unresolved++;
      continue;
    }
    const next = applyResolvedOutcomeToExecutionReconciliation(prior, {
      resolved_at: String(source.resolved_at),
      winning_outcome: outcome.candidateWinningOutcome,
      winning_token_id: outcome.candidateWinningTokenId,
    });
    if (JSON.stringify(next) === JSON.stringify(prior)) continue;
    if (!options.writeMode) continue;
    const { data: changed, error: updateError } = await supabase
      .from("executor_order_events")
      .update({ executor_meta: mergeExecutionReconciliationMeta(row.executor_meta as Record<string, unknown> | null, next) })
      .eq("id", row.id)
      .eq("idempotency_key", prior.idempotency_key)
      .eq("clob_order_id", prior.clob_order_id)
      .select("id")
      .single();
    if (updateError || !changed) throw new Error("EXECUTION_RECONCILIATION_UPDATE_FAILED");
    summary.updated++;
  }
  return summary;
}
