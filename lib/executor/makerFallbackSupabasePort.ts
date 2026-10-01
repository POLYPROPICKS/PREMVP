// Supabase adapter for the MAKER_FALLBACK_1 authorization port. Thin infrastructure glue:
// all decisions live in makerFallbackAuthorization.ts.
//
// Diagnostics writes are optimistic-concurrency (updated_at compare-and-set) so a replayed or
// concurrent callback can neither create a second maker command nor erase an existing one.

import { supabaseAdmin } from "@/lib/supabase/server";
import { fetchOrderBook } from "@/lib/liquidity/polymarketClient";
import { getBestBidAsk } from "@/lib/liquidity/orderbookMath";
import type { EventExecutionQueueRow } from "./executorQueueTypes";
import { claimMakerCommandCas, recordAttemptResultCas, type QueueCasPort, type QueueCasRow } from "./queueAttemptsCas";
import type { MakerFallbackPort } from "./makerFallbackAuthorization";

export function createSupabaseQueueCasPort(): QueueCasPort {
  return {
    async read(queueId) {
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .select("status, diagnostics, updated_at")
        .eq("id", queueId)
        .maybeSingle();
      if (error) throw new Error("QUEUE_CAS_READ_FAILED");
      return (data as QueueCasRow | null) ?? null;
    },
    async compareAndSet(queueId, expectedUpdatedAt, columns) {
      let q = supabaseAdmin.from("event_execution_queue").update(columns).eq("id", queueId);
      q = expectedUpdatedAt ? q.eq("updated_at", expectedUpdatedAt) : q.is("updated_at", null);
      const { data, error } = await q
        .select("id, status, order_key, match_family_key, stake_usd, condition_id, token_id, side, idempotency_key, diagnostics, updated_at");
      if (error) throw new Error("QUEUE_CAS_WRITE_FAILED");
      return data && data.length === 1 ? (data[0] as Record<string, unknown>) : null;
    },
  };
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
      await recordAttemptResultCas(createSupabaseQueueCasPort(), queueId, slot, result);
    },
    async claimMakerFallback(queueId, command) {
      return claimMakerCommandCas(createSupabaseQueueCasPort(), queueId, command);
    },
  };
}
