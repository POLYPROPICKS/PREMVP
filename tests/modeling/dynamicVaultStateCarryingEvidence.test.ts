import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root=path.join(process.cwd(),"modeling","evidence","2026-07-16-dynamic-vault-state-carrying-validation");
const packet=JSON.parse(readFileSync(path.join(root,"founder_decision_packet.json"),"utf8"));
const manifest=JSON.parse(readFileSync(path.join(root,"manifest.json"),"utf8"));
const boundary=packet.blockBoundary;

test("continuous replay keeps Active at the boundary",()=>assert.notEqual(boundary.block24Start.active,50));
test("continuous replay keeps Vault at the boundary",()=>assert.notEqual(boundary.block24Start.vault,0));
test("peak Total persists",()=>assert.equal(boundary.block23End.totalHighWater,boundary.block24Start.totalHighWater));
test("peak profit persists",()=>assert.equal(boundary.block23End.peakProfit,boundary.block24Start.peakProfit));
test("principal recovery progress persists",()=>assert.equal(boundary.block23End.principalRecoveryProgress,boundary.block24Start.principalRecoveryProgress));
test("cycle transfer allowance persists",()=>assert.equal(boundary.block23End.remainingTransferAllowance,boundary.block24Start.remainingTransferAllowance));
test("cross-boundary open positions persist",()=>assert.deepEqual(boundary.block23End.openPositionIds,boundary.block24Start.openPositionIds));
test("block 23 end is the exact block 24 start",()=>assert.equal(boundary.block23EndHash,boundary.block24StartHash));
test("continuous replay reproduces Dynamic No Vault",()=>{const full=packet.comparators.dynamicNoVault.full;assert.equal(full.executed,230);assert.equal(full.skipped,1);assert.equal(full.pnl,169.32412195);assert.equal(full.maximumTotalFall,33.96564534);assert.equal(full.cvar95MaximumFall,43.85905932);});
test("continuous replay reproduces Fixed Safe",()=>{const full=packet.comparators.fixedSafe.full;assert.equal(full.pnl,51.89997402);assert.equal(full.maximumTotalFall,6.43150453);assert.equal(full.cvar95MaximumFall,9.92765355);assert.equal(full.endingVault,40.75998961);});
test("continuous replay reproduces the nominated PRV2 candidate",()=>{const full=packet.primaryCandidate.full;assert.equal(full.pnl,121.85057149);assert.equal(full.endingActive,119.50804292);assert.equal(full.endingVault,52.34252857);assert.equal(full.maximumTotalFall,19.99816041);assert.equal(full.cvar95MaximumFall,25.69447488);});
test("development selection uses no confirmation metric",()=>assert.equal(packet.methodology.selectionUsesConfirmation,false));
test("confirmation cannot replace the development winner",()=>assert.equal(packet.developmentWinner.id,"PRV2_T50_P25_R0.25_S0_C0.1"));
test("candidate registry remains exactly 24",()=>assert.equal(packet.candidateCount,24));
test("nominated candidate parameters remain frozen",()=>assert.deepEqual(packet.primaryCandidate.policy,{family:"DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2",id:"PRV2_T25_P50_R1_S0.05_C0.1",triggerProfitU:25,principalTargetU:50,principalRecoveryRate:1,postRecoverySkimRate:.05,transferCapPctOfActiveReference:.1}));
test("block-local reset is diagnostic only",()=>{assert.equal(packet.resetVersusStateCarry.reset.label,"BLOCK_LOCAL_RESET_DIAGNOSTIC");assert.equal(packet.resetVersusStateCarry.reset.selectionEligible,false);});
test("state hashes and input hashes are deterministic",()=>{assert.equal(manifest.datasetSha256,"b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45");assert.equal(manifest.inputExecutionIdsSha256,"99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");assert.equal(boundary.block23EndHash,boundary.block24StartHash);});
test("no candidate path has negative capital",()=>assert.ok(packet.developmentResults.every((row:{development:{capitalValid:boolean}})=>row.development.capitalValid)));
test("dashboard embeds evidence and does not recalculate policy logic",()=>{const html=readFileSync(path.join(root,"dashboard.html"),"utf8");assert.match(html,/machine-evidence/);assert.doesNotMatch(html,/principalRecoveryRate\s*\*/);});
