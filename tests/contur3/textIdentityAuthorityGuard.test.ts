import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditFunctionSource,
  runGuard,
  RULES,
  TEXT_CLASSIFICATION_ALLOWLIST,
} from "../../scripts/guard-text-identity-authority.mjs";

test("active PREMVP authority functions satisfy the semantic guard", () => {
  assert.deepEqual(runGuard(), []);
  assert.ok(RULES.length >= 3);
  assert.ok(TEXT_CLASSIFICATION_ALLOWLIST.includes("lib/contur3/taxonomy.ts"));
});

test("guard rejects display text used inside a planning identity decision", () => {
  const failures = auditFunctionSource(
    `function resolvePlanningAnchorDecision(input: any) {
      return input.anchorInput.providerMarketQuestion === input.anchorInput.eventTitle;
    }`,
    "resolvePlanningAnchorDecision",
    RULES[0].forbidden,
    "synthetic-regression.ts",
  );
  assert.ok(failures.some((failure) => failure.includes("display text")));
});

test("guard rejects condition-bounded event sibling loading", () => {
  const failures = auditFunctionSource(
    `async function loadExactProviderSiblingRowsFromAnchor(queryByConditionId: any) {
      return queryByConditionId("condition-only");
    }`,
    "loadExactProviderSiblingRowsFromAnchor",
    RULES[1].forbidden,
    "synthetic-regression.ts",
  );
  assert.ok(failures.some((failure) => failure.includes("one market condition")));
});
