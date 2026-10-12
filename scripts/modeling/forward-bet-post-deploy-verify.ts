import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { pathToFileURL } from "node:url";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const LEDGER = "prospective_selection_shadow_runtime";
const AUTHORITY = "virtual_bet_settlement_authority";
/** Receipt of the one pre-contract DB-first row; it must be byte-for-byte what it was before the migration. */
export const CHLOE_NOEL_RECEIPT = {
  model_id: "TENNIS_P50_52_SAFE", physical_event_key: "1174651",
  condition_id: "0xd33dcc3f0f257bbd467ab208d64ab0eddd8842d9d2481f4c674b2bb1d8cb7f90",
  decision_timestamp: "2026-10-12T12:02:43.744+00:00", first_persisted_at: "2026-10-12T12:31:49.386258+00:00",
  event_start: "2026-10-12T17:00:00+00:00", entry_price: 0.505,
} as const;
export const HISTORICAL_FLOOR = 2858;

export type Check = { id: string; verdict: "PASS" | "FAIL" | "UNPROVEN"; detail: string };

/** Read-only plus provably no-op probes (DELETE/UPDATE on a non-existent key must be refused by privileges, not by absence). */
export async function verifyDeployedSchema(db: SupabaseClient): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, verdict: ok === null ? "UNPROVEN" : ok ? "PASS" : "FAIL", detail });
  const cols = await db.from(LEDGER).select("contract_version,canonical_game_key,game_identity_basis,provider_root_game_id,scope_basis,economic_unit_key,timing_class,timing_detail,contract_status,verification_status,executable_buy_price,executable_price_authority,first_persisted_at").limit(1);
  add("LEDGER_CONTRACT_COLUMNS", !cols.error, cols.error ? `${cols.error.code}:${cols.error.message}` : "all contract columns selectable");
  const auth = await db.from(AUTHORITY).select("check_id,check_kind,outcome,provider_digest,checked_at").limit(1);
  add("SETTLEMENT_AUTHORITY_TABLE", !auth.error, auth.error ? `${auth.error.code}:${auth.error.message}` : "table selectable");
  const del = await db.from(LEDGER).delete().eq("row_key", "__post_deploy_probe_nonexistent__");
  add("LEDGER_DELETE_REFUSED", del.error?.code === "42501", `code=${del.error?.code ?? "none"}`);
  const sDel = await db.from(AUTHORITY).delete().eq("bet_row_key", "__post_deploy_probe_nonexistent__");
  add("SETTLEMENT_DELETE_REFUSED", sDel.error?.code === "42501", `code=${sDel.error?.code ?? "none"}`);
  const sUpd = await db.from(AUTHORITY).update({ reason: "probe" }).eq("bet_row_key", "__post_deploy_probe_nonexistent__");
  add("SETTLEMENT_UPDATE_REFUSED", sUpd.error?.code === "42501", `code=${sUpd.error?.code ?? "none"}`);
  if (cols.error) return checks;
  const historical = await db.from(LEDGER).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").is("first_persisted_at", null);
  add("HISTORICAL_NOT_BACKFILLED", historical.count !== null && historical.count >= HISTORICAL_FLOOR, `rows with unknown first persistence=${historical.count}`);
  const leaked = await db.from(LEDGER).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").is("first_persisted_at", null).not("contract_version", "is", null);
  add("HISTORICAL_HAS_NO_CONTRACT_FIELDS", leaked.count === 0, `historical rows carrying contract fields=${leaked.count}`);
  const chloe = await db.from(LEDGER).select("model_id,physical_event_key,condition_id,decision_timestamp,first_persisted_at,event_start,entry_price,contract_version,settlement_state").eq("row_kind", "LEDGER").eq("physical_event_key", CHLOE_NOEL_RECEIPT.physical_event_key).eq("model_id", CHLOE_NOEL_RECEIPT.model_id).limit(2);
  const row = (chloe.data ?? [])[0] as Record<string, unknown> | undefined;
  const same = !!row && (chloe.data ?? []).length === 1 && Object.entries(CHLOE_NOEL_RECEIPT).every(([k, v]) => k === "entry_price" ? Number(row[k]) === v : new Date(String(row[k])).getTime() === new Date(String(v)).getTime() || row[k] === v) && row.contract_version === null;
  add("CHLOE_NOEL_PRECEDENT_UNCHANGED", same, same ? "receipt identical, still contract-less" : "precedent row differs or is missing");
  return checks;
}

async function main() {
  const url = process.env.SUPABASE_CLONE_URL; const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  if (new URL(url).hostname.split(".")[0] !== CLONE_REF) throw new Error("REFUSING_NON_CLONE_TARGET");
  const checks = await verifyDeployedSchema(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  const overall = checks.every((c) => c.verdict === "PASS") ? "PASS" : "FAIL";
  console.log(JSON.stringify({ FORWARD_BET_POST_DEPLOY_VERIFY: overall, checks }, null, 1));
  process.exitCode = overall === "PASS" ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
