import { createHash } from "node:crypto";

export type ApprovedBankrollProfileId = "FIXED_SAFE_V1" | "DYNAMIC_PROTECTED_GROWTH_V1";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const COMMON_CONTRACT = {
  signalModelId: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
  signalCount: 231,
  inputExecutionIdsSha256: "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca",
  datasetSha256: "b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45",
  capacity: { operationContract: "24X7", maxConcurrentPositions: 36, maxActiveExposurePct: 1, maxAcceptedPerOperatingDay: 100, initialBankU: 50, unitUsd: 100 },
  preservedExecutionContracts: ["T_MINUS_90", "STRONG_MATCH_IDENTITY", "DETERMINISTIC_SIGNAL_ORDER", "ENTRY_AND_SETTLEMENT", "MINSK_CYCLE"],
} as const;

const PROFILES = [
  {
    id: "FIXED_SAFE_V1",
    label: "Fixed Safe",
    signalContractId: COMMON_CONTRACT.signalModelId,
    stake: { id: "FIXED_1U", amountU: 1, referenceBehavior: "CONSTANT_1U" },
    vault: { family: "ONE_WAY_RATCHETED_CPPI", policyId: "CPPI_0.4_0.5", alpha: .4, multiplier: .5, direction: "ACTIVE_TO_VAULT_ONLY", stakeReferenceBehavior: "FIXED_1U_PER_ACCEPTED_SIGNAL", transferBehavior: "RATCHET_TO_ALPHA_TIMES_SETTLED_TOTAL_HIGH_WATER", riskBudgetBehavior: "ACTIVE_CAPACITY_AFTER_ONE_WAY_VAULT_RATCHET", skipBehavior: "FAIL_CLOSED_ON_ACTIVE_EXPOSURE_OR_CAPACITY", failureBehavior: "NO_VAULT_TO_ACTIVE_REFILL" },
    historicalEvidence: { classification: "HISTORICAL_EVIDENCE_NOT_A_RUNTIME_OR_FORWARD_GUARANTEE", metrics: { pnlU: 51.89997402, maximumFallU: 6.43150453, cvar95MaximumFallU: 9.92765355, endingVaultU: 40.75998961 } },
  },
  {
    id: "DYNAMIC_PROTECTED_GROWTH_V1",
    label: "Dynamic Protected Growth",
    signalContractId: COMMON_CONTRACT.signalModelId,
    stake: { id: "DYNAMIC_ACTIVE_3PCT", activeReferencePct: .03, referenceBehavior: "MINSK_CYCLE_ACTIVE_REFERENCE_MAX3" },
    vault: { family: "DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2", policyId: "PRV2_T25_P50_R1_S0.05_C0.1", direction: "ACTIVE_TO_VAULT_ONLY", stakeReferenceBehavior: "CARRIED_MINSK_CYCLE_ACTIVE_REFERENCE", transferBehavior: "PRINCIPAL_RECOVERY_THEN_POST_RECOVERY_SKIM", riskBudgetBehavior: "CYCLE_TRANSFER_CAP_PCT_OF_ACTIVE_REFERENCE", skipBehavior: "FAIL_CLOSED_ON_ACTIVE_EXPOSURE_OR_CAPACITY", failureBehavior: "NO_VAULT_TO_ACTIVE_REFILL", parameters: { triggerProfitU: 25, principalTargetU: 50, principalRecoveryRate: 1, postRecoverySkimRate: .05, transferCapPctOfActiveReference: .1 } },
    historicalEvidence: { classification: "HISTORICAL_EVIDENCE_NOT_A_RUNTIME_OR_FORWARD_GUARANTEE", stateCarryHash: "a1c56aa72d068f9118ff4774b6b758c15837178ea47a11fe4254e72d43f2eb33", metrics: { developmentPnlU: 86.37246171, confirmationIncrementalPnlU: 35.47810978, fullContinuousPnlU: 121.85057149, endingActiveU: 119.50804292, endingVaultU: 52.34252857, endingTotalU: 171.85057149, maximumFallU: 19.99816041, cvar95MaximumFallU: 25.69447488, additionalSkipsVsDynamicNoVault: 0 } },
  },
] as const;

const EVIDENCE_LINEAGE = [
  { role: "FIXED_SAFE_MODELING", path: "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault", manifestSha256: "585b4a0cf9ca0f4bf2d67431c188295e934efca38dfba706e5912a69dc4a9c14" },
  { role: "DYNAMIC_V2_CANDIDATE_SEARCH", path: "modeling/evidence/2026-07-16-dynamic-vault-pnl-max-v2", manifestSha256: "7bf1df9d7b908af1c766df1ad6f5b2dab9a0444e765ea115f1268c8f49fbc8a9" },
  { role: "DYNAMIC_STATE_CARRYING_VALIDATION", path: "modeling/evidence/2026-07-16-dynamic-vault-state-carrying-validation", commit: "eb7b5182168be35da4044d175de61edd0e07f32e", manifestSha256: "b9015202b84c539dcde689bc7b3a109ef472c373e8304d22ffe413f95ace9a76" },
  { role: "GATE_1_BASELINE_EXCEPTION", path: "modeling/evidence/2026-07-16-dynamic-vault-state-carrying-validation/VERIFICATION.md", commit: "eb7b5182168be35da4044d175de61edd0e07f32e", artifactSha256: "85ffcf1bb8c16d961749055cd3e09deeb623b0e6e31124f4a9924047efee847d" },
] as const;

