import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
const root=path.join(process.cwd(),"modeling","evidence","2026-07-16-dynamic-vault-pnl-max-v2");
test("V2 evidence preserves hashes, candidate budget, and honest no-candidate result",()=>{const registry=JSON.parse(readFileSync(path.join(root,"candidate_registry.json"),"utf8")),winner=JSON.parse(readFileSync(path.join(root,"winner_decision.json"),"utf8")),manifest=JSON.parse(readFileSync(path.join(root,"manifest.json"),"utf8"));assert.equal(registry.stageA.length,24);assert.ok(registry.stageB.length<=8);assert.ok(registry.stageA.length+registry.stageB.length<=32);assert.equal(winner.status,"NO_V2_CANDIDATE_MET_MINIMUM_PROTECTED_GROWTH_CONTRACT");assert.equal(winner.winner,null);assert.equal(manifest.datasetSha256,"b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45");assert.equal(manifest.inputExecutionIdsSha256,"99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");});
test("V2 dashboard consumes evidence without policy calculations",()=>{const html=readFileSync(path.join(root,"dashboard.html"),"utf8");assert.match(html,/machine-evidence/);assert.doesNotMatch(html,/principalRecoveryRate\s*\*/);});
