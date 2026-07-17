// @ts-expect-error Vitest is supplied by the required one-off npx command.
import { describe, expect, it } from "vitest";
import { applyExecutionCostScenario, filterLockedExecutionSequence, runFixedOneUnitControl } from "../../lib/modeling/postJuneCanonicalFreeze";

describe("post-June canonical freeze",()=>{
  const rows=[{executionIndex:0,observationId:"a",decisionAtIso:"2026-06-08T20:59:00.000Z",entryPrice:.5,result:"win"},{executionIndex:1,observationId:"b",decisionAtIso:"2026-06-08T21:00:00.000Z",entryPrice:.5,result:"loss"}] as any;
  it("uses Minsk cutoff and preserves relative execution order",()=>expect(filterLockedExecutionSequence(rows,"2026-06-09").map((x:any)=>x.observationId)).toEqual(["b"]));
  it("runs every selected decision as flat 1u and applies exact costs",()=>{const c=runFixedOneUnitControl(rows.slice(1));expect(c.totalStake).toBe(1);expect(c.grossPnl).toBe(-1);expect(applyExecutionCostScenario(c,200).netPnl).toBe(-1.02);});
});