const REGISTRY_PAYLOAD = {
  freezeMetadata: { freezeVersion: 1, freezeDate: "2026-07-16", founderDecision: "APPROVED", evidenceGeneration: "SERIALIZATION_ONLY_NO_MODELING_REPLAY" },
  profileCount: 2,
  productionDefaultProfile: null,
  commonContract: COMMON_CONTRACT,
  profiles: PROFILES,
  evidenceLineage: EVIDENCE_LINEAGE,
} as const;

export function hashBankrollRegistry(registry: any) {
  const payload = { freezeMetadata: registry.freezeMetadata, profileCount: registry.profileCount, productionDefaultProfile: registry.productionDefaultProfile, commonContract: registry.commonContract, profiles: registry.profiles, evidenceLineage: registry.evidenceLineage };
  return {
    registrySha256: sha256(canonical(payload)),
    profileSha256: Object.fromEntries(registry.profiles.map((profile: any) => [profile.id, sha256(canonical(profile))])),
    commonSignalContractSha256: sha256(canonical(registry.commonContract)),
    evidenceLineageSha256: sha256(canonical(registry.evidenceLineage)),
  };
}

export const BANKROLL_PROFILE_REGISTRY = deepFreeze({ ...REGISTRY_PAYLOAD, hashes: hashBankrollRegistry(REGISTRY_PAYLOAD) });
export type BankrollProfileRegistry = typeof BANKROLL_PROFILE_REGISTRY;
export type ApprovedBankrollProfile = BankrollProfileRegistry["profiles"][number];

export function canonicalBankrollRegistryJson(registry: unknown): string { return canonical(registry); }

function fail(rule: string, context = ""): never { throw new Error(`BANKROLL_PROFILE_REGISTRY_INVALID rule=${rule} freezeVersion=1 ${context}`.trim()); }

export function validateBankrollProfileRegistry(input: unknown): BankrollProfileRegistry {
  if (!input || typeof input !== "object") fail("MALFORMED_REGISTRY");
  const registry = input as any;
  if (!Array.isArray(registry.profiles)) fail("MALFORMED_REGISTRY");
  if (registry.profileCount !== 2 || registry.profiles.length !== 2 || new Set(registry.profiles.map((profile: any) => profile?.id)).size !== 2) fail("PROFILE_COUNT_OR_DUPLICATE");
  if (registry.productionDefaultProfile !== null) fail("PRODUCTION_DEFAULT_FORBIDDEN");
  for (let index = 0; index < PROFILES.length; index++) if (canonical(registry.profiles[index]) !== canonical(PROFILES[index])) fail("PROFILE_CONTRACT_MISMATCH", `profileId=${registry.profiles[index]?.id ?? "missing"}`);
  if (canonical(registry.commonContract) !== canonical(COMMON_CONTRACT) || canonical(registry.evidenceLineage) !== canonical(EVIDENCE_LINEAGE) || canonical(registry.freezeMetadata) !== canonical(REGISTRY_PAYLOAD.freezeMetadata)) fail("FROZEN_CONTENT_MISMATCH");
  const actual = hashBankrollRegistry(registry);
  if (canonical(actual) !== canonical(registry.hashes)) fail("REGISTRY_HASH_MISMATCH", `expected=${actual.registrySha256.slice(0, 12)} actual=${String(registry.hashes?.registrySha256).slice(0, 12)}`);
  return deepFreeze(registry) as BankrollProfileRegistry;
}

export function resolveBankrollProfile(profileId: "FIXED_SAFE_V1"): BankrollProfileRegistry["profiles"][0];
export function resolveBankrollProfile(profileId: "DYNAMIC_PROTECTED_GROWTH_V1"): BankrollProfileRegistry["profiles"][1];
export function resolveBankrollProfile(profileId: string | undefined): ApprovedBankrollProfile;
export function resolveBankrollProfile(profileId: string | undefined): ApprovedBankrollProfile {
  if (!profileId) throw new Error("PROFILE_ID_REQUIRED");
  const registry = validateBankrollProfileRegistry(BANKROLL_PROFILE_REGISTRY);
  const profile = registry.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`PROFILE_ID_NOT_APPROVED profileId=${profileId}`);
  return profile;
}
