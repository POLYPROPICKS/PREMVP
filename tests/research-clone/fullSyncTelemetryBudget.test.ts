// OCTOBER_D1_BUSINESS_RECOVERY_V1: only the 02 UTC full sync gets the larger bounded telemetry
// append budget; hourly telemetry-only runs keep 8 pages, and a still-pending table withholds the marker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SPECS, appendPageBudget, isFullSyncComplete } from "../../scripts/research-clone-daily-sync";
import { runAppendSync, type Watermark } from "../../lib/research-clone/dailySync";

const inplay = SPECS.find((s) => s.table === "research_inplay_core_path_observations")!;
const gsp = SPECS.find((s) => s.table === "generated_signal_pairs")!;

test("budget: hourly telemetry 8, full-sync telemetry 64, non-telemetry unchanged", () => {
  assert.equal(appendPageBudget(inplay, false), 8);
  assert.equal(appendPageBudget(inplay, true), 64);
  assert.equal(appendPageBudget(gsp, false), appendPageBudget(gsp, true));
});

test("only the full-sync SPECS loop passes fullSync=true", () => {
  const src = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
  assert.equal((src.match(/syncTable\([^)]*,\s*true\)/g) ?? []).length, 1);
  assert.match(src, /for \(const spec of SPECS\) \{\s*try \{\s*tables\[spec\.table\] = await syncTable\(target, source, spec, bootstrapSince, true\);/);
});

function burst(n: number, pages: number) {
  const base = Date.parse("2026-10-12T00:00:00.000Z");
  const rows = Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, observed_at: new Date(base + i * 1000).toISOString() }));
  let cp: Watermark | null = null;
  const key = (w: Watermark) => `${String(w.observed_at)}|${String(w.id)}`;
  return runAppendSync(["observed_at", "id"], pages, {
    sourceMaxWatermark: async () => rows.at(-1) as unknown as Watermark,
    targetMaxWatermark: async () => cp,
    readCheckpoint: async () => cp,
    fetchSourcePage: async (after) => rows.filter((r) => !after || key(r as unknown as Watermark) > key(after)).slice(0, 200) as never,
    upsertTargetRows: async (page) => ({ newRows: page.length, updatedRows: 0, duplicateN: 0 }),
    writeCheckpoint: async (w) => { cp = w; },
  }, null);
}

test("a 2,400-row in-play burst stays pending at 8 pages but drains at the full budget", async () => {
  assert.equal((await burst(2400, appendPageBudget(inplay, false))).pending, true);
  assert.equal((await burst(2400, appendPageBudget(inplay, true))).pending, false);
});

test("marker gate unchanged: any pending table withholds full-sync-complete", () => {
  assert.equal(isFullSyncComplete({ pendingTables: ["research_inplay_core_path_observations"], schemaPendingTables: [], researchEvidencePending: false }), false);
  assert.equal(isFullSyncComplete({ pendingTables: [], schemaPendingTables: [], researchEvidencePending: false }), true);
});
