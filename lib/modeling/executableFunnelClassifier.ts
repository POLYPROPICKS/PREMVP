// Pure loader + validator for the executable funnel classifier registry
// (Phase 3E.3A-1).
//
// The classifier consolidates the completed 3E.3A-0 / 0B / 0D forensic work
// into one machine-readable artifact: formula-model arithmetic, per-bundle
// ordered funnels (INPUT/CALCULATE/REQUIRE/EXCLUDE/GROUP/ORDER/KEEP/STAKE/
// OUTPUT), alias resolution, source provenance, lineage confidence, and the
// separate historical vs normalized-current evaluation pipelines.
//
// This module is math/validation only. It does NOT read env/DB/network, does
// NOT compute ROI, does NOT modify any underlying algorithm, and does NOT
// resolve source conflicts -- blocked bundles stay blocked. It reads one JSON
// file (the registry) from disk in loadExecutableFunnelClassifier(); the
// validator itself is a pure function over an in-memory object.

import { readFileSync } from "node:fs";
import path from "node:path";

export const APPROVED_FUNNEL_ACTIONS = [
  "INPUT",
  "CALCULATE",
  "REQUIRE",
  "EXCLUDE",
  "GROUP",
  "ORDER",
  "KEEP",
  "STAKE",
  "OUTPUT",
] as const;
export type FunnelAction = (typeof APPROVED_FUNNEL_ACTIONS)[number];

export const APPROVED_SOURCE_CLASSES = [
  "CURRENT_EXECUTABLE",
  "HISTORICAL_EXECUTABLE",
  "SUPERSEDED_EXECUTABLE",
  "DEAD_UNREACHABLE_CODE",
  "RESEARCH_EXECUTABLE",
  "DECLARATION_ONLY",
  "DOC_SPEC",
  "GENERATED_RESULT",
  "SQL_CONTRACT_STUB",
  "UNRESOLVED",
] as const;
export type SourceClass = (typeof APPROVED_SOURCE_CLASSES)[number];

export const APPROVED_LINEAGE_CONFIDENCE = [
  "HEAD_NATIVE",
  "UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH",
  "DECLARATION_ONLY",
  "UNRESOLVED",
] as const;
export type LineageConfidence = (typeof APPROVED_LINEAGE_CONFIDENCE)[number];

export const APPROVED_RUN_STATUSES = [
  "READY_EXACT",
  "RUNNABLE_APPROX_ONLY",
  "BLOCKED_EVENT_IDENTITY_CONTRACT",
  "BLOCKED_SOURCE_CONFLICT",
  "BLOCKED_MISSING_FIELD",
  "BLOCKED_MISSING_FORMULA",
  "RELATED_BUT_NOT_IDENTICAL",
  "CONTRACT_STUB_ONLY",
  "LABEL_ONLY",
  "UNRESOLVED",
  "VERIFIED_EXECUTABLE",
  "VERIFIED_ALIAS",
  "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION",
  "AMBIGUOUS_ALIAS_NOT_EXECUTABLE",
] as const;
export type RunStatus = (typeof APPROVED_RUN_STATUSES)[number];

// Sibling-branch commits proven NON-ancestors of HEAD in Phase 3E.3A-0D.
// They may only ever appear as UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH.
export const SIBLING_BRANCH_COMMIT_PREFIXES = ["f45b77c", "408b38a", "3c31b42"] as const;

export interface SourceEvidence {
  path?: string;
  symbol?: string;
  commit?: string;
  sourceClass: SourceClass;
  lineageConfidence?: LineageConfidence;
  note?: string;
}

export interface FormulaInput {
  field: string;
  role: string;
  directWeight: number | null;
  source: string;
}

export interface FormulaContribution {
  input: string;
  weight: number;
}

export interface FormulaCalculationStep {
  output: string;
  expression: string;
  contributions: FormulaContribution[];
}

export interface FormulaModelRecord {
  formulaModelId: string;
  metricFormulaVersion: string;
  generationLineage: string[];
  producingFunction: string;
  sourcePath: string;
  sourceClass: SourceClass;
  lineageConfidence: LineageConfidence;
  inputs: FormulaInput[];
  calculationSteps: FormulaCalculationStep[];
  outputs: string[];
  capsAndFloors: Array<{ name: string; plainLanguage: string; value: number | string }>;
  tests?: SourceEvidence[];
}

export interface FunnelStep {
  step: number;
  action: FunnelAction;
  plainLanguage: string;
  field: string | null;
  exactRule: Record<string, unknown> | null;
  sourceEvidence: SourceEvidence[];
  currentDatasetAvailability: "AVAILABLE" | "AVAILABLE_VIA_DIAGNOSTICS" | "MISSING" | "NOT_APPLICABLE";
  executionStatus: "VERIFIED" | "VERIFIED_WITH_LIMITATION" | "BLOCKED" | "NOT_APPLICABLE";
}

