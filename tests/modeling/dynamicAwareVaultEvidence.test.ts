import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root=path.join(process.cwd(),"modeling","evidence","2026-07-16-final-dynamic-aware-vault");
test("dynamic-aware evidence locks seven arms and the exact no-Vault control",()=>{const evidence=JSON.parse(readFileSync(path.join(root,"seven_arm_results.json"),"utf8"));assert.equal(evidence.policies.length,7);assert.equal(evidence.inputExecutionIdsSha256,"99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");const control=evidence.fullHistory[0];assert.equal(control.intendedSignals,231);assert.equal(control.executed,230);assert.equal(control.pnl,169.32412195);assert.equal(control.maximumFallFromTotalPeak,33.96564534);assert.equal(control.risk.cvar95MaximumFall,43.85905932);assert.equal(evidence.selection.status,"NO_DYNAMIC_VAULT_PASSED_PREDECLARED_GATES");});
test("dashboard embeds machine evidence and contains no policy implementation",()=>{const html=readFileSync(path.join(root,"dashboard.html"),"utf8");assert.match(html,/machine-evidence/);assert.doesNotMatch(html,/profitLockRatio\s*\*/);});
