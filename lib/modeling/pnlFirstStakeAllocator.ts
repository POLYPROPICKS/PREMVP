import type { FounderRiskConfig } from "./founderRiskConfig";
import { DEFAULT_FOUNDER_RISK_CONFIG } from "./founderRiskConfig";
import type { StakeTier } from "./stakeCalibration";

export const TERMINAL_EXECUTION_RESULTS=["EXECUTED_FULL","EXECUTED_70","EXECUTED_50","EXECUTED_30","NO_POSITIVE_ESTIMATED_EDGE","OPEN_EXPOSURE_LIMIT","POSITION_LIMIT","DAILY_LIMIT","INSUFFICIENT_ACTIVE_CAPACITY","INVALID_SETTLEMENT","OTHER_EXACT_REASON"] as const;
export type TerminalExecutionResult=typeof TERMINAL_EXECUTION_RESULTS[number];
export interface PnlAllocationCandidate {observationId:string;decisionAtMs:number;resolvedAtMs:number;expectedPnlPerDollar:number;posteriorEvidenceStrength:number;requestedTier:StakeTier;finalScore:number;dataCoverage:number;entryPrice:number;createdAtMs:number;settlementValid:boolean}
export interface PnlAllocationResult extends PnlAllocationCandidate {founderMaximumStake:number;actualTier:StakeTier;actualStake:number;estimatedIncrementalPnl:number;terminalResult:TerminalExecutionResult}
const round=(value:number)=>Math.round(value*1e8)/1e8;
const lower=(t:StakeTier):StakeTier=>t===1?.7:t===.7?.5:t===.5?.3:0;
const rank=(a:PnlAllocationCandidate,b:PnlAllocationCandidate)=>b.expectedPnlPerDollar*b.requestedTier-a.expectedPnlPerDollar*a.requestedTier||b.expectedPnlPerDollar-a.expectedPnlPerDollar||b.posteriorEvidenceStrength-a.posteriorEvidenceStrength||b.finalScore-a.finalScore||b.dataCoverage-a.dataCoverage||a.entryPrice-b.entryPrice||a.createdAtMs-b.createdAtMs||a.observationId.localeCompare(b.observationId);
export function allocatePnlFirstBatches(candidates:readonly PnlAllocationCandidate[],cycleReferenceActiveBankroll:number,config:FounderRiskConfig=DEFAULT_FOUNDER_RISK_CONFIG):PnlAllocationResult[]{
  const maximum=cycleReferenceActiveBankroll*config.maxStakePctOfCycleActive,accepted:PnlAllocationResult[]=[],out:PnlAllocationResult[]=[];
  const ordered=[...candidates].sort((a,b)=>a.decisionAtMs-b.decisionAtMs||rank(a,b));
  for(let offset=0;offset<ordered.length;){const at=ordered[offset].decisionAtMs;const batch:PnlAllocationCandidate[]=[];while(offset<ordered.length&&ordered[offset].decisionAtMs===at)batch.push(ordered[offset++]);
    const open=accepted.filter(x=>x.resolvedAtMs>at),day=new Date(at).toISOString().slice(0,10),usedDay=accepted.filter(x=>new Date(x.decisionAtMs).toISOString().slice(0,10)===day).length;let acceptedToday=usedDay;
    for(const c of batch.sort(rank)){let tier=c.requestedTier,reason:TerminalExecutionResult;
      if(!c.settlementValid){tier=0;reason="INVALID_SETTLEMENT"}else if(!(c.expectedPnlPerDollar>0)||tier===0){tier=0;reason="NO_POSITIVE_ESTIMATED_EDGE"}else if(open.length>=config.maxOpenPositions){tier=0;reason="POSITION_LIMIT"}else if(acceptedToday>=config.maxAcceptedPerUtcDay){tier=0;reason="DAILY_LIMIT"}else{const exposure=open.reduce((s,x)=>s+x.actualStake,0);while(tier>0&&exposure+tier*maximum>config.maxOpenExposurePct*cycleReferenceActiveBankroll+1e-9)tier=lower(tier);reason=tier===0?"OPEN_EXPOSURE_LIMIT":tier===1?"EXECUTED_FULL":tier===.7?"EXECUTED_70":tier===.5?"EXECUTED_50":"EXECUTED_30"}
      const actualStake=round(tier*maximum);const result:PnlAllocationResult={...c,founderMaximumStake:round(maximum),actualTier:tier,actualStake,estimatedIncrementalPnl:round(actualStake*c.expectedPnlPerDollar),terminalResult:reason!};out.push(result);if(tier>0){accepted.push(result);open.push(result);acceptedToday++}
    }
  }return out.sort((a,b)=>a.observationId.localeCompare(b.observationId));
}
