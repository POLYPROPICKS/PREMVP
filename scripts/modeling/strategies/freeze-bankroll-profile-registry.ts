#!/usr/bin/env -S node --import tsx
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BANKROLL_PROFILE_REGISTRY, validateBankrollProfileRegistry } from "../../../lib/modeling/bankrollProfileRegistry";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function buildBankrollProfileFreezeArtifacts(): Record<string, string> {
  const registry = validateBankrollProfileRegistry(JSON.parse(JSON.stringify(BANKROLL_PROFILE_REGISTRY)));
  const registryJson = json(registry);
  const hashes = registry.hashes;
  const lineage = `# Source and evidence lineage\n\n${registry.evidenceLineage.map((item) => `- **${item.role}**: \`${item.path}\`; ${"manifestSha256" in item ? `manifest \`${item.manifestSha256}\`` : `artifact \`${item.artifactSha256}\``}${"commit" in item ? `; commit \`${item.commit}\`` : ""}.`).join("\n")}\n`;
  const verification = `# Atomic Bankroll Profiles Freeze V1 verification\n\n- Founder decision: APPROVED\n- Profile count: 2\n- Production default: NOT SELECTED\n- Fixed profile: FIXED_SAFE_V1 / FIXED_1U / CPPI_0.4_0.5\n- Dynamic profile: DYNAMIC_PROTECTED_GROWTH_V1 / DYNAMIC_ACTIVE_3PCT / PRV2_T25_P50_R1_S0.05_C0.1\n- Dataset SHA-256: ${registry.commonContract.datasetSha256}\n- 231-ID SHA-256: ${registry.commonContract.inputExecutionIdsSha256}\n- State-carry hash: ${registry.profiles[1].historicalEvidence.stateCarryHash}\n- Historical evidence only; not a runtime, forward, or live guarantee.\n- Evidence generation: serialization only; no modeling replay.\n`;
  const report = `# Атомарная фиксация профилей банка V1\n\nЗафиксированы ровно два профиля: **Fixed Safe** (фиксированная ставка 1u и только его CPPI Vault \`CPPI_0.4_0.5\`) и **Dynamic Protected Growth** (3% от Active и только его Principal Recovery Vault \`PRV2_T25_P50_R1_S0.05_C0.1\`). Ставка и Vault образуют неделимый профиль: Dynamic без Vault, Dynamic с Fixed CPPI, Fixed с Dynamic Vault и любые неизвестные сочетания запрещены.\n\nProduction default не выбран: интеграция обязана передать явный approved profile ID. Хэши реестра, каждого профиля, общего signal-контракта и evidence lineage защищают параметры от скрытого изменения. Исторические метрики подтверждают зафиксированные варианты, но не гарантируют будущий или live результат.\n\nСледующий шаг может только подключить PREMVP к этому реестру. Интеграции запрещено менять signal model, stake, Vault, capacity, параметры или evidence lineage. Ireland остаётся заблокирован до отдельного integration Gate 1 и inspect-only parity.\n`;
  const inventory = json({ registrySha256: hashes.registrySha256, fixedProfileSha256: hashes.profileSha256.FIXED_SAFE_V1, dynamicProfileSha256: hashes.profileSha256.DYNAMIC_PROTECTED_GROWTH_V1, commonSignalContractSha256: hashes.commonSignalContractSha256, evidenceLineageSha256: hashes.evidenceLineageSha256 });
  const base = { "bankroll_profiles_v1.json": registryJson, "VERIFICATION.md": verification, "founder_report_ru.md": report, "hash_inventory.json": inventory, "source_evidence_lineage.md": lineage };
  const artifactHashes = Object.fromEntries(Object.entries(base).map(([name, content]) => [name, sha256(content)]));
  const manifestPayload = { freezeVersion: 1, profileCount: 2, productionDefaultProfile: null, registrySha256: hashes.registrySha256, artifactHashes };
  return { ...base, "manifest.json": json({ ...manifestPayload, manifestSha256: sha256(json(manifestPayload)) }) };
}

export function writeBankrollProfileFreezeArtifacts(outputRoot: string): Record<string, string> {
  if (!outputRoot) throw new Error("OUTPUT_ROOT_REQUIRED");
  const artifacts = buildBankrollProfileFreezeArtifacts();
  mkdirSync(outputRoot, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) writeFileSync(path.join(outputRoot, name), content);
  return artifacts;
}

if (require.main === module) {
  const outputRoot = process.argv[2];
  if (!outputRoot) throw new Error("usage: freeze-bankroll-profile-registry <output-root>");
  writeBankrollProfileFreezeArtifacts(outputRoot);
}
