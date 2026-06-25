// Contur3 — computed-tier probe for the six FIFA fixtures (READ-ONLY).
//
// Companion to reservation-capacity-audit.mjs. The .mjs reads the RAW signal
// layer; this probe runs the SAME builder the producer uses
// (buildFireModelCandidates) and prints the COMPUTED tier/score/coverage per
// fixture, so we can tell apart:
//   - WRONG_TIER_MAPPING        (builder downgrades a real Tier1 to TIER2/3)
//   - PRODUCER_ADMISSION_FILTER (Tier1 exists but planner drops it)
//   - PHYSICAL_MATCH_KEY_MISMATCH (candidate exists but key won't join)
//   - NON_TIER1 / NO_ALLOWED_ANCHOR (correct skip, not a bug)
//
// READ-ONLY: builds the candidate universe in memory; no DB writes; no orders.
//
// Run on Railway /app:  npx tsx scripts/contur3/reservation-capacity-audit.tier-probe.ts

import { loadEnvConfig } from "@next/env";

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const FIXTURES: Array<{ id: string; teams: [string[], string[]] }> = [
  { id: "Curaçao vs Côte d’Ivoire", teams: [["curacao"], ["cotedivoire", "ivoire", "coteivoire"]] },
  { id: "Ecuador vs Germany", teams: [["ecuador"], ["germany", "deutschland"]] },
  { id: "Japan vs Sweden", teams: [["japan"], ["sweden"]] },
  { id: "Tunisia vs Netherlands", teams: [["tunisia"], ["netherlands", "holland"]] },
  { id: "Türkiye vs United States", teams: [["turkiye", "turkey"], ["unitedstates", "usa"]] },
  { id: "Paraguay vs Australia", teams: [["paraguay"], ["australia"]] },
];

function teamMatch(textNorm: string, variants: string[]): boolean {
  return variants.some((v) => textNorm.includes(v));
}

async function main() {
  loadEnvConfig(process.cwd());
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");

  // Same universe the night reservation planner consumes (planningMode=true, uncapped).
  const { candidates } = await buildFireModelCandidates(100_000, "all", true);
  console.log(`universe_size: ${candidates.length}`);

  for (const fx of FIXTURES) {
    const hits = candidates.filter((c) => {
      const tn = norm(
        `${c.event_slug ?? ""} ${c.market_slug ?? ""} ${c.match_family_key} ${c.canonical_event_key ?? ""}`,
      );
      // BOTH teams, or either team (single-team market) — show all so nothing is hidden.
      return teamMatch(tn, fx.teams[0]) || teamMatch(tn, fx.teams[1]);
    });

    const tier1 = hits.filter((c) => c.strategy === "TIER1_CORE_STRICT_72_COV50");
    console.log(`\n=== ${fx.id} ===`);
    console.log(`  candidates_found: ${hits.length}  tier1: ${tier1.length}`);
    for (const c of hits.slice(0, 12)) {
      console.log(
        "  " +
          JSON.stringify({
            strategy: c.strategy,
            score: c.diagnostics?.score,
            coverage: c.diagnostics?.coverage,
            mfk: c.match_family_key,
            mfk_source: c.match_family_key_source,
            mfk_weak: c.match_family_key_is_weak,
            cek: c.canonical_event_key,
            market: c.market_slug,
            start: c.diagnostics?.game_start_iso,
          }),
      );
    }
  }

  console.log(
    "\nINTERPRETATION:\n" +
      "  tier1>0 but no reservation  -> PRODUCER_ADMISSION or PHYSICAL_MATCH_KEY_MISMATCH\n" +
      "  candidates_found>0 but tier1=0 with score>=72&cov>=50 in raw -> WRONG_TIER_MAPPING\n" +
      "  candidates_found=0 for a fixture with raw signals -> KEY/SOURCE layer mismatch\n" +
      "  only TIER2/TIER3 or blocked markets -> correct Tier1 skip (NOT a bug)",
  );
}

main().catch((e) => {
  console.error("tier-probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
