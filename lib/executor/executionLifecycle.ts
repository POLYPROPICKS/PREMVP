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
  mirrorLedgerSettlement?(eventId: string, reconciliation: ExecutionReconciliationV1): Promise<void>;
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
    if (!prior) continue;
    if (prior.settlement_status === "SETTLED_RECONCILED") {
      if (options.writeMode) await port.mirrorLedgerSettlement?.(row.id, prior);
      continue;
    }
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
    if (JSON.stringify(next) === JSON.stringify(prior)) {
      if (options.writeMode && (next.result_status === "WON" || next.result_status === "LOST"))
        await port.mirrorLedgerSettlement?.(row.id, next);
      continue;
    }
    if (!options.writeMode) { summary.would_update++; continue; }
    await port.persistEvent({
      id: row.id,
      idempotency_key: prior.idempotency_key,
      clob_order_id: prior.clob_order_id,
      executor_meta: mergeExecutionReconciliationMeta(row.executor_meta, next),
    });
    if (next.result_status === "WON" || next.result_status === "LOST")
      await port.mirrorLedgerSettlement?.(row.id, next);
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
    async mirrorLedgerSettlement(eventId, reconciliation) {
      if ((reconciliation.result_status !== "WON" && reconciliation.result_status !== "LOST") ||
          !reconciliation.resolved_at || reconciliation.gross_pnl_usd == null) return;
      const { data: ledger, error: readError } = await supabase.from("bet_execution_ledger")
        .select("id,executed_stake,raw_order").eq("id", eventId).maybeSingle();
      if (readError) throw new Error(`LEDGER_SETTLEMENT_READ_FAILED: ${readError.message}`);
      // Historical events without a materialized execution row are outside
      // this mission; never create one during settlement.
      if (!ledger) return;
      const feeReported = reconciliation.fee_status === "REPORTED" && reconciliation.fee_usd != null;
      const realPnl = feeReported ? reconciliation.net_pnl_usd : null;
      const executedStake = Number(ledger.executed_stake);
      const roi = realPnl != null && ledger.executed_stake != null && Number.isFinite(executedStake) && executedStake > 0
        ? realPnl / executedStake * 100 : null;
      const rawOrder = ledger.raw_order && typeof ledger.raw_order === "object" && !Array.isArray(ledger.raw_order)
        ? ledger.raw_order as Record<string, unknown> : {};
      const { data: updated, error: writeError } = await supabase.from("bet_execution_ledger").update({
        bet_status: reconciliation.result_status,
        settled_at: reconciliation.resolved_at,
        gross_pnl: reconciliation.gross_pnl_usd,
        fee_paid_real: feeReported ? reconciliation.fee_usd : null,
        real_pnl: realPnl,
        real_roi_on_stake: roi,
        result_side: null,
        raw_order: { ...rawOrder, settlement_v1: {
          reconciliation,
          winning_outcome: reconciliation.winning_outcome,
          winning_token_id: reconciliation.winning_token_id,
        } },
      }).eq("id", eventId).select("id").single();
      if (writeError || !updated) throw new Error(`LEDGER_SETTLEMENT_WRITE_FAILED: ${writeError?.message ?? "missing row"}`);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconcileExecutionLifecycle(supabase: any, options: ExecutionLifecycleReconciliationOptions): Promise<ExecutionLifecycleReconciliationSummary> {
  return reconcileExecutionLifecycleWithPort(createSupabaseExecutionLifecyclePort(supabase), options);
}
