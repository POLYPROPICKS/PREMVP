// scripts/preview-event-rebalance.ts
//
// Dry-run preview of the Contur3 per-event rebalance → execution queue.
//   npm exec tsx scripts/preview-event-rebalance.ts            # dry-run, no writes
//   npm exec tsx scripts/preview-event-rebalance.ts --write    # persist queue rows (safe env only)
//
// Read-only by default. No order placement.

import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const write = process.argv.includes("--write");

  const { runEventRebalance } = await import("../lib/executor/eventExecutionQueue");
  const result = await runEventRebalance(Date.now(), { write });

  console.log("=== EVENT REBALANCE PREVIEW ===");
  console.log(`rebalance_run_id: ${result.rebalance_run_id}`);
  console.log(
    `due=${result.due_count} queued=${result.queued_count} skipped=${result.skipped_count} already=${result.already_queued_count} wrote=${result.wrote}`
  );
  console.log("\n--- outcomes ---");
  result.outcomes.forEach((o) => {
    console.log(`  [${o.result}] ${o.match_family_key} — ${o.reason}`);
    if (o.queue_row) {
      console.log(
        `      market=${o.queue_row.market_slug} side=${o.queue_row.side} ` +
          `stake=$${o.queue_row.stake_usd} entry=${o.queue_row.preferred_entry_iso}..${o.queue_row.latest_entry_iso}`
      );
    }
  });
  if (result.outcomes.length === 0) console.log("  (no due reservations)");

  if (!write) console.log("\n[dry-run] no writes. Pass --write to persist queue rows.");
}

main().catch((e) => {
  console.error("[preview-rebalance] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
