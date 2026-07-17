// @ts-expect-error Vitest is supplied by the required one-off npx audit command, not the locked package manifest.
import { describe, expect, it } from "vitest";
import {
  buildDualChronology,
  canonicalHash,
  runFixedOneUnitSuffixControl,
  validateJoinedRows,
} from "../../lib/modeling/suspiciousGrowthTemporalAudit";

describe("suspicious growth temporal audit", () => {
  const rows = [
    { executionIndex: 0, observationId: "a", decisionAtIso: "2026-06-08T21:00:00.000Z", resolvedAtIso: "2026-06-10T00:00:00.000Z", entryPrice: .5, result: "win", fixedStake: 1, fixedRealizedPnl: 1 },
    { executionIndex: 1, observationId: "b", decisionAtIso: "2026-06-08T21:30:00.000Z", resolvedAtIso: "2026-06-10T00:00:00.000Z", entryPrice: .5, result: "loss", fixedStake: 1, fixedRealizedPnl: -1 },
  ] as any;

  it("detects duplicates and counts missing attribution", () => {
    const result = validateJoinedRows([...rows, { ...rows[0] }], 3);
    expect(result.duplicateObservationIds).toEqual(["a"]);
    expect(result.missingAttribution.sport).toBe(3);
  });

  it("uses distinct chronologies, stable same-time execution order, and zero days", () => {
    const result = buildDualChronology(rows, "2026-06-09", "2026-06-11");
    expect(result.settlement.map((x) => x.date)).toEqual(["2026-06-09", "2026-06-10", "2026-06-11"]);
    expect(result.settlement[1].executionIndexes).toEqual([0, 1]);
    expect(result.decision[0].count).toBe(2);
  });

  it("applies Europe/Minsk suffix boundary and fixed 1u only", () => {
    const result = runFixedOneUnitSuffixControl(rows, "2026-06-09");
    expect(result.count).toBe(2);
    expect(result.totalStake).toBe(2);
    expect(result.grossPnl).toBe(0);
    expect((result as any).vault).toBeUndefined();
  });

  it("canonical hashes are deterministic", () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
  });
});
