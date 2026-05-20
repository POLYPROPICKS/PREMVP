// Signal generation script
// Generates TrustedInitialformulaLanding1.1 pairs and caches them in Supabase

import { buildLandingCards } from "../lib/feed/buildLandingCards";
import {
  writeGeneratedSignalPairs,
  writeJobRun,
} from "../lib/feed/cacheGeneratedSignals";
import { FORMULA_VERSION } from "../lib/feed/types";

const CONFIG = {
  limit: 15,
  category: "sports",
  minDataCoverage: 40,
  excludeEnded: true,
  cacheExpiryHours: 1, // Cache valid for 1 hour
  includeUpcoming: true,
  upcomingLimit: 5,
};

async function main() {
  const startedAt = new Date().toISOString();
  let status: "success" | "empty" | "error" = "success";
  let generatedCount = 0;
  let rejectedCount = 0;
  let errorMessage: string | undefined;
  let diagnostics: Record<string, unknown> = {};

  console.log("[generate-signals] Starting signal generation...");
  console.log(`[generate-signals] Config: ${JSON.stringify(CONFIG)}`);

  try {
    // Call sports landing cards generation logic
    const result = await buildLandingCards({
      limit: CONFIG.limit,
      category: CONFIG.category,
      minDataCoverage: CONFIG.minDataCoverage,
      excludeEnded: CONFIG.excludeEnded,
      includeUpcoming: CONFIG.includeUpcoming,
      upcomingLimit: CONFIG.upcomingLimit,
    });

    const pairsToCache = [...result.pairs, ...(result.upcomingPairs ?? [])];
    generatedCount = pairsToCache.length;
    rejectedCount = result.rejected?.length ?? 0;

    diagnostics = {
      discoveryMode: "markets-first-buildLandingCards",
      generated_count: generatedCount,
      qualified_count: result.pairs.length,
      upcoming_count: result.upcomingPairs?.length ?? 0,
      rejected_count: rejectedCount,
      inspected: result.inspected,
    };

    console.log(`[generate-signals] Generated ${result.pairs.length} qualified + ${result.upcomingPairs?.length ?? 0} upcoming = ${generatedCount} total pairs`);
    console.log(`[generate-signals] Rejected ${rejectedCount} markets`);

    if (generatedCount === 0) {
      status = "empty";
      console.log("[generate-signals] No pairs generated - caching skipped");
    } else {
      // Write pairs to cache for ok/partial status
      const expiresAt = new Date(
        Date.now() + CONFIG.cacheExpiryHours * 60 * 60 * 1000
      ).toISOString();

      await writeGeneratedSignalPairs({
        pairs: pairsToCache.map((p: any) => ({
          premiumSignal: {
            ...p.premiumSignal,
            metrics: p.premiumSignal.metrics.map((m: any) => ({
              ...m,
              value: typeof m.value === 'number' ? m.value : parseFloat(String(m.value)) || 0,
            })),
          },
          marketSource: p.marketSource,
          marketSources: p.marketSources,
          diagnostics: p.diagnostics,
        })),
        source: "polymarket",
        formulaVersion: FORMULA_VERSION,
        expiresAt,
      });

      console.log(`[generate-signals] Cached ${generatedCount} pairs (expires: ${expiresAt})`);
    }
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[generate-signals] Generation failed:", errorMessage);
  }

  // Write job run record regardless of outcome
  const finishedAt = new Date().toISOString();
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  try {
    await writeJobRun({
      source: "polymarket",
      formulaVersion: FORMULA_VERSION,
      startedAt,
      finishedAt,
      status,
      generatedCount,
      rejectedCount,
      durationMs,
      errorMessage,
      diagnostics,
    });
    console.log(`[generate-signals] Job run recorded (${status})`);
  } catch (jobRunError) {
    console.error(
      "[generate-signals] Failed to write job run:",
      jobRunError instanceof Error ? jobRunError.message : String(jobRunError)
    );
  }

  // Final summary
  console.log("[generate-signals] === SUMMARY ===");
  console.log(`  generated_count: ${generatedCount}`);
  console.log(`  rejected_count: ${rejectedCount}`);
  console.log(`  duration_ms: ${durationMs}`);
  console.log(`  formula_version: ${FORMULA_VERSION}`);
  console.log(`  status: ${status}`);
  if (errorMessage) {
    console.log(`  error: ${errorMessage}`);
  }

  // Exit with error code if generation failed
  if (status === "error") {
    process.exit(1);
  }
}

main();
