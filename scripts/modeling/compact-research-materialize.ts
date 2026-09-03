/**
 * COMPACT_RESEARCH_MATERIALIZER_V1 — one-slice proof.
 *
 * Takes ONE closed D-1 raw research-clone slice, materializes the compact
 * population-aware modeling corpus, and immediately runs the existing frozen
 * C4 research semantics on the compact output. Reports the compression funnel
 * (separate units) and the Founder-facing C4 scorecard.
 *
 * Deterministic: same input bytes -> byte-identical stdout / artifacts.
 *
 *   npx tsx scripts/modeling/compact-research-materialize.ts \
 *     [--slice PATH] [--out-dir DIR]
 *
 * No DB, no Gamma call, no production/runtime configuration touched.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCompactCorpus,
  runCompactC4Scorecard,
  type CompactCorpusSlice,
} from "@/lib/modeling/forward-rich/compactCorpus";
import type { PopulationId } from "@/lib/modeling/forward-rich/types";

const DEFAULT_SLICE =
  "modeling/local_exports/compact_research_materializer_v1/D1_SLICE_FIXTURE.json";
const DEFAULT_OUT_DIR = "modeling/evidence/compact-research-materializer-v1";

const SEPTEMBER_POPULATIONS: PopulationId[] = [
  "SEP_PUBLIC_RICH_V1",
  "SEP_SHADOW_STRATEGIC_V1",
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function main(): void {
  const slicePath = arg("--slice", DEFAULT_SLICE);
  const outDir = arg("--out-dir", DEFAULT_OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  const raw = JSON.parse(readFileSync(slicePath, "utf8")) as CompactCorpusSlice & {
    sliceDateUtc: string;
    materializedAt: string;
  };
  const slice: CompactCorpusSlice = {
    sliceDateUtc: raw.sliceDateUtc,
    sinceCutoff: raw.sinceCutoff,
    materializedAt: raw.materializedAt,
    signalPairs: raw.signalPairs,
    observations: raw.observations,
  };

  const corpus = buildCompactCorpus(slice);

  const compactJsonl = toJsonl(corpus.rows);
  const compactPath = join(outDir, "COMPACT_CORPUS.jsonl");
  writeFileSync(compactPath, compactJsonl);
  const compactBytes = statSync(compactPath).size;

  const sliceBytes = statSync(slicePath).size;

  // ── C4 proof, per September population (never pooled) ───────────────────
  const scorecards = SEPTEMBER_POPULATIONS.map((pop) =>
    runCompactC4Scorecard(corpus.rows, pop),
  );

  // ── data-quality accounting (RESEARCH_CORPUS_CONTRACT.md §8) ────────────
  const dq = SEPTEMBER_POPULATIONS.map((pop) => {
    const popRows = corpus.rows.filter((r) => r.populationId === pop);
    const labelCounts: Record<string, number> = {};
    for (const r of popRows) labelCounts[r.label] = (labelCounts[r.label] ?? 0) + 1;
    const scored = popRows.filter((r) => r.score.observationCount > 0).length;
    const priced = popRows.filter((r) => r.selectedPrice.observationCount > 0).length;
    const volume = popRows.filter((r) => r.volumeUsd != null).length;
    return {
      populationId: pop,
      totalCorpusN: popRows.length,
      settledN: popRows.filter((r) =>
        ["WIN", "LOSS", "VOID"].includes(r.label),
      ).length,
      labelCounts,
      featureCoverage: {
        scoreNumericPct: popRows.length ? round2((100 * scored) / popRows.length) : 0,
        pricePathPct: popRows.length ? round2((100 * priced) / popRows.length) : 0,
        volumeUsdPct: popRows.length ? round2((100 * volume) / popRows.length) : 0,
      },
    };
  });

  const report = {
    mission: "COMPACT_RESEARCH_MATERIALIZER_V1",
    slice: {
      path: slicePath,
      sha256: sha256(readFileSync(slicePath, "utf8")),
      sliceDateUtc: corpus.sliceDateUtc,
      sinceCutoff: corpus.sinceCutoff,
      materializedAt: corpus.materializedAt,
      note:
        "D-1 slice is a deterministic fixture — no research-clone-scoped read " +
        "credential exists in this environment; production-primary reads are " +
        "forbidden (RESEARCH_CORPUS_CONTRACT.md §7). Live-clone swap is wiring-only.",
    },
    compressionFunnel: {
      INPUT_rawGspRows: corpus.funnel.inputRawGspRows,
      INPUT_uniqueSourceEvents: corpus.funnel.inputUniqueSourceEvents,
      INPUT_uniqueMarkets: corpus.funnel.inputUniqueMarkets,
      OUTPUT_compactFeatureRows: corpus.funnel.outputCompactFeatureRows,
      OUTPUT_uniqueCompactEvents: corpus.funnel.outputUniqueCompactEvents,
      C4_ELIGIBLE_uniqueEvents: Object.fromEntries(
        scorecards.map((s) => [s.populationId, s.uniqueEligibleEvents]),
      ),
      C4_SELECTED_bets: Object.fromEntries(
        scorecards.map((s) => [s.populationId, s.bets]),
      ),
      compressionRatio: corpus.funnel.compressionRatio,
      artifactBytes: { rawSliceJson: sliceBytes, compactCorpusJsonl: compactBytes },
      artifactSizeReductionPct: round2(100 * (1 - compactBytes / sliceBytes)),
    },
    populationRowCounts: corpus.populationRowCounts,
    c4Scorecards: scorecards.map((s) => ({
      model: "C4",
      population: s.populationId,
      period: s.period,
      uniqueEligibleEvents: s.uniqueEligibleEvents,
      bets: s.bets,
      pnlUnits: s.pnlUnits,
      roiPct: s.roiPct,
      maxDrawdownUnits: s.maxDrawdownUnits,
      pnlPer100Bets: s.pnlPer100Bets,
      stability: s.stability,
      engineModelVersion: s.engineModelVersion,
      engineDropAccounting: s.adapt.dropped,
    })),
    dataQuality: dq,
    pitGuarantee: assertNoLeakage(corpus.rows),
  };

  const reportJson = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(join(outDir, "COMPACT_MATERIALIZER_PROOF.json"), reportJson);
  writeFileSync(join(outDir, "COMPACT_MATERIALIZER_PROOF.md"), renderMd(report));
  writeFileSync(
    join(outDir, "SHA256.txt"),
    [
      `${sha256(compactJsonl)}  COMPACT_CORPUS.jsonl`,
      `${sha256(reportJson)}  COMPACT_MATERIALIZER_PROOF.json`,
    ].join("\n") + "\n",
  );

  process.stdout.write(reportJson);
}

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Hard PIT check: no eligible observation used post-dates its decision. */
function assertNoLeakage(
  rows: ReturnType<typeof buildCompactCorpus>["rows"],
): { ok: true; rowsChecked: number } {
  for (const r of rows) {
    for (const series of [r.score, r.selectedPrice]) {
      if (
        series.lastEligibleObservedAt !== null &&
        series.lastEligibleObservedAt > r.decisionAt
      ) {
        throw new Error(
          `PIT LEAKAGE: ${r.conditionId}::${r.selectedTokenId} used observation ` +
            `${series.lastEligibleObservedAt} > decisionAt ${r.decisionAt}`,
        );
      }
      if (series.lastEligibleObservedAt !== null && series.lastEligibleObservedAt > r.eligibleObservationWindowEnd) {
        throw new Error(`PIT WINDOW VIOLATION on ${r.conditionId}`);
      }
    }
  }
  return { ok: true, rowsChecked: rows.length };
}

