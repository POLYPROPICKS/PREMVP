// FireModel1 Candidate Funnel / Reason Breakdown — read-only, no writes.
// Explains why we get or do not get 15–25 valid candidates/day.
// Run: npm run firemodel1:funnel

import { supabaseAdmin } from "../lib/supabase/server";

const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];
const OLD_SHADOW = "shadow-strategic-sports-v1";
const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const BAD_BUCKET_COV_LO = 50;
const BAD_BUCKET_COV_HI = 74;
const BAD_BUCKET_EP_LO = 0.44;
const BAD_BUCKET_EP_HI = 0.58;

type RawRow = {
  id: string;
  condition_id: string | null;
  selected_token_id: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  signal_result: string | null;
  expires_at: string;
  metric_formula_version: string | null;
  market_slug: string | null;
  event_slug: string | null;
  created_at: string;
  diagnostics: Record<string, unknown>;
};

const now = Date.now();
const since24h = new Date(now - 86_400_000).toISOString();
const since2h = new Date(now - 2 * 3_600_000).toISOString();

function mref(r: RawRow): string {
  return ((r.market_slug ?? "") + " " + (r.event_slug ?? "")).toLowerCase();
}

function isNbaOrNhl(r: RawRow): boolean {
  return NBA_NHL_RE.test(mref(r));
}

function isBadBucket(r: RawRow): boolean {
  const cov = r.diagnostics?.dataCoverage as number | null;
  const ep = r.entry_price_num;
  return (
    cov != null &&
    ep != null &&
    cov >= BAD_BUCKET_COV_LO &&
    cov <= BAD_BUCKET_COV_HI &&
    ep >= BAD_BUCKET_EP_LO &&
    ep <= BAD_BUCKET_EP_HI
  );
}

