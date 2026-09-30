/**
 * FOOTBALL_MARKET_PRIORITY_POLICY_V1 runner — read-only research transition.
 * Reuses the canonical v2 reconciliation pipeline (extended range), the
 * structural-authority candidate builder (physicalEventKey = provider_event_id),
 * and daily-portfolio-frontier settlement/metrics primitives. Settlement is
 * attached ONLY after selection. Writes only modeling/evidence/market-priority-policy-v1/.
 *
 *   npx tsx scripts/modeling/run-football-market-priority-policy-v1.ts
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { runReconciliationV2, RANGE_START, GSP_OVERSIZE_POLICY } from "./build-football-denominator-reconciliation-v2";
import { EXPECTED_CLONE_REF, obj, type SourceRow } from "./build-football-denominator-reconciliation";
import { buildStructuralCandidates, marketBucketOf, type StructuralCandidate } from "./football-structural-authority";
import { settledBetsOnly, metricsFor, type SelectedCandidate } from "./daily-portfolio-frontier";
import { buildChoiceSets, chooseBaseline, choosePolicy, familyOf, FAMILIES, CORE, type Policy, type PolicyRow, type Family } from "./football-market-priority-policy";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

const OUT_DIR = "modeling/evidence/market-priority-policy-v1";
const CACHE = process.env.MPP_CACHE ?? "";
const SPLITS = ["AUG", "SEP01_12", "SEP13_24", "SEP25_29"] as const;
type Split = (typeof SPLITS)[number];
const splitOf = (d: string): Split => (d <= "2026-08-31" ? "AUG" : d <= "2026-09-12" ? "SEP01_12" : d <= "2026-09-24" ? "SEP13_24" : "SEP25_29"); // SEP25_29 bucket holds 09-25 (+ later if extended)

const P = (id: string, priority: Family[], requireAll?: Family[], requireAny?: Family[]): Policy => ({ id, priority, requireAll, requireAny });
const rest = (first: Family[]): Family[] => [...first, ...FAMILIES.filter((f) => !first.includes(f))];
const POLICIES: Array<{ policy: Policy; domain: string }> = [
  { policy: P("SPREADS_FIRST", rest(["spreads", "moneyline", "totals"])), domain: "ALL_ORDINARY_EVENTS" },
  { policy: P("MONEYLINE_FIRST", rest(["moneyline", "spreads", "totals"])), domain: "ALL_ORDINARY_EVENTS" },
  { policy: P("TOTALS_FIRST", rest(["totals", "spreads", "moneyline"])), domain: "ALL_ORDINARY_EVENTS" },
  { policy: P("SPREAD_OVER_ML", ["spreads", "moneyline"], ["spreads", "moneyline"]), domain: "PAIR spreads&moneyline" },
  { policy: P("ML_OVER_SPREAD", ["moneyline", "spreads"], ["spreads", "moneyline"]), domain: "PAIR spreads&moneyline" },
  { policy: P("SPREAD_OVER_TOTALS", ["spreads", "totals"], ["spreads", "totals"]), domain: "PAIR spreads&totals" },
  { policy: P("TOTALS_OVER_SPREAD", ["totals", "spreads"], ["spreads", "totals"]), domain: "PAIR spreads&totals" },
  { policy: P("ML_OVER_TOTALS", ["moneyline", "totals"], ["moneyline", "totals"]), domain: "PAIR moneyline&totals" },
  { policy: P("TOTALS_OVER_ML", ["totals", "moneyline"], ["moneyline", "totals"]), domain: "PAIR moneyline&totals" },
  { policy: P("CORE_OVER_CORNERS", [...CORE, "total_corners"], ["total_corners"], CORE), domain: "corners&any-core" },
  { policy: P("CORNERS_OVER_CORE", ["total_corners", ...CORE], ["total_corners"], CORE), domain: "corners&any-core" },
  { policy: P("CORE_OVER_OTHER", [...CORE, "other_structured"], ["other_structured"], CORE), domain: "other_structured&any-core" },
  { policy: P("OTHER_OVER_CORE", ["other_structured", ...CORE], ["other_structured"], CORE), domain: "other_structured&any-core" },
];

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const asSel = (r: PolicyRow, c: StructuralCandidate): SelectedCandidate => ({
  physicalEventKey: r.physicalEventKey, decisionTimestamp: r.decisionTimestamp, eventStart: r.eventStart,
  leadTimeHours: c.rowLeadTimeHours ?? (Date.parse(r.eventStart) - Date.parse(r.decisionTimestamp)) / 3.6e6,
  entryPrice: r.entryPrice, sportFamily: "soccer", ref: r.conditionId, candidateRef: r.tokenId, tier: 1, day: c.modelDate,
  candidateIdentity: r.candidateIdentity,
});

interface Ctx { candByIdent: Map<string, StructuralCandidate>; settle: Map<string, CorpusLabel>; meta: Map<string, { pop: string; code: string; cov: string }> }

function metrics(rows: PolicyRow[], ctx: Ctx) {
  const sel = rows.map((r) => asSel(r, ctx.candByIdent.get(r.candidateIdentity)!));
  const sp = settledBetsOnly(sel, ctx.settle);
  const m = metricsFor(sp.settledBets);
  const days = new Set(sel.map((s) => s.day)).size;
  return { SELECTED_N: sel.length, SETTLED_N: sp.settledBets.length, OPEN_N: sp.openN, OTHER_NONTERMINAL_N: sp.otherNonterminalN,
    WINS: m.wins, LOSSES: m.losses, PNL_U: r4(m.pnl_u), ROI_PCT: r4(m.roi_pct), MAX_DD_U: r4(m.max_drawdown_u), BETS_PER_DAY: days ? r4(sel.length / days) : 0 };
}
const pnlOf = (r: PolicyRow, ctx: Ctx): number | null => {
  const l = ctx.settle.get(r.candidateIdentity);
  return l === "WIN" ? 1 / r.entryPrice - 1 : l === "LOSS" ? -1 : null;
};

function evaluate(sets: Map<string, PolicyRow[]>, ctx: Ctx, pol: Policy, domain: string) {
  const picks: PolicyRow[] = [], base: PolicyRow[] = [];
  let domainN = 0;
  const paired: Array<{ d: number; split: Split; code: string }> = [];
  let differN = 0;
  for (const set of [...sets.values()].sort((a, b) => (a[0].physicalEventKey < b[0].physicalEventKey ? -1 : 1))) {
    const c = choosePolicy(set, pol);
    if (!c) continue;
    domainN++;
    const b = chooseBaseline(set)!;
    picks.push(c); base.push(b);
    if (c.candidateIdentity !== b.candidateIdentity) {
      differN++;
      const pc = pnlOf(c, ctx), pb = pnlOf(b, ctx);
      if (pc !== null && pb !== null) paired.push({ d: pc - pb, split: splitOf(ctx.candByIdent.get(c.candidateIdentity)!.modelDate), code: ctx.meta.get(c.candidateIdentity)?.code ?? "?" });
    }
  }
  const bySplit = (rows: PolicyRow[]) => Object.fromEntries(SPLITS.map((s) => [s, metrics(rows.filter((r) => splitOf(ctx.candByIdent.get(r.candidateIdentity)!.modelDate) === s), ctx)]));
  const byRegime = (rows: PolicyRow[]) => {
    const g = new Map<string, PolicyRow[]>();
    for (const r of rows) { const k = ctx.meta.get(r.candidateIdentity)?.pop ?? "?"; (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    return Object.fromEntries([...g.entries()].sort().map(([k, v]) => [k, metrics(v, ctx)]));
  };
  const n = paired.length, mean = n ? paired.reduce((a, x) => a + x.d, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(paired.reduce((a, x) => a + (x.d - mean) ** 2, 0) / (n - 1)) : 0;
  const z = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const deltaBySplit = Object.fromEntries(SPLITS.map((s) => { const x = paired.filter((p) => p.split === s); return [s, { N: x.length, DELTA_PNL_U: r4(x.reduce((a, p) => a + p.d, 0)) }]; }));
  const posByCode = new Map<string, number>();
  for (const p of paired) if (p.d > 0) posByCode.set(p.code, (posByCode.get(p.code) ?? 0) + p.d);
  const posTotal = [...posByCode.values()].reduce((a, b) => a + b, 0);
  const topCode = [...posByCode.entries()].sort((a, b) => b[1] - a[1])[0];
  const fam = (rows: PolicyRow[]) => { const o: Record<string, number> = {}; for (const r of rows) o[familyOf(r)!] = (o[familyOf(r)!] ?? 0) + 1; return o; };
  return {
    policy: pol.id, domain, exact_priority: pol.priority, requireAll: pol.requireAll ?? [], requireAny: pol.requireAny ?? [],
    CHOICE_SET_PHYSICAL_EVENT_N: domainN, SELECTED_FAMILY_MIX: fam(picks),
    POLICY: { ...metrics(picks, ctx), SPLITS: bySplit(picks), SOURCE_REGIME_SPLIT: byRegime(picks) },
    BASELINE_SAME_DOMAIN: { ...metrics(base, ctx), FAMILY_MIX: fam(base), SPLITS: bySplit(base) },
    PAIRED_DIFFERING_EVENTS: { DIFFER_EVENT_N: differN, BOTH_SETTLED_N: n, MEAN_DELTA_PNL_U: r4(mean), TOTAL_DELTA_PNL_U: r4(mean * n), Z: r4(z), DELTA_BY_SPLIT: deltaBySplit,
      TOP_PROVIDER_SPORT_CODE_SHARE_OF_POSITIVE_DELTA: posTotal > 0 && topCode ? { code: topCode[0], share: r4(topCode[1] / posTotal) } : null },
    _picks: picks,
  };
}

async function main() {
  GSP_OVERSIZE_POLICY.mode = "SKIP";
  const t0 = Date.now();
  const url = process.env.SUPABASE_CLONE_URL, key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_READ_AUTHORIZATION_UNAVAILABLE");
  if (new URL(url).hostname.split(".")[0] !== EXPECTED_CLONE_REF) throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const originMain = execSync("git rev-parse origin/main", { encoding: "utf8" }).trim();
  const { data: mx, error } = await db.from("research_model_ready_rows").select("model_date").order("model_date", { ascending: false }).limit(1);
  if (error) throw new Error(`CLONE_UNREACHABLE:${error.message}`);
  const maxDate = String(mx?.[0]?.model_date);
  console.error(JSON.stringify({ STAGE: "START_GATE", originMain, maxDate }));

  let sourceRows: SourceRow[], overlay: any[], skipped: string[];
  if (CACHE && existsSync(CACHE)) ({ sourceRows, overlay, skipped } = JSON.parse(readFileSync(CACHE, "utf8")));
  else {
    ({ sourceRows, overlay } = await runReconciliationV2(db, maxDate));
    skipped = [...GSP_OVERSIZE_POLICY.skipped];
    if (CACHE) writeFileSync(CACHE, JSON.stringify({ sourceRows, overlay, skipped }));
  }
  const skippedSet = new Set(skipped);
  const END = process.env.MPP_END ?? maxDate;
  const built = buildStructuralCandidates(sourceRows, overlay);
  const candidates = built.candidates.filter((c) => c.modelDate <= END);
  const settlementByCandidateIdentity = built.settlementByCandidateIdentity;
  const meta = new Map<string, { pop: string; code: string; cov: string }>();
  for (const r of sourceRows) {
    const cr = obj(r.canonical_row);
    meta.set(`${r.condition_id}::${r.selected_token_id}::${r.decision_at}`, {
      pop: r.population_id, code: String(cr.providerSportCode ?? "?"), cov: String(cr.dataCoverage ?? "?"),
    });
  }
  const candByIdent = new Map<string, StructuralCandidate>();
  for (const c of candidates) if (!candByIdent.has(c.candidateIdentity!)) candByIdent.set(c.candidateIdentity!, c);
  const rows: PolicyRow[] = [...candByIdent.values()].map((c) => ({
    physicalEventKey: c.physicalEventKey, decisionTimestamp: c.decisionTimestamp, eventStart: c.eventStart, entryPrice: c.entryPrice,
    marketTypeRaw: c.marketTypeRaw ?? null, conditionId: String(c.ref), tokenId: String(c.candidateRef), candidateIdentity: c.candidateIdentity!,
  }));
  const ctx: Ctx = { candByIdent, settle: settlementByCandidateIdentity, meta };
  const sets = buildChoiceSets(rows);

  // Same-event overlap counts (T0 choice set) + wider diagnostic (any time) for context.
  const famSets = [...sets.values()].map((s) => new Set(s.map((r) => familyOf(r)!)));
  const overlaps: Record<string, number> = {};
  for (let i = 0; i < FAMILIES.length; i++) for (let j = i + 1; j < FAMILIES.length; j++)
    overlaps[`${FAMILIES[i]}&${FAMILIES[j]}`] = famSets.filter((s) => s.has(FAMILIES[i]) && s.has(FAMILIES[j])).length;
  const allEventsAnyTime = new Map<string, Set<Family>>();
  for (const r of rows) { const f = familyOf(r); if (f) (allEventsAnyTime.get(r.physicalEventKey) ?? allEventsAnyTime.set(r.physicalEventKey, new Set()).get(r.physicalEventKey)!).add(f); }
  const overlapsAnyTime: Record<string, number> = {};
  for (let i = 0; i < FAMILIES.length; i++) for (let j = i + 1; j < FAMILIES.length; j++)
    overlapsAnyTime[`${FAMILIES[i]}&${FAMILIES[j]}`] = [...allEventsAnyTime.values()].filter((s) => s.has(FAMILIES[i]) && s.has(FAMILIES[j])).length;

  const results = POLICIES.map(({ policy, domain }) => evaluate(sets, ctx, policy, domain));

  // Spread anomaly diagnostics on the SPREADS_FIRST picks that are spreads.
  const spreadRows = results[0]._picks.filter((r) => familyOf(r) === "spreads");
  const grp = (keyf: (r: PolicyRow) => string) => {
    const g = new Map<string, PolicyRow[]>();
    for (const r of spreadRows) { const k = keyf(r); (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    return Object.fromEntries([...g.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([k, v]) => [k, metrics(v, ctx)]));
  };
  const price = (r: PolicyRow) => { const o = 1 / r.entryPrice; return o < 1.5 ? "<1.5" : o < 2 ? "1.5-2" : o < 3 ? "2-3" : ">=3"; };
  const lead = (r: PolicyRow) => { const h = (Date.parse(r.eventStart) - Date.parse(r.decisionTimestamp)) / 3.6e6; return h < 3 ? "<3h" : h < 12 ? "3-12h" : h < 24 ? "12-24h" : ">=24h"; };
  const spreadDiagnostics = {
    N: spreadRows.length,
    BY_PROVIDER_SPORT_CODE_TOP12: grp((r) => ctx.meta.get(r.candidateIdentity)?.code ?? "?"),
    BY_SOURCE_POPULATION: grp((r) => ctx.meta.get(r.candidateIdentity)?.pop ?? "?"),
    BY_DATA_COVERAGE: grp((r) => ctx.meta.get(r.candidateIdentity)?.cov ?? "?"),
    BY_DISPLAY_ODDS: grp(price), BY_LEAD_TIME: grp(lead),
    NOT_AVAILABLE_WITHOUT_BROAD_RESEARCH: ["handicap_line", "selected_side", "favorite_underdog", "league_country_authority", "parent_vs_exact_market_volume_semantic", "pre_post_fanout_regime(proxy=population/period)"],
  };

  // Predeclared verdict rule (frozen before evaluation).
  const RULE = { DOMAIN: "policy in ALL_ORDINARY_EVENTS or PAIR domain", MIN_BOTH_SETTLED_DIFFER_N: 100, MIN_TOTAL_DELTA_PNL_U: 0.0001, MIN_Z: 1.64,
    MIN_SPLITS_WITH_POSITIVE_DELTA: 3, MAX_TOP_CODE_SHARE_OF_POSITIVE_DELTA: 0.4, MAX_DD_NOT_WORSE_THAN_BASELINE_BY: 0.25 };
  const verdicts = results.map((r) => {
    const pd = r.PAIRED_DIFFERING_EVENTS;
    const pos = SPLITS.filter((s) => pd.DELTA_BY_SPLIT[s].DELTA_PNL_U > 0).length;
    const ddOk = r.POLICY.MAX_DD_U >= r.BASELINE_SAME_DOMAIN.MAX_DD_U * (1 + RULE.MAX_DD_NOT_WORSE_THAN_BASELINE_BY);
    const conc = pd.TOP_PROVIDER_SPORT_CODE_SHARE_OF_POSITIVE_DELTA?.share ?? 0;
    const pass = pd.BOTH_SETTLED_N >= RULE.MIN_BOTH_SETTLED_DIFFER_N && pd.TOTAL_DELTA_PNL_U > RULE.MIN_TOTAL_DELTA_PNL_U && pd.Z >= RULE.MIN_Z
      && pos >= RULE.MIN_SPLITS_WITH_POSITIVE_DELTA && conc <= RULE.MAX_TOP_CODE_SHARE_OF_POSITIVE_DELTA && ddOk;
    return { policy: r.policy, pass, checks: { n: pd.BOTH_SETTLED_N, delta: pd.TOTAL_DELTA_PNL_U, z: pd.Z, splitsPositive: pos, topCodeShare: conc, ddOk } };
  });
  const status = verdicts.some((v) => v.pass) ? "PROVISIONAL_LIVE_CANDIDATE" : "NOT_BETTER_THAN_CURRENT_BASELINE";

  const artifact = {
    ARTIFACT: "MARKET_PRIORITY_POLICY_V1", STATUS: status, ORIGIN_MAIN: originMain, CLONE_PROJECT_REF: EXPECTED_CLONE_REF,
    EVIDENCE_DATE_RANGE: `${RANGE_START}..${END}`, MODEL_READY_MAX_DATE: maxDate,
    CHOICE_SET_DEFINITION: "PRE-SELECTION: per physicalEventKey (=provider_event_id), all ORDINARY rows (resolved non-Exact-Score market type, canonical soccer) sharing the event's FIRST decision timestamp T0; deduped by conditionId::tokenId::decisionAt. Source: research_model_ready_rows via frozen v2 reconciliation extended range — NOT research_strategy_selected_bets.",
    BASELINE: "CURRENT_EARLY_PIN: first row of the T0 ordinary choice set under the tie-break (equals runStandaloneStrict chronological-first for isOrdinaryHold rows).",
    TIE_BREAK: "decisionTimestamp asc -> entryPrice asc -> conditionId asc -> tokenId asc -> candidateIdentity asc (decision-time-only; no outcome).",
    FAIL_CLOSED: ["null physicalEventKey", "UNRESOLVED market type", "soccer_exact_score", "entryPrice outside (0,1)", "non-canonical-soccer", "event missing a required family for pair policies -> not in domain (no bet)", "empty choice set -> no bet"],
    SELECTION_RULE_FROZEN: RULE, VERDICTS: verdicts,
    CHOICE_SET_EVENT_N_TOTAL: sets.size, SAME_EVENT_FAMILY_OVERLAP_T0: overlaps, SAME_EVENT_FAMILY_OVERLAP_ANY_TIME_DIAGNOSTIC: overlapsAnyTime,
    POLICIES: results.map(({ _picks, ...rest }) => rest), SPREAD_CONCENTRATION_DIAGNOSTICS: spreadDiagnostics,
    CAVEATS: ["Reference price is REFERENCE_PNL, not executable full-stake fill.", "signal_score/100 is not probability; no probabilities invented.",
      "Single frozen predeclared rule; no retuning. Overlap-domain pair policies test priority only where both families coexist at T0.",
      "T0-only choice set is a conservative simultaneity definition; later-arriving markets are excluded (shown only in ANY_TIME diagnostic).",
      "Source-regime split uses population_id as proxy; pre/post fan-out marker not canonical in code.",
      "Settled N differs by day-lag; OPEN excluded from PnL/ROI."],
    SATURATED_CONDITION_N: skipped.length, EXCLUDED_PHYSICAL_EVENT_N: new Set(sourceRows.filter((r) => skippedSet.has(`${r.condition_id}::${r.selected_token_id}`) && r.provider_event_id).map((r) => r.provider_event_id)).size, PRODUCTION_WRITES: 0, CLONE_DB_WRITES: 0, RUNTIME_SEC: Math.round((Date.now() - t0) / 1000),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(artifact, null, 2) + "\n";
  writeFileSync(join(OUT_DIR, "MARKET_PRIORITY_POLICY_V1.json"), json);
  writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), `${createHash("sha256").update(json).digest("hex")}  MARKET_PRIORITY_POLICY_V1.json\n`);
  console.log(JSON.stringify({ STATUS: status, VERDICTS: verdicts, EVENTS: sets.size, OVERLAP: overlaps }));
}
main().catch((e) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; });
