import { fetchGammaMarketByConditionId, resolveProviderMarketWinner, type ProviderMarketResolution } from "../feed/resolveSignalOutcome";
import {
  advanceExecutionReconciliationFromTelemetry,
  applyResolvedOutcomeToExecutionReconciliation,
  mergeExecutionReconciliationMeta,
  readExecutionReconciliation,
  type ExecutionReconciliationV1,
} from "./executionReconciliation";
import { readEconomicTelemetry } from "./economicTelemetry";
import { planLedgerFillRepair } from "./matchedExecutionLedgerRow";

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
  /** Repairs NULL ledger fill economics from a MATCHED_CONFIRMED reconciliation; CONFLICT = fail closed. */
  mirrorLedgerFill?(eventId: string, reconciliation: ExecutionReconciliationV1): Promise<"UPDATED" | "NOOP" | "MISSING" | "CONFLICT">;
  mirrorLedgerSettlement?(eventId: string, reconciliation: ExecutionReconciliationV1): Promise<void>;
}

export type ExecutionLifecycleResolver = (input: {
  conditionId: string;
}) => Promise<ProviderMarketResolution>;

/** Rotate bounded pages on the existing 5-10 minute cron without a new cursor table. */
export function lifecycleCandidateWindow(count: number, limit: number, nowMs: number): { from: number; to: number } | null {
  if (count <= 0 || limit <= 0) return null;
  const pages = Math.ceil(count / limit);
  const from = (Math.floor(nowMs / 600_000) % pages) * limit;
  return { from, to: Math.min(from + limit - 1, count - 1) };
}

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
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 20);
  const eventRows = await port.loadEvents({ eventIds: options.eventIds, limit });
  const summary: ExecutionLifecycleReconciliationSummary = { loaded: eventRows.length, eligible: 0, updated: 0, unresolved: 0, conflicts: 0, would_update: 0 };
  const resolver = options.resolver ?? defaultResolver;
  // Ledger mirror: fill facts first (settlement ROI reads the ledger's executed stake), never needing
  // market resolution. A conflicting non-null ledger money fact fails closed: no further ledger write.
  const mirrorLedger = async (eventId: string, reconciliation: ExecutionReconciliationV1, settle: boolean): Promise<void> => {
    if (!options.writeMode) return;
    if (reconciliation.fill_status === "MATCHED_CONFIRMED") {
      if ((await port.mirrorLedgerFill?.(eventId, reconciliation)) === "CONFLICT") { summary.conflicts++; return; }
    }
    if (settle) await port.mirrorLedgerSettlement?.(eventId, reconciliation);
  };
  for (const row of eventRows) {
    const prior = readExecutionReconciliation(row.executor_meta);
    if (!prior) continue;
    if (prior.settlement_status === "SETTLED_RECONCILED") {
      await mirrorLedger(row.id, prior, true);
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
      await mirrorLedger(row.id, next, next.result_status === "WON" || next.result_status === "LOST");
      continue;
    }
    if (!options.writeMode) { summary.would_update++; continue; }
    await port.persistEvent({
      id: row.id,
      idempotency_key: prior.idempotency_key,
      clob_order_id: prior.clob_order_id,
      executor_meta: mergeExecutionReconciliationMeta(row.executor_meta, next),
    });
    await mirrorLedger(row.id, next, next.result_status === "WON" || next.result_status === "LOST");
    summary.updated++;
  }
  return summary;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSupabaseExecutionLifecyclePort(supabase: any): ExecutionLifecycleDbPort {
  return {
    async loadEvents({ eventIds, limit }) {
      const projected = "id,created_at,clob_order_id,idempotency_key,executor_meta";
      if (eventIds?.length) {
        const { data, error } = await supabase.from("executor_order_events")
          .select(projected).not("clob_order_id", "is", null).in("id", eventIds).limit(limit);
        if (error) throw new Error(`EXECUTION_RECONCILIATION_READ_FAILED: ${error.message}`);
        return (data ?? []) as ExecutionLifecycleEventRow[];
      }
      const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
      const pendingLimit = Math.min(limit, 15);
      const feeLimit = limit - pendingLimit;
      const [pendingCount, feeCount] = await Promise.all([
        supabase.from("executor_order_events").select("id", { count: "exact", head: true })
          .not("clob_order_id", "is", null).gte("created_at", since)
          .eq("executor_meta->reconciliation_v1->>fill_status", "MATCHED_CONFIRMED")
          .eq("executor_meta->reconciliation_v1->>settlement_status", "PENDING_MARKET_RESOLUTION"),
        supabase.from("executor_order_events").select("id", { count: "exact", head: true })
          .not("clob_order_id", "is", null).gte("created_at", since)
          .eq("executor_meta->reconciliation_v1->>settlement_status", "RESOLVED_FEE_PENDING"),
      ]);
      if (pendingCount.error || feeCount.error) throw new Error(`EXECUTION_RECONCILIATION_COUNT_FAILED: ${pendingCount.error?.message ?? feeCount.error?.message}`);
      const nowMs = Date.now();
      const pendingWindow = lifecycleCandidateWindow(pendingCount.count ?? 0, pendingLimit, nowMs);
      const feeWindow = lifecycleCandidateWindow(feeCount.count ?? 0, feeLimit, nowMs);
      const [pending, feePending] = await Promise.all([
        pendingWindow ? supabase.from("executor_order_events")
          .select(projected).not("clob_order_id", "is", null).gte("created_at", since)
          .eq("executor_meta->reconciliation_v1->>fill_status", "MATCHED_CONFIRMED")
          .eq("executor_meta->reconciliation_v1->>settlement_status", "PENDING_MARKET_RESOLUTION")
          .order("created_at", { ascending: false }).range(pendingWindow.from, pendingWindow.to) : Promise.resolve({ data: [], error: null }),
        feeWindow ? supabase.from("executor_order_events")
          .select(projected).not("clob_order_id", "is", null).gte("created_at", since)
          .eq("executor_meta->reconciliation_v1->>settlement_status", "RESOLVED_FEE_PENDING")
          .order("created_at", { ascending: false }).range(feeWindow.from, feeWindow.to) : Promise.resolve({ data: [], error: null }),
      ]);
      if (pending.error || feePending.error) throw new Error(`EXECUTION_RECONCILIATION_READ_FAILED: ${pending.error?.message ?? feePending.error?.message}`);
      return [...((pending.data ?? []) as ExecutionLifecycleEventRow[]), ...((feePending.data ?? []) as ExecutionLifecycleEventRow[])];
    },
    async persistEvent(input) {
      const { data, error } = await supabase.from("executor_order_events").update({ executor_meta: input.executor_meta }).eq("id", input.id).eq("idempotency_key", input.idempotency_key).eq("clob_order_id", input.clob_order_id).select("id").single();
      if (error || !data) throw new Error("EXECUTION_RECONCILIATION_UPDATE_FAILED");
    },
    async mirrorLedgerFill(eventId, reconciliation) {
      const { data: ledger, error: readError } = await supabase.from("bet_execution_ledger")
        .select("id,executed_stake,fill_price,fee_paid_real").eq("id", eventId).maybeSingle();
      if (readError) throw new Error(`LEDGER_FILL_READ_FAILED: ${readError.message}`);
      // Never create a ledger row here; the callback path owns materialization.
      if (!ledger) return "MISSING";
      const plan = planLedgerFillRepair(ledger as Record<string, unknown>, reconciliation);
      if (plan.kind !== "UPDATE") return plan.kind;
      // Guard each populated column with IS NULL so a concurrent writer is never overwritten.
      let query = supabase.from("bet_execution_ledger").update(plan.patch).eq("id", eventId);
      for (const key of Object.keys(plan.patch)) query = query.is(key, null);
      const { data: written, error: writeError } = await query.select("id");
      if (writeError) throw new Error(`LEDGER_FILL_WRITE_FAILED: ${writeError.message}`);
      // Zero rows = a concurrent writer filled a guarded column first; the next pass re-plans against it.
      return Array.isArray(written) && written.length > 0 ? "UPDATED" : "NOOP";
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
      // Ledger stake wins; reconciliation notional is the authority when the fill mirror has not run.
      const executedStake = Number(ledger.executed_stake ?? reconciliation.executed_notional_usd);
      const roi = realPnl != null && Number.isFinite(executedStake) && executedStake > 0
        ? realPnl / executedStake * 100 : null;
      const rawOrder = ledger.raw_order && typeof ledger.raw_order === "object" && !Array.isArray(ledger.raw_order)
        ? ledger.raw_order as Record<string, unknown> : {};
      const { data: updated, error: writeError } = await supabase.from("bet_execution_ledger").update({
        bet_status: reconciliation.result_status,
        settled_at: reconciliation.resolved_at,
        gross_pnl: reconciliation.gross_pnl_usd,
        // An unreported fee never writes (or nulls) fee_paid_real: a known fact is never regressed.
        ...(feeReported ? { fee_paid_real: reconciliation.fee_usd } : {}),
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