async function main() {
  // Fetch all recent rows — broad net to show full funnel
  const { data: rawData, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, condition_id, selected_token_id, entry_price_num, signal_confidence_num, " +
        "signal_result, expires_at, metric_formula_version, market_slug, event_slug, created_at, diagnostics",
    )
    .gte("created_at", since24h)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(`DB error: ${error.message}`);
  const all = (rawData ?? []) as unknown as RawRow[];

  // Fetch old shadow for reference count
  const { data: oldShadow } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id, condition_id, selected_token_id")
    .eq("metric_formula_version", OLD_SHADOW)
    .gte("created_at", since24h);

  const line = "─".repeat(56);
  console.log(`\nFIREMODEL1 CANDIDATE FUNNEL  ${new Date().toISOString()}`);
  console.log(`Window: last 24h  (${all.length} total rows fetched)\n`);

  // ── A) RAW POOL ────────────────────────────────────────────
  const last24h = all;
  const last2h = all.filter((r) => r.created_at >= since2h);
  const allowedVer = all.filter((r) => ALLOWED_VERSIONS.includes(r.metric_formula_version ?? ""));
  const oldShadowRows = (oldShadow ?? []).length;
  const activeUnresolved = all.filter(
    (r) => r.signal_result === null && r.expires_at >= new Date().toISOString(),
  );

  const withToken = all.filter((r) => r.selected_token_id && r.selected_token_id !== "");
  const withCondition = all.filter((r) => r.condition_id && r.condition_id !== "");
  const withGsi = all.filter(
    (r) =>
      r.diagnostics?.gameStartIso &&
      (r.diagnostics.gameStartIso as string) !== "null" &&
      (r.diagnostics.gameStartIso as string) !== "",
  );
  const withEp = all.filter((r) => r.entry_price_num != null);

  console.log("A) RAW POOL (last 24h)");
  console.log(`   rows_last_24h         : ${last24h.length}`);
  console.log(`   rows_last_2h          : ${last2h.length}`);
  console.log(`   active_unresolved     : ${activeUnresolved.length}`);
  console.log(`   allowed_version_rows  : ${allowedVer.length}`);
  console.log(`   old_shadow_excluded   : ${oldShadowRows}`);
  console.log(`   token_id_present      : ${withToken.length}/${all.length}`);
  console.log(`   condition_id_present  : ${withCondition.length}/${all.length}`);
  console.log(`   gameStartIso_present  : ${withGsi.length}/${all.length}`);
  console.log(`   entry_price_present   : ${withEp.length}/${all.length}`);

  // ── B) SEQUENTIAL FUNNEL ───────────────────────────────────
  console.log(`\n${line}`);
  console.log("B) SEQUENTIAL FUNNEL");

  let stage = all;
  const step = (label: string, filtered: RawRow[]) => {
    console.log(`   ${label.padEnd(32)} : ${filtered.length} (−${stage.length - filtered.length})`);
    stage = filtered;
    return filtered;
  };

  stage = step("raw_24h", all);
  stage = step("allowed_versions", stage.filter((r) => ALLOWED_VERSIONS.includes(r.metric_formula_version ?? "")));
  stage = step("active_unresolved", stage.filter((r) => r.signal_result === null && r.expires_at >= new Date().toISOString()));
  stage = step("token_present", stage.filter((r) => !!r.selected_token_id));
  stage = step("condition_present", stage.filter((r) => !!r.condition_id));
  stage = step("gameStartIso_present", stage.filter((r) => {
    const g = r.diagnostics?.gameStartIso as string | null;
    return !!g && g !== "null" && g !== "";
  }));
  stage = step("entry_price_present", stage.filter((r) => r.entry_price_num != null));
  stage = step("score>=50", stage.filter((r) => (r.signal_confidence_num ?? 0) >= 50));
  const covStage = stage.filter((r) => ((r.diagnostics?.dataCoverage as number) ?? 0) >= 25);
  stage = step("coverage>=25", covStage);
  stage = step("not_NBA/NHL", stage.filter((r) => !isNbaOrNhl(r)));
  stage = step("not_bad_bucket", stage.filter((r) => !isBadBucket(r)));
  const notStarted = stage.filter((r) => {
    const g = r.diagnostics?.gameStartIso as string | null;
    return !!g && new Date(g).getTime() > now;
  });
  stage = step("not_started", notStarted);
  const betOrGo = stage.filter((r) => {
    const g = r.diagnostics?.gameStartIso as string | null;
    const hoursToStart = g ? (new Date(g).getTime() - now) / 3_600_000 : 999;
    const sc = r.signal_confidence_num ?? 0;
    const cov = (r.diagnostics?.dataCoverage as number) ?? 0;
    const tier1 = sc >= 72 && cov >= 50;
    const tier2 = sc >= 60 && cov >= 50;
    return hoursToStart <= 2 && (tier1 || tier2);
  });
  const finalValid = stage;
  step("final_valid_candidates", finalValid);
  console.log(`   BET_OR_PAPER_GO subset  : ${betOrGo.length}`);

  // ── C) REASON COUNTS ──────────────────────────────────────
  console.log(`\n${line}`);
  console.log("C) REJECTION REASON COUNTS (from full 24h raw)");

  type ReasonKey =
    | "TOKEN_MISSING" | "CONDITION_MISSING" | "GAME_START_MISSING"
    | "ENTRY_PRICE_MISSING" | "OLD_SHADOW_UNENRICHED" | "NBA_NHL_EXCLUDED"
    | "BAD_BUCKET" | "BELOW_SCORE_COVERAGE" | "ALREADY_STARTED" | "VALID";

  const reasons: Record<ReasonKey, number> = {
    TOKEN_MISSING: 0, CONDITION_MISSING: 0, GAME_START_MISSING: 0,
    ENTRY_PRICE_MISSING: 0, OLD_SHADOW_UNENRICHED: 0, NBA_NHL_EXCLUDED: 0,
    BAD_BUCKET: 0, BELOW_SCORE_COVERAGE: 0, ALREADY_STARTED: 0, VALID: 0,
  };

  const allowedSet = all.filter((r) => ALLOWED_VERSIONS.includes(r.metric_formula_version ?? ""));
  for (const r of allowedSet) {
    if (!r.selected_token_id) { reasons.TOKEN_MISSING++; continue; }
    if (!r.condition_id) { reasons.CONDITION_MISSING++; continue; }
    const g = r.diagnostics?.gameStartIso as string | null;
    if (!g || g === "null" || g === "") { reasons.GAME_START_MISSING++; continue; }
    if (r.entry_price_num == null) { reasons.ENTRY_PRICE_MISSING++; continue; }
    if ((r.signal_confidence_num ?? 0) < 50 || ((r.diagnostics?.dataCoverage as number) ?? 0) < 25) {
      reasons.BELOW_SCORE_COVERAGE++; continue;
    }
    if (isNbaOrNhl(r)) { reasons.NBA_NHL_EXCLUDED++; continue; }
    if (isBadBucket(r)) { reasons.BAD_BUCKET++; continue; }
    if (new Date(g).getTime() <= now) { reasons.ALREADY_STARTED++; continue; }
    reasons.VALID++;
  }
  reasons.OLD_SHADOW_UNENRICHED = oldShadowRows;

  for (const [k, v] of Object.entries(reasons)) {
    console.log(`   ${k.padEnd(28)} : ${v}`);
  }

  // ── D) TARGET DIAGNOSIS ───────────────────────────────────
  console.log(`\n${line}`);
  console.log("D) TARGET DIAGNOSIS");
  const valid = reasons.VALID;
  console.log(`   valid_total            : ${valid}`);
  console.log(`   can_return_10          : ${valid >= 10}`);
  console.log(`   can_return_25          : ${valid >= 25}`);
  console.log(`   can_return_50          : ${valid >= 50}`);

  // First bottleneck
  const bottleneck = [
    ["TOKEN_MISSING", reasons.TOKEN_MISSING],
    ["GAME_START_MISSING", reasons.GAME_START_MISSING],
    ["ENTRY_PRICE_MISSING", reasons.ENTRY_PRICE_MISSING],
    ["BELOW_SCORE_COVERAGE", reasons.BELOW_SCORE_COVERAGE],
    ["NBA_NHL_EXCLUDED", reasons.NBA_NHL_EXCLUDED],
    ["BAD_BUCKET", reasons.BAD_BUCKET],
    ["ALREADY_STARTED", reasons.ALREADY_STARTED],
  ]
    .filter(([, v]) => (v as number) > 0)
    .sort(([, a], [, b]) => (b as number) - (a as number));

  if (bottleneck.length > 0) {
    console.log(`   first_bottleneck       : ${bottleneck[0][0]} (${bottleneck[0][1]} rows)`);
    if (bottleneck[0][0] === "ALREADY_STARTED") {
      console.log(`   supply_fix_hint        : Run cron more frequently; rows expire after game start`);
    } else if (bottleneck[0][0] === "BELOW_SCORE_COVERAGE") {
      console.log(`   supply_fix_hint        : Lower gate to coverage>=20 or score>=45 — risk: lower ROI`);
    } else if (bottleneck[0][0] === "GAME_START_MISSING") {
      console.log(`   supply_fix_hint        : Enrichment pipeline missing gameStartIso for these rows`);
    } else if (bottleneck[0][0] === "BAD_BUCKET") {
      console.log(`   supply_fix_hint        : Bad bucket is intentional exclusion — do not relax`);
    }
  } else {
    console.log(`   first_bottleneck       : NONE — supply sufficient`);
  }

  console.log(`${line}\n`);
}

main().catch((e) => {
  console.error("FUNNEL_ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
