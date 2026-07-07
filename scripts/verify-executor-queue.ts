// scripts/verify-executor-queue.ts
//
// Read-only verification of event_execution_queue (the Ireland executable source).
//   npm exec tsx scripts/verify-executor-queue.ts
//
// Prints READY rows in deterministic order and flags any policy violation
// (non-Tier1, invalid stake, missing condition/token/side, expired latest_entry,
// missing price cap). No writes. No orders.
//
// Stake is dynamic per-candidate (computeBaseStake/computeStake in
// buildFireModelCandidates.ts), not a fixed $7 — this check validates the
// stake is a sane positive number within the current model's cap, not that it
// equals a single hardcoded constant.

import { loadEnvConfig } from "@next/env";

// Mirrors the outer cap in lib/executor/buildFireModelCandidates.ts computeStake()
// (Math.min(stake, 10)). Kept as an upper sanity bound, not the only valid value.
const MAX_SANE_STAKE_USD = 10;

async function main() {
  loadEnvConfig(process.cwd());
  const { supabaseAdmin } = await import("../lib/supabase/server");
  const { EXECUTABLE_TIER } = await import("../lib/executor/executorQueueTypes");

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
    const stake = Number(r.stake_usd);
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_SANE_STAKE_USD) {
      violations.push(`${tag}: stake=${r.stake_usd} (expected finite 0 < stake <= ${MAX_SANE_STAKE_USD})`);
    }
    if (!r.condition_id || !r.token_id || !r.side)
      violations.push(`${tag}: missing condition/token/side`);
    if (typeof r.latest_entry_iso === "string" && Date.parse(r.latest_entry_iso) <= Date.now())
      violations.push(`${tag}: latest_entry_iso already passed`);
    const diagnostics = (r.diagnostics ?? {}) as Record<string, unknown>;
    const maxEntryPrice = Number(diagnostics.max_entry_price);
    if (!Number.isFinite(maxEntryPrice)) {
      violations.push(`${tag}: missing max_entry_price in diagnostics (no price cap for consumer)`);
    }
    console.log(
      `  [${r.tier}] ${r.match_family_key} side=${r.side} stake=$${r.stake_usd} ` +
        `max_entry_price=${diagnostics.max_entry_price ?? "MISSING"} ` +
        `entry=${r.preferred_entry_iso}..${r.latest_entry_iso}`
    );
  }

  console.log("\n--- policy check ---");
  if (violations.length === 0) {
    console.log("PASS: all READY rows satisfy Tier1 / valid stake / price cap / ids / unexpired.");
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
