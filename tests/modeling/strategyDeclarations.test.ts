import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function readJson(relPath: string): unknown {
  const raw = readFileSync(path.join(ROOT, relPath), "utf8");
  return JSON.parse(raw);
}

const DECLARATION_PATHS = {
  baseline: "scripts/modeling/strategies/declarations/baseline_v1_control.json",
  primary: "scripts/modeling/strategies/declarations/primary_v1_avoid_nba_nhl_cov_cap.json",
  alt1: "scripts/modeling/strategies/declarations/alt1_one_per_event_best_coverage.json",
  scoreGe72: "scripts/modeling/strategies/declarations/score_ge_72_family.json",
};

const REQUIRED_FIELDS = [
  "strategyId",
  "version",
  "status",
  "sourceType",
  "datasetSource",
  "selectionUnit",
  "oneMatchModeSupported",
  "canonicalDedupKey",
  "stakeMode",
  "dateMode",
  "filters",
  "evidence",
  "readWriteSafety",
  "knownRisks",
  "promotionBlockedReasons",
];

const NOT_READY_SOURCE_TYPES = ["CONTRACT_STUB", "MISSING", "DOC_ONLY"];

test("strategy_declarations schema file exists", () => {
  assert.ok(
    existsSync(path.join(ROOT, "scripts/modeling/strategies/strategy_declarations.schema.json")),
  );
});

test("all four declaration files exist", () => {
  for (const relPath of Object.values(DECLARATION_PATHS)) {
    assert.ok(existsSync(path.join(ROOT, relPath)), `expected ${relPath} to exist`);
  }
});

test("every declaration has all required fields", () => {
  for (const relPath of Object.values(DECLARATION_PATHS)) {
    const declaration = readJson(relPath) as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(declaration, field),
        `expected ${relPath} to have field ${field}`,
      );
    }
  }
});

test("no READY_TO_NORMALIZE declaration has a non-executable sourceType", () => {
  for (const relPath of Object.values(DECLARATION_PATHS)) {
    const declaration = readJson(relPath) as { status: string; sourceType: string };
    if (declaration.status === "READY_TO_NORMALIZE") {
      assert.ok(
        !NOT_READY_SOURCE_TYPES.includes(declaration.sourceType),
        `${relPath} is READY_TO_NORMALIZE but sourceType is ${declaration.sourceType}`,
      );
    }
  }
});

test("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP declares score/league/selection/dedup facts", () => {
  const declaration = readJson(DECLARATION_PATHS.primary) as {
    strategyId: string;
    selectionUnit: string;
    canonicalDedupKey: string;
    filters: {
      scoreThreshold?: number;
      avoidLeagues?: string[];
    };
  };

  assert.equal(declaration.strategyId, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.equal(declaration.filters.scoreThreshold, 72);
  assert.ok(declaration.filters.avoidLeagues?.includes("NBA"));
  assert.ok(declaration.filters.avoidLeagues?.includes("NHL"));
  assert.equal(declaration.selectionUnit, "one per event");
  assert.equal(declaration.canonicalDedupKey, "event_group_key");
});

test("ALT1_ONE_PER_EVENT_BEST_COVERAGE knownRisks mentions Python/TS dedup mismatch", () => {
  const declaration = readJson(DECLARATION_PATHS.alt1) as {
    strategyId: string;
    knownRisks: string[];
  };

  assert.equal(declaration.strategyId, "ALT1_ONE_PER_EVENT_BEST_COVERAGE");
  const mentionsMismatch = declaration.knownRisks.some(
    (risk) => /python/i.test(risk) && /ts|typescript/i.test(risk) && /dedup|key/i.test(risk),
  );
  assert.ok(mentionsMismatch, "expected a knownRisks entry describing the Python/TS dedup key mismatch");
});

test("SCORE_GE_72_FAMILY variants include all 3 required variants", () => {
  const declaration = readJson(DECLARATION_PATHS.scoreGe72) as {
    strategyId: string;
    variants: string[];
  };

  assert.equal(declaration.strategyId, "SCORE_GE_72_FAMILY");
  assert.ok(declaration.variants.includes("SCORE_GE_72_AVOID_6_24H"));
  assert.ok(declaration.variants.includes("SCORE_GE_72_AVOID_3_12H_LEGACY"));
  assert.ok(declaration.variants.includes("COVERAGE_GE_75_SCORE_GE_72"));
});

test("registry JSON points READY declarations to actual declarationPath files", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{
      rawName: string;
      lineVerified?: boolean;
      declarationPath?: string;
    }>;
  };

  const readyRawNames = [
    "BASELINE_V1_CONTROL",
    "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    "ALT1_ONE_PER_EVENT_BEST_COVERAGE",
  ];

  for (const rawName of readyRawNames) {
    const entry = registry.entries.find((e) => e.rawName === rawName);
    assert.ok(entry, `expected registry entry for ${rawName}`);
    assert.equal(entry?.lineVerified, true);
    assert.ok(entry?.declarationPath, `expected declarationPath for ${rawName}`);
    assert.ok(
      existsSync(path.join(ROOT, entry!.declarationPath!)),
      `declarationPath for ${rawName} must point to an existing file`,
    );
  }
});

test("ALT2/ALT3/ALT_SM registry entries are not marked READY_TO_NORMALIZE", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{ rawName: string; reproducibilityStatus?: string; status?: string }>;
  };

  const blockedRawNames = [
    "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH",
    "ALT3_V1_AVOID_NBA_NHL",
    "ALT_SM_GUARD_ON_PRIMARY",
  ];

  for (const rawName of blockedRawNames) {
    const entry = registry.entries.find((e) => e.rawName === rawName);
    assert.ok(entry, `expected registry entry for ${rawName}`);
    assert.notEqual(entry?.reproducibilityStatus, "READY_TO_NORMALIZE");
    assert.notEqual(entry?.status, "READY_TO_NORMALIZE");
  }
});
