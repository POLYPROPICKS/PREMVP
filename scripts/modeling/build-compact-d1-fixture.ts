/**
 * COMPACT_RESEARCH_MATERIALIZER_V1 — deterministic D-1 raw-slice fixture builder.
 *
 * WHY A FIXTURE: this environment has no research-clone-scoped read credential
 * (only a production PostgREST credential exists, and RESEARCH_CORPUS_CONTRACT.md
 * §7 / NEW_CONTOUR_9 R07/R31 forbid modelling reads against the production
 * primary). This script emits ONE closed D-1 slice with the exact shape the
 * research clone produces — immutable `generated_signal_pairs` decision rows
 * (with repeated emissions) + `generated_signal_research_snapshots` observations
 * (with repeated snapshots, some deliberately AFTER the decision to prove the
 * point-in-time cut). Swapping this for a real clone read is a wiring-only
 * follow-up (RESEARCH_CLONE_RUNTIME_ACTIVATE_VERIFY_V1); the compact
 * materializer + C4 proof are identical either way.
 *
 * Deterministic: no wall-clock, no RNG. Same code -> byte-identical JSON.
 *
 *   npx tsx scripts/modeling/build-compact-d1-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ForwardRichSignalPair,
  ForwardRichSnapshotObservation,
  GammaTerminalState,
} from "@/lib/modeling/forward-rich/types";

const D1 = "2026-09-02";
const OUT = "modeling/local_exports/compact_research_materializer_v1/D1_SLICE_FIXTURE.json";

interface Spec {
  ev: string;
  cid: string;
  tok: string;
  formula: "public-rich-scorer-v2" | "shadow-strategic-sports-v1";
  sport: string;
  entry: number;
  /** first decision hour (UTC) on D1 */
  decHour: number;
  /** event start ISO */
  start: string;
  gamma: GammaTerminalState | null;
  /** later re-emission decision hours on D1 (same identity) */
  reEmitHours: number[];
  volumeUsd: number;
  /** base score for scored population; null keeps it unscored */
  score: number | null;
}

const SPECS: Spec[] = [
  { ev: "E1", cid: "c1", tok: "t1", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.55, decHour: 6, start: "2026-09-02T18:00:00.000Z", gamma: "WIN", reEmitHours: [8, 10], volumeUsd: 42000, score: 61 },
  { ev: "E1", cid: "c1b", tok: "t1b", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.52, decHour: 6, start: "2026-09-02T18:00:00.000Z", gamma: "LOSS", reEmitHours: [9], volumeUsd: 18000, score: 55 },
  { ev: "E2", cid: "c2", tok: "t2", formula: "public-rich-scorer-v2", sport: "basketball", entry: 0.57, decHour: 5, start: "2026-09-04T01:00:00.000Z", gamma: "WIN", reEmitHours: [7, 9, 11], volumeUsd: 91000, score: 64 },
  { ev: "E2", cid: "c2b", tok: "t2b", formula: "public-rich-scorer-v2", sport: "basketball", entry: 0.53, decHour: 5, start: "2026-09-04T01:00:00.000Z", gamma: "WIN", reEmitHours: [], volumeUsd: 12000, score: 58 },
  { ev: "E3", cid: "c3", tok: "t3", formula: "public-rich-scorer-v2", sport: "tennis", entry: 0.54, decHour: 4, start: "2026-09-02T12:00:00.000Z", gamma: "LOSS", reEmitHours: [], volumeUsd: 8000, score: 59 },
  { ev: "E4", cid: "c4", tok: "t4", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.58, decHour: 3, start: "2026-09-03T20:00:00.000Z", gamma: "WIN", reEmitHours: [6], volumeUsd: 33000, score: 62 },
  { ev: "E5", cid: "c5", tok: "t5", formula: "public-rich-scorer-v2", sport: "baseball", entry: 0.51, decHour: 2, start: "2026-09-05T00:00:00.000Z", gamma: "LOSS", reEmitHours: [5, 8], volumeUsd: 27000, score: 57 },
  { ev: "E6", cid: "c6", tok: "t6", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.505, decHour: 9, start: "2026-09-02T21:00:00.000Z", gamma: "WIN", reEmitHours: [], volumeUsd: 15000, score: 60 },
  { ev: "E7", cid: "c7", tok: "t7", formula: "public-rich-scorer-v2", sport: "hockey", entry: 0.65, decHour: 7, start: "2026-09-04T00:00:00.000Z", gamma: "LOSS", reEmitHours: [10], volumeUsd: 9000, score: 66 },
  { ev: "E8", cid: "c8", tok: "t8", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.59, decHour: 8, start: "2026-09-03T19:00:00.000Z", gamma: "VOID", reEmitHours: [], volumeUsd: 11000, score: 58 },
  { ev: "E9", cid: "c9", tok: "t9", formula: "public-rich-scorer-v2", sport: "basketball", entry: 0.56, decHour: 10, start: "2026-09-04T02:00:00.000Z", gamma: null, reEmitHours: [12], volumeUsd: 20000, score: 63 },
  { ev: "E10", cid: "c10", tok: "t10", formula: "public-rich-scorer-v2", sport: "soccer", entry: 0.545, decHour: 11, start: "2026-09-02T23:00:00.000Z", gamma: "WIN", reEmitHours: [13, 15], volumeUsd: 51000, score: 61 },
  { ev: "E11", cid: "c11", tok: "t11", formula: "shadow-strategic-sports-v1", sport: "soccer", entry: 0.55, decHour: 6, start: "2026-09-03T18:00:00.000Z", gamma: "WIN", reEmitHours: [9], volumeUsd: 4000, score: null },
  { ev: "E12", cid: "c12", tok: "t12", formula: "shadow-strategic-sports-v1", sport: "mma", entry: 0.52, decHour: 7, start: "2026-09-04T03:00:00.000Z", gamma: "LOSS", reEmitHours: [], volumeUsd: 3000, score: null },
];

