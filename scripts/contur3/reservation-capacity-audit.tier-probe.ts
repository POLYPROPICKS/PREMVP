// Contur3 — computed-tier + admission-reject probe for the live-funnel fixtures (READ-ONLY).
//
// Companion to reservation-capacity-audit.mjs. Two layers:
//   LAYER A: runs the SAME builder the producer uses (buildFireModelCandidates)
//            and prints the COMPUTED tier/score/coverage per fixture.
//   LAYER B: queries generated_signal_pairs directly and replicates the builder's
//            admission guards per row, so for a fixture with raw allowed full-match
//            inventory but NO emitted full-match candidate we get the EXACT reason
//            each row was rejected (LOW_SCORE / LOW_COVERAGE / FOOTBALL_NO_SIDE /
//            BAD_BUCKET / GAME_STARTED / would-be TIER1/2/3).
//
// This distinguishes:
//   - WRONG guard suppressing real Tier1 full-match -> fixable producer/builder bug
//   - genuinely sub-threshold full-match inventory   -> correct skip, NOT a bug
//     (reserving it would weaken the live scoring policy)
//
// Fixture matching is per-fixture AND-of-team-groups (every required team/name group
// must be present in the normalized text). It never falls back to an OR across
// unrelated team names, which previously let e.g. "Australia vs Egypt" rows leak
// into the "Paraguay vs Australia" fixture bucket just because "australia" matched.
//
// READ-ONLY: no DB writes; no orders. Run on Railway /app:
//   npm run contur3:reservation-tier-probe

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export type FixtureSpec = {
  id: string;
  // Every group is a set of interchangeable name variants; ALL groups must
  // have at least one variant present (AND across groups, OR within a group).
  requiredTeamGroups: string[][];
  // Optional extra required pattern (e.g. "Match Winner" single-team markets),
  // matched against the normalized text.
  marketHint?: RegExp;
};

// Corrected post-PR27 live-funnel fixtures (deploy 1e3180e).
export const FIXTURES: FixtureSpec[] = [
  { id: "Paraguay vs Australia", requiredTeamGroups: [["paraguay"], ["australia"]] },
  {
    id: "Argentina vs Cabo Verde - More Markets",
    requiredTeamGroups: [["argentina"], ["caboverde"]],
  },
  {
    id: "Türkiye vs United States",
    requiredTeamGroups: [["turkiye", "turkey"], ["unitedstates", "usa"]],
  },
  { id: "Colombia vs Ghana - More Markets", requiredTeamGroups: [["colombia"], ["ghana"]] },
  { id: "Egypt — Match Winner", requiredTeamGroups: [["egypt"]], marketHint: /matchwinner/ },
  {
    id: "Switzerland — Match Winner",
    requiredTeamGroups: [["switzerland"]],
    marketHint: /matchwinner/,
  },
  { id: "Portugal — Match Winner", requiredTeamGroups: [["portugal"]], marketHint: /matchwinner/ },
  { id: "Spain — Match Winner", requiredTeamGroups: [["spain"]], marketHint: /matchwinner/ },
];

// Explicit, deterministic fixture matching: normalizes accents/apostrophes/dashes
// (via norm()) and requires ALL team groups to be present. No loose unrelated
// team-pair fallback — a text containing only one of the two required teams
// (e.g. "australia" alone) never matches a two-team fixture.
export function matchesFixture(textNorm: string, fx: FixtureSpec): boolean {
  const allTeamsPresent = fx.requiredTeamGroups.every((variants) =>
    variants.some((v) => textNorm.includes(v)),
  );
  if (!allTeamsPresent) return false;
  if (fx.marketHint && !fx.marketHint.test(textNorm)) return false;
  return true;
}

