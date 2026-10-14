// Research-only runner for FORWARD_MODEL_DECISIONS_T90_V3. Builds the frozen T-90 cohort with the existing builder, replays
// the EXISTING frozen SAFE selectors chronologically over their own causal source universe, joins them to the cohort by
// exact token, measures each model-owned BET under that model's own economics authority, and reports DB first-persistence
// readiness against the deployed FORWARD_BET_V1 contract. It contains NO database write: no approved application-owned
// FORWARD_BET_V1 writer exists on this repository boundary. Reads: Research DBClone (GET, explicit projections),
// Polymarket Gamma/CLOB (public). Writes ONE local receipt.
//   npm run research-clone:forward-model-decisions-t90 -- --out <dir>
// With `--persist-v2` (and FORWARD_DECISION_V2_WRITE=RESEARCH_DBCLONE_AUTHORIZED) the SAME pipeline persists genuine NEW forward BETs
// (5-share virtual fill on the exact token's own asks) and evaluated SKIPs through the FORWARD_DECISION_V2 contract on the Research
// DBClone only, then reads them back independently. Fees are never fetched in that mode.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import "dotenv/config";
import { buildExecutableLiquidityCohort } from "../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, buildModelDefinitionManifest, chronologicalClaims, DEFINITION_ANALYZER_VERSION, decideCohortModels, economicsState, FORWARD_CONTRACT,
  FORWARD_DECISIONS_VERSION, harnessIdentity, modelKey, modelReadiness, modelVersionOf, parseCandidateIdentity, persistenceReadiness,
  REGISTERED_MODEL_ECONOMICS, summarizeDecisions, tokenKey, versionAuthorityOf,
  type DefinitionAnalysis, type DefinitionPackage, type DefinitionStatement, type GitReader, type ModelBet, type ModelEvaluation, type ModelRef, type ModelSourceRow,
  type PersistenceEnvironment, type PrefixSelection,
} from "../lib/research/forwardModelDecisionsT90";
import { fetchOrderBooksConcurrent, fetchTokenFeeSchedule } from "../lib/liquidity/polymarketClient";
import { resolveSportFamily } from "../lib/research-clone/modelReady";
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES } from "../lib/research/inplayPaperDecisions";
import { CAP, MODEL_IDS, numberOrNull, selectedByModel, type V4EvidenceRow } from "./modeling/prospective-selection-shadow";
import { toSettlementFreeDecisionTimeCandidates } from "./modeling/factor-atlas";
import { PORTFOLIOS } from "./modeling/daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./modeling/quality-fill-portfolio-test";
import { buildSafeUniverse, QUALITY_FILL_A_SAFE_MIX_CONFIGS, type IdentityCandidate } from "./modeling/tennis-safe-comparable-leaderboard";
import { ACTIVE_D1_FOOTBALL_STRATEGIES } from "./modeling/active-d1-football-strategies";
import { cloneTarget, readSource } from "./research-t90-liquidity-cohort";
import { buildV2BetRow, buildV2SkipRow, fillVirtualShares, FORWARD_DECISION_V2, writeVerdict, type BuildContext, type VirtualFill } from "../lib/research/forwardDecisionV2";
import { dbClockMs, ledgerCounts, persistRow, readBack, readBackProof, readPriorClaims, skipEvidenceFor, type ReadBackRow, type WriterClient } from "../lib/research/forwardDecisionV2Writer";
import { classifyForwardStatus, PERSIST_MARGIN_MS, GUARD_LATE_OR_REPLAY_MS, type ModelEventDecision } from "../lib/research/forwardModelDecisionsT90";
import type { FetchOrderBookResult } from "../lib/liquidity/types";

// ── model identity authority ─────────────────────────────────────────────────────────────────────────────────────

const SAFE_OWNER = "scripts/modeling/prospective-selection-shadow.ts";
const THIS_SCRIPT = "scripts/research-forward-model-decisions-t90.ts";
const THIS_LIB = "lib/research/forwardModelDecisionsT90.ts";
const FOOTBALL_OWNERS = ["scripts/modeling/active-d1-football-strategies.ts", "scripts/modeling/football-strategy-registry.ts", "scripts/modeling/football-live-safe-rebaseline.ts"];

/** Git blob SHA-1 of a file's content (what `git hash-object` returns). */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest("hex");
}
function sourceIdentity(paths: readonly string[]): string | null {
  try {
    let head = "NO_GIT";
    try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* no git */ }
    return `${head}:${paths.map((p) => `${p}@${gitBlobSha(readFileSync(p))}`).join(",")}`;
  } catch { return null; }
}

export function gitReader(root: string): GitReader {
  const run = (args: string[]) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } };
  return { headCommit: () => run(["rev-parse", "HEAD"]), blobAtHead: (path) => run(["rev-parse", `HEAD:${path}`]) };
}

// ── effective-definition analysis ────────────────────────────────────────────────────────────────────────────────
// A source commit SHA does not identify what a model executes: the SAFE selector reaches code in other modules (including
// LIVE executor modules). The effective definition is therefore computed with the TypeScript checker as SYMBOL REACHABILITY
// from the selector's root symbols: only the top-level statements actually referenced (plus module initialisation that can
// execute or mutate reached state) count. Anything that cannot be proven complete and deterministic is reported in `unproven`
// and the identity stays VERSION_AUTHORITY_UNPROVEN: environment / process-state access, wall clock or randomness, filesystem
// or network I/O, dynamic module loading, unresolved references and packages absent from the lockfile.

export type DefinitionRoot = { file: string; symbol: string };
export type Lockfile = { packages?: Record<string, { version?: string; integrity?: string }> } | null;

const NON_VALUE_KINDS = new Set<ts.SyntaxKind>([ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ExportDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EmptyStatement]);
const DECLARATION_KINDS = new Set<ts.SyntaxKind>([...NON_VALUE_KINDS, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.ModuleDeclaration]);
const CLOCK_RANDOM_CALLEE = /^(Date\.now|Math\.random|performance\.now|crypto\.(randomUUID|randomBytes|getRandomValues)|randomUUID|randomBytes)$/;
const IO_CALLEE = /(^|\.)(readFileSync|readFile|readdirSync|readdir|existsSync|statSync|lstatSync|writeFileSync|writeFile|appendFileSync|createReadStream|createWriteStream|fetch|execFileSync|execSync|execFile|exec|spawn|spawnSync)$/;
const PROCESS_STATE = new Set(["env", "argv", "cwd", "platform", "hrtime", "stdin", "uptime", "pid"]);
const BUILTINS = new Set(builtinModules);

type SpecifierClass = { kind: "LOCAL" } | { kind: "BUILTIN" } | { kind: "PACKAGE"; name: string };
function classifySpecifier(spec: string): SpecifierClass {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) return { kind: "LOCAL" };
  if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])) return { kind: "BUILTIN" };
  const parts = spec.split("/");
  return { kind: "PACKAGE", name: spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] };
}

const statementName = (st: ts.Statement): string | null => {
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st))) return st.name?.text ?? "default";
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.map((d) => d.name.getText()).join(",");
  return null;
};
const hasEffectfulExpression = (node: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node) => { if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isAwaitExpression(n)) found = true; if (!found) ts.forEachChild(n, visit); };
  visit(node);
  return found;
};
const isEntrypointGuard = (st: ts.Statement, sf: ts.SourceFile) => {
  if (!ts.isIfStatement(st)) return false;
  const cond = st.expression.getText(sf);
  return /import\.meta\.url/.test(cond) && /process\.argv\[1\]/.test(cond);
};
const normalizedHash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

function readTsconfigOptions(root: string): ts.CompilerOptions {
  const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root).options;
}

