// INPLAY_SHADOW_PROBES_V1: read-only. Prints deterministic JSON to stdout.
// Run: npx tsx scripts/modeling/inplay-shadow-probes-v1.ts [--with-prod-count]
// Reads DBClone only (explicit columns, bounded rows). Production is touched only by --with-prod-count (head count + 1 timestamp).
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { resolveCloneClient } from "./live-d1-research-corpus";
import { PROBE_COLUMNS, runInplayShadowProbes, type InplayObservation } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";

const TABLE = "research_inplay_core_path_observations";
export const RAW_ROW_CAP = 200;

type ReadClient = { from: (t: string) => any };

async function headCount(db: ReadClient): Promise<number> {
  const r = await db.from(TABLE).select("id", { count: "exact", head: true });
  if (r.error) throw new Error(`INPLAY_COUNT:${r.error.message}`);
  return r.count ?? 0;
}

/** FULL_CURRENT_CLONE when the table fits the cap; otherwise the earliest cap rows, labelled BOUNDED_SAMPLE. */
export async function readCorpus(db: ReadClient, cap = RAW_ROW_CAP) {
  const total = await headCount(db);
  const r = await db.from(TABLE).select(PROBE_COLUMNS.join(",")).order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(cap);
  if (r.error) throw new Error(`INPLAY_READ:${r.error.message}`);
  const rows = (r.data ?? []) as InplayObservation[];
  return {
    rows,
    clone_row_n: total,
    corpus_scope: total <= cap ? "FULL_CURRENT_CLONE" : "BOUNDED_SAMPLE",
    selection_rule: total <= cap ? "all rows" : `earliest ${cap} rows by observed_at asc, id asc`,
  };
}

async function prodCount(): Promise<{ prod_row_n: number; prod_max_observed_at: string | null }> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("INPLAY_PRODUCTION_DB_CONFIG_MISSING");
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const n = await headCount(db);
  const last = await db.from(TABLE).select("observed_at").order("observed_at", { ascending: false }).limit(1);
  if (last.error) throw new Error(`INPLAY_PROD_MAX:${last.error.message}`);
  return { prod_row_n: n, prod_max_observed_at: last.data?.[0]?.observed_at ?? null };
}

async function main(): Promise<void> {
  const { client } = resolveCloneClient();
  const corpus = await readCorpus(client);
  const out: Record<string, unknown> = {
    task: "INPLAY_SHADOW_PROBES_V1",
    CORPUS_SCOPE: corpus.corpus_scope,
    SELECTION_RULE: corpus.selection_rule,
    CLONE_ROW_N: corpus.clone_row_n,
    ...runInplayShadowProbes(corpus.rows),
  };
  if (process.argv.includes("--with-prod-count")) {
    const prod = await prodCount();
    out.PROD_ROW_N = prod.prod_row_n;
    out.CLONE_LAG_ROWS = prod.prod_row_n - corpus.clone_row_n;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : "INPLAY_PROBES_FAILED"); process.exit(1); });
}
