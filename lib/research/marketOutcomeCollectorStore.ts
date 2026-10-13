// Supabase (DBClone) implementation of CollectorStore. Uses only grants Box B gives service_role
// (select/insert on the two tables) plus the existing job_runs table for the durable checkpoint.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BoxBRejected, COLLECTOR_SOURCE, COND_RE, emptyState, RECHECK_STATUSES,
  type CollectorState, type CollectorStore, type CycleStats, type HeadPos, type DiscoverySource, type LatestRevision, type Receipt, type RevisionRow,
} from "./marketOutcomeCollector";

const IN_CHUNK = 40;
const fail = (what: string, e: { message?: string } | null) => new Error(`BOX_B_COLLECTOR_${what}:${(e?.message ?? "unknown").slice(0, 200)}`);

export function createSupabaseStore(db: SupabaseClient): CollectorStore {
  return {
    async readCheckpoint() {
      const { data, error } = await db.from("job_runs").select("diagnostics")
        .eq("source", COLLECTOR_SOURCE).order("finished_at", { ascending: false }).limit(1); // newest write wins; every row of this source carries the state
      if (error) throw fail("CHECKPOINT_READ", error);
      const st = (data?.[0]?.diagnostics as { state?: CollectorState } | undefined)?.state;
      if (!st || st.v !== 1) return null;
      return { ...emptyState(), ...st, sources: { ...emptyState().sources, ...st.sources } };
    },

    async writeCheckpoint(state: CollectorState, stats: CycleStats) {
      const { error } = await db.from("job_runs").insert({
        source: COLLECTOR_SOURCE, formula_version: COLLECTOR_SOURCE,
        started_at: stats.started_at, finished_at: stats.finished_at ?? new Date().toISOString(),
        // status stays "success" (reader contract); the real cycle verdict is diagnostics.stats.verdict
        status: "success", generated_count: stats.revisions_inserted, rejected_count: stats.db_rejected + stats.db_errors,
        duration_ms: Math.max(0, Date.parse(stats.finished_at ?? stats.started_at) - Date.parse(stats.started_at)),
        diagnostics: { state, stats },
      });
      if (error) throw fail("CHECKPOINT_WRITE", error);
    },

    async readBackfillPage(table: DiscoverySource, after, limit) {
      let q = db.from(table).select("condition_id").order("condition_id", { ascending: true }).limit(limit);
      if (after) q = q.gt("condition_id", after);
      const { data, error } = await q;
      if (error) throw fail(`READ_${table}`, error);
      const rows = (data ?? []) as { condition_id: string }[];
      const ids: string[] = []; const seen = new Set<string>(); const bad = new Set<string>();
      for (const r of rows) {
        const id = r.condition_id;
        if (!COND_RE.test(id)) { bad.add(id); continue; }
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      return { ids, malformed: bad.size, last: rows.length ? rows[rows.length - 1]!.condition_id : null, exhausted: rows.length < limit };
    },

    async readHeadPage(table: DiscoverySource, pos: HeadPos, limit) {
      let q = db.from(table).select("condition_id,observed_at")
        .order("observed_at", { ascending: true }).order("condition_id", { ascending: true }).limit(limit);
      q = pos.id === null
        ? q.gt("observed_at", pos.t)
        : q.or(`observed_at.gt.${pos.t},and(observed_at.eq.${pos.t},condition_id.gt.${pos.id})`);
      const { data, error } = await q;
      if (error) throw fail(`HEAD_${table}`, error);
      const rows = (data ?? []) as { condition_id: string; observed_at: string }[];
      const bad = new Set<string>();
      const ok = rows.filter((r) => { if (COND_RE.test(r.condition_id)) return true; bad.add(r.condition_id); return false; });
      // the position follows the page tail even when its last rows are malformed
      const last = rows.length ? rows[rows.length - 1]! : null;
      return {
        rows: ok.map((r) => ({ id: r.condition_id, observed_at: r.observed_at })),
        tail: last ? { t: last.observed_at, id: last.condition_id } : null,
        malformed: bad.size, exhausted: rows.length < limit,
      };
    },

    async countReceipts() {
      const { count, error } = await db.from("market_outcome_provider_receipts").select("receipt_id", { count: "estimated", head: true });
      if (error) throw fail("RECEIPT_COUNT", error);
      return count ?? 0;
    },

    async latestRevisions(ids: string[]) {
      const out = new Map<string, LatestRevision>();
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const chunk = ids.slice(i, i + IN_CHUNK);
        const { data, error } = await db.from("market_outcome_revisions")
          .select("condition_id,revision_no,outcome_status,winner_token_id,gamma_winner_token_id,clob_winner_token_id,resolved_at,status_reason,checked_at")
          .in("condition_id", chunk);
        if (error) throw fail("LATEST_READ", error);
        for (const r of (data ?? []) as LatestRevision[]) {
          const prev = out.get(r.condition_id);
          if (!prev || r.revision_no > prev.revision_no) out.set(r.condition_id, r);
        }
      }
      return out;
    },

    async readRecheckPage(after, limit) {
      let q = db.from("market_outcome_revisions").select("condition_id")
        .in("outcome_status", [...RECHECK_STATUSES]).order("condition_id", { ascending: true }).limit(limit);
      if (after) q = q.gt("condition_id", after);
      const { data, error } = await q;
      if (error) throw fail("RECHECK_READ", error);
      const rows = (data ?? []) as { condition_id: string }[];
      return { ids: [...new Set(rows.map((r) => r.condition_id))], last: rows.length ? rows[rows.length - 1]!.condition_id : null, exhausted: rows.length < limit };
    },

    async saveReceipts(receipts: Receipt[]) {
      const uniq = new Map<string, Receipt>();
      for (const r of receipts) uniq.set(`${r.provider}|${r.raw_digest}`, r);
      const list = [...uniq.values()];
      const { error } = await db.from("market_outcome_provider_receipts")
        .upsert(list, { onConflict: "provider,request_kind,request_key,raw_digest", ignoreDuplicates: true });
      if (error) throw fail("RECEIPT_WRITE", error);
      const key = list[0]!.request_key;
      const { data, error: e2 } = await db.from("market_outcome_provider_receipts")
        .select("receipt_id,provider,raw_digest").eq("request_kind", "condition_id").eq("request_key", key)
        .in("raw_digest", list.map((r) => r.raw_digest));
      if (e2) throw fail("RECEIPT_READ", e2);
      const out = new Map<string, number>();
      for (const r of (data ?? []) as { receipt_id: number; provider: string; raw_digest: string }[]) out.set(`${r.provider}|${r.raw_digest}`, r.receipt_id);
      return out;
    },

    async insertRevision(row: RevisionRow) {
      const { data, error } = await db.from("market_outcome_revisions").insert(row).select("condition_id");
      if (error) {
        if (/BOX_B_|violates (check|foreign key|not-null)/i.test(error.message ?? "")) throw new BoxBRejected(error.message.slice(0, 200));
        throw fail("REVISION_WRITE", error);
      }
      return (data ?? []).length > 0; // empty = revision guard's idempotent no-op (identical evidence)
    },
  };
}
