import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { stableHash } from "../../lib/modeling/scientificCapitalArchitecture";

const artifactPath = join(process.cwd(), "modeling/evidence/prospective-selection-shadow-v1/PROSPECTIVE_LEDGER.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

test("prospective SAFE cap30 ledger is exact-date, settlement-free, and deterministically hashed", () => {
  assert.deepEqual(Object.keys(artifact.ledgerHashes).sort(), ["2026-09-21", "2026-09-22"]);
  for (const date of ["2026-09-21", "2026-09-22"]) {
    const rows = artifact.ledger.filter((row: any) => row.date === date);
    assert.equal(rows.length, 150);
    assert.equal(stableHash(rows), artifact.ledgerHashes[date]);
    assert(rows.every((row: any) => row.settlementState === "UNQUERIED"));
    assert(rows.every((row: any) => !("signal_result" in row) && !("outcome" in row)));
    for (const model of ["P50_52_SAFE", "PORTFOLIO_BROAD_SAFE", "QUALITY_FILL_A_SAFE", "QUALITY_FILL_D_SAFE", "TENNIS_P50_52_SAFE"]) {
      const modelRows = rows.filter((row: any) => row.model === model);
      assert.equal(modelRows.length, 30);
      assert.equal(new Set(modelRows.map((row: any) => row.physicalEventKey)).size, modelRows.length);
    }
  }
});

test("V4 selection read projection excludes settlement and outcome columns", () => {
  const runner = readFileSync(join(process.cwd(), "scripts/modeling/prospective-selection-shadow.ts"), "utf8");
  const projection = runner.match(/const columns = "([^"]+)"/)?.[1];
  assert.ok(projection, "the clone read must use one explicit column projection");
  const columns = projection.split(",");
  assert.equal(columns.includes("signal_result"), false);
  assert.equal(columns.some((column) => /settlement|outcome|label/i.test(column)), false);
});

test("forward capital shadow carries locked principal without realized PnL or vault credit", () => {
  for (const family of [artifact.fixedShadow, artifact.protectedShadow]) {
    assert.equal(family.length, 10);
    for (const row of family) {
      assert.equal(row.total_usd, 100);
      assert.equal(row.active_usd, row.free_active_usd + row.open_principal_usd);
      assert.equal(row.total_usd, row.active_usd + row.vault_usd);
      assert.equal(row.vault_usd, 0);
      assert.equal(row.selected_n, 30);
    }
  }
  assert.equal(artifact.freshness.selectionFreshThrough, "2026-09-22");
  assert.equal(artifact.freshness.settlementFreshThrough, "2026-09-20");
  assert.equal(artifact.freshness.pnlFreshThrough, "2026-09-20");
});

test("CAPITAL tab loads and labels the forward shadow section", () => {
  const html = readFileSync(join(process.cwd(), "modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html"), "utf8");
  const script = readFileSync(join(process.cwd(), "modeling/evidence/modeling-dashboard-v1/FORWARD_SHADOW_DATA.js"), "utf8");
  assert.match(html, /FORWARD SHADOW — EXACT PROSPECTIVE SELECTION/);
  assert.match(html, /Settlement UNQUERIED|SETTLEMENT UNQUERIED/);
  assert.match(html, /FORWARD_SHADOW_DATA\.js/);
  assert.match(script, /window\.POLYPROPICKS_FORWARD_SHADOW_DATA/);
});
