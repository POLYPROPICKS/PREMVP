import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const authorityPath = "modeling/evidence/modeling-dashboard-v1/CURRENT_MODELING_AUTHORITY.js";

test("CURRENT_MODELING_AUTHORITY_V1 is aggregate-only, complete, cap30-default compatible, and worst-case positive", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(authorityPath, "utf8"), sandbox, { filename: authorityPath });
  const a = sandbox.window.POLYPROPICKS_CURRENT_MODELING_AUTHORITY;
  assert.equal(a.authorityId, "CURRENT_MODELING_AUTHORITY_V1");
  assert.equal(a.rows.length, 15);
  assert.deepEqual([...new Set(a.rows.map((r) => r.CAP))], [30, 40, 50]);
  assert.equal(a.rows.filter((r) => r.CAP === 30).length, 5);
  for (const row of a.rows) {
    assert.equal(row.STATUS, "PARTIAL_SETTLEMENT");
    assert.ok(row.FINAL_PNL_WORST > 0, `${row.MODEL} cap${row.CAP}`);
  }
  const p50 = a.rows.find((r) => r.MODEL === "P50_52_SAFE" && r.CAP === 30);
  assert.deepEqual({ n: p50.SELECTED_N, settled: p50.SETTLED_N, open: p50.OPEN_N, pnl: p50.PNL_U_PARTIAL }, { n: 1015, settled: 937, open: 78, pnl: 150.31 });
});
