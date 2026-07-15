export interface PnlObservation { observationId:string; resolvedAtMs:number; win:boolean; score:number; price:number; coverage:number; marketFamily:string|null }
export interface PnlDecision { observationId:string; decisionAtMs:number; score:number; price:number; coverage:number; marketFamily:string|null }
export type PnlBucketLevel = "SCORE_PRICE_COVERAGE_FAMILY"|"SCORE_PRICE_COVERAGE"|"SCORE_PRICE"|"PRICE"|"GLOBAL_PRIOR";
export interface PnlEdgeEstimate { bucketLevel:PnlBucketLevel; sampleSize:number; wins:number; posteriorAlpha:number; posteriorBeta:number; posteriorWinProbability:number; posteriorStdDev:number; posteriorMeanExpectedPnl:number; posteriorEvidenceStrength:number }
const band=(x:number,w:number)=>Math.floor(x/w);
export function estimatePastOnlyPnlEdge(d:PnlDecision, observations:readonly PnlObservation[], minimumBucket=20):PnlEdgeEstimate{
  const past=observations.filter(x=>x.resolvedAtMs<d.decisionAtMs).sort((a,b)=>a.resolvedAtMs-b.resolvedAtMs||a.observationId.localeCompare(b.observationId));
  const globalWins=past.filter(x=>x.win).length;
  const priorStrength=Math.min(20,Math.max(2,past.length));
  const globalMean=past.length?(globalWins+1)/(past.length+2):.5;
  const priorAlpha=globalMean*priorStrength,priorBeta=(1-globalMean)*priorStrength;
  const levels:Array<[PnlBucketLevel,(x:PnlObservation)=>boolean]>=[
    ["SCORE_PRICE_COVERAGE_FAMILY",x=>band(x.score,5)===band(d.score,5)&&band(x.price,.1)===band(d.price,.1)&&band(x.coverage,25)===band(d.coverage,25)&&x.marketFamily===d.marketFamily],
    ["SCORE_PRICE_COVERAGE",x=>band(x.score,5)===band(d.score,5)&&band(x.price,.1)===band(d.price,.1)&&band(x.coverage,25)===band(d.coverage,25)],
    ["SCORE_PRICE",x=>band(x.score,5)===band(d.score,5)&&band(x.price,.1)===band(d.price,.1)],
    ["PRICE",x=>band(x.price,.1)===band(d.price,.1)], ["GLOBAL_PRIOR",()=>true],
  ];
  let selected:PnlObservation[]=[],bucketLevel:PnlBucketLevel="GLOBAL_PRIOR";
  for(const [level,predicate] of levels){const found=past.filter(predicate);if(found.length>=minimumBucket||level==="GLOBAL_PRIOR"){selected=found;bucketLevel=level;break}}
  const wins=selected.filter(x=>x.win).length,alpha=priorAlpha+wins,beta=priorBeta+selected.length-wins,total=alpha+beta;
  const q=alpha/total,std=Math.sqrt(alpha*beta/(total*total*(total+1)));
  return{bucketLevel,sampleSize:selected.length,wins,posteriorAlpha:alpha,posteriorBeta:beta,posteriorWinProbability:q,posteriorStdDev:std,posteriorMeanExpectedPnl:d.price>0?q/d.price-1:-1,posteriorEvidenceStrength:total};
}
