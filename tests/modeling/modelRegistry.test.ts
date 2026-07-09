import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function readJson(relPath: string): unknown {
  const raw = readFileSync(path.join(ROOT, relPath), "utf8");
  return JSON.parse(raw);
}

const REQUIRED_DATASET_NAMES = [
  "generated_signal_pairs",
  "generated_signal_research_snapshots",
  "track_record_display_signals",
  "track_record_shown_signal_history",
  "track_record_window_results",
  "track_record_window_summary",
  "night_event_reservations",
  "event_execution_queue",
  "executor_order_events",
];

test("dataset_registry.json has canonicalModelAuditDataset === generated_signal_pairs", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    canonicalModelAuditDataset: string;
  };

  assert.equal(registry.canonicalModelAuditDataset, "generated_signal_pairs");
});

test("dataset_registry.json datasets include all 9 required dataset names", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    datasets: Array<{ name: string }>;
  };

  const names = registry.datasets.map((d) => d.name);

  for (const required of REQUIRED_DATASET_NAMES) {
    assert.ok(names.includes(required), `expected dataset ${required} in registry`);
  }
});

test("dataset_registry.json marks generated_signal_pairs suitability as FULL", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    datasets: Array<{ name: string; suitability: string }>;
  };

  const entry = registry.datasets.find((d) => d.name === "generated_signal_pairs");
  assert.ok(entry);
  assert.equal(entry?.suitability, "FULL");
});

test("dataset_registry.json does not mark track_record_window_results as FULL", () => {
  const registry = readJson("modeling/model_registry/dataset_registry.json") as {
    datasets: Array<{ name: string; suitability: string }>;
  };

  const entry = registry.datasets.find((d) => d.name === "track_record_window_results");
  assert.ok(entry);
  assert.notEqual(entry?.suitability, "FULL");
});

test("model_strategy_registry.json has an entries array", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<Record<string, unknown>>;
  };

  assert.ok(Array.isArray(registry.entries));
  assert.ok(registry.entries.length > 0);
});

test("model_strategy_registry.json includes BASELINE_V1_CONTROL", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{ rawName: string }>;
  };

  assert.ok(registry.entries.some((e) => e.rawName === "BASELINE_V1_CONTROL"));
});

test("model_strategy_registry.json includes ALT1_ONE_PER_EVENT_BEST_COVERAGE", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{ rawName: string }>;
  };

  assert.ok(
    registry.entries.some((e) => e.rawName === "ALT1_ONE_PER_EVENT_BEST_COVERAGE"),
  );
});

test("model_strategy_registry.json includes missing entry BLUE_MODEL2_SAFE_CORE_V1 with reproducibilityStatus MISSING_SCRIPT", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{ rawName: string; reproducibilityStatus: string }>;
  };

  const entry = registry.entries.find((e) => e.rawName === "BLUE_MODEL2_SAFE_CORE_V1");
  assert.ok(entry, "expected BLUE_MODEL2_SAFE_CORE_V1 entry");
  assert.equal(entry?.reproducibilityStatus, "MISSING_SCRIPT");
});

test("model_strategy_registry.json includes champion_current_v1 marked as a contract stub", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{
      rawName: string;
      normalizedName: string;
      reproducibilityStatus: string;
      notes: string[];
    }>;
  };

  const entry = registry.entries.find(
    (e) => e.rawName === "CHAMPION_CURRENT" || e.normalizedName === "champion_current_v1",
  );

  assert.ok(entry, "expected champion_current_v1 entry");

  const isContractStub =
    entry?.reproducibilityStatus === "CONTRACT_STUB" ||
    (entry?.notes ?? []).some((n) => /contract stub/i.test(n));

  assert.ok(isContractStub, "expected champion_current_v1 to be marked as a contract stub");
});

test("model_strategy_registry.json: no entry with an empty sourcePaths is marked HAS_SCRIPT", () => {
  const registry = readJson("modeling/model_registry/model_strategy_registry.json") as {
    entries: Array<{ rawName: string; reproducibilityStatus: string; sourcePaths: string[] }>;
  };

  for (const entry of registry.entries) {
    if (entry.reproducibilityStatus === "HAS_SCRIPT") {
      assert.ok(
        Array.isArray(entry.sourcePaths) && entry.sourcePaths.length > 0,
        `expected ${entry.rawName} marked HAS_SCRIPT to have at least one sourcePath`,
      );
    }
  }
});
