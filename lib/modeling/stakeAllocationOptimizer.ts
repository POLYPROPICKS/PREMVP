import type { StakeTier } from "./stakeCalibration";

export type StakePolicyId = "CONTROL_ACTIVE3_SHRINKING_V1" | "FIXED_CYCLE_MAX3_V1" | "ROBUST_LCB_TIERED_MAX3_V1";
export interface AllocationCandidate { observationId: string; decisionAtMs: number; resolvedAtMs: number; robustExpectedRoi: number; requestedTier: StakeTier; finalScore: number; dataCoverage: number; entryPrice: number; createdAtMs: number }
export interface AllocationResult extends AllocationCandidate { maxStakePerMatch: number; actualTier: StakeTier; actualStake: number; decision: "EXECUTED" | "NO_POSITIVE_ROBUST_EDGE" | "CAPACITY_REJECTED"; capacityReduced: boolean }

const tierDown = (tier: StakeTier): StakeTier => tier === 1 ? .7 : tier === .7 ? .5 : tier === .5 ? .3 : 0;
const order = (a: AllocationCandidate,b: AllocationCandidate) => b.robustExpectedRoi-a.robustExpectedRoi||b.finalScore-a.finalScore||b.dataCoverage-a.dataCoverage||a.entryPrice-b.entryPrice||a.createdAtMs-b.createdAtMs||a.observationId.localeCompare(b.observationId);
export function allocateStakeCapacity(candidates: readonly AllocationCandidate[], options: { cycleReferenceActiveBankroll: number; maxStakePct: number; maximumOpenExposurePct?: number; maximumPositions?: number; maximumAcceptedPerDay?: number }): AllocationResult[] {
  const maxStake = options.cycleReferenceActiveBankroll * options.maxStakePct, exposureCap = options.cycleReferenceActiveBankroll * (options.maximumOpenExposurePct ?? .8), positionCap = options.maximumPositions ?? 30, dayCap = options.maximumAcceptedPerDay ?? 100;
  const sorted = [...candidates].sort(order), accepted: AllocationResult[] = [], open: AllocationResult[] = [], output: AllocationResult[] = [];
  for (const c of sorted) {
    for (let i=open.length-1;i>=0;i--) if (open[i].resolvedAtMs <= c.decisionAtMs) open.splice(i,1);
    if (c.requestedTier === 0) { output.push({...c,maxStakePerMatch:maxStake,actualTier:0,actualStake:0,decision:"NO_POSITIVE_ROBUST_EDGE",capacityReduced:false}); continue; }
    let tier: StakeTier = c.requestedTier;
    const day = new Date(c.decisionAtMs).toISOString().slice(0,10), dayCount = accepted.filter(x=>new Date(x.decisionAtMs).toISOString().slice(0,10)===day).length;
    while (tier > 0 && open.reduce((s,x)=>s+x.actualStake,0) + tier*maxStake > exposureCap + 1e-9) tier = tierDown(tier);
    if (open.length >= positionCap || dayCount >= dayCap) tier = 0;
    const result: AllocationResult = {...c,maxStakePerMatch:maxStake,actualTier:tier,actualStake:tier*maxStake,decision:tier>0?"EXECUTED":"CAPACITY_REJECTED",capacityReduced:tier<c.requestedTier};
    output.push(result); if(tier>0){accepted.push(result);open.push(result)}
  }
  return output.sort((a,b)=>a.observationId.localeCompare(b.observationId));
}
export interface StakeComparatorSummary { policyId: StakePolicyId; uniqueMatchCandidates: number; executedMatches: number; zeroEdgeExclusions: number; capacityReductions: number; capacityRejections: number; tierCounts: Record<string,number>; minimumStake:number; medianStake:number; meanStake:number; maximumStake:number; totalStaked:number }
export function compareStakePolicies(candidates: readonly AllocationCandidate[], referenceActive = 50): StakeComparatorSummary[] {
  const ids: StakePolicyId[]=["CONTROL_ACTIVE3_SHRINKING_V1","FIXED_CYCLE_MAX3_V1","ROBUST_LCB_TIERED_MAX3_V1"];
  return ids.map(policyId=>{
    const rows=policyId==="ROBUST_LCB_TIERED_MAX3_V1"?candidates:candidates.map(x=>({...x,requestedTier:1 as StakeTier}));
    const allocated=allocateStakeCapacity(rows,{cycleReferenceActiveBankroll:referenceActive,maxStakePct:.03}); const stakes=allocated.filter(x=>x.actualStake>0).map(x=>x.actualStake).sort((a,b)=>a-b), total=stakes.reduce((a,b)=>a+b,0);
    return {policyId,uniqueMatchCandidates:candidates.length,executedMatches:stakes.length,zeroEdgeExclusions:allocated.filter(x=>x.decision==="NO_POSITIVE_ROBUST_EDGE").length,capacityReductions:allocated.filter(x=>x.capacityReduced&&x.actualStake>0).length,capacityRejections:allocated.filter(x=>x.decision==="CAPACITY_REJECTED").length,tierCounts:Object.fromEntries([0,.3,.5,.7,1].map(t=>[String(t),allocated.filter(x=>x.actualTier===t).length])),minimumStake:stakes[0]??0,medianStake:stakes.length?stakes[Math.floor((stakes.length-1)/2)]:0,meanStake:stakes.length?total/stakes.length:0,maximumStake:stakes.at(-1)??0,totalStaked:total};
  });
}