function renderMd(report: Record<string, unknown>): string {
  const f = report.compressionFunnel as Record<string, unknown>;
  const cards = report.c4Scorecards as Array<Record<string, unknown>>;
  const lines: string[] = [];
  lines.push("# COMPACT_RESEARCH_MATERIALIZER_V1 — proof\n");
  lines.push("## Compression funnel (separate units)\n");
  lines.push("| stage | unit | value |");
  lines.push("|---|---|---|");
  lines.push(`| INPUT | raw GSP rows | ${f.INPUT_rawGspRows} |`);
  lines.push(`| INPUT | unique source events | ${f.INPUT_uniqueSourceEvents} |`);
  lines.push(`| INPUT | unique markets | ${f.INPUT_uniqueMarkets} |`);
  lines.push(`| OUTPUT | compact feature rows | ${f.OUTPUT_compactFeatureRows} |`);
  lines.push(`| OUTPUT | unique compact events | ${f.OUTPUT_uniqueCompactEvents} |`);
  lines.push(
    `| C4 ELIGIBLE | unique events | ${JSON.stringify(f.C4_ELIGIBLE_uniqueEvents)} |`,
  );
  lines.push(`| C4 SELECTED | bets | ${JSON.stringify(f.C4_SELECTED_bets)} |`);
  lines.push("");
  lines.push(`compression ratio (raw rows / compact rows): **${f.compressionRatio}x**`);
  lines.push(
    `artifact size: raw slice ${(f.artifactBytes as any).rawSliceJson} B -> compact ${(f.artifactBytes as any).compactCorpusJsonl} B (${f.artifactSizeReductionPct}% smaller)`,
  );
  lines.push("");
  lines.push("## Founder-facing C4 scorecard (per population — NEVER pooled)\n");
  lines.push(
    "| Model | Population | Period | Unique eligible events | Bets | PnL units | ROI % | MaxDD units | PnL / 100 bets |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of cards) {
    const p = c.period as { fromInclusive: string; toInclusive: string } | null;
    lines.push(
      `| ${c.model} | ${c.population} | ${p ? `${p.fromInclusive}..${p.toInclusive}` : "—"} | ${c.uniqueEligibleEvents} | ${c.bets} | ${c.pnlUnits} | ${c.roiPct} | ${c.maxDrawdownUnits} | ${c.pnlPer100Bets} |`,
    );
  }
  lines.push("");
  for (const c of cards) {
    const stab = c.stability as Array<Record<string, unknown>>;
    if (stab.length === 0) continue;
    lines.push(`### ${c.population} daily stability`);
    lines.push("| bucket | bets | PnL units | cumulative PnL |");
    lines.push("|---|---|---|---|");
    for (const s of stab) {
      lines.push(
        `| ${s.bucket} | ${s.bets} | ${s.pnlUnits} | ${s.cumulativePnlUnits} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `PIT guarantee: ${JSON.stringify(report.pitGuarantee)} — no observation after DECISION_AT entered any feature.`,
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

main();
