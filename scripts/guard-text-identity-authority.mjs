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
  {
    file: "lib/feed/discoverSportsMarkets.ts",
    functionName: "admitsResearchIntakeSportIdentity",
    forbidden: [
      [/providerSportCode/, "scored intake admission requires the optional raw provider league code"],
      [/category|eventTitle|marketQuestion|slug/i, "scored intake admission reads display text"],
    ],
  },
];

export const STRUCTURED_SPORT_RULES = [
  {
    file: "lib/feed/discoverSportsMarkets.ts",
    functionName: "buildBroadStructuredSportsShadowEntries",
    required: [
      [/resolveStructuredSportFamily\(row\.providerTags,\s*providerSportCode\)/, "broad Signal Pair carrier drops canonical provider sport family"],
      [/providerSportCode,\s*providerSportFamily,\s*providerSportSource/s, "broad Signal Pair entry does not keep raw code and canonical family distinct"],
    ],
  },
  {
    file: "lib/feed/cacheGeneratedSignals.ts",
    functionName: "buildShadowProviderEventContext",
    required: [
      [/entry\.providerSportFamily/, "provider event context ignores canonical provider sport family"],
      [/entry\.providerSportCode/, "provider event context drops raw provider sport code"],
      [/sportFamily\s*\?\s*\{\s*sportFamily\s*\}/, "provider event context sportFamily is not canonical family"],
      [/league\s*\?\s*\{\s*league\s*\}/, "provider event context league does not preserve raw provider sport code"],
    ],
  },
  {
    file: "lib/feed/cacheGeneratedSignals.ts",
    functionName: "writeStrategicShadowPairs",
    required: [
      [/select\("condition_id, selected_token_id, metric_formula_version, diagnostics"\)/, "broad dedup cannot validate the persisted sport-family carrier"],
      [/hasMatchingStructuredSportCarrier\(r\.diagnostics,\s*candidate\)/, "broad dedup preserves mismatched code/family carrier rows"],
      [/providerSportCode:\s*entry\.providerSportCode/, "broad persistence drops raw provider sport code"],
      [/providerSportFamily:\s*entry\.providerSportFamily/, "broad persistence drops canonical provider sport family"],
    ],
  },
  {
    file: "lib/feed/buildLandingCards.ts",
    functionName: "researchNestedMarketToCandidate",
    required: [
      [/providerSportCode:\s*rm\.providerSportCode/, "scored adapter drops raw provider sport"],
      [/providerSportFamily:\s*rm\.providerSportFamily/, "scored adapter drops canonical provider sport family"],
      [/providerEventId:\s*rm\.eventId/, "scored adapter drops provider event identity"],
    ],
  },
  {
    file: "lib/feed/buildLandingCards.ts",
    functionName: "buildStructuredProviderDiagnostics",
    required: [
      [/const\s+carriesStructuredSport\s*=/, "structured carrier does not distinguish structured rows from legacy text rows"],
      [/contextSportFamily\s*=\s*\n?\s*parentMeta\.providerSportFamily\s*\?\?/s, "structured carrier sportFamily is not the canonical provider family"],
      [/contextLeague\s*=\s*\n?\s*parentMeta\.providerSportCode\s*\?\?/s, "structured carrier league is not the raw provider sport code"],
      [/carriesStructuredSport\s*\?\s*null\s*:/s, "structured rows may still inherit display category text as sport identity"],
    ],
  },
  {
    file: "lib/feed/discoverSportsMarkets.ts",
    functionName: "admitsResearchIntakeSportIdentity",
    required: [
      [/providerSportFamily/, "scored intake admission ignores the canonical provider sport family"],
    ],
  },
  {
    file: "lib/feed/buildLandingCards.ts",
    functionName: "selectResearchMarketsForScoring",
    required: [
      [/scoreOwnership\s*!==\s*"SUPPORTED_BY_SCORE_MODEL"/, "scorer routing lacks explicit ownership gate"],
      [/row\.eventId.*row\.eventStartIso/s, "scorer routing lacks provider-occurrence conservation"],
    ],
  },
  {
    file: "lib/feed/cacheGeneratedSignals.ts",
    functionName: "buildFireModel1_1ResearchRows",
    required: [
      [/diagnostics:\s*\{\s*\.\.\.diag/s, "scored writer drops structured diagnostics"],
      [/signal_confidence_num:\s*ps\.winProbability/, "scored writer bypasses the real score owner"],
      [/metric_formula_version:\s*FIREMODEL1_1_RESEARCH_METRIC_VERSION/, "scored writer drops score-contract version"],
    ],
  },
  {
    file: "lib/feed/cacheGeneratedSignals.ts",
    functionName: "writeFireModel1_1ResearchPairs",
    required: [
      [/select\("condition_id, selected_token_id, diagnostics"\)/, "research dedup cannot distinguish legacy rows from structured rows"],
      [/hasStructuredScoredSportAuthority\(row\.diagnostics\)/, "legacy scored rows prevent structured replacement writes"],
    ],
  },
  {
    file: "lib/executor/buildFireModelCandidates.ts",
    functionName: "loadContractAPlanningSourceRows",
    required: [
      [/hasStructuredScoredSportAuthority\(row\.diagnostics\)/, "active Contract A loader admits legacy text-authority rows"],
    ],
  },
  {
    file: "lib/executor/buildFireModelCandidates.ts",
    functionName: "resolveModelSport",
    required: [
      [/diag\.providerSportFamily/, "Contract A resolver ignores canonical structured sport family"],
      [/diag\.providerSportCode/, "Contract A resolver ignores raw provider sport code"],
    ],
  },
  {
    file: "lib/feed/sportScoreOwnership.ts",
    functionName: "scoreOwnershipForSportFamily",
    required: [
      [/SUPPORTED_BY_SCORE_MODEL/, "supported scorer ownership is not explicit"],
      [/INTENTIONALLY_UNSCORED/, "unsupported scorer ownership is not explicit"],
    ],
  },
  {
    file: "lib/feed/sportScoreOwnership.ts",
    functionName: "hasStructuredScoredSportAuthority",
    required: [
      [/\(providerContext\.league\s*\?\?\s*null\)\s*===\s*providerSportCode/, "scorer authority does not validate nullable raw provider sport code separately"],
      [/providerContext\.sportFamily\s*===\s*providerSportFamily/, "scorer authority does not reject mismatched code/family carrier state"],
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

export function auditRequiredFunctionSource(source, functionName, required, file = "fixture.ts") {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let target = null;
  const visit = (node) => {
    if (functionNameOf(node) === functionName) target = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!target) return [`${file}:${functionName}: function not found`];
  const body = target.getText(parsed);
  return required
    .filter(([pattern]) => !pattern.test(body))
    .map(([, message]) => `${file}:${functionName}: ${message}`);
}

export function runGuard(root = ROOT) {
  const failures = [];
  for (const rule of RULES) {
    const absolute = path.join(root, rule.file);
    const source = fs.readFileSync(absolute, "utf8");
    failures.push(...auditFunctionSource(source, rule.functionName, rule.forbidden, rule.file));
  }
  for (const rule of STRUCTURED_SPORT_RULES) {
    const absolute = path.join(root, rule.file);
    const source = fs.readFileSync(absolute, "utf8");
    failures.push(...auditRequiredFunctionSource(source, rule.functionName, rule.required, rule.file));
    if (rule.functionName === "resolveModelSport") {
      const structuredIndex = source.indexOf("function resolveModelSport");
      const familyIndex = source.indexOf("diag.providerSportFamily", structuredIndex);
      const textFallbackIndex = source.indexOf("deriveSportScope(identityText)", structuredIndex);
      if (familyIndex < 0 || textFallbackIndex < 0 || familyIndex > textFallbackIndex) {
        failures.push(`${rule.file}:${rule.functionName}: legacy text precedes structured sport authority`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = runGuard();
  if (failures.length > 0) {
    console.error(`TEXT_AS_IDENTITY_AUTHORITY_GUARD_FAIL\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`TEXT_AS_IDENTITY_AUTHORITY_GUARD_PASS rules=${RULES.length + STRUCTURED_SPORT_RULES.length} classification_allowlist=${TEXT_CLASSIFICATION_ALLOWLIST.length}`);
  }
}