function iso(hour: number, minute = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${D1}T${hh}:${mm}:00.000Z`;
}

const signalPairs: ForwardRichSignalPair[] = [];
const observations: ForwardRichSnapshotObservation[] = [];

for (const s of SPECS) {
  const decisionHours = [s.decHour, ...s.reEmitHours];
  for (const h of decisionHours) {
    signalPairs.push({
      conditionId: s.cid,
      selectedTokenId: s.tok,
      decisionAt: iso(h, 0),
      sourceCreatedAt: iso(h, 1),
      entryPriceNum: s.entry,
      volumeUsd: s.volumeUsd,
      eventStartIso: s.start,
      providerEventId: s.ev,
      marketTypeRaw: `${s.sport}_moneyline`,
      marketFamily: s.sport,
      providerSportCode: s.sport === "soccer" ? "epl" : s.sport,
      providerSportFamily: s.sport,
      formulaVersion: s.formula,
      gammaTerminal: s.gamma,
      cloneSignalResult: s.gamma === null ? null : s.gamma === "WIN" ? "win" : s.gamma === "LOSS" ? "loss" : "void",
    });
  }

  // GSRS observations: two eligible snapshots strictly before the first
  // decision, plus one deliberately AFTER it (must be dropped by the PIT cut).
  const firstDec = s.decHour;
  observations.push({
    conditionId: s.cid,
    selectedTokenId: s.tok,
    snapshotAt: iso(Math.max(0, firstDec - 2), 0),
    snapshotRunId: `run-${s.cid}-a`,
    scoreValue: s.score,
    scoreMetricFormulaVersion: s.score === null ? null : "score-metric-v3",
    selectedPriceNum: s.entry - 0.02,
    opposingPriceNum: 1 - (s.entry - 0.02),
    providerEventId: s.ev,
    gameStartIso: s.start,
    dataCoverageNum: 50,
  });
  observations.push({
    conditionId: s.cid,
    selectedTokenId: s.tok,
    snapshotAt: iso(Math.max(0, firstDec - 1), 15),
    snapshotRunId: `run-${s.cid}-b`,
    scoreValue: s.score === null ? null : s.score + 1,
    scoreMetricFormulaVersion: s.score === null ? null : "score-metric-v3",
    selectedPriceNum: s.entry - 0.01,
    opposingPriceNum: 1 - (s.entry - 0.01),
    providerEventId: s.ev,
    gameStartIso: s.start,
    dataCoverageNum: 75,
  });
  observations.push({
    conditionId: s.cid,
    selectedTokenId: s.tok,
    // AFTER the first decision — POST-DECISION LEAKAGE the PIT cut must drop.
    snapshotAt: iso(firstDec + 1, 30),
    snapshotRunId: `run-${s.cid}-post`,
    scoreValue: s.score === null ? null : s.score + 5,
    scoreMetricFormulaVersion: s.score === null ? null : "score-metric-v3",
    selectedPriceNum: s.entry + 0.05,
    opposingPriceNum: 1 - (s.entry + 0.05),
    providerEventId: s.ev,
    gameStartIso: s.start,
    dataCoverageNum: 90,
  });
}

const slice = {
  mission: "COMPACT_RESEARCH_MATERIALIZER_V1",
  note: "Deterministic D-1 research-clone slice fixture. See build-compact-d1-fixture.ts header.",
  sliceDateUtc: D1,
  sinceCutoff: `${D1}T00:00:00.000Z`,
  materializedAt: "2026-09-03T02:00:00.000Z",
  signalPairs,
  observations,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(slice, null, 2) + "\n");
process.stdout.write(
  `wrote ${OUT}: ${signalPairs.length} raw GSP rows, ${observations.length} GSRS observations\n`,
);