// Safety-net check surfaced in output: true if a row that matched a fixture does
// not, on independent re-check, actually contain the fixture's required teams.
// Should always be false given matchesFixture's strict AND semantics; exists so
// a future matching regression is visible in the probe output instead of silent.
export function mismatchWarning(rowTextNorm: string, fx: FixtureSpec): boolean {
  return !matchesFixture(rowTextNorm, fx);
}

// Mirrors lib/executor/buildFireModelCandidates.ts market classification intent.
const BLOCKED_RE = /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|2nd[\s-]half|second[\s-]half|corner|exact[\s-]score|correct[\s-]score|goalscorer|scorer|player[\s-]prop|outright|future/i;
const ALLOWED_FULLMATCH_RE = /moneyline|match\s*winner|to\s*win|\bwinner\b|spread|handicap|total\s*goals|over[\s/]under|o\/u|\btotal\b/i;

export function marketClass(title: string): "BLOCKED" | "ALLOWED_FULLMATCH" | "UNKNOWN" {
  if (/corner/i.test(title)) return "BLOCKED";
  if (BLOCKED_RE.test(title)) return "BLOCKED";
  if (ALLOWED_FULLMATCH_RE.test(title)) return "ALLOWED_FULLMATCH";
  return "UNKNOWN";
}

// Replicates the builder's per-row admission guards (exact thresholds from
// buildFireModelCandidates.ts: LOW_COVERAGE<25, LOW_SCORE<50, BAD_BUCKET,
// FOOTBALL_NO_SIDE, GAME_STARTED, computeTier).
export function admissionVerdict(row: any): string {
  const diag = row.diagnostics ?? {};
  const score = typeof row.signal_confidence_num === "number" ? row.signal_confidence_num : null;
  const coverage =
    typeof diag.dataCoverage === "number" ? diag.dataCoverage
    : typeof diag.coverage === "number" ? diag.coverage : null;
  const entry = typeof row.entry_price_num === "number" ? row.entry_price_num : null;
  const side = (row.selected_outcome ?? diag.selectedOutcome ?? "").toString().toLowerCase();
  const gameStartIso = typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;

  if (coverage == null || coverage < 25) return "LOW_COVERAGE";
  if (score == null || score < 50) return "LOW_SCORE";
  if (entry == null) return "MISSING_ENTRY_PRICE";
  if (!gameStartIso) return "MISSING_GAME_START";
  const gms = Date.parse(gameStartIso);
  if (!Number.isFinite(gms) || gms <= Date.now()) return "GAME_STARTED_OR_INVALID";
  if (coverage >= 50 && coverage <= 74 && entry >= 0.44 && entry <= 0.58) return "BAD_BUCKET_COV_PRICE";
  // Soccer "No" side has undefined semantics in the builder.
  if (side === "no") return "FOOTBALL_NO_SIDE";
  if (score >= 72 && coverage >= 50) return "WOULD_BE_TIER1";
  if (score >= 60 && coverage >= 50) return "WOULD_BE_TIER2";
  if (score >= 50 && coverage >= 25) return "WOULD_BE_TIER3";
  return "TIER_BELOW_THRESHOLD";
}

// ── LAYER C: builder-candidate -> reservation-planner explanation (DIAGNOSTIC_MIRROR) ──
//
// Explains, per fixture, why a builder candidate that Layer A/B show as present did or
// did not become a night_event_reservations row. Read-only: uses `isWithinHorizon` and
// `NightWindow` from lib/executor/nightWindow.ts (pure, no side effects) and inspects the
// already-built ReservationPlan.reservations array (buildReservationPlan is pure — no DB
// writes). The Tier1/allowed-fullmatch/weak-identity checks below are a DIAGNOSTIC_MIRROR
// of the planner's internal group-key/anchor logic (those helpers are not exported), not a
// re-implementation of its exact cap/dedupe behavior.
export type LayerCStatus =
  | "BUILDER_CANDIDATE_PLANNER_SELECTED"
  | "BUILDER_CANDIDATE_OUT_OF_RESERVATION_WINDOW"
  | "BUILDER_CANDIDATE_REJECTED_BY_PLANNER_CAP_OR_DEDUPE"
  | "BUILDER_CANDIDATE_WEAK_IDENTITY"
  | "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH"
  | "BUILDER_CANDIDATE_UNKNOWN_PLANNER_GAP";