/** Symbol-level reachability of the effective definition behind `roots`. Deterministic for a given file set and lockfile. */
export function analyzeEffectiveDefinition(input: { root: string; roots: readonly DefinitionRoot[]; compilerOptions?: ts.CompilerOptions; lockfile?: Lockfile }): DefinitionAnalysis {
  const root = resolve(input.root);
  const options: ts.CompilerOptions = {
    ...(input.compilerOptions ?? readTsconfigOptions(root)),
    noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, incremental: false, composite: false, tsBuildInfoFile: undefined,
  };
  const program = ts.createProgram([...new Set(input.roots.map((r) => resolve(root, r.file)))], options);
  const checker = program.getTypeChecker();
  const rel = (f: string) => relative(root, f).split(sep).join("/");
  const isLocal = (sf: ts.SourceFile) => !sf.isDeclarationFile && !program.isSourceFileDefaultLibrary(sf) && !program.isSourceFileFromExternalLibrary(sf)
    && !sf.fileName.includes("/node_modules/") && resolve(sf.fileName).startsWith(root + sep);
  const unproven = new Set<string>();
  const packageNames = new Set<string>();
  const excludedGuards = new Set<string>();
  const reached = new Map<ts.Statement, DefinitionStatement["via"]>();
  const work: ts.Statement[] = [];

  const notePackage = (spec: string) => { const c = classifySpecifier(spec); if (c.kind === "PACKAGE") packageNames.add(c.name); };
  const aliasSpecifiers = (symbol: ts.Symbol): string[] => {
    const out: string[] = [];
    let cur: ts.Symbol | undefined = symbol;
    for (let hop = 0; cur && (cur.flags & ts.SymbolFlags.Alias) && hop < 32; hop++) {
      for (const d of cur.declarations ?? []) {
        let n: ts.Node | undefined = d;
        while (n && !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n) && !ts.isImportEqualsDeclaration(n)) n = n.parent;
        if (n && (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
        if (n && ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
      }
      try { cur = checker.getImmediateAliasedSymbol(cur); } catch { break; }
    }
    return out;
  };
  const topLevel = (node: ts.Node): ts.Statement | null => {
    let cur: ts.Node = node;
    while (cur.parent && !ts.isSourceFile(cur.parent)) cur = cur.parent;
    return cur.parent ? (cur as ts.Statement) : null;
  };
  const add = (st: ts.Statement | null, via: DefinitionStatement["via"]) => {
    if (!st || reached.has(st) || NON_VALUE_KINDS.has(st.kind)) return;
    reached.set(st, via); work.push(st);
  };
  const addSymbol = (symbol: ts.Symbol | undefined, via: DefinitionStatement["via"]) => {
    if (!symbol) return;
    const wasAlias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
    const specs = wasAlias ? aliasSpecifiers(symbol) : [];
    specs.forEach(notePackage);
    let target = symbol;
    if (wasAlias) { try { target = checker.getAliasedSymbol(symbol); } catch { unproven.add(`UNRESOLVED_ALIAS:${specs.join(",")}`); return; } }
    const decls = target.declarations ?? [];
    if (wasAlias && decls.length === 0) {
      if (specs.some((x) => classifySpecifier(x).kind === "LOCAL")) unproven.add(`UNRESOLVED_LOCAL_REFERENCE:${specs.join(",")}`);
      return;
    }
    for (const d of decls) {
      const sf = d.getSourceFile();
      if (!isLocal(sf)) {
        const m = [...sf.fileName.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].pop();
        if (m && !m[1].startsWith("@types/") && !program.isSourceFileDefaultLibrary(sf)) packageNames.add(m[1]);
        continue;
      }
      if (ts.isSourceFile(d)) { d.statements.forEach((st) => add(st, via)); continue; }
      add(topLevel(d), via);
    }
  };
  const scan = (st: ts.Statement) => {
    const sf = st.getSourceFile();
    const where = rel(sf.fileName);
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) addSymbol(checker.getSymbolAtLocation(n), "REFERENCED");
      if (ts.isShorthandPropertyAssignment(n)) addSymbol(checker.getShorthandAssignmentValueSymbol(n), "REFERENCED");
      if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === "process" && PROCESS_STATE.has(n.name.text)) {
        unproven.add(`${n.name.text === "env" ? "ENVIRONMENT_ACCESS" : "PROCESS_STATE_ACCESS"}:${(n.parent ?? n).getText(sf).slice(0, 60)}@${where}`);
      }
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && (n.arguments?.length ?? 0) === 0) unproven.add(`CLOCK_OR_RANDOM_READ:new Date()@${where}`);
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const calleeText = callee.getText(sf);
        const arg = n.arguments[0];
        if (CLOCK_RANDOM_CALLEE.test(calleeText)) unproven.add(`CLOCK_OR_RANDOM_READ:${calleeText}@${where}`);
        if (IO_CALLEE.test(calleeText)) unproven.add(`FILESYSTEM_OR_NETWORK_IO:${calleeText}@${where}`);
        const loader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && (callee.text === "require" || callee.text === "eval"));
        if (loader && (!arg || !ts.isStringLiteralLike(arg) || (ts.isIdentifier(callee) && callee.text === "eval"))) unproven.add(`DYNAMIC_MODULE_LOADING:${n.getText(sf).slice(0, 50)}@${where}`);
        else if (loader && arg && ts.isStringLiteralLike(arg)) notePackage(arg.text);
      }
      if (ts.isNewExpression(n) && n.expression.getText(sf) === "Function") unproven.add(`DYNAMIC_MODULE_LOADING:new Function@${where}`);
      ts.forEachChild(n, visit);
    };
    visit(st);
  };

  for (const r of input.roots) {
    const sf = program.getSourceFile(resolve(root, r.file));
    const moduleSymbol = sf ? checker.getSymbolAtLocation(sf) : undefined;
    const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol).find((e) => e.name === r.symbol) : undefined;
    if (!exported) { unproven.add(`ROOT_SYMBOL_NOT_FOUND:${r.file}#${r.symbol}`); continue; }
    addSymbol(exported, "ROOT");
  }

  // Module initialisation. A non-declaration statement (expression, if, for, export default ...) of a reached module always
  // executes with it and may mutate shared state: it is part of the definition. A variable initialiser with calls is only a
  // value computation unless its transitive references touch reached state (then it could mutate it).
  const initKind = (st: ts.Statement, sf: ts.SourceFile): "UNCONDITIONAL" | "CONDITIONAL" | null => {
    if (isEntrypointGuard(st, sf)) { excludedGuards.add(rel(sf.fileName)); return null; }
    if (DECLARATION_KINDS.has(st.kind)) return null;
    if (ts.isVariableStatement(st)) return hasEffectfulExpression(st) ? "CONDITIONAL" : null;
    return "UNCONDITIONAL";
  };
  const touchesReached = (start: ts.Statement): boolean => {
    const seen = new Set<ts.Statement>([start]);
    const stack: ts.Statement[] = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      let hit = false;
      const visit = (n: ts.Node) => {
        if (hit) return;
        if (ts.isIdentifier(n) || ts.isShorthandPropertyAssignment(n)) {
          let sym = ts.isIdentifier(n) ? checker.getSymbolAtLocation(n) : checker.getShorthandAssignmentValueSymbol(n);
          if (sym && (sym.flags & ts.SymbolFlags.Alias)) { try { sym = checker.getAliasedSymbol(sym); } catch { sym = undefined; } }
          for (const d of sym?.declarations ?? []) {
            if (ts.isSourceFile(d) || !isLocal(d.getSourceFile())) continue;
            const t = topLevel(d);
            if (!t || NON_VALUE_KINDS.has(t.kind)) continue;
            if (reached.has(t)) { hit = true; return; }
            if (!seen.has(t)) { seen.add(t); stack.push(t); }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(cur);
      if (hit) return true;
    }
    return false;
  };
  // Fixpoint: reference closure; then module initialisation that executes with a reached module, or that touches reached state.
  for (let changed = true; changed;) {
    changed = false;
    while (work.length) scan(work.pop()!);
    const reachedFiles = new Set([...reached.keys()].map((st) => st.getSourceFile().fileName));
    for (const sf of program.getSourceFiles()) {
      if (!isLocal(sf)) continue;
      for (const st of sf.statements) {
        if (reached.has(st)) continue;
        const kind = initKind(st, sf);
        if (!kind) continue;
        const inReachedModule = reachedFiles.has(sf.fileName);
        if (kind === "UNCONDITIONAL" && inReachedModule) { add(st, "INIT_OF_REACHED_MODULE"); changed = true; }
        else if (touchesReached(st)) { add(st, inReachedModule ? "INIT_OF_REACHED_MODULE" : "INIT_MUTATOR"); changed = true; }
      }
    }
  }
  // Side-effect imports of reached modules execute package/module code at load.
  for (const f of new Set([...reached.keys()].map((st) => st.getSourceFile()))) {
    for (const st of f.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) continue;
      const spec = st.moduleSpecifier.text;
      if (!st.importClause) {
        notePackage(spec);
        if (classifySpecifier(spec).kind === "LOCAL" && !checker.getSymbolAtLocation(st.moduleSpecifier)) unproven.add(`UNRESOLVED_MODULE:${spec}@${rel(f.fileName)}`);
      }
    }
  }

  const statements: DefinitionStatement[] = [...reached].map(([st, via]) => {
    const sf = st.getSourceFile();
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    return { file: rel(sf.fileName), kind: ts.SyntaxKind[st.kind], name: statementName(st), via, startLine: start, endLine: end, sha256: normalizedHash(st.getText(sf)) };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine);
  const files = [...new Set(statements.map((st) => st.file))].sort().map((path) => ({ path, blobSha1: gitBlobSha(readFileSync(join(root, path))) }));
  const packages: DefinitionPackage[] = [...packageNames].sort().map((name) => {
    const entry = input.lockfile?.packages?.[`node_modules/${name}`];
    if (!entry?.version) unproven.add(`EXTERNAL_PACKAGE_NOT_IN_LOCKFILE:${name}`);
    return { name, version: entry?.version ?? null, integrity: entry?.integrity ?? null };
  });
  return { analyzer: DEFINITION_ANALYZER_VERSION, roots: input.roots, statements, files, packages, excludedEntrypointGuards: [...excludedGuards].sort(), unproven: [...unproven].sort() };
}

function readLockfile(root: string): Lockfile {
  try { return JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as Lockfile; } catch { return null; }
}
function packageVersion(root: string, name: string): string | null {
  try { return (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: string }).version ?? null; } catch { return null; }
}

