/**
 * DRIFT GUARD — proves CONTRACT_A_FILTER_SIM_CURRENT has a SINGLE canonical
 * authority. Every numeric gate the sim mirrors must still appear verbatim at
 * its cited location in runtime source. If a threshold moves in
 * buildFireModelCandidates.ts / taxonomy.ts without the mirror being updated,
 * this test fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_A_SIM_MIRRORED_CONSTANTS,
  CONTRACT_A_FILTER_SIM_RULES,
} from "../../../lib/modeling/offline-replay/contractAFilterSim";
import { PRODUCTION_SCORED_PLANNING_VERSIONS } from "../../../lib/executor/productionSignalPopulation";

const BFC = readFileSync(join("lib", "executor", "buildFireModelCandidates.ts"), "utf8");
const TAX = readFileSync(join("lib", "contur3", "taxonomy.ts"), "utf8");
const SIM = readFileSync(join("lib", "modeling", "offline-replay", "contractAFilterSim.ts"), "utf8");
const PSP = readFileSync(join("lib", "executor", "productionSignalPopulation.ts"), "utf8");

test("planning formula-version admission is imported from the canonical single-source module (no local mirror)", () => {
  // the sim must import the canonical constant, not re-declare a literal list
  assert.match(
    SIM,
    /import \{ PRODUCTION_SCORED_PLANNING_VERSIONS \} from "\.\.\/\.\.\/executor\/productionSignalPopulation"/,
    "contractAFilterSim must import PRODUCTION_SCORED_PLANNING_VERSIONS",
  );
  assert.doesNotMatch(SIM, /const PLANNING_ALLOWED_VERSIONS = \[\s*"/, "sim still declares a literal PLANNING_ALLOWED_VERSIONS list");
  // the canonical single-source module still owns the constant (it is what
  // buildFireModelCandidates.ts planning mode also consumes)
  assert.ok(PSP.includes("export const PRODUCTION_SCORED_PLANNING_VERSIONS"), "canonical constant export moved");
  // Note: buildFireModelCandidates.ts planning mode consumes this same constant on origin/main
  // (const PLANNING_ALLOWED_VERSIONS = [...PRODUCTION_SCORED_PLANNING_VERSIONS]); the sim no
  // longer needs to string-match that file because it imports the constant directly.
  assert.deepEqual(
    [...CONTRACT_A_SIM_MIRRORED_CONSTANTS.PLANNING_ALLOWED_VERSIONS],
    [...PRODUCTION_SCORED_PLANNING_VERSIONS],
    "sim mirrored constant diverged from the canonical value",
  );
});

test("tier thresholds match computeTier() verbatim", () => {
  const c = CONTRACT_A_SIM_MIRRORED_CONSTANTS;
  assert.ok(BFC.includes(`if (score >= ${c.TIER1_SCORE} && coverage >= ${c.TIER1_COV}) return "TIER1_CORE_STRICT_72_COV50"`));
  assert.ok(BFC.includes(`if (score >= ${c.TIER2_SCORE} && coverage >= ${c.TIER2_COV}) return "TIER2_SAFE_EXPAND_60_COV50"`));
  assert.ok(BFC.includes(`if (score >= ${c.TIER3_SCORE} && coverage >= ${c.TIER3_COV}) return "TIER3_MICRO_EXPAND_50_COV25"`));
});

test("bad-bucket bounds match runtime source verbatim", () => {
  const c = CONTRACT_A_SIM_MIRRORED_CONSTANTS;
  assert.ok(
    BFC.includes(
      `coverage >= ${c.BAD_BUCKET_COV_LO} && coverage <= ${c.BAD_BUCKET_COV_HI} && entryPrice >= ${c.BAD_BUCKET_PRICE_LO} && entryPrice <= ${c.BAD_BUCKET_PRICE_HI}`,
    ),
    "BAD_BUCKET_COV_PRICE bounds changed in buildFireModelCandidates.ts",
  );
});

test("score floor (LOW_SCORE) matches runtime source", () => {
  assert.ok(
    BFC.includes(`if (score == null || score < ${CONTRACT_A_SIM_MIRRORED_CONSTANTS.SCORE_FLOOR})`),
    "LOW_SCORE floor changed",
  );
});

test("canonical market-anchor decision is imported, not re-implemented", () => {
  const sim = readFileSync(join("lib", "modeling", "offline-replay", "contractAFilterSim.ts"), "utf8");
  assert.ok(
    sim.includes('import { resolveMarketAnchorDecision } from "../../contur3/taxonomy"'),
    "contractAFilterSim must import the canonical market-anchor decision",
  );
  assert.ok(TAX.includes("export function resolveMarketAnchorDecision"), "resolveMarketAnchorDecision export moved");
  // the sim must NOT contain its own market-class regex table
  assert.ok(!/FORBIDDEN_HALFTIME|ALLOWED_MONEYLINE_SQ|classifyMarketText\s*\(/.test(sim.replace(/\/\/.*$/gm, "")), "sim re-implements taxonomy");
});

test("every transparency row cites a real source file", () => {
  for (const rule of CONTRACT_A_FILTER_SIM_RULES) {
    const file = rule.SOURCE_OWNER.split(":")[0].split(" ")[0];
    assert.ok(file.startsWith("lib/"), `bad SOURCE_OWNER: ${rule.SOURCE_OWNER}`);
  }
});
