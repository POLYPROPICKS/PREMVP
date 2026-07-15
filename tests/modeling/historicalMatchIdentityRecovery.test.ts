import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoricalMatchIdentityRecovery } from "../../lib/modeling/historicalMatchIdentityRecovery";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const row = (id: string, title: string, slug: string, start = "2026-07-15T18:00:00Z"): ExportRow => ({
  id, event_title: title, event_slug: slug, market_slug: `${slug}-${id}`,
  diagnostics: { gameStartIso: start },
});

test("exact event slug rescues only a unique pair/start identity", () => {
  const result = buildHistoricalMatchIdentityRecovery([
    row("pair", "Alpha vs Beta", "alpha-beta"),
    row("market", "Total corners", "alpha-beta"),
  ]);
  assert.equal(result.audit.safelyRecoveredRows, 1);
  assert.equal(result.audit.collisionCount, 0);
  assert.equal(result.index.byObservationId.get("pair")?.key, result.index.byObservationId.get("market")?.key);
});

test("slug rescue fails closed when the same slug/start maps to different pairs", () => {
  const result = buildHistoricalMatchIdentityRecovery([
    row("a", "Alpha vs Beta", "shared"), row("b", "Gamma vs Delta", "shared"), row("x", "Totals", "shared"),
  ]);
  assert.equal(result.index.byObservationId.get("x")?.key, null);
  assert.equal(result.audit.safelyRecoveredRows, 0);
});

test("recovery is deterministic under input permutation", () => {
  const rows = [row("pair", "Alpha vs Beta", "alpha-beta"), row("market", "Total", "alpha-beta")];
  const a = buildHistoricalMatchIdentityRecovery(rows);
  const b = buildHistoricalMatchIdentityRecovery([...rows].reverse());
  assert.equal(a.audit.contentHash, b.audit.contentHash);
});
