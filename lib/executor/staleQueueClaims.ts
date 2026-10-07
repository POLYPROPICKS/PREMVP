import { hasUnresolvedNeedsReconciliation } from "./makerFallbackAuthorization";

export const STALE_CLAIM_REASON = "CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT";
export const STALE_CLAIM_LIMIT = 50;

export interface StaleClaimRow {
  id: string;
  status: string;
  latest_entry_iso: string | null;
  idempotency_key: string | null;
  condition_id: string | null;
  token_id: string | null;
  side: string | null;
  diagnostics: Record<string, unknown> | null;
}

export interface StaleClaimPort {
  loadExpiredClaims(nowIso: string, limit: number): Promise<StaleClaimRow[]>;
  hasMatchingOrderEvent(row: StaleClaimRow): Promise<boolean>;
  expireClaim(row: StaleClaimRow, nowIso: string, diagnostics: Record<string, unknown>): Promise<boolean>;
}

export async function reconcileStaleClaims(port: StaleClaimPort, nowIso: string, write: boolean) {
  const rows = await port.loadExpiredClaims(nowIso, STALE_CLAIM_LIMIT);
  let protectedByOrderEvent = 0;
  let protectedByUnresolvedTransport = 0;
  let expired = 0;
  for (const row of rows) {
    if (row.status !== "CLAIMED" || !row.latest_entry_iso || row.latest_entry_iso > nowIso) continue;
    // A persisted typed UNKNOWN_TRANSPORT / NEEDS_RECONCILIATION row is an unresolved venue outcome, not "no order
    // event": it must never be silently collapsed into CLAIM_LEASE_EXPIRED_NO_ORDER_EVENT. A later terminal
    // callback resolves it through the normal Queue mark; the sweep leaves it exactly as it is.
    if (hasUnresolvedNeedsReconciliation(row.diagnostics)) {
      protectedByUnresolvedTransport++;
      continue;
    }
    // Unknown or mismatched identity must fail closed; it cannot prove the
    // absence of a venue order associated with this Queue instruction.
    if (!row.idempotency_key || !row.condition_id || !row.token_id || !row.side) continue;
    if (await port.hasMatchingOrderEvent(row)) {
      protectedByOrderEvent++;
      continue;
    }
    if (!write) continue;
    const prior = row.diagnostics ?? {};
    const diagnostics = {
      ...prior,
      claim_expiry: {
        reason: STALE_CLAIM_REASON,
        claimed_at: prior.claimed_at ?? null,
        expired_at: nowIso,
        previous_status: "CLAIMED",
      },
    };
    if (await port.expireClaim(row, nowIso, diagnostics)) expired++;
  }
  return {
    scanned: rows.length,
    protected_by_order_event: protectedByOrderEvent,
    // Reported only when non-zero so the established result shape is unchanged for every other sweep.
    ...(protectedByUnresolvedTransport > 0 ? { protected_by_unresolved_transport: protectedByUnresolvedTransport } : {}),
    expired_count: expired,
  };
}
