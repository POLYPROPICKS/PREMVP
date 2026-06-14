// Signal generation script
// Generates TrustedInitialformulaLanding1.1 pairs and caches them in Supabase

import { randomUUID } from "node:crypto";

import { buildLandingCards, applyStrategicFloor } from "../lib/feed/buildLandingCards";
import {
  writeGeneratedSignalPairs,
  writeStrategicShadowPairs,
  writeJobRun,
} from "../lib/feed/cacheGeneratedSignals";
import { collectWcShadowCandidates, collectEsportShadowCandidates, collectNbaNhlShadowCandidates, collectFullLineOutcomeV1Candidates } from "../lib/feed/discoverSportsMarkets";
import type { WcShadowEntry } from "../lib/feed/discoverSportsMarkets";
import { writeResearchEligibleSignalSnapshots } from "../lib/feed/cacheResearchSnapshots";
import { FORMULA_VERSION } from "../lib/feed/types";

const CONFIG = {
  limit: 15,
  category: "sports",
  minDataCoverage: 40,
  excludeEnded: true,
  cacheExpiryHours: 1, // Cache valid for 1 hour
  includeUpcoming: true,
  // 10 so strategic categories (WC26 2-3 + NBA 2 + NHL 1-2 + eSport 1-2) all fit
  // without eSport being starved by strategic priority ordering at limit 5.
  upcomingLimit: 10,
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
    // Research universe: one UUID per cron run, frozen before buildLandingCards
    const researchSnapshotRunId = randomUUID();
    const researchSnapshotAt = new Date().toISOString();

    // Call sports landing cards generation logic
    const result = await buildLandingCards({
      limit: CONFIG.limit,
      category: CONFIG.category,
      minDataCoverage: CONFIG.minDataCoverage,
      excludeEnded: CONFIG.excludeEnded,
      includeUpcoming: CONFIG.includeUpcoming,
      upcomingLimit: CONFIG.upcomingLimit,
      // Research universe options — does not alter product feed behavior
      collectResearchSnapshots: true,
      researchSnapshotRunId,
      researchSnapshotAt,
      researchLimit: 45,
      researchOddsMin: 1.25,
      researchOddsMax: 4.00,
    });

    // Founder LIVE rule: across the merged qualified + upcoming pool, pre-start
    // sports pairs within the next 24h come first, ordered by aggregate
    // parent-event volume DESC; primary winner/moneyline markets rank above
    // spread/handicap variants of the same event; ties and out-of-window pairs
    // keep their original relative order. Stable.
    const mergedPairs = [...result.pairs, ...(result.upcomingPairs ?? [])];
    const nowMs = Date.now();
    const horizonMs = nowMs + 24 * 60 * 60 * 1000;
    const isWithin24h = (pair: any): boolean => {
      const ts = Date.parse(pair.diagnostics?.gameStartIso ?? "");
      return Number.isFinite(ts) && ts > nowMs && ts <= horizonMs;
    };
    const parentVolume = (pair: any): number =>
      Number(pair.diagnostics?.parentEventVolume24hr ?? 0);
    const primaryMarketRank = (pair: any): number => {
      const title = String(pair.premiumSignal?.eventTitle ?? "").toLowerCase();
      if (title.includes("match winner") || title.includes("moneyline")) return 0;
      if (title.includes("spread") || title.includes("handicap")) return 1;
      return 2;
    };
    const sortedMergedPairs = mergedPairs
      .map((pair, index) => ({ pair, index }))
      .sort((a, b) => {
        const aw = isWithin24h(a.pair);
        const bw = isWithin24h(b.pair);
        if (aw !== bw) return aw ? -1 : 1;
        if (aw && bw) {
          const dv = parentVolume(b.pair) - parentVolume(a.pair);
          if (dv !== 0) return dv;
          const dr = primaryMarketRank(a.pair) - primaryMarketRank(b.pair);
          if (dr !== 0) return dr;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.pair);

    // Strategic floor: ensure each strategic category with an eligible generated
    // pair lands inside the route's first-`limit` window (eSport otherwise cut).
    const pairsToCache = applyStrategicFloor(sortedMergedPairs, CONFIG.limit);
    generatedCount = pairsToCache.length;
    rejectedCount = result.rejected?.length ?? 0;

    const inspectedAny = result.inspected as unknown as Record<string, unknown> | undefined;
    const sportsDiscovery = (inspectedAny?.sportsDiscovery as Record<string, unknown> | undefined) ?? null;
    diagnostics = {
      discoveryMode: "markets-first-buildLandingCards",
      generated_count: generatedCount,
      qualified_count: result.pairs.length,
      upcoming_count: result.upcomingPairs?.length ?? 0,
      rejected_count: rejectedCount,
      inspected: result.inspected,
      researchFunnel: result.researchFunnel ?? null,
      sportsDiscoveryCounts: sportsDiscovery
        ? (sportsDiscovery.counts as Record<string, unknown> | null) ?? null
        : null,
      sportsRejectionReasonCounts: sportsDiscovery
        ? (sportsDiscovery.rejectionReasonCounts as Record<string, number> | null) ?? null
        : null,
      sampleToCandidateMarketNulls: sportsDiscovery
        ? (sportsDiscovery.sampleToCandidateMarketNulls as number) ?? null
        : null,
      fallback48hNullDrops: sportsDiscovery
        ? (sportsDiscovery.fallback48hNullDrops as number) ?? null
        : null,
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

    let researchWriterAttempted = false;
    let researchSnapshotsInserted = 0;
    let researchWriterWarning: string | null = null;
    let researchSnapshotsBeforeDedup = 0;
    let researchSnapshotsAfterDedup = 0;
    let researchSnapshotDuplicatesDropped = 0;
    // ── Research universe persistence ──────────────────────────────────────────
    // Mark which research snapshots also landed in the public feed, then write.
    // Runs regardless of generatedCount (research may yield rows even if product feed is empty).
    const rawResearchSnapshots = result.researchSnapshots ?? [];
    if (rawResearchSnapshots.length > 0) {
      // Build identity set from the final public pairs (after strategic floor)
      const publicIdentitySet = new Set(
        pairsToCache.map(
          (pair) =>
            `${pair.diagnostics?.conditionId ?? ""}::${pair.diagnostics?.selectedTokenId ?? ""}`,
        ),
      );

      const markedSnapshots = rawResearchSnapshots.map((snap) => ({
        ...snap,
        publicFeedExposed: publicIdentitySet.has(
          `${snap.conditionId}::${snap.selectedTokenId}`,
        ),
      }));

      // Deduplicate by upsert conflict key: (snapshot_run_id, condition_id, selected_token_id).
      // snapshot_run_id is fixed per cron run; dedup on conditionId+selectedTokenId is sufficient.
      // PostgreSQL raises "cannot affect row a second time" when the same key appears ≥2 times in one batch.
      // Merge rule: publicFeedExposed=true wins; prefer the row with the richer (longer) diagnostics object.
      const seenResearchKeys = new Map<string, typeof markedSnapshots[number]>();
      for (const snap of markedSnapshots) {
        const key = `${snap.conditionId}::${snap.selectedTokenId}`;
        const existing = seenResearchKeys.get(key);
        if (!existing) {
          seenResearchKeys.set(key, snap);
        } else {
          const mergedExposed = existing.publicFeedExposed || snap.publicFeedExposed;
          const existingDiagLen = JSON.stringify(existing.diagnostics ?? {}).length;
          const snapDiagLen = JSON.stringify(snap.diagnostics ?? {}).length;
          const richer = snapDiagLen > existingDiagLen ? snap : existing;
          seenResearchKeys.set(key, { ...richer, publicFeedExposed: mergedExposed });
        }
      }
      const dedupedSnapshots = Array.from(seenResearchKeys.values());
      researchSnapshotsBeforeDedup = markedSnapshots.length;
      researchSnapshotsAfterDedup = dedupedSnapshots.length;
      researchSnapshotDuplicatesDropped = markedSnapshots.length - dedupedSnapshots.length;
      if (researchSnapshotDuplicatesDropped > 0) {
        console.log(`[generate-signals] Research snapshot duplicates dropped: ${researchSnapshotDuplicatesDropped} (${researchSnapshotsBeforeDedup} → ${researchSnapshotsAfterDedup})`);
      }

      let researchInserted = 0;
      try {
        researchWriterAttempted = true;
        const researchResult = await writeResearchEligibleSignalSnapshots({
          snapshots: dedupedSnapshots,
        });
        researchInserted = researchResult.inserted;
        researchSnapshotsInserted = researchInserted;
      } catch (researchError) {
        // Research write failure is non-fatal — log and continue
        researchWriterWarning = researchError instanceof Error ? researchError.message : String(researchError);
        console.warn(
          "[generate-signals] Research snapshot write failed (non-fatal):",
          researchWriterWarning,
        );
      }

      const exposedCount = markedSnapshots.filter((s) => s.publicFeedExposed).length;
      const notExposedCount = markedSnapshots.length - exposedCount;
      console.log(`[generate-signals] Research snapshots collected: ${rawResearchSnapshots.length}`);
      console.log(`[generate-signals] Research snapshots inserted: ${researchInserted}`);
      console.log(`[generate-signals] Research snapshots public_feed_exposed: ${exposedCount}`);
      console.log(`[generate-signals] Research snapshots not exposed: ${notExposedCount}`);
      console.log(`[generate-signals] Research odds corridor: 1.25–4.00`);
    } else {
      console.log(`[generate-signals] Research snapshots collected: 0`);
    }
    // Append research writer stats to diagnostics for job_runs observability
    diagnostics.researchSnapshotsCollected = rawResearchSnapshots.length;
    diagnostics.researchSnapshotsBeforeDedup = researchSnapshotsBeforeDedup;
    diagnostics.researchSnapshotsAfterDedup = researchSnapshotsAfterDedup;
    diagnostics.researchSnapshotDuplicatesDropped = researchSnapshotDuplicatesDropped;
    diagnostics.researchWriterAttempted = researchWriterAttempted;
    diagnostics.researchSnapshotsInserted = researchSnapshotsInserted;
    diagnostics.researchWriterWarning = researchWriterWarning;
    const rf = result.researchFunnel;
    console.log(`[generate-signals] research funnel: attempted=${rf?.attempted ?? 0} eligible=${rf?.eligible ?? 0} inserted=${researchSnapshotsInserted} exec_ok=${rf?.execFetchOk ?? 0} exec_empty=${rf?.execFetchEmptyBook ?? 0} exec_failed=${rf?.execFetchFailed ?? 0}`);

    // ── WC shadow write (fail-open) ─────────────────────────────────────────
    // Collects WC2026 extra-market candidates excluded by PER_EVENT_CAP=1 and
    // writes them as shadow rows for resolver tracking. Non-fatal.
    try {
      const wcShadowExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const shadowCandidates = await collectWcShadowCandidates();
      if (shadowCandidates.length > 0) {
        const shadowInserted = await writeStrategicShadowPairs(shadowCandidates, wcShadowExpiresAt);
        console.log(`[generate-signals] WC shadow pairs written: ${shadowInserted}`);
        diagnostics.wcShadowCandidatesFound = shadowCandidates.length;
        diagnostics.wcShadowPairsInserted = shadowInserted;
      } else {
        console.log(`[generate-signals] WC shadow candidates: 0 (no extra-cap markets found)`);
        diagnostics.wcShadowCandidatesFound = 0;
        diagnostics.wcShadowPairsInserted = 0;
      }
    } catch (shadowErr) {
      const shadowMsg = shadowErr instanceof Error ? shadowErr.message : String(shadowErr);
      console.warn("[generate-signals] WC shadow write failed (non-fatal):", shadowMsg);
      diagnostics.wcShadowWarning = shadowMsg;
    }

    // ── eSport shadow write (fail-open) ────────────────────────────────────
    try {
      const esportExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const esportShadow = await collectEsportShadowCandidates();
      if (esportShadow.length > 0) {
        const esportInserted = await writeStrategicShadowPairs(esportShadow, esportExpiresAt);
        console.log(`[generate-signals] eSport shadow pairs written: ${esportInserted}`);
        diagnostics.esportShadowCandidatesFound = esportShadow.length;
        diagnostics.esportShadowPairsInserted = esportInserted;
      } else {
        console.log(`[generate-signals] eSport shadow candidates: 0`);
        diagnostics.esportShadowCandidatesFound = 0;
        diagnostics.esportShadowPairsInserted = 0;
      }
    } catch (esportErr) {
      console.warn("[generate-signals] eSport shadow write failed (non-fatal):", esportErr instanceof Error ? esportErr.message : String(esportErr));
      diagnostics.esportShadowWarning = esportErr instanceof Error ? esportErr.message : String(esportErr);
    }

    // ── NBA/NHL shadow write (fail-open) ───────────────────────────────────
    try {
      const nbaNhlExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const nbaNhlShadow = await collectNbaNhlShadowCandidates();
      if (nbaNhlShadow.length > 0) {
        const nbaNhlInserted = await writeStrategicShadowPairs(nbaNhlShadow, nbaNhlExpiresAt);
        console.log(`[generate-signals] NBA/NHL shadow pairs written: ${nbaNhlInserted}`);
        diagnostics.nbaNhlShadowCandidatesFound = nbaNhlShadow.length;
        diagnostics.nbaNhlShadowPairsInserted = nbaNhlInserted;
      } else {
        console.log(`[generate-signals] NBA/NHL shadow candidates: 0`);
        diagnostics.nbaNhlShadowCandidatesFound = 0;
        diagnostics.nbaNhlShadowPairsInserted = 0;
      }
    } catch (nbaNhlErr) {
      console.warn("[generate-signals] NBA/NHL shadow write failed (non-fatal):", nbaNhlErr instanceof Error ? nbaNhlErr.message : String(nbaNhlErr));
      diagnostics.nbaNhlShadowWarning = nbaNhlErr instanceof Error ? nbaNhlErr.message : String(nbaNhlErr);
    }

    // ── Full-line outcome capture V1 (fail-open) ───────────────────────────
    // Captures all eligible binary in-band market outcomes (both sides) across
    // WC/eSport/NBA/NHL. Supplements per-scope cap-based collectors. Non-fatal.
    try {
      const v1ExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const v1Candidates = await collectFullLineOutcomeV1Candidates();
      if (v1Candidates.length > 0) {
        const v1Inserted = await writeStrategicShadowPairs(v1Candidates, v1ExpiresAt);
        console.log(`[generate-signals] full-line outcome capture v1 shadow pairs written: ${v1Inserted}`);
        diagnostics.v1ShadowCandidatesFound = v1Candidates.length;
        diagnostics.v1ShadowPairsInserted = v1Inserted;
      } else {
        console.log(`[generate-signals] full-line outcome capture v1 shadow pairs written: 0`);
        diagnostics.v1ShadowCandidatesFound = 0;
        diagnostics.v1ShadowPairsInserted = 0;
      }
    } catch (v1Err) {
      console.warn("[generate-signals] V1 shadow write failed (non-fatal):", v1Err instanceof Error ? v1Err.message : String(v1Err));
      diagnostics.v1ShadowWarning = v1Err instanceof Error ? v1Err.message : String(v1Err);
    }

    // ── WC generated-row mirror to shadow (fail-open) ──────────────────────
    // Maps eligible WC2026 rows from the already-produced v2-lite set into
    // shadow-strategic-sports-v1. Targets spread/total/corners/goals/halves
    // present in the public feed but missed by the game_id V1 collector.
    try {
      const WC_DET = /fifwc|world.?cup|fifa.?wc/i;
      const WC_HVG = /spread|handicap|over.?under|\bO\/U\b|total|team.?total|both.?teams.?to.?score|first.?team.?to.?score|corner|\bhalf\b|first.?half|second.?half/i;
      const WC_EXC = /exact.?scor|correct.?scor|player|assist|\bshot\b|goalscor|anytime.?scor/i;
      const mirrorInBand = (price: number) => (price >= 0.333 && price <= 0.588) || (price >= 0.20 && price <= 0.741);
      const mirrorExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const mirrorCandidates: WcShadowEntry[] = [];
      for (const pair of pairsToCache) {
        const p = pair as unknown as Record<string, any>;
        const conditionId: string | null = p.diagnostics?.conditionId ?? null;
        const selectedTokenId: string | null = p.diagnostics?.selectedTokenId ?? null;
        const currentPrice: number | null = typeof p.diagnostics?.currentPrice === "number" ? p.diagnostics.currentPrice : null;
        if (!conditionId || !selectedTokenId || currentPrice === null) continue;
        if (!mirrorInBand(currentPrice)) continue;
        const eventTitle = String(p.premiumSignal?.eventTitle ?? "");
        const headline = String(p.marketSource?.headline ?? "");
        const league = String(p.premiumSignal?.league ?? "");
        const position = String(p.premiumSignal?.position ?? "");
        const subline = String(p.marketSource?.subline ?? "");
        const mtype = String(p.diagnostics?.researchContext?.marketType ?? "");
        const srcProxy = String(p.diagnostics?.researchContext?.discoverySourceProxy ?? "");
        // Combine all text fields; eventTitle = event_slug and may be the market title itself
        // (e.g. "Spread: Germany (-3.5)") — must be included in both WC + group detection
        const allText = `${eventTitle} ${headline} ${league} ${position} ${subline} ${mtype} ${srcProxy}`;
        // WC detection: identifiers OR WC2026 team names (slug-style rows lack "world cup" text)
        const WC_TEAMS = /\b(germany|curacao|cura[çc]ao|netherlands|japan|sweden|tunisia|spain|c[oô]te.?d.?ivoire|ivory.?coast|ecuador|brazil|argentina|france|england|portugal|mexico|south.?korea|australia|morocco|senegal|ghana|cameroon|nigeria|croatia|uruguay|colombia)\b/i;
        if (!WC_DET.test(allText) && !WC_TEAMS.test(allText)) continue;
        if (!WC_HVG.test(allText)) continue;
        if (WC_EXC.test(allText)) continue;
        const vol: number = typeof p.diagnostics?.parentEventVolume24hr === "number" ? p.diagnostics.parentEventVolume24hr : 0;
        if (vol <= 5000) continue;
        const allL = allText.toLowerCase();
        let detectedGroup = "high_vol_group";
        if (/spread|handicap/.test(allL)) detectedGroup = "spread";
        else if (/team.?total/.test(allL)) detectedGroup = "team_total";
        else if (/corner/.test(allL)) detectedGroup = "corner";
        else if (/both.?teams.?to.?score|first.?team.?to.?score/.test(allL)) detectedGroup = "goal";
        else if (/over.?under|o\/u|\btotal/.test(allL) || /total.?goal/.test(allL)) detectedGroup = "total";
        else if (/half/.test(allL)) detectedGroup = "half";
        const pBucket = currentPrice > 0.85 ? "extreme_favorite"
          : currentPrice >= 0.65 ? "favorite"
          : currentPrice >= 0.35 ? "balanced"
          : currentPrice >= 0.15 ? "underdog"
          : "extreme_longshot";
        mirrorCandidates.push({
          conditionId,
          selectedTokenId,
          entryPriceNum: currentPrice,
          tier: currentPrice >= 0.333 && currentPrice <= 0.588 ? 3 : 2,
          marketQuestion: (eventTitle || headline).substring(0, 200),
          selectedOutcome: String(p.diagnostics?.selectedOutcome ?? "Yes"),
          eventSlug: eventTitle.substring(0, 80),
          eventTitle: eventTitle.substring(0, 100),
          eventEndIso: p.diagnostics?.researchContext?.marketCloseIso ?? null,
          marketType: mtype || null,
          marketSlug: (headline || eventTitle).substring(0, 80),
          marketTitle: (eventTitle || headline).substring(0, 200),
          shadowScope: "WC2026",
          shadowReason: "FULL_LINE_OUTCOME_CAPTURE_V1",
          outcomeName: String(p.diagnostics?.selectedOutcome ?? "") || null,
          tokenIndex: undefined,
          priceBucket: pBucket,
          volumeUsd: vol > 0 ? vol : null,
          v1EligibilityReason: "WC_HIGH_VOLUME_GROUP_V1_1",
          marketFamily: detectedGroup,
        });
      }
      console.log(`[generate-signals] WC generated mirror candidates: ${mirrorCandidates.length}`);
      if (mirrorCandidates.length > 0) {
        const mirrorInserted = await writeStrategicShadowPairs(mirrorCandidates, mirrorExpiresAt);
        console.log(`[generate-signals] WC generated-row mirror shadow pairs written: ${mirrorInserted}`);
        diagnostics.wcMirrorShadowCandidatesFound = mirrorCandidates.length;
        diagnostics.wcMirrorShadowPairsInserted = mirrorInserted;
      }
    } catch (mirrorErr) {
      console.warn("[generate-signals] WC mirror shadow write failed (non-fatal):", mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr));
      diagnostics.wcMirrorShadowWarning = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
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
