// Supabase adapter for the MAKER_FALLBACK_1 authorization port. Thin infrastructure glue:
// all decisions live in makerFallbackAuthorization.ts.
//
// Diagnostics writes are optimistic-concurrency (updated_at compare-and-set) so a replayed or
// concurrent callback can neither create a second maker command nor erase an existing one.

import { supabaseAdmin } from "@/lib/supabase/server";
import { fetchOrderBook } from "@/lib/liquidity/polymarketClient";
import { getBestBidAsk } from "@/lib/liquidity/orderbookMath";
import type { EventExecutionQueueRow } from "./executorQueueTypes";
import {
  EXECUTION_ATTEMPTS_KEY,
  readExecutionAttempts,
  type ExecutionAttemptsV1,
  type MakerFallbackPort,
} from "./makerFallbackAuthorization";

const MAX_CAS_RETRIES = 4;

async function mutateAttempts(
  queueId: string,
  fn: (attempts: ExecutionAttemptsV1) => ExecutionAttemptsV1 | null,
): Promise<boolean> {
  for (let i = 0; i < MAX_CAS_RETRIES; i++) {
    const { data, error } = await supabaseAdmin
      .from("event_execution_queue")
      .select("diagnostics, updated_at")
      .eq("id", queueId)
      .single();
    if (error || !data) throw new Error("MAKER_FALLBACK_QUEUE_READ_FAILED");
    const row = data as { diagnostics: Record<string, unknown> | null; updated_at: string | null };
    const next = fn(readExecutionAttempts(row.diagnostics));
    if (next === null) return false; // nothing to write (e.g. command already exists)
    let q = supabaseAdmin
      .from("event_execution_queue")
      .update({
        diagnostics: { ...(row.diagnostics ?? {}), [EXECUTION_ATTEMPTS_KEY]: next },
        updated_at: new Date().toISOString(),
      })
      .eq("id", queueId);
    q = row.updated_at ? q.eq("updated_at", row.updated_at) : q.is("updated_at", null);
    const { data: updated, error: updateError } = await q.select("id");
    if (updateError) throw new Error("MAKER_FALLBACK_QUEUE_WRITE_FAILED");
    if (updated && updated.length === 1) return true;
  }
  throw new Error("MAKER_FALLBACK_CAS_EXHAUSTED");
}

export function createSupabaseMakerFallbackPort(): MakerFallbackPort {
  return {
    async loadQueueRowByIdempotencyKey(key) {
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as EventExecutionQueueRow | null) ?? null;
    },
    async fetchBook(tokenId) {
      const res = await fetchOrderBook(tokenId);
      if (!res.ok || !res.book) return null;
      const { bestBid, bestAsk } = getBestBidAsk(res.book);
      const raw = res.book.raw as Record<string, unknown> | null | undefined;
      const tick = Number(raw?.tick_size);
      return { bestBid, bestAsk, tickSize: Number.isFinite(tick) && tick > 0 ? tick : null };
    },
    async recordResult(queueId, slot, result) {
      await mutateAttempts(queueId, (a) => ({ ...a, [slot]: { ...(a[slot] ?? {}), result } }));
    },
    async claimMakerFallback(queueId, command) {
      return mutateAttempts(queueId, (a) =>
        a.maker_fallback_1?.command ? null : { ...a, maker_fallback_1: { ...(a.maker_fallback_1 ?? {}), command } },
      );
    },
  };
}
