import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Function-scoped authority rules. Text classifiers are intentionally absent:
// they may classify market type/scope, but these identity-bearing functions
// may not read display text as a key, join, or admission predicate.
export const RULES = [
  {
    file: "lib/executor/planningAnchor.ts",
    functionName: "resolvePlanningAnchorDecision",
    forbidden: [
      [/(?:anchorInput\.)?(?:providerMarketQuestion|eventTitle|marketSlug)/, "planning admission reads display text"],
      [/isEventLevelMatchupText\s*\(/, "planning admission invokes a text identity predicate"],
    ],
  },
  {
    file: "lib/executor/eventExecutionQueue.ts",
    functionName: "loadExactProviderSiblingRowsFromAnchor",
    forbidden: [
      [/queryByConditionId/, "event siblings are loaded by one market condition"],
      [/(?:event_slug|market_slug)/, "event sibling identity reads display text"],
    ],
  },
  {
    file: "lib/executor/eventExecutionQueue.ts",
    functionName: "planningDecisionFromReservation",
    forbidden: [
      [/lineage\.event_slug/, "Reservation reconstruction requires display text"],
    ],
  },
];

// Explicit allowlist: these functions classify a market surface for policy;
// they do not establish event/occurrence identity.
export const TEXT_CLASSIFICATION_ALLOWLIST = [
  "lib/contur3/taxonomy.ts",
  "lib/executor/planningAnchor.ts:isEventLevelMatchupText",
  "lib/executor/nightEventReservations.ts:marketPolicyFingerprint",
];

function functionNameOf(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText();
  }
  if (ts.isVariableDeclaration(node) && node.name && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.getText();
  }
  return null;
}

export function auditFunctionSource(source, functionName, forbidden, file = "fixture.ts") {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let target = null;
  const visit = (node) => {
    if (functionNameOf(node) === functionName) target = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!target) return [`${file}:${functionName}: function not found`];
  const body = target.getText(parsed);
  return forbidden
    .filter(([pattern]) => pattern.test(body))
    .map(([, message]) => `${file}:${functionName}: ${message}`);
}

export function runGuard(root = ROOT) {
  const failures = [];
  for (const rule of RULES) {
    const absolute = path.join(root, rule.file);
    const source = fs.readFileSync(absolute, "utf8");
    failures.push(...auditFunctionSource(source, rule.functionName, rule.forbidden, rule.file));
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = runGuard();
  if (failures.length > 0) {
    console.error(`TEXT_AS_IDENTITY_AUTHORITY_GUARD_FAIL\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`TEXT_AS_IDENTITY_AUTHORITY_GUARD_PASS rules=${RULES.length} classification_allowlist=${TEXT_CLASSIFICATION_ALLOWLIST.length}`);
  }
}