/** The SAFE selector's frozen entry points: the owner's selection function and the constants that parameterise it. */
export const SAFE_DEFINITION_ROOTS: readonly DefinitionRoot[] = [
  { file: SAFE_OWNER, symbol: "selectedByModel" }, { file: SAFE_OWNER, symbol: "CAP" }, { file: SAFE_OWNER, symbol: "MODEL_IDS" },
];
/** The decision procedure (replay, join, execution, readiness): reported beside the models, never part of a model identity. */
export const HARNESS_DEFINITION_ROOTS: readonly DefinitionRoot[] = [
  { file: THIS_SCRIPT, symbol: "evaluateSafeModels" }, { file: THIS_SCRIPT, symbol: "safePrefixSelector" },
  ...["chronologicalClaims", "decideCohortModels", "causalEdge", "sourceRowEdge", "assessExecution", "persistenceReadiness", "classifyForwardStatus", "modelReadiness"].map((symbol) => ({ file: THIS_LIB, symbol })),
];

const SAFE_SCOPE: Record<string, ModelRef["sportScope"]> = { TENNIS_P50_52_SAFE: "tennis" };

/** The imported configuration (data values) behind each SAFE model, captured from the running modules. */
export function safeModelConfiguration(id: (typeof MODEL_IDS)[number]): unknown {
  const base = { cap: CAP, sportScope: SAFE_SCOPE[id] ?? "ALL" };
  switch (id) {
    case "PORTFOLIO_BROAD_SAFE": return { ...base, tiers: PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")?.tiers ?? null };
    case "QUALITY_FILL_A_SAFE": return { ...base, portfolio: QUALITY_PORTFOLIOS.QUALITY_FILL_A, liveMix: QUALITY_FILL_A_SAFE_MIX_CONFIGS[CAP] };
    case "QUALITY_FILL_D_SAFE": return { ...base, portfolio: QUALITY_PORTFOLIOS.QUALITY_FILL_D };
    default: return base;
  }
}

export type DefinitionContext = { analysis: DefinitionAnalysis; git: GitReader; runtime: Record<string, string | null> };
export function loadSafeDefinitionContext(root = process.cwd()): DefinitionContext {
  const lockfile = readLockfile(root);
  return {
    analysis: analyzeEffectiveDefinition({ root, roots: SAFE_DEFINITION_ROOTS, lockfile }), git: gitReader(root),
    runtime: { node: process.version, typescript: ts.version, tsx: packageVersion(root, "tsx"), esbuild: packageVersion(root, "esbuild"), analyzer: DEFINITION_ANALYZER_VERSION },
  };
}
export function loadHarnessIdentity(root = process.cwd()) {
  return harnessIdentity(analyzeEffectiveDefinition({ root, roots: HARNESS_DEFINITION_ROOTS, lockfile: readLockfile(root) }), gitReader(root));
}

/** SAFE identity = a PROVEN effective-definition digest or VERSION_AUTHORITY_UNPROVEN; no semantic version is ever invented. */
export function buildModels(ctx: DefinitionContext = loadSafeDefinitionContext()): ModelRef[] {
  const footballSha = sourceIdentity(FOOTBALL_OWNERS);
  return [
    ...MODEL_IDS.map((id): ModelRef => {
      const definition = buildModelDefinitionManifest({ modelId: id, analysis: ctx.analysis, configuration: safeModelConfiguration(id), git: ctx.git, runtime: ctx.runtime });
      return { modelId: id, modelVersion: modelVersionOf(definition), versionAuthority: versionAuthorityOf(definition), sourceSha: definition.commitBinding.sourceCommit, family: "SAFE_PREMATCH", sportScope: SAFE_SCOPE[id] ?? "ALL", definition };
    }),
    ...ACTIVE_D1_FOOTBALL_STRATEGIES.map((s): ModelRef => ({
      modelId: s.strategy_id, modelVersion: s.strategy_version, sourceSha: footballSha, family: "FOOTBALL_D1", sportScope: "soccer",
      versionAuthority: { state: "SEMANTIC_VERSION", source: "ACTIVE_D1_FOOTBALL_STRATEGIES.strategy_version (football-strategy-registry semantic_version / LIVE_B / D1_CAUSAL_V1)" },
    })),
  ];
}

// ── persistence environment (what this boundary can prove; every false/null is a reported edge) ──────────────────

export const APPROVED_PERSISTENCE_ROUTE: string | null = null;
export const PERSISTENCE_ROUTE_EVIDENCE =
  "FORWARD_BET_V1 writer exists only in protected Draft PR #526 (scripts/modeling/live-shadow-cycle.ts + lib/modeling/forwardBetContract.ts on claude/stoic-pasteur-c0r36x); main/this boundary has the legacy SAFE writer only (no contract_version). No manual SQL route is allowed.";
const FORWARD_COLUMNS = "row_key,row_kind,model_id,model_version,decision_kind,contract_version,physical_event_key,canonical_game_key,economic_unit_key,observed_at,decision_generated_at,scheduled_start_at,authoritative_start_at,authoritative_start_source,first_persisted_at,timing_class,timing_detail,contract_status,verification_status,observation_lag_seconds,lead_time_scheduled_seconds,lead_time_authoritative_seconds,executable_buy_price,executable_price_authority,executable_quote_at";

type Db = ReturnType<typeof createClient>;
const db = (): Db => { const { base, key } = cloneTarget(); return createClient(base, key, { auth: { persistSession: false, autoRefreshToken: false } }); };

/** Read-only: the deployed table exposes every FORWARD_BET_V1 column; count existing contract and legacy LEDGER rows. */
async function probeDeployedContract(client: Db) {
  const cols = await client.from(FORWARD_CONTRACT.table).select(FORWARD_COLUMNS).eq("contract_version", FORWARD_CONTRACT.version).limit(1);
  const contract = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("contract_version", FORWARD_CONTRACT.version);
  const versioned = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).not("model_version", "is", null);
  const legacy = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").is("contract_version", null);
  const firstPersisted = await client.from(FORWARD_CONTRACT.table).select("row_key", { count: "exact", head: true }).eq("row_kind", "LEDGER").not("first_persisted_at", "is", null);
  return {
    columns_verified: !cols.error, columns_error: cols.error?.code ?? null,
    contract_rows_n: contract.count ?? null, model_version_nonnull_rows_n: versioned.count ?? null,
    legacy_ledger_rows_n: legacy.count ?? null, ledger_rows_with_first_persisted_at_n: firstPersisted.count ?? null,
    // Independently verified (Architect catalog read), not unknown: the runner cannot read pg_catalog through PostgREST, so these
    // are carried as attested facts with their provenance; only column presence and row counts are probed live.
    attested_facts: FORWARD_CONTRACT.verifiedFacts,
  };
}