export interface StakePolicy {
  unit: string;
  plainLanguage: string;
  [key: string]: unknown;
}

export interface NormalizedCurrentInput {
  rawSnapshots: number;
  dedupPolicy: string;
  retainedRows: number;
}

export interface BundleRecord {
  bundleId: string;
  plainLanguageName: string;
  aliases: string[];
  formulaModelId: string | null;
  historicalInput: Record<string, unknown>;
  normalizedCurrentInput: NormalizedCurrentInput | null;
  orderedFunnel: FunnelStep[];
  historicalStakePolicy: StakePolicy | null;
  normalizedEvaluationStakePolicy: StakePolicy | null;
  requiredFields: string[];
  sourceAgreement: string;
  sourceEvidence: SourceEvidence[];
  lineageConfidence: LineageConfidence;
  runStatus: RunStatus;
  plainLanguageBlocker: string | null;
}

export interface AliasRecord {
  rawName: string;
  // Present for VERIFIED_ALIAS / RELATED_BUT_NOT_IDENTICAL (single target).
  canonicalTarget?: string;
  // Present for AMBIGUOUS_HISTORICAL_ALIAS: the old name maps to two or more
  // materially different executable variants -- it is never silently
  // collapsed to one of them.
  canonicalTargets?: string[];
  relationship: "VERIFIED_ALIAS" | "RELATED_BUT_NOT_IDENTICAL" | "AMBIGUOUS_HISTORICAL_ALIAS";
}

export interface ExecutableFunnelClassifier {
  schemaVersion: 1;
  generatedFrom: { headCommit: string; provenancePolicy: string };
  formulaModels: FormulaModelRecord[];
  bundles: BundleRecord[];
  aliases: AliasRecord[];
  unresolvedDecisions: Array<{ id: string; plainLanguage: string; affects: string[] }>;
}

const REGISTRY_PATH = path.resolve(
  __dirname,
  "../../modeling/model_registry/executable_funnel_classifier.json",
);

export function loadExecutableFunnelClassifier(): ExecutableFunnelClassifier {
  const raw = readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw) as ExecutableFunnelClassifier;
  validateExecutableFunnelClassifier(parsed);
  return parsed;
}

export interface ValidationResult {
  ok: true;
  bundleCount: number;
  formulaModelCount: number;
  aliasCount: number;
}

/**
 * Pure structural validator. Throws on the first violation with a
 * deterministic message; returns a stable summary object on success. Never
 * mutates its input.
 */
