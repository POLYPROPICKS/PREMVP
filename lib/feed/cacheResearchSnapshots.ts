// Research snapshot cache layer — ISOLATED from public feed.
// Writes ONLY to public.generated_signal_research_snapshots.
// Never reads or writes generated_signal_pairs.
// Never affects API reads, UI, or resolver behavior.

import { supabaseAdmin } from "@/lib/supabase/server";
import { ResearchEligibleSignalSnapshot } from "./types";

/**
 * Write research-eligible signal snapshots to the isolated research table.
 * Uses upsert with conflict target (snapshot_run_id, condition_id, selected_token_id).
 * Returns { inserted: 0 } for empty input without hitting Supabase.
 */
export async function writeResearchEligibleSignalSnapshots({
  snapshots,
}: {
  snapshots: ResearchEligibleSignalSnapshot[];
}): Promise<{ inserted: number }> {
  if (snapshots.length === 0) return { inserted: 0 };

  const rows = snapshots.map((s) => ({
    snapshot_run_id: s.snapshotRunId,
    snapshot_at: s.snapshotAt,
    expires_at: s.expiresAt,
    scope: s.scope,
    formula_version: s.formulaVersion ?? null,
    condition_id: s.conditionId,
    selected_token_id: s.selectedTokenId,
    opposing_token_id: s.opposingTokenId,
    event_slug: s.eventSlug ?? null,
    selected_outcome: s.selectedOutcome ?? null,
    selected_price_num: s.selectedPriceNum ?? null,
    selected_european_odds_num: s.selectedEuropeanOddsNum ?? null,
    market_family: s.marketFamily ?? null,
    league: s.league ?? null,
    game_start_iso: s.gameStartIso ?? null,
    data_coverage_num: s.dataCoverageNum ?? null,
    product_rejection_reasons: s.productRejectionReasons,
    diagnostics: s.diagnostics,
    public_feed_exposed: s.publicFeedExposed,
    // Modeling feature contract v1
    event_id: s.eventId ?? null,
    formula_feature_version: s.formulaFeatureVersion ?? null,
    hours_until_start_num: s.hoursUntilStartNum ?? null,
    signal_phase_at_snapshot: s.signalPhaseAtSnapshot ?? null,
    odds_band_label: s.oddsBandLabel ?? null,
    opposing_price_num: s.opposingPriceNum ?? null,
  }));

  const { error, count } = await supabaseAdmin
    .from("generated_signal_research_snapshots")
    .upsert(rows, {
      onConflict: "snapshot_run_id,condition_id,selected_token_id",
    });

  if (error) {
    throw new Error(`Failed to write research snapshots: ${error.message}`);
  }

  return { inserted: count ?? rows.length };
}
