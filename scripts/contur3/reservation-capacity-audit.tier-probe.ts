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

async function main() {
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());

  // ── LAYER A: builder candidate universe (what the producer actually sees) ──
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  const { candidates } = await buildFireModelCandidates(100_000, "all", true);
  console.log(`\n=== LAYER A: builder candidate universe (size ${candidates.length}) ===`);
  for (const fx of FIXTURES) {
    const hits = candidates.filter((c) => {
      const tn = norm(`${c.event_slug ?? ""} ${c.market_slug ?? ""} ${c.match_family_key} ${c.canonical_event_key ?? ""}`);
      return matchesFixture(tn, fx);
    });
    const t1Allowed = hits.filter(
      (c) => c.strategy === "TIER1_CORE_STRICT_72_COV50" &&
        marketClass(`${c.market_slug ?? ""} ${c.event_slug ?? ""}`) === "ALLOWED_FULLMATCH",
    );
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
