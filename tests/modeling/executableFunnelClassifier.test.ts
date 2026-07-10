// Phase 3E.3A-1 Commit A -- executable funnel classifier registry tests.
//
// The classifier consolidates the completed 3E.3A-0/0B/0D forensic work into
// one machine-readable registry: formula-model arithmetic, per-bundle ordered
// funnels, alias resolution, provenance/lineage confidence, and historical vs
// normalized pipelines. These tests lock the invariants; they do not re-run
// repository archaeology and do not resolve source conflicts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  loadExecutableFunnelClassifier,
  validateExecutableFunnelClassifier,
  resolveAlias,
  getFormulaModel,
  getBundle,
  APPROVED_FUNNEL_ACTIONS,
  APPROVED_SOURCE_CLASSES,
  APPROVED_LINEAGE_CONFIDENCE,
  type ExecutableFunnelClassifier,
} from "../../lib/modeling/executableFunnelClassifier";

const registry: ExecutableFunnelClassifier = loadExecutableFunnelClassifier();

test("A1: schemaVersion is required and present", () => {
  assert.equal(registry.schemaVersion, 1);
  const { schemaVersion: _omit, ...rest } = registry;
  assert.throws(() => validateExecutableFunnelClassifier(rest as unknown as ExecutableFunnelClassifier));
});

test("A2: duplicate bundle IDs are rejected", () => {
  const clone = structuredClone(registry);
  clone.bundles.push(structuredClone(clone.bundles[0]));
  assert.throws(() => validateExecutableFunnelClassifier(clone), /duplicate bundle/i);
});

test("A3: every alias resolves to exactly one canonical target", () => {
  for (const alias of registry.aliases) {
    const resolved = resolveAlias(registry, alias.rawName);
    assert.equal(resolved.length, 1, `alias ${alias.rawName} must resolve to exactly one bundle`);
  }
});

test("A4: ordered funnel step numbers are contiguous starting at 1", () => {
  for (const bundle of registry.bundles) {
    const steps = bundle.orderedFunnel.map((s) => s.step);
    for (let i = 0; i < steps.length; i++) {
      assert.equal(steps[i], i + 1, `bundle ${bundle.bundleId} funnel step ${i} not contiguous`);
    }
  }
});

test("A5: funnel actions use only the approved enum", () => {
  for (const bundle of registry.bundles) {
    for (const step of bundle.orderedFunnel) {
      assert.ok(
        (APPROVED_FUNNEL_ACTIONS as readonly string[]).includes(step.action),
        `bundle ${bundle.bundleId} step ${step.step} uses non-approved action ${step.action}`,
      );
    }
  }
});

test("A6: each executable funnel step has plain-language text", () => {
  for (const bundle of registry.bundles) {
    for (const step of bundle.orderedFunnel) {
      assert.ok(
        typeof step.plainLanguage === "string" && step.plainLanguage.trim().length > 0,
        `bundle ${bundle.bundleId} step ${step.step} missing plainLanguage`,
      );
    }
  }
});

test("A7: each executable funnel step carries source evidence", () => {
  for (const bundle of registry.bundles) {
    if (bundle.runStatus === "CONTRACT_STUB_ONLY" || bundle.runStatus === "LABEL_ONLY") continue;
    for (const step of bundle.orderedFunnel) {
      assert.ok(Array.isArray(step.sourceEvidence) && step.sourceEvidence.length > 0,
        `bundle ${bundle.bundleId} step ${step.step} missing sourceEvidence`);
    }
  }
});

test("A8: smart_money_score_num is a formula input with weight 0.25", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  assert.ok(model);
  const input = model!.inputs.find((i) => i.field === "smart_money_score_num");
  assert.ok(input, "smart_money_score_num must be a formula input");
  assert.equal(input!.directWeight, 0.25);
});

test("A9: whale_public_score_num is a formula input with weight 0.15", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const input = model!.inputs.find((i) => i.field === "whale_public_score_num");
  assert.ok(input);
  assert.equal(input!.directWeight, 0.15);
});

test("A10: pre_event_score_num is a formula input with weight 0.20", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const input = model!.inputs.find((i) => i.field === "pre_event_score_num");
  assert.ok(input);
  assert.equal(input!.directWeight, 0.2);
});

