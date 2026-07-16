import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { stableHash } from "../../lib/modeling/scientificCapitalArchitecture";

const root = path.resolve("modeling/evidence/2026-07-16-final-scientific-architecture-freeze");
const readText = (name: string) => readFileSync(path.join(root, name), "utf8");
const readJson = (name: string) => JSON.parse(readText(name));
const sha = (name: string) => createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex");

test("freeze manifest, artifact hashes and registry hashes reconcile exactly", () => {
  const manifest = readJson("manifest.json");
  const freeze = readJson("freeze_registry.json");
  const artifactNames: Record<string, string> = {
    capital_policy_frontier: "capital_policy_frontier.json",
    final_model_stake_matrix: "final_model_stake_matrix.json",
    winner_execution_ledger: "winner_execution_ledger.json",
    winner_capital_curve: "winner_capital_curve.json",
    final_selection: "final_selection.json",
    founder_report_ru: "founder_report_ru.md",
    dashboard: "scientific_architecture_dashboard.html",
  };
  for (const [key, file] of Object.entries(artifactNames)) assert.equal(sha(file), manifest.artifactHashes[key], file);
  const { manifestSha256, ...manifestBase } = manifest;
  assert.equal(manifestSha256, stableHash(manifestBase));
  const { freezeRegistryHash, ...freezeBase } = freeze;
  assert.equal(freezeRegistryHash, stableHash(freezeBase));
  assert.equal(freeze.evidenceManifestHash, manifest.manifestSha256);
  assert.equal(freeze.executionLedgerHash, stableHash(readJson("winner_execution_ledger.json")));
  assert.equal(freeze.capitalCurveHash, stableHash(readJson("winner_capital_curve.json")));
  assert.deepEqual(freeze.status, ["HISTORICAL_ARCHITECTURE_FROZEN", "IRELAND_PARITY_PENDING", "FORWARD_VALIDATION_PENDING", "NOT_LIVE"]);
});

test("dashboard machine evidence exactly matches source JSON and never recomputes selection", () => {
  const html = readText("scientific_architecture_dashboard.html");
  const embedded = html.match(/<script type="application\/json" id="machine-evidence">(.*?)<\/script>/)?.[1];
  assert.ok(embedded);
  const evidence = JSON.parse(embedded);
  assert.deepEqual(evidence.capitalFrontier, readJson("capital_policy_frontier.json"));
  assert.deepEqual(evidence.finalMatrix, readJson("final_model_stake_matrix.json"));
  assert.deepEqual(evidence.winner, readJson("final_selection.json").SCIENTIFIC_FINAL_WINNER);
  assert.deepEqual(evidence.winnerCurve, readJson("winner_capital_curve.json"));
});

test("oracle outputs retain the validated package convention and p-value ordering", () => {
  for (const label of ["PRIMARY", "SENSITIVITY"]) {
    const block = readJson(`oracle_${label}_block_length_output.json`);
    const spa = readJson(`oracle_${label}_spa_output.json`);
    assert.equal(block.runtime.arch, "8.0.0");
    assert.equal(spa.runtime.arch, "8.0.0");
    assert.ok(block.results.b_sb > 0 && block.results.b_cb > 0);
    assert.ok(spa.results.pvalues.lower <= spa.results.pvalues.consistent);
    assert.ok(spa.results.pvalues.consistent <= spa.results.pvalues.upper);
    assert.equal(spa.parameters.bootstrap, "stationary");
    assert.equal(spa.parameters.reps, 20_000);
    assert.equal(spa.parameters.seed, 20260716);
    assert.equal(spa.parameters.studentize, true);
    assert.equal(spa.parameters.nested, false);
  }
});
