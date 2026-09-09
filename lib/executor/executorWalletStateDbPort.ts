// lib/executor/executorWalletStateDbPort.ts
//
// Supabase-backed WalletStateDbPort for the canonical current-spendable-balance
// helper. Thin infrastructure glue only — all selection logic lives in the pure
// ./executorWalletState module.

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  getCurrentSpendableWalletState,
  type CurrentSpendableWalletState,
  type GetCurrentSpendableWalletStateOptions,
  type WalletObservationRow,
  type WalletStateDbPort,
} from "./executorWalletState";

const WALLET_OBSERVATION_SELECT =
  "id,idempotency_key,clob_order_id,created_at," +
  "spendable_balance_usd,collateral_balance_usd,allowance_usd," +
  "wallet_observed_at,wallet_observation_lifecycle_point";

function toRow(record: Record<string, unknown>): WalletObservationRow {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const lifecycle = str(record.wallet_observation_lifecycle_point);
  return {
    id: String(record.id),
    idempotency_key: str(record.idempotency_key),
    clob_order_id: str(record.clob_order_id),
    created_at: str(record.created_at),
    spendable_balance_usd: num(record.spendable_balance_usd),
    collateral_balance_usd: num(record.collateral_balance_usd),
    allowance_usd: num(record.allowance_usd),
    wallet_observed_at: str(record.wallet_observed_at),
    wallet_observation_lifecycle_point: (lifecycle as WalletObservationRow["wallet_observation_lifecycle_point"]) ?? null,
  };
}

export function createSupabaseWalletStateDbPort(): WalletStateDbPort {
  return {
    async recentWalletObservations(limit) {
      const { data, error } = await supabaseAdmin
        .from("executor_order_events")
        .select(WALLET_OBSERVATION_SELECT)
        .not("wallet_observed_at", "is", null)
        .not("spendable_balance_usd", "is", null)
        .order("wallet_observed_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRow);
    },
  };
}

/**
 * Canonical internal read for CURRENT_SPENDABLE_BALANCE_USD against the live
 * executor_order_events table. Returns null when no accepted callback has yet
 * carried a usable spendable-balance observation.
 */
export async function readCurrentSpendableWalletState(
  options?: GetCurrentSpendableWalletStateOptions,
): Promise<CurrentSpendableWalletState | null> {
  return getCurrentSpendableWalletState(createSupabaseWalletStateDbPort(), options);
}