export function validateExecutableFunnelClassifier(
  registry: ExecutableFunnelClassifier,
): ValidationResult {
  if (!registry || (registry as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("executable funnel classifier: schemaVersion must be 1");
  }
  if (!Array.isArray(registry.bundles) || !Array.isArray(registry.formulaModels)) {
    throw new Error("executable funnel classifier: bundles and formulaModels must be arrays");
  }

  const seenBundleIds = new Set<string>();
  for (const bundle of registry.bundles) {
    if (seenBundleIds.has(bundle.bundleId)) {
      throw new Error(`executable funnel classifier: duplicate bundle id ${bundle.bundleId}`);
    }
    seenBundleIds.add(bundle.bundleId);

    if (!(APPROVED_RUN_STATUSES as readonly string[]).includes(bundle.runStatus)) {
      throw new Error(`executable funnel classifier: bundle ${bundle.bundleId} has unapproved runStatus ${bundle.runStatus}`);
    }

    // Ordered funnel steps must be contiguous from 1, use approved actions,
    // and carry plain-language text.
    bundle.orderedFunnel.forEach((step, index) => {
      if (step.step !== index + 1) {
        throw new Error(`executable funnel classifier: bundle ${bundle.bundleId} funnel step numbers not contiguous`);
      }
      if (!(APPROVED_FUNNEL_ACTIONS as readonly string[]).includes(step.action)) {
        throw new Error(`executable funnel classifier: bundle ${bundle.bundleId} step ${step.step} uses unapproved action ${step.action}`);
      }
      if (typeof step.plainLanguage !== "string" || step.plainLanguage.trim() === "") {
        throw new Error(`executable funnel classifier: bundle ${bundle.bundleId} step ${step.step} missing plainLanguage`);
      }
    });

    // SQL contract stubs may never carry an executable run status.
    const isStub = bundle.sourceEvidence.some((e) => e.sourceClass === "SQL_CONTRACT_STUB");
    const EXECUTABLE = ["READY_EXACT", "RUNNABLE_APPROX_ONLY", "VERIFIED_EXECUTABLE", "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION"];
    if (isStub && EXECUTABLE.includes(bundle.runStatus)) {
      throw new Error(`executable funnel classifier: SQL stub ${bundle.bundleId} cannot have executable status`);
    }

    // An ambiguous historical alias placeholder must never carry an
    // executable funnel of its own -- it exists only to point at the
    // explicit variants that replaced it.
    if (bundle.runStatus === "AMBIGUOUS_ALIAS_NOT_EXECUTABLE" && bundle.orderedFunnel.length !== 0) {
      throw new Error(`executable funnel classifier: ambiguous alias bundle ${bundle.bundleId} must not carry an executable funnel`);
    }
  }

  // Aliases must resolve to exactly one canonical target, OR (for an
  // explicitly ambiguous historical alias) to two or more explicit variant
  // bundle ids -- never zero, and never a silent single collapse.
  for (const alias of registry.aliases) {
    if (alias.relationship === "AMBIGUOUS_HISTORICAL_ALIAS") {
      if (!Array.isArray(alias.canonicalTargets) || alias.canonicalTargets.length < 2) {
        throw new Error(`executable funnel classifier: ambiguous alias ${alias.rawName} must list two or more canonicalTargets`);
      }
      for (const target of alias.canonicalTargets) {
        if (!seenBundleIds.has(target)) {
          throw new Error(`executable funnel classifier: alias ${alias.rawName} targets unknown bundle ${target}`);
        }
      }
    } else {
      if (!alias.canonicalTarget || !seenBundleIds.has(alias.canonicalTarget)) {
        throw new Error(`executable funnel classifier: alias ${alias.rawName} targets unknown bundle ${alias.canonicalTarget}`);
      }
    }
  }

  // Provenance guard: any evidence referencing a proven sibling-branch commit
  // must be classified UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH, never HEAD_NATIVE.
  const allEvidence: SourceEvidence[] = [];
  for (const model of registry.formulaModels) {
    for (const e of model.tests ?? []) allEvidence.push(e);
  }
  for (const bundle of registry.bundles) {
    for (const e of bundle.sourceEvidence) allEvidence.push(e);
    for (const step of bundle.orderedFunnel) for (const e of step.sourceEvidence) allEvidence.push(e);
  }
  for (const e of allEvidence) {
    if (e.commit && SIBLING_BRANCH_COMMIT_PREFIXES.some((c) => e.commit!.startsWith(c))) {
      if (e.lineageConfidence !== "UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH") {
        throw new Error(`executable funnel classifier: sibling-branch commit ${e.commit} must use lineageConfidence UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH, not ${e.lineageConfidence}`);
      }
    }
    if (e.sourceClass && !(APPROVED_SOURCE_CLASSES as readonly string[]).includes(e.sourceClass)) {
      throw new Error(`executable funnel classifier: unapproved sourceClass ${e.sourceClass}`);
    }
  }

  return {
    ok: true,
    bundleCount: registry.bundles.length,
    formulaModelCount: registry.formulaModels.length,
    aliasCount: registry.aliases.length,
  };
}

export function getFormulaModel(
  registry: ExecutableFunnelClassifier,
  id: string,
): FormulaModelRecord | undefined {
  return registry.formulaModels.find((m) => m.formulaModelId === id);
}

export function getBundle(
  registry: ExecutableFunnelClassifier,
  id: string,
): BundleRecord | undefined {
  return registry.bundles.find((b) => b.bundleId === id);
}

/**
 * Resolves a raw name to the canonical bundle id(s) it refers to. A direct
 * bundle id resolves to itself. A registered VERIFIED_ALIAS resolves to its
 * single canonical target. A RELATED_BUT_NOT_IDENTICAL name resolves only to
 * itself (never silently to the canonical target), so an approximate sibling
 * is never conflated with the real algorithm.
 */
export function resolveAlias(registry: ExecutableFunnelClassifier, rawName: string): string[] {
  const directBundle = registry.bundles.find((b) => b.bundleId === rawName);
  const alias = registry.aliases.find((a) => a.rawName === rawName);
  if (alias && alias.relationship === "VERIFIED_ALIAS" && alias.canonicalTarget) {
    return [alias.canonicalTarget];
  }
  if (alias && alias.relationship === "AMBIGUOUS_HISTORICAL_ALIAS" && alias.canonicalTargets) {
    return [...alias.canonicalTargets];
  }
  if (directBundle) return [directBundle.bundleId];
  if (alias) return [alias.rawName];
  return [];
}
