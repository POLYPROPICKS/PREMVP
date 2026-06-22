// scripts/verify-executor-queue.ts
//
// Read-only verification of event_execution_queue (the Ireland executable source).
//   npm exec tsx scripts/verify-executor-queue.ts
//
// Prints READY rows in deterministic order and flags any policy violation
// (non-Tier1, stake != 7, missing condition/token/side, expired latest_entry).
// No writes. No orders.

import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const { supabaseAdmin } = await import("../lib/supabase/server");
  const { EXECUTABLE_STAKE_USD, EXECUTABLE_TIER } = await import(
    "../lib/executor/executorQueueTypes"
  );

  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("event_execution_queue")
    .select("*")
    .eq("status", "READY")
    .order("preferred_entry_iso", { ascending: true })
    .order("queued_at", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  console.log(`=== EXECUTOR QUEUE VERIFY (${nowIso}) ===`);
  console.log(`READY rows: ${rows.length}`);

  const violations: string[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const tag = `${r.match_family_key}`;
    if (r.tier !== EXECUTABLE_TIER) violations.push(`${tag}: tier=${r.tier} (expected ${EXECUTABLE_TIER})`);
    if (Number(r.stake_usd) !== EXECUTABLE_STAKE_USD)
      violations.push(`${tag}: stake=${r.stake_usd} (expected ${EXECUTABLE_STAKE_USD})`);
    if (!r.condition_id || !r.token_id || !r.side)
      violations.push(`${tag}: missing condition/token/side`);
    if (typeof r.latest_entry_iso === "string" && Date.parse(r.latest_entry_iso) <= Date.now())
      violations.push(`${tag}: latest_entry_iso already passed`);
    console.log(
      `  [${r.tier}] ${r.match_family_key} side=${r.side} stake=$${r.stake_usd} ` +
        `entry=${r.preferred_entry_iso}..${r.latest_entry_iso}`
    );
  }

  console.log("\n--- policy check ---");
  if (violations.length === 0) {
    console.log("PASS: all READY rows satisfy Tier1 / stake=7 / ids / unexpired.");
  } else {
    console.log(`FAIL: ${violations.length} violation(s):`);
    violations.forEach((v) => console.log(`  - ${v}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[verify-queue] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