/** Physical event keys already holding a LEDGER row for each model_id (legacy or contract): the trigger rejects re-claims, and
 *  the first claim is irreversible. Also returns the token each existing claim holds (reporting only: does the replay agree?).
 *  Exact while no FORWARD_BET_V1 row exists (probe contract_rows_n); contract rows can also claim via canonical_game_key /
 *  economic_unit_key, whose derivation lives only in protected PR #526, so with contract rows this is a lower bound. */
async function readExistingEconomicUnits(client: Db, keysByModel: Map<string, Set<string>>) {
  const units = new Map<string, Set<string>>();
  const tokens = new Map<string, Map<string, string | null>>();
  for (const [modelId, keys] of keysByModel) {
    const set = new Set<string>();
    const tokenByKey = new Map<string, string | null>();
    const list = [...keys];
    for (let i = 0; i < list.length; i += 50) {
      const { data, error } = await client.from(FORWARD_CONTRACT.table).select("physical_event_key,selected_token_id").eq("row_kind", "LEDGER").eq("model_id", modelId).in("physical_event_key", list.slice(i, i + 50));
      if (error) throw new Error(`EXISTING_UNITS_READ:${error.code ?? "FAILED"}`);
      for (const r of (data ?? []) as Array<{ physical_event_key: string; selected_token_id: string | null }>) { set.add(r.physical_event_key); tokenByKey.set(r.physical_event_key, r.selected_token_id ?? null); }
    }
    units.set(modelId, set);
    tokens.set(modelId, tokenByKey);
  }
  return { units, tokens };
}

const V2_WRITE_ENV = "FORWARD_DECISION_V2_WRITE";
const V2_WRITE_TOKEN = "RESEARCH_DBCLONE_AUTHORIZED";
/** Approved research route: this runner + lib/research/forwardDecisionV2Writer.ts -> FORWARD_DECISION_V2 on the Research DBClone (insert-only). */
export const APPROVED_V2_PERSISTENCE_ROUTE = "scripts/research-forward-model-decisions-t90.ts --persist-v2 (lib/research/forwardDecisionV2Writer.ts) -> FORWARD_DECISION_V2, Research DBClone nppznoujvnyjargjkmnv, insert-only";

/** Persist-mode generation clock: the DATABASE's own clock (floor to ms), never the local one. */
async function dbGeneratedClock(client: Db): Promise<{ generatedMs: number; localMs: number; serverDateMs: number | null }> {
  const generatedMs = await dbClockMs(client as unknown as WriterClient);
  return { generatedMs, localMs: Date.now(), serverDateMs: generatedMs };
}

/** Server-bounded clock: the decision is generated no earlier than the later of the local clock and the gateway Date. */
async function serverBoundedNow(): Promise<{ generatedMs: number; localMs: number; serverDateMs: number | null }> {
  const { base, key } = cloneTarget();
  const res = await fetch(`${base}/rest/v1/${FORWARD_CONTRACT.table}?select=row_key&limit=0`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const localMs = Date.now();
  const header = res.headers.get("date");
  const serverDateMs = header ? Date.parse(header) : null;
  return { generatedMs: Math.max(localMs, serverDateMs !== null && Number.isFinite(serverDateMs) ? serverDateMs + 999 : localMs), localMs, serverDateMs };
}

// ── football D-1: prove the absence of a prospective, settlement-free input path ─────────────────────────────────

async function probeFootballInputPath(client: Db, referenceMs: number) {
  const todayMinsk = new Date(referenceMs + 3 * 3_600_000).toISOString().slice(0, 10);
  const days = await client.from("research_model_ready_days").select("model_date,status").order("model_date", { ascending: false }).limit(1);
  const upcoming = await client.from("research_model_ready_rows").select("model_date", { count: "exact", head: true }).gte("model_date", todayMinsk);
  return { today_minsk: todayMinsk, latest_model_ready_day: (days.data?.[0] as { model_date?: string } | undefined)?.model_date ?? null, model_ready_rows_for_today_or_later_n: upcoming.count ?? null };
}

/** Each of the 11 frozen D-1 football models is BLOCKED individually, with its own identity in the evidence; no predicate is touched. */
function footballBlock(probe: Awaited<ReturnType<typeof probeFootballInputPath>>, model: ModelRef): ModelEvaluation {
  return {
    status: "BLOCKED", reason: "FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT",
    evidence: `${modelKey(model)}: RunContext is built only by classifyOneDay <- research_model_ready_rows(model_date): a nightly D-1 materialization whose rows carry settlement_label and have no ingested_at column; latest MODEL_READY day=${probe.latest_model_ready_day}; rows for model_date>=${probe.today_minsk}: ${probe.model_ready_rows_for_today_or_later_n}. No other RunContext builder exists; replaying settlement-bearing rows as prospective is forbidden.`,
  };
}

// ── SAFE: chronological prefix replay over the SAFE owner's own projection ────────────────────────────────────────

const V4_COLUMNS = "observation_id,observed_at,ingested_at,item_observation_id,condition_id,selected_token_id,entry_price_num,pre_event_score_num,provider_event_id,provider_sport_family,market_type,event_title,market_question,game_start_iso,data_coverage";
const PAGE = 1000;
const LOOKBACK_HOURS = 72;
type V4Row = V4EvidenceRow & { ingested_at: string };
const minskDate = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);

/**
 * COMPLETE Minsk decision days (the owner reads whole dates) with NO event-start filter: events that already started or
 * start beyond the cohort horizon still competed for each day's cap and rank, so dropping them would let the replay
 * claim picks a real day would have cap-exhausted. Only the cohort join restricts to upcoming events.
 */
