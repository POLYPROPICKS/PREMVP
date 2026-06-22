// scripts/preview-night-event-reservations.ts
//
// Dry-run preview of the Contur3 event-first night reservation plan.
//   npm exec tsx scripts/preview-night-event-reservations.ts            # dry-run, no writes
//   npm exec tsx scripts/preview-night-event-reservations.ts --write    # persist (safe env only)
//
// Read-only by default. No order placement. The --write flag persists frozen
// reservations and must only be used against a configured Supabase env.
//
// Exits 1 if any reservation contains market-level text in key or title (P0 guard).

import { loadEnvConfig } from "@next/env";

const MARKET_LEVEL_FAIL_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|halftime[\s-]result|\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|player\s+prop|goalscorer/i;

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
        `start=${r.game_start_iso} score=${r.event_score} key=${r.match_family_key}`
    );
  });
  if (plan.reservations.length === 0) console.log("  (none)");

  // ── P0 guard: fail if any reservation contains market-level text ──────────
  const violations: string[] = [];
  const seenKeys = new Map<string, number>(); // key → first rank
  for (const r of plan.reservations) {
    if (MARKET_LEVEL_FAIL_RE.test(r.match_family_key)) {
      violations.push(`MARKET_LEVEL_KEY in match_family_key: #${r.reservation_rank} key="${r.match_family_key}"`);
    }
    if (MARKET_LEVEL_FAIL_RE.test(r.event_title ?? "")) {
      violations.push(`MARKET_LEVEL_TEXT in event_title: #${r.reservation_rank} title="${r.event_title}"`);
    }
    if (seenKeys.has(r.match_family_key)) {
      violations.push(`DUPLICATE_KEY: #${r.reservation_rank} and #${seenKeys.get(r.match_family_key)} share key="${r.match_family_key}"`);
    } else {
      seenKeys.set(r.match_family_key, r.reservation_rank ?? -1);
    }
  }

  console.log("\n--- normalization summary ---");
  console.log(`  reserved_count:              ${plan.diagnostics.reserved_count}`);
  console.log(`  canonical_event_groups:      ${plan.diagnostics.canonical_event_groups}`);
  console.log(`  market_level_keys_skipped:   ${plan.diagnostics.market_level_keys_skipped}`);
  console.log(`  market_level_keys_normalized:${plan.diagnostics.market_level_keys_normalized}`);
  console.log(`  skipped_weak_key:            ${plan.diagnostics.skipped_weak_key}`);
  console.log(`  by_sport:                    ${JSON.stringify(plan.diagnostics.by_sport)}`);

  if (violations.length > 0) {
    console.error("\n[FAIL] P0 VIOLATIONS — market-level text in reservations:");
    violations.forEach((v) => console.error(`  ✗ ${v}`));
    process.exit(1);
  }
  console.log("\n[PASS] No market-level keys or titles in reservations.");

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