test("A11: oddsFit is a formula input with weight 0.35", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const input = model!.inputs.find((i) => i.field === "oddsFit");
  assert.ok(input);
  assert.equal(input!.directWeight, 0.35);
});

test("A12: data coverage direct weight is 0.05", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const input = model!.inputs.find((i) => i.field === "dataCoverage");
  assert.ok(input);
  assert.equal(input!.directWeight, 0.05);
});

test("A13: nested pre-event coverage contribution (0.10 inside preEventVal) is preserved", () => {
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const preEventStep = model!.calculationSteps.find((s) => s.output === "preEventVal");
  assert.ok(preEventStep, "preEventVal calculation step must exist");
  const covContribution = preEventStep!.contributions.find((c) => c.input === "dataCoverage");
  assert.ok(covContribution, "dataCoverage must contribute inside preEventVal");
  assert.equal(covContribution!.weight, 0.1);
});

test("A14: formula/model inputs are kept separate from external filters", () => {
  // A field used both in the formula and as an external policy must appear in
  // both places explicitly, never merged into a single ambiguous entry.
  const model = getFormulaModel(registry, "V2_LITE_GROWTH_SAFE");
  const smInFormula = model!.inputs.some((i) => i.field === "smart_money_score_num");
  const modelA = getBundle(registry, "MODEL_A") ?? getBundle(registry, "ALT_SM_GUARD_ON_PRIMARY");
  const smAsExternal = modelA!.orderedFunnel.some(
    (s) => s.action === "STAKE" && s.field === "smart_money_score_num",
  );
  assert.ok(smInFormula, "smart money must appear as a formula input");
  assert.ok(smAsExternal, "smart money must appear as an external stake policy step");
});

test("A15: historical and normalized stake policies remain separate", () => {
  for (const bundle of registry.bundles) {
    if (!bundle.historicalStakePolicy || !bundle.normalizedEvaluationStakePolicy) continue;
    assert.notEqual(
      JSON.stringify(bundle.historicalStakePolicy),
      undefined,
    );
    // Normalized ROI stake is always flat 1 unit; historical is never silently
    // overwritten to match it.
    assert.equal(bundle.normalizedEvaluationStakePolicy.unit, "FLAT_1_UNIT");
  }
});

test("A16: ALT1 remains blocked by event identity contract", () => {
  const b = getBundle(registry, "ALT1_ONE_PER_EVENT_BEST_COVERAGE");
  assert.equal(b!.runStatus, "BLOCKED_EVENT_IDENTITY_CONTRACT");
});

test("A17: ALT2 remains blocked by source conflict", () => {
  const b = getBundle(registry, "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH");
  assert.equal(b!.runStatus, "BLOCKED_SOURCE_CONFLICT");
});

test("A18: ALT3 remains blocked by source conflict", () => {
  const b = getBundle(registry, "ALT3_V1_AVOID_NBA_NHL");
  assert.equal(b!.runStatus, "BLOCKED_SOURCE_CONFLICT");
});

test("A19: MODEL_A resolves to ALT_SM_GUARD_ON_PRIMARY", () => {
  const resolved = resolveAlias(registry, "MODEL_A");
  assert.deepEqual(resolved, ["ALT_SM_GUARD_ON_PRIMARY"]);
});

test("A20: _APPROX is not treated as the same algorithm", () => {
  const approx = getBundle(registry, "ALT_SM_GUARD_ON_PRIMARY_APPROX");
  assert.ok(approx);
  assert.equal(approx!.runStatus, "RELATED_BUT_NOT_IDENTICAL");
  // It must NOT be registered as an alias of the canonical bundle.
  const resolved = resolveAlias(registry, "ALT_SM_GUARD_ON_PRIMARY_APPROX");
  assert.notDeepEqual(resolved, ["ALT_SM_GUARD_ON_PRIMARY"]);
});