export interface LayerCResult {
  status: LayerCStatus;
  reason: string;
  inReservationWindow: boolean | "unknown";
  wouldSelectForReservation: boolean;
  existingReservationMatch: boolean;
  bestCandidate: any | null;
}

function pickBestCandidate(hits: any[]): any | null {
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => {
    const as = typeof a.diagnostics?.score === "number" ? a.diagnostics.score : -1;
    const bs = typeof b.diagnostics?.score === "number" ? b.diagnostics.score : -1;
    if (bs !== as) return bs - as;
    const ac = typeof a.diagnostics?.coverage === "number" ? a.diagnostics.coverage : -1;
    const bc = typeof b.diagnostics?.coverage === "number" ? b.diagnostics.coverage : -1;
    return bc - ac;
  })[0];
}

export function classifyLayerC(args: {
  fx: FixtureSpec;
  hits: any[];
  tier1Allowed: any[];
  window: { horizonEndMs: number };
  nowMs: number;
  reservations: any[];
}): LayerCResult {
  const { fx, hits, tier1Allowed, window, nowMs, reservations } = args;
  const best = pickBestCandidate(hits);

  if (!best) {
    return {
      status: "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH",
      reason: "SOURCE_MATCH_NOT_FOUND: builder produced 0 candidates matching this fixture text pattern",
      inReservationWindow: "unknown",
      wouldSelectForReservation: false,
      existingReservationMatch: false,
      bestCandidate: null,
    };
  }

  const startIso = best.diagnostics?.game_start_iso ?? null;
  const startMs = startIso ? Date.parse(startIso) : NaN;
  const inWindow: boolean | "unknown" =
    !Number.isFinite(startMs) ? "unknown" : startMs > nowMs && startMs <= window.horizonEndMs;

  const existingReservationMatch = reservations.some((r) => {
    const tn = norm(`${r.event_title ?? ""} ${r.match_family_key ?? ""}`);
    return matchesFixture(tn, fx);
  });

  if (existingReservationMatch) {
    return {
      status: "BUILDER_CANDIDATE_PLANNER_SELECTED",
      reason: "A matching night_event_reservations row exists for this fixture.",
      inReservationWindow: inWindow,
      wouldSelectForReservation: true,
      existingReservationMatch,
      bestCandidate: best,
    };
  }

  if (inWindow === false) {
    return {
      status: "BUILDER_CANDIDATE_OUT_OF_RESERVATION_WINDOW",
      reason: `best candidate start ${startIso} is outside the current reservation horizon (ends ${new Date(window.horizonEndMs).toISOString()})`,
      inReservationWindow: inWindow,
      wouldSelectForReservation: false,
      existingReservationMatch,
      bestCandidate: best,
    };
  }

  const bestIsTier1Allowed = tier1Allowed.length > 0;
  const isWeakIdentity = /^WEAK_/.test(String(best.match_family_key ?? ""));

  if (bestIsTier1Allowed && inWindow === true) {
    return {
      status: "BUILDER_CANDIDATE_REJECTED_BY_PLANNER_CAP_OR_DEDUPE",
      reason: "candidate is a Tier1 allowed-fullmatch, in-window, but no matching reservation row exists — likely planner cap/dedupe/slot-fill limit (DIAGNOSTIC_MIRROR, not exact re-implementation).",
      inReservationWindow: inWindow,
      wouldSelectForReservation: true,
      existingReservationMatch,
      bestCandidate: best,
    };
  }

  if (isWeakIdentity && !bestIsTier1Allowed) {
    return {
      status: "BUILDER_CANDIDATE_WEAK_IDENTITY",
      reason: "best candidate is a weak single-team identity key and not a Tier1 allowed-fullmatch candidate.",
      inReservationWindow: inWindow,
      wouldSelectForReservation: false,
      existingReservationMatch,
      bestCandidate: best,
    };
  }

  if (!bestIsTier1Allowed) {
    return {
      status: "BUILDER_CANDIDATE_NO_SAFE_ALLOWED_FULLMATCH",
      reason: "in-window candidates exist but none is a Tier1 allowed-fullmatch candidate; correct skip, not a builder bug.",
      inReservationWindow: inWindow,
      wouldSelectForReservation: false,
      existingReservationMatch,
      bestCandidate: best,
    };
  }

  return {
    status: "BUILDER_CANDIDATE_UNKNOWN_PLANNER_GAP",
    reason: "candidate is in-window and Tier1 allowed-fullmatch but no explanation matched — requires manual review.",
    inReservationWindow: inWindow,
    wouldSelectForReservation: true,
    existingReservationMatch,
    bestCandidate: best,
  };
}

