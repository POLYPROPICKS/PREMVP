/** Read-only restored-lineage audit over the frozen football denominator V2. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AUG_END, SEP_1_12_END, RANGE_START, RANGE_END } from "./build-football-denominator-reconciliation-v2";
import { loadFrozenFootballDenominatorV2, FROZEN_OVERLAY_COMPRESSED_SHA256, FROZEN_OVERLAY_CONTENT_SHA256 } from "./load-frozen-football-denominator-v2";
import { buildStructuralCandidates, connectClone, displayOdds, isOrdinaryHold, marketBucketOf, type StructuralCandidate } from "./football-structural-authority";
import { runStandaloneStrict, settledBetsOnly, metricsFor } from "./daily-portfolio-frontier";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

const OUT_DIR = "modeling/evidence/p5052-p5054-c1-restored-lineage-audit-v2";
const PERIODS = ["AUG", "SEP_1_12", "SEP_13_20", "SEP_21_24", "COMBINED_FULL_AUG04_SEP24"] as const;
const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

function periodOf(date: string): typeof PERIODS[number] {
  if (date <= AUG_END) return "AUG";
  if (date <= SEP_1_12_END) return "SEP_1_12";
  if (date <= "2026-09-20") return "SEP_13_20";
  return "SEP_21_24";
}

function row(candidates: StructuralCandidate[], settlement: Map<string, CorpusLabel>, qualifies: (c: StructuralCandidate) => boolean) {
  const selected = runStandaloneStrict(candidates, (evaluated) => qualifies(evaluated as StructuralCandidate));
  const { settledBets, openN, otherNonterminalN } = settledBetsOnly(selected, settlement);
  const metrics = metricsFor(settledBets);
  return {
    SELECTED_N: selected.length,
    SETTLED_N: settledBets.length,
    OPEN_N: openN,
    OTHER_NONTERMINAL_N: otherNonterminalN,
    WINS: metrics.wins,
    LOSSES: metrics.losses,
    HIT_RATE_PCT: metrics.wins + metrics.losses ? round(100 * metrics.wins / (metrics.wins + metrics.losses)) : null,
    AVG_ENTRY_PRICE: selected.length ? round(selected.reduce((sum, s) => sum + s.entryPrice, 0) / selected.length, 4) : null,
    AVG_DECIMAL_ODDS: selected.length ? round(selected.reduce((sum, s) => sum + displayOdds(s.entryPrice), 0) / selected.length, 4) : null,
    REFERENCE_PNL_U: round(metrics.pnl_u),
    REFERENCE_ROI_PCT: round(metrics.roi_pct),
    MAX_DD_U: round(metrics.max_drawdown_u),
  };
}

async function main() {
  const db = await connectClone();
  const frozen = await loadFrozenFootballDenominatorV2(db);
  const { candidates, settlementByCandidateIdentity } = buildStructuralCandidates(frozen.sourceRows, frozen.overlay);
  const bands = {
    P50_52: [0.5, 0.52],
    P50_54: [0.5, 0.54],
    C1: [0.5, 0.6],
  } as const;
  const models: Record<string, Record<string, ReturnType<typeof row>>> = {};
  for (const [model, [lo, hi]] of Object.entries(bands)) {
    models[model] = {};
    for (const period of PERIODS) {
      const pop = period === "COMBINED_FULL_AUG04_SEP24" ? candidates : candidates.filter((c) => periodOf(c.modelDate) === period);
      models[model][period] = row(pop, settlementByCandidateIdentity, (c) => isOrdinaryHold(c.marketTypeRaw) && c.entryPrice >= lo && c.entryPrice < hi);
    }
  }
  const families = ["moneyline", "totals", "spreads"] as const;
  const livePrice = (c: StructuralCandidate) => c.entryPrice >= 0.5 && c.entryPrice < 0.54;
  const liveFamily = (c: StructuralCandidate) => families.some((f) => marketBucketOf(c.marketTypeRaw) === f);
  const calendarDays = Math.round((Date.parse(`${RANGE_END}T00:00:00Z`) - Date.parse(`${RANGE_START}T00:00:00Z`)) / 86_400_000) + 1;
  const liveTotal = row(candidates, settlementByCandidateIdentity, (c) => livePrice(c) && liveFamily(c));
  const liveByFamily = Object.fromEntries(families.map((family) => [family, row(candidates, settlementByCandidateIdentity, (c) => livePrice(c) && marketBucketOf(c.marketTypeRaw) === family)]));
  const report = {
    MISSION: "P50_52_P50_54_C1_RESTORED_LINEAGE_AUDIT_V2",
    NOT_EXECUTION_AUTHORITY: true,
    ECONOMICS: "SELECTION_BEFORE_SETTLEMENT; OPEN_KEEPS_SLOT; ONE_BET_PER_PHYSICAL_EVENT_PER_CELL; FLAT_1U; DISPLAY_ODDS; REFERENCE_PNL",
    RANGE: `${RANGE_START}..${RANGE_END}`,
    FROZEN_OVERLAY_COMPRESSED_SHA256,
    FROZEN_OVERLAY_CONTENT_SHA256,
    SOURCE_ROW_N: frozen.sourceRows.length,
    OVERLAY_ROW_N: frozen.overlay.length,
    PERIODS,
    MODELS: models,
    LIVE_POLICY_REPLAY: {
      SCOPE: "football, entry_price [0.50,0.54), moneyline/totals/spreads, full history",
      TOTAL: { ...liveTotal, SELECTED_EVENTS_PER_CALENDAR_DAY: round(liveTotal.SELECTED_N / calendarDays, 4) },
      BY_FAMILY: Object.fromEntries(Object.entries(liveByFamily).map(([family, value]) => [family, { ...value, SELECTED_EVENTS_PER_CALENDAR_DAY: round(value.SELECTED_N / calendarDays, 4) }])),
      CALENDAR_DAYS: calendarDays,
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(report, null, 2) + "\n";
  const md = [
    "# Restored-lineage P50/C1 audit V2", "", "REFERENCE_PNL; NOT_EXECUTION_AUTHORITY.", "",
    `Frozen overlay SHA256: ${FROZEN_OVERLAY_COMPRESSED_SHA256}`, "",
    "| Model | Period | Selected | Settled | Open | W | L | Hit % | Avg entry | Avg odds | PnL u | ROI % | MaxDD u |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(models).flatMap(([model, periods]) => PERIODS.map((period) => { const r = periods[period]; return `| ${model} | ${period} | ${r.SELECTED_N} | ${r.SETTLED_N} | ${r.OPEN_N} | ${r.WINS} | ${r.LOSSES} | ${r.HIT_RATE_PCT ?? "—"} | ${r.AVG_ENTRY_PRICE ?? "—"} | ${r.AVG_DECIMAL_ODDS ?? "—"} | ${r.REFERENCE_PNL_U} | ${r.REFERENCE_ROI_PCT} | ${r.MAX_DD_U} |`; })),
    "", "## Live policy replay", "", "Full history; moneyline, totals, spreads; entry price [0.50,0.54).", "",
    "| Family | Selected | Settled | Open | W | L | Hit % | PnL u | ROI % | Events/calendar day |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries({ TOTAL: liveTotal, ...liveByFamily }).map(([family, r]) => `| ${family} | ${r.SELECTED_N} | ${r.SETTLED_N} | ${r.OPEN_N} | ${r.WINS} | ${r.LOSSES} | ${r.HIT_RATE_PCT ?? "—"} | ${r.REFERENCE_PNL_U} | ${r.REFERENCE_ROI_PCT} | ${round(r.SELECTED_N / calendarDays, 4)} |`),
    "",
  ].join("\n");
  const sha = createHash("sha256").update(json).digest("hex");
  writeFileSync(`${OUT_DIR}/AUDIT_REPORT.json`, json);
  writeFileSync(`${OUT_DIR}/FINDINGS.md`, md);
  writeFileSync(`${OUT_DIR}/SHA256SUMS.txt`, `${sha}  AUDIT_REPORT.json\n${createHash("sha256").update(md).digest("hex")}  FINDINGS.md\n`);
  console.log(JSON.stringify({ STATUS: "PASS", ARTIFACT_SHA256: sha, SOURCE_ROWS: frozen.sourceRows.length, OVERLAY_ROWS: frozen.overlay.length, P50_52_COMBINED: models.P50_52.COMBINED_FULL_AUG04_SEP24, P50_54_COMBINED: models.P50_54.COMBINED_FULL_AUG04_SEP24, C1_COMBINED: models.C1.COMBINED_FULL_AUG04_SEP24, LIVE_TOTAL: liveTotal }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ STATUS: "FAILED", ERROR: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
}
