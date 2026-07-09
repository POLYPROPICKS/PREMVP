import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function readJson(relPath: string): unknown {
  const raw = readFileSync(path.join(ROOT, relPath), "utf8");
  return JSON.parse(raw);
}

test("dataset_registry.json is valid and has required fields per dataset", () => {
  const registry = readJson(
    "modeling/model_registry/dataset_registry.json",
  ) as {
    version: string;
    canonicalModelAuditDataset: string;
    datasets: Array<Record<string, unknown>>;
    rules: string[];
  };

  assert.equal(typeof registry.version, "string");
  assert.equal(registry.canonicalModelAuditDataset, "generated_signal_pairs");
  assert.ok(Array.isArray(registry.datasets));
  assert.ok(registry.datasets.length >= 9);
  assert.ok(Array.isArray(registry.rules));
  assert.ok(registry.rules.length > 0);

  for (const dataset of registry.datasets) {
    assert.equal(typeof dataset.name, "string");
    assert.equal(typeof dataset.role, "string");
    assert.equal(typeof dataset.suitability, "string");
    assert.ok(Array.isArray(dataset.dateFields));
    assert.ok(Array.isArray(dataset.resultFields));
    assert.ok(Array.isArray(dataset.returnPriceFields));
    assert.ok(Array.isArray(dataset.modelFormulaFields));
    assert.ok(Array.isArray(dataset.evidencePaths));
    assert.ok(Array.isArray(dataset.notes));
  }
});

test("dataset_registry.json includes generated_signal_pairs as FULL suitability", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    datasets: Array<{ name: string; suitability: string }>;
  };

  const canonical = registry.datasets.find(
    (d) => d.name === "generated_signal_pairs",
  );

  assert.ok(canonical);
  assert.equal(canonical?.suitability, "FULL");
});

test("dataset_registry.json marks execution-contour tables as EXECUTION_ONLY", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    datasets: Array<{ name: string; suitability: string }>;
  };

  const executionOnlyNames = [
    "night_event_reservations",
    "event_execution_queue",
    "executor_order_events",
  ];

  for (const name of executionOnlyNames) {
    const dataset = registry.datasets.find((d) => d.name === name);
    assert.ok(dataset, `expected dataset entry for ${name}`);
    assert.equal(dataset?.suitability, "EXECUTION_ONLY");
  }
});

test("model_strategy_registry.json is valid and has required top-level sections", () => {
  const registry = readJson(
    "modeling/model_registry/model_strategy_registry.json",
  ) as {
    version: string;
    categories: string[];
    contextContours: Array<Record<string, unknown>>;
    formulaModels: Array<Record<string, unknown>>;
    dqaAudits: Array<Record<string, unknown>>;
    strategyPolicies: Array<Record<string, unknown>>;
    missingStrategyNames: Array<Record<string, unknown>>;
  };

  assert.equal(typeof registry.version, "string");
  assert.ok(Array.isArray(registry.categories));
  assert.ok(registry.categories.includes("STRATEGY_POLICY"));
  assert.ok(registry.categories.includes("DQA_AUDIT"));
  assert.ok(registry.categories.includes("UNKNOWN"));
  assert.ok(Array.isArray(registry.contextContours));
  assert.ok(Array.isArray(registry.formulaModels));
  assert.ok(Array.isArray(registry.dqaAudits));
  assert.equal(registry.dqaAudits.length, 3);
  assert.ok(Array.isArray(registry.strategyPolicies));
  assert.ok(Array.isArray(registry.missingStrategyNames));
});

test("model_strategy_registry.json marks sql_registry/models contract stubs as HAS_SQL, not implemented", () => {
  const registry = readJson(
    "modeling/model_registry/model_strategy_registry.json",
  ) as {
    strategyPolicies: Array<{
      canonicalStrategyId: string;
      reproducibility: string;
      evidencePaths: string[];
    }>;
  };

  const contractStubIds = [
    "CHAMPION_CURRENT",
    "PUBLISHED_ONE_PER_FIXTURE",
    "FIRE_FAMILY_SELECTIVE",
    "SAFETY_BASELINE",
    "TIERED_LIVE_CONTOUR",
  ];

  for (const id of contractStubIds) {
    const entry = registry.strategyPolicies.find(
      (s) => s.canonicalStrategyId === id,
    );
    assert.ok(entry, `expected strategy policy entry for ${id}`);
    assert.equal(entry?.reproducibility, "HAS_SQL");
  }
});

test("model_strategy_registry.json lists all requested-but-missing strategy names as MISSING_SCRIPT", () => {
  const registry = readJson(
    "modeling/model_registry/model_strategy_registry.json",
  ) as {
    missingStrategyNames: Array<{
      canonicalStrategyId: string;
      reproducibility: string;
    }>;
  };

  const expectedMissing = [
    "ALT3_V1_AVOID_NBA_NHL_RAW_PROFIT",
    "ALT_AGGR_COVTIER_6_12",
    "ALT_SM75_GATE_FLAT",
    "ALT_COV75_FIRST_SM_IGNORED",
    "SCORE_GE_50",
    "SCORE_60_71",
    "BLUE_MODEL2_SAFE_CORE_V1",
  ];

  const foundIds = registry.missingStrategyNames.map((s) => s.canonicalStrategyId);

  for (const id of expectedMissing) {
    assert.ok(foundIds.includes(id), `expected ${id} in missingStrategyNames`);
  }

  for (const entry of registry.missingStrategyNames) {
    assert.equal(entry.reproducibility, "MISSING_SCRIPT");
  }
});