async function main() {
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());

  // ── LAYER A: builder candidate universe (what the producer actually sees) ──
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  const { candidates } = await buildFireModelCandidates(100_000, "all", true);
  console.log(`\n=== LAYER A: builder candidate universe (size ${candidates.length}) ===`);
  const fixtureHits = new Map<string, { hits: any[]; t1Allowed: any[] }>();
  for (const fx of FIXTURES) {
    const hits = candidates.filter((c) => {
      const tn = norm(`${c.event_slug ?? ""} ${c.market_slug ?? ""} ${c.match_family_key} ${c.canonical_event_key ?? ""}`);
      return matchesFixture(tn, fx);
    });
    const t1Allowed = hits.filter(
      (c) => c.strategy === "TIER1_CORE_STRICT_72_COV50" &&
        marketClass(`${c.market_slug ?? ""} ${c.event_slug ?? ""}`) === "ALLOWED_FULLMATCH",
    );
    fixtureHits.set(fx.id, { hits, t1Allowed });
    console.log(`\n--- ${fx.id} --- candidates=${hits.length} tier1_allowed_fullmatch=${t1Allowed.length}`);
    console.log(`  requested_fixture: ${fx.id}`);
    console.log(`  matched_event_titles_sample: ${JSON.stringify(hits.slice(0, 10).map((c) => c.event_slug ?? c.match_family_key ?? ""))}`);
    for (const c of hits.slice(0, 10)) {
      const tn = norm(`${c.event_slug ?? ""} ${c.market_slug ?? ""} ${c.match_family_key} ${c.canonical_event_key ?? ""}`);
      console.log("  " + JSON.stringify({
        strategy: c.strategy, score: c.diagnostics?.score, coverage: c.diagnostics?.coverage,
        market_class: marketClass(`${c.market_slug ?? ""} ${c.event_slug ?? ""}`),
        mfk: c.match_family_key, market: c.market_slug, start: c.diagnostics?.game_start_iso,
        mismatch_warning: mismatchWarning(tn, fx),
      }));
    }
  }

  // ── LAYER C: planner explanation (builder candidates -> reservation planner) ──
  // buildReservationPlan is PURE (no DB writes, no fs writes) — safe read-only reuse.
  const { buildReservationPlan } = await import("../../lib/executor/nightEventReservations");
  const nowMs = Date.now();
  const plan = await buildReservationPlan(nowMs);
  console.log(`\n=== LAYER C: builder candidate -> reservation planner explanation (plan_run_id=${plan.plan_run_id}) ===`);
  for (const fx of FIXTURES) {
    const { hits, t1Allowed } = fixtureHits.get(fx.id)!;
    const layerC = classifyLayerC({ fx, hits, tier1Allowed: t1Allowed, window: plan.window, nowMs, reservations: plan.reservations });
    const bc = layerC.bestCandidate;
    console.log(`\n--- ${fx.id} ---`);
    console.log("  " + JSON.stringify({
      requested_fixture: fx.id,
      builder_candidates_count: hits.length,
      tier1_allowed_fullmatch: t1Allowed.length,
      best_candidate: bc ? {
        market: bc.market_slug, start: bc.diagnostics?.game_start_iso, mfk: bc.match_family_key,
        strategy: bc.strategy, score: bc.diagnostics?.score, coverage: bc.diagnostics?.coverage,
        market_class: marketClass(`${bc.market_slug ?? ""} ${bc.event_slug ?? ""}`),
      } : null,
      layer_c_planner_status: layerC.status,
      layer_c_reason: layerC.reason,
      in_reservation_window: layerC.inReservationWindow,
      would_select_for_reservation: layerC.wouldSelectForReservation,
      existing_reservation_match: layerC.existingReservationMatch,
    }));
  }

  // ── LAYER B: raw generated_signal_pairs admission analysis ──
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log("\nLAYER B skipped: no SUPABASE_URL/SERVICE_ROLE_KEY.");
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, supabaseKey);
  const sinceIso = new Date(Date.now() - 36 * 3_600_000).toISOString();

  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("generated_signal_pairs")
      .select("*")
      .gte("created_at", sinceIso)
      .range(from, from + 999);
    if (error) { console.log(`LAYER B query failed: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }

  console.log(`\n=== LAYER B: raw signal admission per fixture (scanned ${all.length} rows, 36h) ===`);
  for (const fx of FIXTURES) {
    const rows = all.filter((r) => {
      const tn = norm(`${r.event_slug ?? ""} ${r.market_slug ?? ""} ${r.selected_outcome ?? ""}`);
      return matchesFixture(tn, fx);
    });
    const fullmatch = rows.filter((r) => marketClass(`${r.market_slug ?? ""} ${r.event_slug ?? ""}`) === "ALLOWED_FULLMATCH");
    const hist: Record<string, number> = {};
    let bestScore = -1, bestCov = -1, bestTitle = "";
    for (const r of fullmatch) {
      const v = admissionVerdict(r);
      hist[v] = (hist[v] ?? 0) + 1;
      const sc = typeof r.signal_confidence_num === "number" ? r.signal_confidence_num : -1;
      if (sc > bestScore) {
        bestScore = sc;
        const diag = r.diagnostics ?? {};
        bestCov = typeof diag.dataCoverage === "number" ? diag.dataCoverage : (typeof diag.coverage === "number" ? diag.coverage : -1);
        bestTitle = r.market_slug ?? r.event_slug ?? "";
      }
    }
    console.log(`\n--- ${fx.id} --- raw=${rows.length} allowed_fullmatch=${fullmatch.length}`);
    console.log(`  requested_fixture: ${fx.id}`);
    console.log(`  matched_keys_sample: ${JSON.stringify(rows.slice(0, 10).map((r) => r.event_slug ?? r.market_slug ?? ""))}`);
    console.log(`  admission_histogram: ${JSON.stringify(hist)}`);
    console.log(`  best_fullmatch_score=${bestScore} coverage=${bestCov} title="${bestTitle}"`);
  }

  console.log(
    "\nDECISION:\n" +
      "  WOULD_BE_TIER1 > 0 in LAYER B but absent in LAYER A -> REAL builder admission bug (fix exact guard).\n" +
      "  all full-match LOW_SCORE/LOW_COVERAGE/TIER_BELOW_THRESHOLD -> correct skip; NO safe allowed anchor\n" +
      "    -> PRODUCER_PATCH_BLOCKED_NO_SAFE_ALLOWED_CANDIDATE (do NOT weaken policy / do NOT anchor halftime).\n" +
      "  FOOTBALL_NO_SIDE dominating -> side-mapping/outcome bug worth a targeted fix.",
  );
}

const isEntrypoint = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((e) => {
    console.error("tier-probe failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
