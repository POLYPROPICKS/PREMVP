/**
 * DETERMINISTIC_RICH_MODEL_SCORECARD_V1 — thin CLI.
 *
 * Evaluates the frozen C0/C1/C4/C5 models against the canonical rolling
 * research corpus for 7d / 14d / 30d ending at the latest closed Minsk day,
 * per compatible population separately, and writes ONE machine-readable
 * scorecard artifact.
 *
 *   npx tsx scripts/modeling/scorecard-run.ts [--now <iso>] [--out <path>] [--pretty]
 *
 * No DB, no clone, no production, no rematerialization. Reads only the local
 * immutable partition artifacts through the canonical rolling loader.
 * Determinism is proven inline (built twice, reversed partition order).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildRollingManifest,
  buildScorecardRowView,
  resolveWindowDates,
  type LoadedPartition,
} from "@/lib/modeling/research-corpus/rollingCorpus";
import { loadPartition, partitionExists } from "./rolling-research-corpus";
import { buildScorecard, PERIODS, type Period, type ScorecardInput } from "@/lib/modeling/scorecard/scorecardEvaluator";

const OUT_DIR = "modeling/evidence/rich-model-scorecard-v1";
const PERIOD_DAYS: Record<Period, 7 | 14 | 30> = { "7d": 7, "14d": 14, "30d": 30 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(f: string): boolean {
  return process.argv.includes(f);
}

function periodsInput(nowUtc: string, generatedAt: string, partitions: LoadedPartition[]): ScorecardInput {
  const periods = {} as ScorecardInput["periods"];
  for (const period of PERIODS) {
    const windowDays = PERIOD_DAYS[period];
    const view = buildScorecardRowView({ windowDays, nowUtc, partitions });
    const manifest = buildRollingManifest({ windowDays, nowUtc, partitions }, generatedAt);
    periods[period] = { view, manifestPopulations: manifest.POPULATIONS };
  }
  return { periods, generatedAt };
}

function main(): void {
  const nowUtc = arg("--now") ?? new Date().toISOString();
  const generatedAt = arg("--generated-at") ?? new Date().toISOString();

  // Load every partition the 30d window needs, once, from local disk only.
  const { dates } = resolveWindowDates(30, nowUtc);
  const missing = dates.filter((d) => !partitionExists(d));
  if (missing.length) {
    console.error(`SCORECARD_BLOCKED_INCOMPLETE_CORPUS: missing immutable partitions ${missing.join(", ")}`);
    process.exit(2);
  }
  const partitions = dates.map(loadPartition);

  const scorecard = buildScorecard(periodsInput(nowUtc, generatedAt, partitions));

  // ── determinism proof: rebuild from reversed partition order, same generatedAt ──
  const reversed = buildScorecard(periodsInput(nowUtc, generatedAt, [...partitions].reverse()));
  const canon = (o: unknown) => JSON.stringify(o);
  const sha = createHash("sha256").update(canon(scorecard), "utf8").digest("hex");
  const shaReversed = createHash("sha256").update(canon(reversed), "utf8").digest("hex");
  if (sha !== shaReversed) {
    throw new Error(`SCORECARD_NONDETERMINISTIC: ${sha} != ${shaReversed} (input-order dependent)`);
  }

  const stem = `SCORECARD_7d14d30d_${scorecard.WINDOW_END}`;
  const outPath = arg("--out") ?? join(OUT_DIR, `${stem}.json`);
  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(scorecard, null, 2) + "\n";
  writeFileSync(outPath, json);
  writeFileSync(
    join(OUT_DIR, `${stem}.SHA256SUMS.txt`),
    `${createHash("sha256").update(json, "utf8").digest("hex")}  ${stem}.json\n` +
      `${sha}  SCORECARD_CANONICAL_CONTENT (deterministic, GENERATED_AT-independent when --generated-at fixed)\n`,
  );

  // ── compact comparison table to stdout ────────────────────────────────
  const table = scorecard.COMPARISON.map((e) => ({
    MODEL: e.MODEL_ID,
    POP: e.POPULATION_ID.replace("SEP_", "").replace("_V1", ""),
    "7d N/PnL/ROI%": `${e.BY_PERIOD["7d"].N}/${e.BY_PERIOD["7d"].PNL_U}/${e.BY_PERIOD["7d"].ROI_PCT}`,
    "14d N/PnL/ROI%": `${e.BY_PERIOD["14d"].N}/${e.BY_PERIOD["14d"].PNL_U}/${e.BY_PERIOD["14d"].ROI_PCT}`,
    "30d N/PnL/ROI%": `${e.BY_PERIOD["30d"].N}/${e.BY_PERIOD["30d"].PNL_U}/${e.BY_PERIOD["30d"].ROI_PCT}`,
    "30d MaxDD": e.BY_PERIOD["30d"].MAX_DRAWDOWN_U,
    "30d +/- wk": `${e.BY_PERIOD["30d"].POSITIVE_BUCKET_N}/${e.BY_PERIOD["30d"].NEGATIVE_BUCKET_N}`,
    "30d burst": e.BY_PERIOD["30d"].BURST_CONCENTRATION,
  }));

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        MISSION: scorecard.MISSION,
        EVALUATION_MODE: scorecard.EVALUATION_MODE,
        FORWARD_VALIDATED: scorecard.FORWARD_VALIDATED,
        THRESHOLD_SEARCH_PERFORMED: scorecard.THRESHOLD_SEARCH_PERFORMED,
        SCORE_SERIES_USED_AS_PREDICATE: scorecard.SCORE_SERIES_USED_AS_PREDICATE,
        WINDOW_END: scorecard.WINDOW_END,
        DB_READS: 0,
        BROAD_SCANS: 0,
        SCORECARD_CANONICAL_CONTENT_SHA256: sha,
        INPUT_ORDER_INDEPENDENT: sha === shaReversed,
        CELL_N: scorecard.CELLS.length,
        outPath,
        COMPARISON: table,
      },
      null,
      has("--pretty") ? 2 : 2,
    ) + "\n",
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /scorecard-run(\.ts|\.js|\.mjs)?$/.test(process.argv[1]);
if (invokedDirectly) main();

export { main };
