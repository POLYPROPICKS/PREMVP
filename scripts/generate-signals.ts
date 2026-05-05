// Signal generation script
// Generates TrustedInitialformulaLanding1.1 pairs and caches them in Supabase

import { buildLandingCards } from "../lib/feed/buildLandingCards";
import {
  writeGeneratedSignalPairs,
  writeJobRun,
} from "../lib/feed/cacheGeneratedSignals";
import { FORMULA_VERSION } from "../lib/feed/types";

const CONFIG = {
  limit: 10,
  category: "sports",
  minDataCoverage: 40,
  excludeEnded: true,
  cacheExpiryHours: 1, // Cache valid for 1 hour
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
    // Call feed generation logic
    const result = await buildLandingCards({
      limit: CONFIG.limit,
      category: CONFIG.category,
      minDataCoverage: CONFIG.minDataCoverage,
      excludeEnded: CONFIG.excludeEnded,
    });

    generatedCount = result.pairs.length;
    rejectedCount = result.rejected.length;

    // Store diagnostics for job run
    diagnostics = {
      filters: result.filters,
      inspected: result.inspected,
      error: result.error,
    };

    console.log(`[generate-signals] Generated ${generatedCount} pairs`);
    console.log(`[generate-signals] Rejected ${rejectedCount} markets`);

    if (generatedCount === 0) {
      status = "empty";
      console.log("[generate-signals] No pairs generated - caching skipped");
    } else {
      // Write pairs to cache
      const expiresAt = new Date(
        Date.now() + CONFIG.cacheExpiryHours * 60 * 60 * 1000
      ).toISOString();

      await writeGeneratedSignalPairs({
        pairs: result.pairs.map((p) => ({
          premiumSignal: p.premiumSignal,
          marketSource: p.marketSource,
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
