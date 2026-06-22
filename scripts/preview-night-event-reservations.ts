// scripts/preview-night-event-reservations.ts
//
// Dry-run preview of the Contur3 event-first night reservation plan.
//   npm exec tsx scripts/preview-night-event-reservations.ts            # dry-run, no writes
//   npm exec tsx scripts/preview-night-event-reservations.ts --write    # persist (safe env only)
//
// Read-only by default. No order placement. The --write flag persists frozen
// reservations and must only be used against a configured Supabase env.

import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const write = process.argv.includes("--write");
  const force = process.argv.includes("--force");

  const { buildReservationPlan, persistReservationPlan } = await import(
    "../lib/executor/nightEventReservations"
  );

  const plan = await buildReservationPlan(Date.now());

  console.log("=== NIGHT EVENT RESERVATION PREVIEW ===");
  console.log(`plan_run_id:    ${plan.plan_run_id}`);
  console.log(`plan_date:      ${plan.plan_date_minsk}`);
  console.log(`window:         ${plan.window.startIso} -> ${plan.window.endIso}`);
  console.log(`horizon_end:    ${plan.window.horizonEndIso}`);
  console.log(`diagnostics:    ${JSON.stringify(plan.diagnostics, null, 2)}`);
  console.log("\n--- reserved events ---");
  plan.reservations.forEach((r) => {
    console.log(
      `  #${r.reservation_rank} [${r.event_tier}] ${r.event_title} (${r.strategic_scope}) ` +
        `start=${r.game_start_iso} score=${r.event_score}`
    );
  });
  if (plan.reservations.length === 0) console.log("  (none)");

  if (write) {
    const result = await persistReservationPlan(plan, { force });
    console.log("\n=== PERSIST RESULT ===");
    console.log(JSON.stringify({ ...result, reservations: undefined }, null, 2));
  } else {
    console.log("\n[dry-run] no writes. Pass --write to persist.");
  }
}

main().catch((e) => {
  console.error("[preview-reservations] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
