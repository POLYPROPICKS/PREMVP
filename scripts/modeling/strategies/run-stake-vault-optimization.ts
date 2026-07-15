#!/usr/bin/env -S node --import tsx
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildExecutionWaterfall, compactExecutionWaterfall, type WaterfallModelPolicyId } from "../../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../../lib/modeling/executableFunnelClassifier";
import { replayOptimizedStakePolicy, runThreeComparators } from "../../../lib/modeling/stakeVaultOptimization";
import { optimizeVaultPolicies } from "../../../lib/modeling/vaultPolicyOptimizer";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const write=(root:string,name:string,value:unknown)=>writeFileSync(path.join(root,name),`${JSON.stringify(value,null,2)}\n`);
export function runStakeVaultOptimization(input:string,outputRoot:string):Record<string,unknown>{
  const raw=readFileSync(input,"utf8"),rows=JSON.parse(raw) as ExportRow[],classifier=loadExecutableFunnelClassifier();mkdirSync(outputRoot,{recursive:true});
  const primary=buildExecutionWaterfall(rows,classifier),comparators=runThreeComparators(rows,classifier,primary),robust=comparators.find(x=>x.policyId==="ROBUST_LCB_TIERED_MAX3_V1")!;
  const daily=Object.entries(robust.dailyPnl).sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),vaultGrid=optimizeVaultPolicies(daily,2000,20260715),selectedVault=vaultGrid[0];
  const models:WaterfallModelPolicyId[]=["B2_PRICE_FLOOR_030_TIMING_WITHIN_120M","B2_TIMING_WITHIN_120M","B2_PRICE_FLOOR_030"];
  const shadows=models.map(model=>{const wf=model===models[0]?primary:buildExecutionWaterfall(rows,classifier,model);const replay=replayOptimizedStakePolicy(wf.executionCandidates,"ROBUST_LCB_TIERED_MAX3_V1",model);return{...replay,maximumTotalCapitalDrawdownPctOfPeak:replay.maximumTotalCapitalDrawdown/Math.max(100,replay.endingTotalCapital)*100,baseRows:wf.baseModelRows,t90Rows:wf.t90QualifiedRows,uniqueMatches:wf.derivedSportingMatchGroups,selectedStakePolicy:robust.policyId,selectedVaultPolicy:selectedVault.policy.id};});
  const selected={stakePolicy:robust,vaultPolicy:selectedVault,model:"B2_PRICE_FLOOR_030_TIMING_WITHIN_120M"};
  write(outputRoot,"execution_waterfall.json",compactExecutionWaterfall(primary));write(outputRoot,"stake_comparators.json",comparators);write(outputRoot,"vault_policy_grid.json",vaultGrid);write(outputRoot,"selected_policy_replay.json",selected);write(outputRoot,"shadow_model_comparison.json",shadows);
  const manifest={inputSha256:sha(raw),classifierSha256:sha(readFileSync("modeling/model_registry/executable_funnel_classifier.json","utf8")),selectedStakePolicy:robust.policyId,selectedVaultPolicy:selectedVault.policy.id,maxStakePct:.03,bootstrapSamples:2000,bootstrapSeed:20260715,artifacts:["execution_waterfall.json","stake_comparators.json","vault_policy_grid.json","selected_policy_replay.json","shadow_model_comparison.json"]};write(outputRoot,"selected_policy_manifest.json",manifest);return{manifest,comparators,vaultGrid,selected,shadows,waterfall:compactExecutionWaterfall(primary)};
}
if(require.main===module){const input=process.argv[2],out=process.argv[3];if(!input||!out)throw new Error("usage: run-stake-vault-optimization <input.json> <output-root>");runStakeVaultOptimization(input,out);}