async function readSafeUniverse(client: Db, watermarkMs: number, referenceMs: number): Promise<V4Row[]> {
  const firstDay = minskDate(new Date(referenceMs - LOOKBACK_HOURS * 3_600_000).toISOString());
  const from = new Date(Date.parse(`${firstDay}T00:00:00.000Z`) - 3 * 3_600_000).toISOString();
  const rows: V4Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.from("research_evidence_page_rows").select(V4_COLUMNS)
      .gte("observed_at", from).lte("ingested_at", new Date(watermarkMs).toISOString())
      .order("observed_at", { ascending: true }).order("observation_id", { ascending: true }).order("item_observation_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`SAFE_UNIVERSE_READ:${error.code ?? "FAILED"}`);
    rows.push(...(data ?? []) as unknown as V4Row[]);
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

/** The SAFE owner's universe stage, reproduced from its own exported building blocks to expose per-model evaluation sets. */
function safeUniverseStage(rows: readonly V4Row[]) {
  const scorecard = rows.map((row) => ({
    populationId: "RESEARCH_EVIDENCE_V4", conditionId: row.condition_id, selectedTokenId: row.selected_token_id, providerEventId: row.provider_event_id,
    decisionAt: row.observed_at, entryPrice: numberOrNull(row.entry_price_num), eventStart: row.game_start_iso,
    sportFamily: resolveSportFamily({ providerSportFamily: row.provider_sport_family }), providerSportFamily: row.provider_sport_family,
    scoreLevel: numberOrNull(row.pre_event_score_num), score: EMPTY, selectedPrice: EMPTY, volumeUsd: null, leadTimeHours: null,
    marketTypeRaw: row.market_type, eventTitle: row.event_title, marketQuestion: row.market_question, dataCoverage: numberOrNull(row.data_coverage) ?? 0,
  }));
  const decisionCandidates = toSettlementFreeDecisionTimeCandidates(scorecard as never);
  const byIdentity = new Map<string, IdentityCandidate>(rows.map((r) => [`${r.condition_id}::${r.selected_token_id}::${r.observed_at}`, { createdAt: r.observed_at, structuredMarketType: r.market_type, marketText: r.market_question, eventIdentityText: r.event_title }]));
  const { safeUniverse } = buildSafeUniverse(decisionCandidates, (c, t, d) => byIdentity.get(`${c}::${t}::${d}`) ?? null);
  return { decisionCandidates, safeUniverse };
}
const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

type SafePick = { candidateIdentity: string; physicalEventKey: string; decisionTimestamp: string; eventStart: string; entryPrice: number };

export function safePrefixSelector(date: string, models: readonly ModelRef[]) {
  return (prefix: readonly V4Row[]): PrefixSelection<SafePick> => {
    const { capped } = selectedByModel(prefix, date);
    const { decisionCandidates, safeUniverse } = safeUniverseStage(prefix);
    const universeIds = new Set(safeUniverse.map((c) => c.candidateIdentity));
    const predicateEvaluated = new Map<string, Set<string>>();
    const gateRejected = new Map<string, Set<string>>();
    const picks = new Map<string, SafePick[]>();
    for (const m of models) {
      const scoped = (sport: string) => m.sportScope === "ALL" || m.sportScope === sport;
      predicateEvaluated.set(m.modelId, new Set(safeUniverse.filter((c) => scoped(c.sportFamily)).map((c) => tokenKey(c.ref!, c.candidateRef!))));
      gateRejected.set(m.modelId, new Set(decisionCandidates.filter((c) => scoped(c.sportFamily) && !universeIds.has(c.candidateIdentity)).map((c) => tokenKey(c.ref!, c.candidateRef!))));
      const chosen = capped.get(m.modelId as (typeof MODEL_IDS)[number]) ?? [];
      for (const c of chosen) if (!universeIds.has(c.candidateIdentity)) throw new Error(`SAFE_UNIVERSE_PARITY_FAILED:${m.modelId}`);
      picks.set(m.modelId, chosen.map((c) => ({ candidateIdentity: c.candidateIdentity, physicalEventKey: c.physicalEventKey, decisionTimestamp: c.decisionTimestamp, eventStart: c.eventStart, entryPrice: c.entryPrice })));
    }
    return { picks, predicateEvaluated, gateRejected };
  };
}

/** Per Minsk decision date, replay every causal prefix (ingested_at order); claims are first-in-time and never revised. */
export function evaluateSafeModels(rows: readonly V4Row[], models: readonly ModelRef[]) {
  const safe = models.filter((m) => m.family === "SAFE_PREMATCH");
  const byDate = new Map<string, V4Row[]>();
  for (const r of rows) {
    if (!r.game_start_iso) continue;
    const d = minskDate(r.observed_at);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(r);
  }
  // The model's exact source row: candidate identity (condition::token::observed_at) can be shared by several source rows.
  // The cited row is the earliest-ingested one; it is only exact if every duplicate carries the same selector-relevant
  // columns (then the pick cannot depend on which duplicate the selector saw). Disagreeing duplicates are AMBIGUOUS => BLOCKED.
  // Only rows that can enter a causal prefix (observed_at <= ingested_at) count.
  const byIdentity = new Map<string, V4Row[]>();
  for (const r of rows) {
    if (!(Date.parse(r.observed_at) <= Date.parse(r.ingested_at))) continue;
    const k = `${r.condition_id}::${r.selected_token_id}::${r.observed_at}`;
    (byIdentity.get(k) ?? byIdentity.set(k, []).get(k)!).push(r);
  }
  const selectorColumns = (r: V4Row) => JSON.stringify([r.entry_price_num, r.pre_event_score_num, r.provider_event_id, r.provider_sport_family, r.market_type, r.event_title, r.market_question, r.game_start_iso, r.data_coverage]);
  const exactRows = new Map<string, ModelSourceRow>();
  const duplicates = { duplicate_identity_n: 0, disagreeing_identity_n: 0 };
  for (const [identity, list] of byIdentity) {
    const ordered = [...list].sort((a, b) => Date.parse(a.ingested_at) - Date.parse(b.ingested_at) || (a.observation_id < b.observation_id ? -1 : a.observation_id > b.observation_id ? 1 : 0) || (a.item_observation_id < b.item_observation_id ? -1 : 1));
    const distinct = new Set(ordered.map((r) => `${r.observation_id}|${r.item_observation_id}`)).size;
    const agree = new Set(ordered.map(selectorColumns)).size === 1;
    if (distinct > 1) { duplicates.duplicate_identity_n++; if (!agree) duplicates.disagreeing_identity_n++; }
    exactRows.set(identity, { observationId: ordered[0].observation_id, itemObservationId: ordered[0].item_observation_id, ingestedAt: ordered[0].ingested_at, identityRowN: distinct, selectorColumnsAgree: agree });
  }
  const bets = new Map<string, ModelBet[]>(safe.map((m) => [m.modelId, []]));
  const predicate = new Map(safe.map((m) => [m.modelId, new Set<string>()]));
  const gate = new Map(safe.map((m) => [m.modelId, new Set<string>()]));
  const capSpent = new Map(safe.map((m) => [m.modelId, new Set<string>()]));
  const replay = { dates: 0, instants: 0, inconsistent_availability_n: 0, cap_exhausted_n: 0, ...duplicates };
  for (const [date, dayRows] of [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const r = chronologicalClaims(dayRows, safe.map((m) => m.modelId), CAP, safePrefixSelector(date, safe));
    replay.dates++; replay.instants += r.instants; replay.inconsistent_availability_n += r.inconsistentAvailabilityN; replay.cap_exhausted_n += r.capExhaustedN;
    for (const m of safe) {
      for (const k of r.predicateEvaluated.get(m.modelId) ?? []) predicate.get(m.modelId)!.add(k);
      for (const k of r.gateRejected.get(m.modelId) ?? []) gate.get(m.modelId)!.add(k);
      for (const identity of r.capSpentIdentities.get(m.modelId) ?? []) {
        const p = parseCandidateIdentity(identity);
        if (!p) throw new Error(`SAFE_CANDIDATE_IDENTITY_UNPARSEABLE:${m.modelId}`);
        capSpent.get(m.modelId)!.add(tokenKey(p.conditionId, p.tokenId));
      }
      for (const c of r.claims.get(m.modelId) ?? []) {
        const p = parseCandidateIdentity(c.candidateIdentity);
        if (!p) throw new Error(`SAFE_CANDIDATE_IDENTITY_UNPARSEABLE:${m.modelId}`);
        const sourceRow = exactRows.get(c.candidateIdentity) ?? null;
        bets.get(m.modelId)!.push({
          candidateIdentity: c.candidateIdentity, conditionId: p.conditionId, tokenId: p.tokenId, observedAt: c.decisionTimestamp, eventStart: c.eventStart,
          entryPrice: c.entryPrice, modelPhysicalEventKey: c.physicalEventKey, sourceIngestedAt: sourceRow?.ingestedAt ?? null, sourceRow, claimInstant: c.claimInstant,
        });
      }
    }
  }
  const evaluations = new Map<string, ModelEvaluation>(safe.map((m) => [modelKey(m), {
    status: "EVALUATED", bets: bets.get(m.modelId)!, predicateEvaluatedTokenKeys: predicate.get(m.modelId)!, gateRejectedTokenKeys: gate.get(m.modelId)!,
    capSpentTokenKeys: capSpent.get(m.modelId)!,
  }]));
  return { evaluations, replay };
}

// ── FORWARD_DECISION_V2 persistence (Research DBClone only; insert-only; DB owns every timing field) ───────────────

type PersistArgs = {
  client: Db; models: readonly ModelRef[]; evaluations: ReadonlyMap<string, ModelEvaluation>;
  run: Awaited<ReturnType<typeof buildExecutableLiquidityCohort>>; result: ReturnType<typeof decideCohortModels>;
  safeRows: readonly V4Row[]; books: readonly FetchOrderBookResult[]; bets: readonly ModelEventDecision[];
  clock: { generatedMs: number; localMs: number; serverDateMs: number | null };
  replay: Record<string, number>; write: (receipt: Record<string, unknown>) => string; startedMs: number;
};

const tally = (xs: readonly string[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});

async function runPersistV2(a: PersistArgs) {
  const writer = a.client as unknown as WriterClient;
  const before = await ledgerCounts(writer); // throws if the V2 migration is not deployed (skip table / columns missing)
  const safeDecisions = a.result.decisions.filter((d) => d.family === "SAFE_PREMATCH");
  const modelBy = new Map(a.models.map((m) => [modelKey(m), m]));

  // The model's own latest evaluated source row per token (causal: ingested within the snapshot watermark).
  const latest = new Map<string, V4Row>();
  for (const r of a.safeRows) {
    if (!(Date.parse(r.observed_at) <= Date.parse(r.ingested_at))) continue;
    const k = tokenKey(r.condition_id, r.selected_token_id);
    const cur = latest.get(k);
    if (!cur || Date.parse(r.ingested_at) > Date.parse(cur.ingested_at) || (r.ingested_at === cur.ingested_at && r.observed_at > cur.observed_at)) latest.set(k, r);
  }
  const sourceOf = (c: string, t: string) => {
    const r = latest.get(tokenKey(c, t));
    return r ? { observedAt: r.observed_at, ingestedAt: r.ingested_at, observationId: r.observation_id, itemObservationId: r.item_observation_id, conditionId: c, tokenId: t } : null;
  };
  const eventById = new Map(a.run.cohort.selected.map((e) => [e.physicalEventId, e]));

  // Candidate keys (for prior-claim reads): BET claims and SKIP evidence keys.
  const skipDecisions = safeDecisions.filter((d) => d.outcome === "SKIP");
  const skipEvidence = new Map<ModelEventDecision, ReturnType<typeof skipEvidenceFor>>();
  for (const d of skipDecisions) {
    const event = eventById.get(d.physicalEventId);
    skipEvidence.set(d, event ? skipEvidenceFor(d, event.inventory, a.evaluations.get(modelKey(d)), sourceOf) : null);
  }
  const keysByModel = new Map<string, Set<string>>();
  const addKey = (m: string, k: string) => (keysByModel.get(m) ?? keysByModel.set(m, new Set()).get(m)!).add(k);
  for (const d of a.bets) if (d.family === "SAFE_PREMATCH") addKey(d.modelId, d.bet!.modelPhysicalEventKey);
  for (const d of skipDecisions) { const e = skipEvidence.get(d); if (e) addKey(d.modelId, e.physicalEventKey); }
  const prior = await readPriorClaims(writer, keysByModel);

  // BET side: fresh and unclaimed -> 5-share fill on the exact token's own book.
  const env: PersistenceEnvironment = {
    deployedContractColumnsVerified: true, existingEconomicUnitsByModelId: prior.betClaims, approvedPersistenceRoute: APPROVED_V2_PERSISTENCE_ROUTE, authoritativeStartSource: null,
  };
  const bookByToken = new Map(a.books.map((b) => [b.tokenId, b]));
  const betReport = { total: 0, historical_replay: [] as string[], not_new_verdict: [] as string[], fill_blocked: [] as string[], builder_blocked: [] as string[], candidates: [] as Array<{ d: ModelEventDecision; fill: VirtualFill }> };
  const classifyAtMs = a.clock.generatedMs;
  for (const d of a.bets.filter((x) => x.family === "SAFE_PREMATCH")) {
    betReport.total++;
    const forward = classifyForwardStatus(d, env, classifyAtMs);
    if (forward.state !== "NEW_FORWARD") { betReport.historical_replay.push(...(forward.state === "HISTORICAL_REPLAY" ? forward.reasons : ["NOT_A_BET"])); continue; }
    const verdict = writeVerdict("BET", d.modelId, d.modelVersion, d.bet!.modelPhysicalEventKey, prior);
    if (verdict !== "WRITE") { betReport.not_new_verdict.push(verdict); continue; }
    const fill = fillVirtualShares(d.bet!.tokenId, bookByToken.get(d.bet!.tokenId));
    if (fill.state !== "FILLED") { betReport.fill_blocked.push(fill.reason); continue; }
    betReport.candidates.push({ d, fill });
  }

  // Seal the decisions at the DB clock AFTER the fills were measured (quote <= decision <= first persistence).
  const sealMs = await dbClockMs(writer);
  const sourceShaOf = (d: ModelEventDecision) => modelBy.get(modelKey(d))?.sourceSha ?? null;
  const ctxOf = (d: ModelEventDecision): BuildContext => ({ decisionGeneratedAtMs: sealMs, sourceSha: sourceShaOf(d), cohortDigest: a.result.digestBefore, authoritativeStart: null });

  type Planned = { kind: "BET" | "SKIP"; key: string; d: ModelEventDecision; row: Record<string, unknown> };
  const planned: Planned[] = [];
  for (const c of betReport.candidates) {
    const built = buildV2BetRow(c.d, c.fill, ctxOf(c.d));
    if (!built.ok) { betReport.builder_blocked.push(built.reason); continue; }
    planned.push({ kind: "BET", key: built.row.row_key as string, d: c.d, row: built.row });
  }
  const skipReport = { total: skipDecisions.length, evidence_missing: 0, already_persisted: 0, after_claim: 0, source_stale: 0, builder_blocked: [] as string[] };
  for (const d of skipDecisions) {
    const evidence = skipEvidence.get(d) ?? null;
    if (!evidence) { skipReport.evidence_missing++; continue; }
    const verdict = writeVerdict("SKIP", d.modelId, d.modelVersion, evidence.physicalEventKey, prior);
    if (verdict === "ALREADY_PERSISTED_SKIP") { skipReport.already_persisted++; continue; }
    if (verdict === "SKIP_AFTER_BET_CLAIM") { skipReport.after_claim++; continue; }
    if (!(sealMs - Date.parse(evidence.source.observedAt) + PERSIST_MARGIN_MS <= GUARD_LATE_OR_REPLAY_MS)) { skipReport.source_stale++; continue; }
    const built = buildV2SkipRow(d, evidence, ctxOf(d));
    if (!built.ok) { skipReport.builder_blocked.push(built.reason); continue; }
    planned.push({ kind: "SKIP", key: built.row.row_key as string, d, row: built.row });
  }

  // Insert-only. A unique violation is an idempotent no-op; trigger/CHECK rejections are reported verbatim.
  const outcomes: Array<{ kind: "BET" | "SKIP"; key: string; status: string; code?: string | null; message?: string }> = [];
  for (const p of planned) {
    const r = await persistRow(writer, p.kind, p.row as never);
    outcomes.push({ kind: p.kind, key: p.key, status: r.status, ...(r.status === "PERSISTED" ? {} : { code: r.code, message: r.message }) });
  }
  const persistedKeys = (kind: "BET" | "SKIP") => outcomes.filter((o) => o.kind === kind && o.status === "PERSISTED").map((o) => o.key);

  // Independent read-back (separate read of the stored rows, not the insert response).
  const betBack: ReadBackRow[] = await readBack(writer, "BET", persistedKeys("BET"));
  const skipBack: ReadBackRow[] = await readBack(writer, "SKIP", persistedKeys("SKIP"));
  const proofs = [...betBack, ...skipBack].map((r) => ({ row_key: r.row_key as string, ...readBackProof(r) }));
  const after = await ledgerCounts(writer);
  // Duplicate audit across legacy / V1 / V2 BET claims for every (model_id, event) we wrote or evaluated.
  const claimsAfter = await readPriorClaims(writer, keysByModel);
  const claimCount = new Map<string, number>();
  for (const [m, keys] of keysByModel) {
    for (let i = 0; i < [...keys].length; i += 50) {
      const batch = [...keys].slice(i, i + 50);
      const { data } = await (a.client as Db).from(FORWARD_DECISION_V2.ledgerTable).select("model_id,physical_event_key").eq("row_kind", "LEDGER").eq("model_id", m).in("physical_event_key", batch);
      for (const r of (data ?? []) as Array<{ model_id: string; physical_event_key: string }>) claimCount.set(`${r.model_id}|${r.physical_event_key}`, (claimCount.get(`${r.model_id}|${r.physical_event_key}`) ?? 0) + 1);
    }
  }
  const duplicateBetClaims = [...claimCount.values()].filter((n) => n > 1).length;

  const countOut = (kind: "BET" | "SKIP") => ({
    persisted: outcomes.filter((o) => o.kind === kind && o.status === "PERSISTED").length,
    idempotent_conflict: outcomes.filter((o) => o.kind === kind && o.status === "IDEMPOTENT_CONFLICT").length,
    db_rejected: tally(outcomes.filter((o) => o.kind === kind && o.status === "REJECTED").map((o) => (o.message ?? "").slice(0, 80))),
  });
  const betOut = countOut("BET");
  const skipOut = countOut("SKIP");
  const blocked = tally(a.result.decisions.filter((d) => d.outcome === "BLOCKED").map((d) => `${d.family}:${d.reason}`));
  const verified = betBack.filter((r) => r.start_verification_state === "VERIFIED_ACTUAL_START").length;
  const proofFailures = proofs.filter((p) => !p.ok);
  const label = betOut.persisted > 0 && proofFailures.length === 0 ? "NEW_FORWARD_BET_PERSISTED"
    : skipOut.persisted > 0 && proofFailures.length === 0 ? "NEW_FORWARD_SKIP_ONLY" : "EXACT_FIRST_BLOCKER";
  const firstBlocker = label !== "EXACT_FIRST_BLOCKER" ? null
    : proofFailures.length ? `READBACK_PROOF_FAILED:${proofFailures[0].failed.join(",")}`
      : betReport.total > 0 && betReport.candidates.length === 0 && skipOut.persisted === 0 ? `NO_NEW_FORWARD_BET: ${JSON.stringify(tally([...betReport.historical_replay, ...betReport.not_new_verdict]))}`
        : Object.keys(betOut.db_rejected).length || Object.keys(skipOut.db_rejected).length ? `DB_REJECTED:${JSON.stringify({ ...betOut.db_rejected, ...skipOut.db_rejected })}` : "NO_QUALIFYING_FORWARD_DECISION_IN_WINDOW";
  const summaryOut = {
    version: `${FORWARD_DECISIONS_VERSION}+${FORWARD_DECISION_V2.version}`, research_only: true, target: "nppznoujvnyjargjkmnv", result: label, first_blocker: firstBlocker,
    clock: { generation_probe_db_clock_at: new Date(a.clock.generatedMs).toISOString(), sealed_db_clock_at: new Date(sealMs).toISOString(), run_seconds: Math.round((Date.now() - a.startedMs) / 1000) },
    cohort: { digest: a.result.digestBefore, stable: new Set([a.result.digestBefore, a.result.digestAfter, ...Object.values(a.result.digestByModel)]).size === 1 },
    ledger_counts: { before, after, legacy_unchanged: before.legacy_n === after.legacy_n, v1_unchanged: before.v1_n === after.v1_n },
    bets: { model_bets_total: betReport.total, historical_replay: tally(betReport.historical_replay), already_claimed_verdict: tally(betReport.not_new_verdict), fill_blocked: tally(betReport.fill_blocked), builder_blocked: tally(betReport.builder_blocked), attempted: betReport.candidates.length - betReport.builder_blocked.length, ...betOut },
    skips: { evaluated_skip_decisions: skipReport.total, evidence_missing: skipReport.evidence_missing, already_persisted: skipReport.already_persisted, skip_after_claim: skipReport.after_claim, source_stale: skipReport.source_stale, builder_blocked: tally(skipReport.builder_blocked), ...skipOut },
    blocked_decisions_not_persisted: blocked,
    football_d1: tally(a.result.decisions.filter((d) => d.family === "FOOTBALL_D1").map((d) => `${d.outcome}:${d.reason.slice(0, 40)}`)),
    readback: { bet_rows: betBack.length, skip_rows: skipBack.length, proof_ok: proofs.length - proofFailures.length, proof_failed: proofFailures.length, start_verification: { VERIFIED_ACTUAL_START: verified, PROVISIONAL_SCHEDULED_ONLY: betBack.length + skipBack.length - verified } },
    duplicate_bet_claims_across_contracts: duplicateBetClaims, claims_after_models: claimsAfter.betClaims.size,
  };
  const file = a.write({ ...summaryOut, readback_rows: { bets: betBack, skips: skipBack }, proofs, outcomes: outcomes.map((o) => ({ ...o, key: o.key.slice(0, 24) })) });
  console.log(JSON.stringify({ file, ...summaryOut }, null, 2));
  if (label === "EXACT_FIRST_BLOCKER") process.exitCode = 3;
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (!outDir) throw new Error("--out <dir> is required (receipt contains live prospective identities; never commit it)");
  mkdirSync(outDir, { recursive: true });
  const write = (receipt: Record<string, unknown>) => {
    const file = join(outDir, `forward-model-decisions-t90-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
    writeFileSync(file, JSON.stringify(receipt, null, 2));
    return file;
  };
  const safeContext = loadSafeDefinitionContext();
  const models = buildModels(safeContext);
  const excluded = {
    control_in_play_not_prematch: CONTROL_STRATEGIES.map((s) => `${s.id}@${s.version}`),
    alpha_v0_facts_only_cannot_bet: ALPHA_PROGRAMS.map((s) => `${s.id}@${s.version}`),
  };
  try { cloneTarget(); } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const file = write({ version: FORWARD_DECISIONS_VERSION, business_pass: false, db_writes: 0, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models, excluded });
    console.log(JSON.stringify({ file, business_pass: false, first_broken_edge: `RESEARCH_DBCLONE_READ_CAPABILITY:${reason}`, models_registered: models.length }, null, 2));
    process.exit(2);
  }
  const client = db();
  const t0 = Date.now();
  const run = await buildExecutableLiquidityCohort({ readSource });
  const safeRows = await readSafeUniverse(client, run.timing.dbIngestWatermarkMs, run.timing.referenceMs);
  const { evaluations, replay } = evaluateSafeModels(safeRows, models);
  const footballProbe = await probeFootballInputPath(client, run.timing.referenceMs);
  for (const m of models) if (m.family === "FOOTBALL_D1") evaluations.set(modelKey(m), footballBlock(footballProbe, m));
  const persistV2 = process.argv.includes("--persist-v2");
  if (persistV2 && process.env[V2_WRITE_ENV] !== V2_WRITE_TOKEN) throw new Error(`V2_WRITE_NOT_AUTHORIZED: set ${V2_WRITE_ENV}=${V2_WRITE_TOKEN} (Research DBClone only)`);
  const clock = persistV2 ? await dbGeneratedClock(client) : await serverBoundedNow();
  const result = decideCohortModels(run.cohort, models, evaluations, clock.generatedMs);

  const bets = result.decisions.filter((d) => d.outcome === "BET");
  const books = await fetchOrderBooksConcurrent(bets.map((d) => d.bet!.tokenId), 6);
  if (persistV2) {
    await runPersistV2({ client, models, evaluations, run, result, safeRows, books, bets, clock, replay, write, startedMs: t0 });
    return;
  }
  const fees = await Promise.all(bets.map((d) => fetchTokenFeeSchedule(d.bet!.tokenId, { timeoutMs: 5000 })));
  const keysByModel = new Map<string, Set<string>>();
  for (const d of bets) (keysByModel.get(d.modelId) ?? keysByModel.set(d.modelId, new Set()).get(d.modelId)!).add(d.bet!.modelPhysicalEventKey);
  const contractProbe = await probeDeployedContract(client);
  const existing = await readExistingEconomicUnits(client, keysByModel);
  const env: PersistenceEnvironment = {
    deployedContractColumnsVerified: contractProbe.columns_verified,
    existingEconomicUnitsByModelId: existing.units,
    existingClaimTokensByModelId: existing.tokens,
    approvedPersistenceRoute: APPROVED_PERSISTENCE_ROUTE,
    authoritativeStartSource: null, // cohort start = scored source game_start_iso confirmed against provider schedule (scheduled-only)
  };
  const nowMs = Date.now();
  const assessed = bets.map((d, i) => {
    const execution = assessExecution(d, books[i], fees[i], run.timing.snapshotReadCompletedLocalMs);
    return { decision: d, execution, persistence: persistenceReadiness(d, execution, env, nowMs) };
  });
  const count = (xs: readonly string[]) => xs.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {});
  const firstEdges = count(assessed.map((a) => a.persistence.firstFailedEdge ?? "READY"));
  const allEdges = count(assessed.flatMap((a) => a.persistence.failedEdges));
  const executionBlocked = count(assessed.map((a) => a.execution.blockedAt?.reason ?? "NONE"));
  const forwardStatus = {
    new_forward_bet_n: assessed.filter((a) => a.persistence.forward.state === "NEW_FORWARD").length,
    historical_replay_bet_n: assessed.filter((a) => a.persistence.forward.state === "HISTORICAL_REPLAY").length,
    historical_replay_reasons: count(assessed.flatMap((a) => a.persistence.forward.state === "HISTORICAL_REPLAY" ? a.persistence.forward.reasons : [])),
  };
  const existingClaims = count(assessed.map((a) => a.persistence.existingClaim));
  const verification = { verified_label_eligible_n: assessed.filter((a) => a.persistence.verification.eligible).length, reasons: count(assessed.map((a) => a.persistence.verification.reason ?? "ELIGIBLE")) };
  const lagsS = assessed.map((a) => Math.round(a.persistence.observationLagAtCheckMs / 1000)).sort((x, y) => x - y);
  const observationLag = lagsS.length ? { min_s: lagsS[0], median_s: lagsS[Math.floor(lagsS.length / 2)], max_s: lagsS[lagsS.length - 1] } : null;
  const modelReadinessRows = models.map((m) => modelReadiness(m, evaluations.get(modelKey(m)), REGISTERED_MODEL_ECONOMICS, env));
  const summary = summarizeDecisions(result.decisions);
  const digests = new Set([result.digestBefore, result.digestAfter, ...Object.values(result.digestBeforeByModel), ...Object.values(result.digestByModel)]);
  const cohortStable = digests.size === 1;
  const harness = loadHarnessIdentity();
  const safeModels = models.filter((m) => m.family === "SAFE_PREMATCH");
  const unprovenSafe = safeModels.filter((m) => m.versionAuthority.state === "UNPROVEN");
  const evaluatedWithoutEconomics = models.filter((m) => evaluations.get(modelKey(m))?.status === "EVALUATED" && economicsState(REGISTERED_MODEL_ECONOMICS.get(modelKey(m))) !== "REGISTERED");
  const footballBlocked = models.filter((m) => m.family === "FOOTBALL_D1" && evaluations.get(modelKey(m))?.status === "BLOCKED");
  // Ordered by business provenance. The first entry is the first remaining business blocker.
  const businessBlockers: Array<{ edge: string; detail: string }> = [
    ...(!cohortStable ? [{ edge: "COHORT_DIGEST_CHANGED", detail: `${digests.size} distinct cohort digests` }] : []),
    ...(unprovenSafe.length ? [{ edge: "MODEL_DEFINITION_IDENTITY", detail: `${unprovenSafe.length}/${safeModels.length} SAFE models VERSION_AUTHORITY_UNPROVEN: ${[...new Set(unprovenSafe.flatMap((m) => m.definition?.unprovenReasons ?? []))].join("; ")}` }] : []),
    ...(evaluatedWithoutEconomics.length ? [{ edge: "EXECUTION_AUTHORITY", detail: `${evaluatedWithoutEconomics.length} evaluated models have no registered stake / price cap (MODEL_ECONOMICS_AUTHORITY_ABSENT): no BET can be EXECUTABLE` }] : []),
    ...(bets.length === 0 ? [{ edge: "NO_MODEL_ELIGIBLE_BET_IN_COHORT", detail: "no model produced a causal BET in the frozen cohort" }]
      : forwardStatus.new_forward_bet_n === 0 ? [{ edge: "NO_NEW_FORWARD_BET", detail: `all ${bets.length} BETs are historical replay (${JSON.stringify(forwardStatus.historical_replay_reasons)}); none counts as a new forward BET` }] : []),
    ...(!APPROVED_PERSISTENCE_ROUTE ? [{ edge: "APPROVED_PERSISTENCE_ROUTE", detail: PERSISTENCE_ROUTE_EVIDENCE }] : []),
    { edge: "IMMUTABLE_SKIP_CONTRACT", detail: "deployed FORWARD_BET_V1 admits decision_kind='BET' only: an audited immutable SKIP has no persistence path; uniqueness is model_id-keyed, so a re-identified model cannot re-claim an event" },
    { edge: "VERIFIED_LABEL_AUTHORITATIVE_START", detail: "cohort start is scheduled-only; a schedule cannot be relabelled VERIFIED (insertable but never VERIFIED)" },
    ...(footballBlocked.length ? [{ edge: "FOOTBALL_D1_INPUT", detail: `${footballBlocked.length} football D-1 models individually BLOCKED: no prospective settlement-free RunContext input` }] : []),
  ];
  const firstBroken = businessBlockers[0]?.edge ?? null;
  const receipt = {
    version: FORWARD_DECISIONS_VERSION, research_only: true, db_writes: 0, business_pass: false,
    clock: { decision_generated_at: new Date(clock.generatedMs).toISOString(), local_at: new Date(clock.localMs).toISOString(), server_date_header_at: clock.serverDateMs ? new Date(clock.serverDateMs).toISOString() : null, run_seconds: Math.round((nowMs - t0) / 1000) },
    cohort: { version: run.cohort.version, digest_before: result.digestBefore, digest_after: result.digestAfter, digest_before_by_model: result.digestBeforeByModel, digest_by_model: result.digestByModel, stable: cohortStable, funnel: run.funnel },
    safe_replay: { rows: safeRows.length, ...replay },
    football_input_probe: footballProbe,
    deployed_contract: { ...FORWARD_CONTRACT, probe: contractProbe, approved_persistence_route: APPROVED_PERSISTENCE_ROUTE, route_evidence: PERSISTENCE_ROUTE_EVIDENCE },
    definition_identity: { harness, safe_analysis: { analyzer: safeContext.analysis.analyzer, files: safeContext.analysis.files, statements: safeContext.analysis.statements, packages: safeContext.analysis.packages, excluded_entrypoint_guards: safeContext.analysis.excludedEntrypointGuards, unproven: safeContext.analysis.unproven } },
    models, excluded, summary, out_of_cohort_bets: result.outOfCohortBets, uniqueness_violations: result.uniquenessViolations,
    model_readiness: modelReadinessRows, forward_status: forwardStatus, existing_claim_token_agreement: existingClaims, verification, observation_lag_at_check: observationLag,
    execution_blocked_reasons: executionBlocked, persistence_first_failed_edges: firstEdges, persistence_all_failed_edges: allEdges,
    business_blockers: businessBlockers, first_broken_edge: firstBroken,
    decisions: result.decisions, bets: assessed,
  };
  const file = write(receipt);
  // Terminal: aggregates only.
  console.log(JSON.stringify({
    file, clock: receipt.clock, cohort: { ...receipt.cohort, funnel: undefined }, safe_replay: receipt.safe_replay, football_input_probe: footballProbe, deployed_contract_probe: contractProbe,
    identity: { harness, safe_models: safeModels.map((m) => ({ model: m.modelId, state: m.definition?.state, digest: m.definition?.definitionDigest ?? null, binding: m.definition?.commitBinding.state, reached_files: m.definition?.reachedFileN, reached_statements: m.definition?.reachedStatementN, unproven: m.definition?.unprovenReasons })) },
    summary, model_readiness: modelReadinessRows.map((r) => ({ model: r.modelKey, first_blocker: r.firstBlocker })), forward_status: forwardStatus, existing_claim_token_agreement: existingClaims, verification, observation_lag_at_check: observationLag,
    execution_blocked_reasons: executionBlocked, persistence_first_failed_edges: firstEdges, persistence_all_failed_edges: allEdges, business_blockers: businessBlockers, first_broken_edge: firstBroken,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
