import assert from "node:assert/strict";
import test from "node:test";
import {
  BANKROLL_PROFILE_REGISTRY,
  canonicalBankrollRegistryJson,
  hashBankrollRegistry,
  resolveBankrollProfile,
  validateBankrollProfileRegistry,
} from "../../lib/modeling/bankrollProfileRegistry";
import { buildBankrollProfileFreezeArtifacts } from "../../scripts/modeling/strategies/freeze-bankroll-profile-registry";

const clone = () => JSON.parse(JSON.stringify(BANKROLL_PROFILE_REGISTRY));

test("freeze contains exactly the two approved profiles and no production default", () => {
  assert.equal(BANKROLL_PROFILE_REGISTRY.profileCount, 2);
  assert.deepEqual(BANKROLL_PROFILE_REGISTRY.profiles.map((profile) => profile.id), ["FIXED_SAFE_V1", "DYNAMIC_PROTECTED_GROWTH_V1"]);
  assert.equal(BANKROLL_PROFILE_REGISTRY.productionDefaultProfile, null);
});

test("both profiles share the exact locked signal, dataset, capacity, and ID contracts", () => {
  const common = BANKROLL_PROFILE_REGISTRY.commonContract;
  assert.equal(common.signalModelId, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
  assert.equal(common.signalCount, 231);
  assert.equal(common.datasetSha256, "b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45");
  assert.equal(common.inputExecutionIdsSha256, "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");
  assert.deepEqual(common.capacity, { operationContract: "24X7", maxConcurrentPositions: 36, maxActiveExposurePct: 1, maxAcceptedPerOperatingDay: 100, initialBankU: 50, unitUsd: 100 });
});

test("Fixed Safe resolves to exact committed Fixed stake and CPPI Vault", () => {
  const profile = resolveBankrollProfile("FIXED_SAFE_V1");
  assert.equal(profile.stake.id, "FIXED_1U");
  assert.deepEqual(profile.vault, { family: "ONE_WAY_RATCHETED_CPPI", policyId: "CPPI_0.4_0.5", alpha: .4, multiplier: .5, direction: "ACTIVE_TO_VAULT_ONLY", stakeReferenceBehavior: "FIXED_1U_PER_ACCEPTED_SIGNAL", transferBehavior: "RATCHET_TO_ALPHA_TIMES_SETTLED_TOTAL_HIGH_WATER", riskBudgetBehavior: "ACTIVE_CAPACITY_AFTER_ONE_WAY_VAULT_RATCHET", skipBehavior: "FAIL_CLOSED_ON_ACTIVE_EXPOSURE_OR_CAPACITY", failureBehavior: "NO_VAULT_TO_ACTIVE_REFILL" });
  assert.deepEqual(profile.historicalEvidence.metrics, { pnlU: 51.89997402, maximumFallU: 6.43150453, cvar95MaximumFallU: 9.92765355, endingVaultU: 40.75998961 });
});

test("Dynamic Protected resolves to exact committed stake, Vault parameters, state hash, and evidence", () => {
  const profile = resolveBankrollProfile("DYNAMIC_PROTECTED_GROWTH_V1");
  assert.equal(profile.stake.id, "DYNAMIC_ACTIVE_3PCT");
  assert.equal(profile.vault.policyId, "PRV2_T25_P50_R1_S0.05_C0.1");
  assert.deepEqual(profile.vault.parameters, { triggerProfitU: 25, principalTargetU: 50, principalRecoveryRate: 1, postRecoverySkimRate: .05, transferCapPctOfActiveReference: .1 });
  assert.equal(profile.historicalEvidence.stateCarryHash, "a1c56aa72d068f9118ff4774b6b758c15837178ea47a11fe4254e72d43f2eb33");
  assert.deepEqual(profile.historicalEvidence.metrics, { developmentPnlU: 86.37246171, confirmationIncrementalPnlU: 35.47810978, fullContinuousPnlU: 121.85057149, endingActiveU: 119.50804292, endingVaultU: 52.34252857, endingTotalU: 171.85057149, maximumFallU: 19.99816041, cvar95MaximumFallU: 25.69447488, additionalSkipsVsDynamicNoVault: 0 });
});

test("missing and unknown profile IDs fail closed", () => {
  assert.throws(() => resolveBankrollProfile(undefined), /PROFILE_ID_REQUIRED/);
  assert.throws(() => resolveBankrollProfile("UNKNOWN"), /PROFILE_ID_NOT_APPROVED/);
});

test("unsupported stake and Vault pairings fail closed", () => {
  for (const mutate of [
    (r: any) => { r.profiles[1].vault = { family: "NO_VAULT", policyId: "NO_VAULT" }; },
    (r: any) => { r.profiles[1].vault = r.profiles[0].vault; },
    (r: any) => { r.profiles[0].vault = r.profiles[1].vault; },
    (r: any) => { r.profiles[0].stake.id = "UNKNOWN_STAKE"; },
    (r: any) => { r.profiles[0].vault.policyId = "UNKNOWN_VAULT"; },
  ]) { const registry = clone(); mutate(registry); assert.throws(() => validateBankrollProfileRegistry(registry), /PROFILE_CONTRACT_MISMATCH/); }
});

test("duplicate, third, missing-field, mutated parameter, and mutated evidence content fail closed", () => {
  const mutations = [
    (r: any) => r.profiles.push(r.profiles[0]),
    (r: any) => r.profiles.push({ ...r.profiles[0], id: "THIRD" }),
    (r: any) => delete r.profiles[0].stake,
    (r: any) => { r.profiles[1].vault.parameters.triggerProfitU = 26; },
    (r: any) => { r.commonContract.datasetSha256 = "0".repeat(64); },
  ];
  for (const mutate of mutations) { const registry = clone(); mutate(registry); assert.throws(() => validateBankrollProfileRegistry(registry)); }
});

test("declared hashes are checked and canonical serialization is insertion-order independent", () => {
  const validated = validateBankrollProfileRegistry(clone());
  assert.equal(validated.hashes.registrySha256, hashBankrollRegistry(validated).registrySha256);
  const reordered = JSON.parse(canonicalBankrollRegistryJson(validated));
  assert.equal(canonicalBankrollRegistryJson(reordered), canonicalBankrollRegistryJson(validated));
  const mutated = clone(); mutated.hashes.registrySha256 = "0".repeat(64);
  assert.throws(() => validateBankrollProfileRegistry(mutated), /REGISTRY_HASH_MISMATCH/);
});

test("resolved data is immutable and historical metrics are explicitly non-guaranteed", () => {
  const profile = resolveBankrollProfile("FIXED_SAFE_V1");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(profile.historicalEvidence.classification, "HISTORICAL_EVIDENCE_NOT_A_RUNTIME_OR_FORWARD_GUARANTEE");
  assert.throws(() => ((profile as any).label = "mutated"));
});

test("registry lineage uses only relative paths and freeze generation stores evidence without recalculation", () => {
  assert.equal(BANKROLL_PROFILE_REGISTRY.evidenceLineage.every((item) => !/^[A-Za-z]:[\\/]/.test(item.path)), true);
  assert.equal(BANKROLL_PROFILE_REGISTRY.freezeMetadata.evidenceGeneration, "SERIALIZATION_ONLY_NO_MODELING_REPLAY");
  assert.equal(JSON.stringify(BANKROLL_PROFILE_REGISTRY).includes(process.cwd()), false);
});

test("evidence generation is deterministic serialization and does not auto-run a CLI", () => {
  const one = buildBankrollProfileFreezeArtifacts();
  const two = buildBankrollProfileFreezeArtifacts();
  assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one).sort(), ["VERIFICATION.md", "bankroll_profiles_v1.json", "founder_report_ru.md", "hash_inventory.json", "manifest.json", "source_evidence_lineage.md"]);
  assert.match(one["VERIFICATION.md"], /serialization only; no modeling replay/i);
});
