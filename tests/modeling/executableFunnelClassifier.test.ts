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

test("A3: every non-ambiguous alias resolves to exactly one canonical target", () => {
  for (const alias of registry.aliases) {
    if (alias.relationship === "AMBIGUOUS_HISTORICAL_ALIAS") continue;
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

test("A16: ALT1's normalized canonical variant is blocked/limited by event identity, never promoted to exact", () => {
  const b = getBundle(registry, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(b!.runStatus, "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION");
});

test("A17: ALT2's two normalized variants disagree by design -- neither silently wins", () => {
  const ts = getBundle(registry, "ALT2_TS_SCORE_GE_65");
  const py = getBundle(registry, "ALT2_PY_SCORE_GE_65_SM_LT_85");
  assert.notEqual(ts!.orderedFunnel.length === py!.orderedFunnel.length &&
    JSON.stringify(ts!.orderedFunnel) === JSON.stringify(py!.orderedFunnel), true);
});

test("A18: ALT3's two normalized variants disagree by design -- neither silently wins", () => {
  const ts = getBundle(registry, "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  const py = getBundle(registry, "ALT3_PY_SCORE_GE_65");
  assert.notEqual(ts!.orderedFunnel.length === py!.orderedFunnel.length &&
    JSON.stringify(ts!.orderedFunnel) === JSON.stringify(py!.orderedFunnel), true);
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
    "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION", "AMBIGUOUS_ALIAS_NOT_EXECUTABLE",
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

// ---- Phase 3E.3A-2: normalize historical variants, resolve minimum blockers ----

test("B1: ALT1 old ID cannot execute directly", () => {
  const old = getBundle(registry, "ALT1_ONE_PER_EVENT_BEST_COVERAGE");
  assert.ok(old);
  assert.equal(old!.runStatus, "AMBIGUOUS_ALIAS_NOT_EXECUTABLE");
  assert.equal(old!.orderedFunnel.length, 0);
});

test("B2: ALT1 old ID resolves to exactly two explicit variants", () => {
  const resolved = resolveAlias(registry, "ALT1_ONE_PER_EVENT_BEST_COVERAGE");
  assert.deepEqual(
    [...resolved].sort(),
    ["ALT1_CANONICAL_EVENT_GROUPING", "ALT1_PY_EVENT_KEY_VARIANT"].sort(),
  );
});

test("B3: canonical ALT1 variant uses the existing canonical event-group helper", () => {
  const b = getBundle(registry, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.ok(b);
  const groupStep = b!.orderedFunnel.find((s) => s.action === "GROUP");
  assert.ok(groupStep);
  assert.ok(groupStep!.sourceEvidence.some((e) => e.symbol?.includes("buildEventGroupKey") || e.symbol?.includes("eventGroupSelection")));
});

test("B4: canonical ALT1 variant carries an explicit exploratory identity limitation", () => {
  const b = getBundle(registry, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(b!.runStatus, "READY_EXPLORATORY_WITH_IDENTITY_LIMITATION");
  assert.ok(b!.plainLanguageBlocker && /exploratory|исследователь/i.test(b!.plainLanguageBlocker));
});

test("B5: Python ALT1 variant preserves event_key -> condition_id fallback exactly", () => {
  const b = getBundle(registry, "ALT1_PY_EVENT_KEY_VARIANT");
  assert.ok(b);
  const groupStep = b!.orderedFunnel.find((s) => s.action === "GROUP");
  assert.ok(groupStep);
  assert.deepEqual(groupStep!.exactRule, { fallbackChain: ["event_key", "condition_id"] });
});

test("B6: ALT2 old ID cannot execute directly", () => {
  const old = getBundle(registry, "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH");
  assert.equal(old!.runStatus, "AMBIGUOUS_ALIAS_NOT_EXECUTABLE");
  assert.equal(old!.orderedFunnel.length, 0);
});

test("B7: ALT2 TS variant has no smart-money predicate anywhere in its funnel", () => {
  const b = getBundle(registry, "ALT2_TS_SCORE_GE_65");
  assert.ok(b);
  assert.ok(!b!.orderedFunnel.some((s) => s.field === "smart_money_score_num"));
});

test("B8: ALT2 Python variant requires smart money missing or < 85", () => {
  const b = getBundle(registry, "ALT2_PY_SCORE_GE_65_SM_LT_85");
  const step = b!.orderedFunnel.find((s) => s.field === "smart_money_score_num");
  assert.ok(step);
  assert.deepEqual(step!.exactRule, { rule: "smart_money is None or smart_money < 85" });
});

test("B9: ALT3 old ID cannot execute directly", () => {
  const old = getBundle(registry, "ALT3_V1_AVOID_NBA_NHL");
  assert.equal(old!.runStatus, "AMBIGUOUS_ALIAS_NOT_EXECUTABLE");
  assert.equal(old!.orderedFunnel.length, 0);
});

test("B10: ALT3 TS variant excludes NBA/NHL", () => {
  const b = getBundle(registry, "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL");
  assert.ok(b!.orderedFunnel.some((s) => s.action === "EXCLUDE" && s.field === "league"));
});

test("B11: ALT3 Python variant does not exclude NBA/NHL", () => {
  const b = getBundle(registry, "ALT3_PY_SCORE_GE_65");
  assert.ok(!b!.orderedFunnel.some((s) => s.action === "EXCLUDE" && s.field === "league"));
});

test("B12: MODEL_A remains an exact verified alias of ALT_SM_GUARD_ON_PRIMARY", () => {
  assert.deepEqual(resolveAlias(registry, "MODEL_A"), ["ALT_SM_GUARD_ON_PRIMARY"]);
  assert.equal(getBundle(registry, "MODEL_A")!.runStatus, "VERIFIED_ALIAS");
});

test("B13: soft smart-money stake guard remains distinct from hard exclusion", () => {
  const guard = getBundle(registry, "ALT_SM_GUARD_ON_PRIMARY");
  const approx = getBundle(registry, "ALT_SM_GUARD_ON_PRIMARY_APPROX");
  const guardStep = guard!.orderedFunnel.find((s) => s.field === "smart_money_score_num");
  const approxStep = approx!.orderedFunnel.find((s) => s.field === "smart_money_score_num");
  assert.equal(guardStep!.action, "STAKE");
  assert.equal(approxStep!.action, "EXCLUDE");
});

test("B14: PRIMARY remains RUNNABLE_APPROX_ONLY, not upgraded to exact", () => {
  assert.equal(getBundle(registry, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP")!.runStatus, "RUNNABLE_APPROX_ONLY");
});

test("B15: SQL stubs remain non-executable", () => {
  for (const id of ["CHAMPION_CURRENT", "PUBLISHED_ONE_PER_FIXTURE", "FIRE_FAMILY_SELECTIVE", "SAFETY_BASELINE", "TIERED_LIVE_CONTOUR"]) {
    assert.equal(getBundle(registry, id)!.runStatus, "CONTRACT_STUB_ONLY");
  }
});

test("B16: no historical variant bundle was deleted -- all pre-existing bundle ids remain present", () => {
  const PRE_EXISTING = [
    "BASELINE_V1_CONTROL", "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", "ALT1_ONE_PER_EVENT_BEST_COVERAGE",
    "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH", "ALT3_V1_AVOID_NBA_NHL", "ALT_SM_GUARD_ON_PRIMARY",
    "MODEL_A", "ALT_SM_GUARD_ON_PRIMARY_APPROX", "CHAMPION_CURRENT", "PUBLISHED_ONE_PER_FIXTURE",
    "FIRE_FAMILY_SELECTIVE", "SAFETY_BASELINE", "TIERED_LIVE_CONTOUR", "FIRE_MODEL_1_LOCKED",
  ];
  for (const id of PRE_EXISTING) {
    assert.ok(getBundle(registry, id), `pre-existing bundle ${id} must not be deleted`);
  }
});

test("B17: each new executable variant has contiguous ordered funnel steps", () => {
  for (const id of [
    "ALT1_CANONICAL_EVENT_GROUPING", "ALT1_PY_EVENT_KEY_VARIANT", "ALT2_TS_SCORE_GE_65",
    "ALT2_PY_SCORE_GE_65_SM_LT_85", "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL", "ALT3_PY_SCORE_GE_65",
  ]) {
    const b = getBundle(registry, id);
    assert.ok(b, `variant ${id} must exist`);
    b!.orderedFunnel.forEach((s, i) => assert.equal(s.step, i + 1));
  }
});

test("B18: each exact rule step in the new variants has source evidence", () => {
  for (const id of [
    "ALT1_CANONICAL_EVENT_GROUPING", "ALT1_PY_EVENT_KEY_VARIANT", "ALT2_TS_SCORE_GE_65",
    "ALT2_PY_SCORE_GE_65_SM_LT_85", "ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL", "ALT3_PY_SCORE_GE_65",
  ]) {
    const b = getBundle(registry, id);
    for (const step of b!.orderedFunnel) {
      if (step.exactRule !== null) {
        assert.ok(step.sourceEvidence.length > 0, `${id} step ${step.step} exactRule needs sourceEvidence`);
      }
    }
  }
});

test("B19: no predicate is inferred from the bundle name alone -- TS/Python variants differ where source differs", () => {
  const tsAlt2 = getBundle(registry, "ALT2_TS_SCORE_GE_65");
  const pyAlt2 = getBundle(registry, "ALT2_PY_SCORE_GE_65_SM_LT_85");
  // Same family name root, but the TS variant's funnel must NOT contain the
  // smart-money predicate implied by "SMARTMONEY_HIGH" in the old shared name.
  assert.notDeepEqual(tsAlt2!.orderedFunnel, pyAlt2!.orderedFunnel);
});

test("B20: registry output is deterministic after normalization", () => {
  const a = validateExecutableFunnelClassifier(structuredClone(registry));
  const b = validateExecutableFunnelClassifier(structuredClone(registry));
  assert.deepEqual(a, b);
});