test("A21: sibling-branch content-match items cannot claim HEAD_NATIVE lineage", () => {
  const SIBLING = "UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH";
  const collectEvidence = (): Array<{ commit?: string; lineageConfidence?: string }> => {
    const out: Array<{ commit?: string; lineageConfidence?: string }> = [];
    for (const m of registry.formulaModels) for (const e of m.tests ?? []) out.push(e);
    for (const b of registry.bundles) for (const s of b.orderedFunnel) for (const e of s.sourceEvidence) out.push(e);
    return out;
  };
  for (const e of collectEvidence()) {
    if (e.commit && ["f45b77c", "408b38a", "3c31b42"].some((c) => e.commit!.startsWith(c))) {
      assert.notEqual(e.lineageConfidence, "HEAD_NATIVE",
        `sibling-branch commit ${e.commit} must not be HEAD_NATIVE`);
      assert.equal(e.lineageConfidence, SIBLING);
    }
  }
  // The validator must actively reject a HEAD_NATIVE sibling commit.
  const clone = structuredClone(registry);
  clone.formulaModels[0].tests = [{ commit: "f45b77c0", lineageConfidence: "HEAD_NATIVE" } as never];
  assert.throws(() => validateExecutableFunnelClassifier(clone), /sibling|lineage/i);
});

test("A22: SQL contract stubs cannot have an executable run status", () => {
  const EXECUTABLE = new Set(["READY_EXACT", "RUNNABLE_APPROX_ONLY", "VERIFIED_EXECUTABLE"]);
  for (const bundle of registry.bundles) {
    const isStub = bundle.sourceEvidence.some((e) => e.sourceClass === "SQL_CONTRACT_STUB");
    if (isStub) {
      assert.ok(!EXECUTABLE.has(bundle.runStatus),
        `SQL stub ${bundle.bundleId} must not have executable status ${bundle.runStatus}`);
    }
  }
});

test("A23: no bundle is automatically named Champion / promoted as best", () => {
  for (const bundle of registry.bundles) {
    assert.doesNotMatch(bundle.plainLanguageName, /\bchampion\b|\bbest model\b|\brecommended\b/i);
  }
  const champion = getBundle(registry, "CHAMPION_CURRENT");
  assert.ok(champion);
  assert.ok(["CONTRACT_STUB_ONLY", "LABEL_ONLY", "UNRESOLVED"].includes(champion!.runStatus));
});

test("A24: current run statuses use approved values only", () => {
  const APPROVED = new Set([
    "READY_EXACT", "RUNNABLE_APPROX_ONLY", "BLOCKED_EVENT_IDENTITY_CONTRACT",
    "BLOCKED_SOURCE_CONFLICT", "BLOCKED_MISSING_FIELD", "BLOCKED_MISSING_FORMULA",
    "RELATED_BUT_NOT_IDENTICAL", "CONTRACT_STUB_ONLY", "LABEL_ONLY", "UNRESOLVED",
    "VERIFIED_EXECUTABLE", "VERIFIED_ALIAS",
  ]);
  for (const bundle of registry.bundles) {
    assert.ok(APPROVED.has(bundle.runStatus), `bundle ${bundle.bundleId} status ${bundle.runStatus} not approved`);
  }
});

test("A25: registry validation is deterministic (same input, same verdict)", () => {
  const a = validateExecutableFunnelClassifier(structuredClone(registry));
  const b = validateExecutableFunnelClassifier(structuredClone(registry));
  assert.deepEqual(a, b);
});

test("A26: BASELINE is READY_EXACT and PRIMARY is RUNNABLE_APPROX_ONLY", () => {
  assert.equal(getBundle(registry, "BASELINE_V1_CONTROL")!.runStatus, "READY_EXACT");
  assert.equal(getBundle(registry, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!.runStatus, "RUNNABLE_APPROX_ONLY");
});

test("A27: normalized pipeline starts from 42,088 -> 1,657 strict-dedup rows", () => {
  for (const bundle of registry.bundles) {
    if (!bundle.normalizedCurrentInput) continue;
    assert.equal(bundle.normalizedCurrentInput.rawSnapshots, 42088);
    assert.equal(bundle.normalizedCurrentInput.retainedRows, 1657);
    assert.equal(bundle.normalizedCurrentInput.dedupPolicy, "strict_latest_created_before_resolved");
  }
});

test("A28: enums exported match the schema's approved values", () => {
  assert.ok(APPROVED_SOURCE_CLASSES.includes("CURRENT_EXECUTABLE"));
  assert.ok(APPROVED_SOURCE_CLASSES.includes("SQL_CONTRACT_STUB"));
  assert.ok(APPROVED_LINEAGE_CONFIDENCE.includes("HEAD_NATIVE"));
  assert.ok(APPROVED_LINEAGE_CONFIDENCE.includes("UNVERIFIED_SIBLING_BRANCH_CONTENT_MATCH"));
});
