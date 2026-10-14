/**
 * FORWARD_MODEL_DECISIONS_T90_V3 — research-only prospective decision producer.
 *
 * Consumes the FROZEN, model-independent EXECUTABLE_LIQUIDITY_COHORT_T90_V2 and the outputs of the existing frozen model
 * selectors (injected; never re-implemented here) and produces one explicit outcome per (physical event, model):
 * BET, SKIP, BLOCKED or NOT_APPLICABLE (sport scope). It then classifies model-specific execution authority and DB
 * first-persistence readiness against the DEPLOYED FORWARD_BET_V1 contract. It contains NO database write path. Pure.
 *
 * Invariants:
 *  - the cohort is deep-frozen and its canonical digest is proven identical before every model and after evaluation;
 *  - CAUSALITY: source observed_at <= source ingested_at <= actual decision-generation time < event T-90. The decision
 *    time is the instant the runner actually generated the decision; it is never backdated to observed_at;
 *  - CHRONOLOGY: model inputs are replayed in availability order (chronologicalClaims); a pick is claimed at the first
 *    availability instant whose prefix selects it, so no later observation can change an earlier decision;
 *  - a model's BET token is the model's OWN selected token; the research anchor is never used as a betting side;
 *  - a BET on a token with no scored source row of its own is UNPROVEN (scores/prices are never copied across tokens);
 *  - SKIP needs MODEL-SPECIFIC evaluation evidence (the candidate reached this model's own gate/predicate); general
 *    source membership is never a SKIP; missing data is BLOCKED;
 *  - a model identity is either an existing semantic version or a PROVEN effective-definition digest (selector statements,
 *    configuration, transitive dependencies, bound to the source commit); anything else is VERSION_AUTHORITY_UNPROVEN and a
 *    version is never invented;
 *  - a BET names the model's exact source row (observation + item observation); duplicate rows that disagree => BLOCKED;
 *  - EXECUTABLE needs the model's OWN registered stake + price cap, measured full-stake on its own token book with the
 *    venue minimum order and a fetched fee; no registry entry => never EXECUTABLE; LIVE Queue policy is never copied.
 */
import {
  canonicalJson, cohortDigest, measureResearchLiquidity, RESEARCH_LIQUIDITY_CONTRACT, sha256, t90CutoffMs,
  type Cohort, type CohortSelection, type MeasuredToken, type ResearchLiquidity,
} from "./executableLiquidityCohortT90";
import { buildExecutableSiblingColumns } from "../executor/t10ExecutableSiblingTelemetry";
import type { FetchOrderBookResult } from "../liquidity/types";
import type { TokenFeeScheduleResult } from "../liquidity/polymarketClient";

export const FORWARD_DECISIONS_VERSION = "FORWARD_MODEL_DECISIONS_T90_V3";

// ── deployed FORWARD_BET_V1 contract facts (migration 20261012180000_virtual_bet_forward_contract_v1) ───────────────
/** Deployed trigger: persisted - observed_at > 7200s => timing_class LATE_OR_REPLAY / HISTORICAL_REPLAY. */
export const GUARD_LATE_OR_REPLAY_MS = 7200 * 1000;
/** Safety margin between our check and the trigger's clock_timestamp() at insert. */
export const PERSIST_MARGIN_MS = 300 * 1000;
export const FORWARD_CONTRACT = Object.freeze({
  version: "FORWARD_BET_V1",
  table: "prospective_selection_shadow_runtime",
  /** CHECK prospective_shadow_forward_contract_ck: contract rows must be decision_kind='BET'. SKIP cannot be persisted. */
  decisionKinds: ["BET"] as const,
  /** Trigger DUPLICATE_ECONOMIC_UNIT + unique index (model_id, economic_unit_key): keyed on model_id, NOT model_version,
   *  across legacy AND contract LEDGER rows. A new version of the same model_id can never re-claim an event. */
  uniquenessKey: "model_id + (physical_event_key | canonical_game_key | economic_unit_key)",
  authoritativeStartSources: ["OFFICIAL_SOURCE_CONFIRMED_START", "PROVIDER_PUBLISHED_ACTUAL_START"] as const,
  firstPersistedAt: "trigger: clock_timestamp() on INSERT; immutable on UPDATE; DELETE/TRUNCATE rejected",
  t90: "NOT enforced by the deployed trigger (it only classifies timing): enforced here before any write",
  /** Independently verified deployed-DB facts (NOT unknown schema facts). Provenance is part of the fact. */
  verifiedFacts: Object.freeze({
    provenance: "Architect independent catalog read of Research DBClone nppznoujvnyjargjkmnv, PR #537 issuecomment-6169812887 (2026-10-14); column presence is re-probed read-only by the runner",
    modelVersionColumnExists: true,
    firstPersistedAtOwner: "DB (row guard sets clock_timestamp())",
    rowGuardTrigger: Object.freeze({ name: "prospective_selection_shadow_guard_row_trg", enabled: true }),
    forwardCheck: Object.freeze({ name: "prospective_shadow_forward_contract_ck", contractVersion: "FORWARD_BET_V1", decisionKind: "BET", skipAdmissible: false }),
    economicUnitUniqueIndex: Object.freeze({ name: "prospective_shadow_economic_unit_uidx", keys: ["model_id", "economic_unit_key"] as const, includesModelVersion: false }),
    legacyCollision: "the trigger rejects a new row sharing model_id and physical_event_key/canonical_game_key with a legacy row regardless of model_version",
    leadTimeAuthoritativeFrom: "authoritative_start_at",
    scheduleOnlyStartCanBeVerified: false,
  }),
});

// ── model registry views (identities come from the frozen owners; this file only names their families) ───────────

export type ModelFamily = "SAFE_PREMATCH" | "FOOTBALL_D1";
export type VersionAuthority =
  | { state: "SEMANTIC_VERSION"; source: string }
  /** A proven effective-definition digest (see ModelDefinitionManifest). It is content-derived, never a semantic version. */
  | { state: "DEFINITION_DIGEST"; source: string }
  | { state: "UNPROVEN"; reason: string };
export type ModelRef = {
  modelId: string;
  /** An existing semantic version, a proven `def-sha256:<digest>`, or the literal VERSION_AUTHORITY_UNPROVEN (never a version). */
  modelVersion: string;
  versionAuthority: VersionAuthority;
  /** Source commit the identity is bound to (HEAD at evaluation) when binding is proven; a provenance field, not a version. */
  sourceSha: string | null;
  family: ModelFamily;
  sportScope: "ALL" | "soccer" | "tennis";
  /** The auditable manifest behind a DEFINITION_DIGEST / UNPROVEN SAFE identity (null for owner-versioned models). */
  definition?: ModelDefinitionManifest | null;
};
export const VERSION_UNPROVEN = "VERSION_AUTHORITY_UNPROVEN";

// ── A. effective-definition manifest (pure; the analysis that feeds it lives in the runner) ──────────────────────

export const DEFINITION_MANIFEST_VERSION = "SAFE_DEFINITION_MANIFEST_V1";
export const DEFINITION_ANALYZER_VERSION = "SYMBOL_REACHABILITY_V1";
export const DEFINITION_VERSION_PREFIX = "def-sha256:";

export type DefinitionStatement = {
  file: string; kind: string; name: string | null;
  via: "ROOT" | "REFERENCED" | "INIT_OF_REACHED_MODULE" | "INIT_MUTATOR";
  startLine: number; endLine: number;
  /** sha256 of the statement's source text (CRLF normalised). Comments between statements and formatting outside never count. */
  sha256: string;
};
export type DefinitionPackage = { name: string; version: string | null; integrity: string | null };
export type DefinitionAnalysis = {
  analyzer: string;
  roots: ReadonlyArray<{ file: string; symbol: string }>;
  statements: readonly DefinitionStatement[];
  /** git blob SHA-1 (what `git hash-object` returns) of every reached file's executing content. */
  files: ReadonlyArray<{ path: string; blobSha1: string }>;
  packages: readonly DefinitionPackage[];
  /** `if (import.meta.url === process.argv[1]…) main()` guards: run only when the module is the process entrypoint. */
  excludedEntrypointGuards: readonly string[];
  /** Why the definition cannot be proven complete and deterministic (empty = the analysis found none). */
  unproven: readonly string[];
};
export type GitReader = { headCommit(): string | null; blobAtHead(path: string): string | null };
export type CommitBinding = { state: "BOUND" | "UNBOUND"; sourceCommit: string | null; mismatchedFiles: string[]; reason: string | null };

/** Pure. BOUND only when every reached file is byte-identical to its blob at the source commit. */
export function verifyCommitBinding(files: DefinitionAnalysis["files"], git: GitReader): CommitBinding {
  const sourceCommit = git.headCommit();
  if (!sourceCommit) return { state: "UNBOUND", sourceCommit: null, mismatchedFiles: [], reason: "NO_GIT_HEAD" };
  const mismatchedFiles = files.filter((f) => git.blobAtHead(f.path) !== f.blobSha1).map((f) => f.path).sort();
  return mismatchedFiles.length === 0
    ? { state: "BOUND", sourceCommit, mismatchedFiles, reason: null }
    : { state: "UNBOUND", sourceCommit, mismatchedFiles, reason: "DEFINITION_FILES_DIFFER_FROM_SOURCE_COMMIT" };
}

const cmpStatement = (a: DefinitionStatement, b: DefinitionStatement) => cmp(a.file, b.file) || cmp(a.sha256, b.sha256) || cmp(a.name ?? "", b.name ?? "");

/** Pure. Position-independent: only the reached statements' text, packages and the analyzer version (never line numbers or `via`). */
export function sharedDefinitionDigest(analysis: DefinitionAnalysis): string {
  return sha256({
    manifest: DEFINITION_MANIFEST_VERSION, analyzer: analysis.analyzer,
    roots: [...analysis.roots].map((r) => `${r.file}#${r.symbol}`).sort(),
    statements: [...analysis.statements].sort(cmpStatement).map((s) => ({ file: s.file, kind: s.kind, name: s.name, sha256: s.sha256 })),
    packages: [...analysis.packages].sort((a, b) => cmp(a.name, b.name)).map((p) => ({ name: p.name, version: p.version, integrity: p.integrity })),
    excluded_entrypoint_guards: [...analysis.excludedEntrypointGuards].sort(),
  });
}

/**
 * Pure. Data values of a model's imported configuration, canonicalised. Functions carry their NAME only: their logic is
 * bound by the reached statements' text (never by `Function#toString`, which would tie identity to the transpiler).
 */
export function configurationDigest(configuration: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "function") return { $fn: v.name || "anonymous" };
    if (v === undefined) return null;
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (typeof v === "number" && !Number.isFinite(v)) return { $number: String(v) };
    if (v instanceof Set) return { $set: [...v].map(norm).map(canonicalJson).sort() };
    if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [norm(k), norm(x)]).sort((a, b) => cmp(canonicalJson(a[0]), canonicalJson(b[0]))) };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return sha256(norm(configuration));
}

export type ModelDefinitionManifest = {
  manifestVersion: typeof DEFINITION_MANIFEST_VERSION; analyzer: string; modelId: string;
  /** DEFINITION_DIGEST_PROVEN: complete, deterministic and bound to the source commit. Anything else: VERSION_AUTHORITY_UNPROVEN. */
  state: "DEFINITION_DIGEST_PROVEN" | "VERSION_AUTHORITY_UNPROVEN";
  unprovenReasons: readonly string[];
  /** Every model of one shared selector function is re-identified by any change to it or its dependencies (never under-identified). */
  granularity: "SHARED_SELECTOR_STATEMENTS";
  /** The model's identity; null unless proven. */
  definitionDigest: string | null;
  /** What the digest would be; never an identity unless `state` is proven. */
  observedDigest: string;
  sharedDefinitionDigest: string; configurationDigest: string;
  commitBinding: CommitBinding;
  roots: DefinitionAnalysis["roots"]; reachedFileN: number; reachedStatementN: number;
  files: DefinitionAnalysis["files"]; packages: DefinitionAnalysis["packages"]; excludedEntrypointGuards: readonly string[];
  /** Toolchain description. NOT part of the digest. */
  runtime: Readonly<Record<string, string | null>>;
};

/** Pure. A definition is proven only if the analysis found no unprovable edge AND every reached file is at the source commit. */
export function buildModelDefinitionManifest(input: {
  modelId: string; analysis: DefinitionAnalysis; configuration: unknown; git: GitReader; runtime: Readonly<Record<string, string | null>>;
}): ModelDefinitionManifest {
  const { analysis } = input;
  const binding = verifyCommitBinding(analysis.files, input.git);
  const reasons = [...analysis.unproven];
  // A definition that reached no statement (e.g. a type-only root) identifies nothing: never "proven" by absence of evidence.
  if (analysis.statements.length === 0) reasons.push("EMPTY_DEFINITION:NO_REACHED_STATEMENT");
  if (binding.state !== "BOUND") reasons.push(`COMMIT_BINDING:${binding.reason}${binding.mismatchedFiles.length ? `:${binding.mismatchedFiles.join(",")}` : ""}`);
  const shared = sharedDefinitionDigest(analysis);
  const configuration = configurationDigest(input.configuration);
  const observedDigest = sha256({ manifest: DEFINITION_MANIFEST_VERSION, model_id: input.modelId, shared, configuration });
  const proven = reasons.length === 0;
  return {
    manifestVersion: DEFINITION_MANIFEST_VERSION, analyzer: analysis.analyzer, modelId: input.modelId,
    state: proven ? "DEFINITION_DIGEST_PROVEN" : "VERSION_AUTHORITY_UNPROVEN", unprovenReasons: reasons,
    granularity: "SHARED_SELECTOR_STATEMENTS", definitionDigest: proven ? observedDigest : null, observedDigest,
    sharedDefinitionDigest: shared, configurationDigest: configuration, commitBinding: binding,
    roots: analysis.roots, reachedFileN: analysis.files.length, reachedStatementN: analysis.statements.length,
    files: analysis.files, packages: analysis.packages, excludedEntrypointGuards: analysis.excludedEntrypointGuards, runtime: input.runtime,
  };
}

export const modelVersionOf = (m: ModelDefinitionManifest): string => m.definitionDigest ? `${DEFINITION_VERSION_PREFIX}${m.definitionDigest}` : VERSION_UNPROVEN;
export const versionAuthorityOf = (m: ModelDefinitionManifest): VersionAuthority => m.definitionDigest
  ? { state: "DEFINITION_DIGEST", source: `${m.manifestVersion}/${m.analyzer} bound to ${m.commitBinding.sourceCommit}` }
  : { state: "UNPROVEN", reason: m.unprovenReasons.join("; ") };

/** Pure. A harness (decision-procedure) identity: the same analysis over the decision functions, reported beside the models. */
export function harnessIdentity(analysis: DefinitionAnalysis, git: GitReader) {
  const manifest = buildModelDefinitionManifest({ modelId: "DECISION_PROCEDURE", analysis, configuration: null, git, runtime: {} });
  return { state: manifest.state, digest: manifest.definitionDigest, observedDigest: manifest.observedDigest, unprovenReasons: manifest.unprovenReasons, commitBinding: manifest.commitBinding, reachedFileN: manifest.reachedFileN, reachedStatementN: manifest.reachedStatementN };
}

/**
 * One frozen-selector pick's exact source row. candidateIdentity (condition::token::observed_at) can be shared by several
 * source rows; the identity is only exact when one row exists or every duplicate agrees on the selector's own columns.
 */
export type ModelSourceRow = {
  observationId: string; itemObservationId: string;
  /** ingested_at of the cited row (the earliest of agreeing duplicates). */
  ingestedAt: string;
  /** Number of distinct source rows sharing the candidate identity. */
  identityRowN: number;
  /** All duplicate rows carry identical selector-relevant columns (trivially true for one row). */
  selectorColumnsAgree: boolean;
};

/** One frozen-selector pick. candidateIdentity = `${condition_id}::${selected_token_id}::${observed_at}` (owner format). */
export type ModelBet = {
  candidateIdentity: string; conditionId: string; tokenId: string;
  /** Owner decisionAt == source observed_at of the selected row. NOT the decision-generation time. */
  observedAt: string;
  eventStart: string; entryPrice: number; modelPhysicalEventKey: string;
  /** DB `ingested_at` of the model's OWN source row; null = unproven. */
  sourceIngestedAt: string | null;
  /** The model's own exact source row (never the cohort's or the anchor's); null = unproven. */
  sourceRow: ModelSourceRow | null;
  /** First availability instant (an ingested_at watermark) whose causal prefix made the model select this pick. */
  claimInstant: string;
};

export type ModelEvaluation =
  | {
    status: "EVALUATED";
    bets: readonly ModelBet[];
    /** condition|token keys that reached THIS model's own predicate/cap stage (in its universe and sport scope). */
    predicateEvaluatedTokenKeys: ReadonlySet<string>;
    /** condition|token keys that this model's own universe gate received and rejected. */
    gateRejectedTokenKeys: ReadonlySet<string>;
    /** condition|token keys the model selected at some causal instant but whose daily cap was already spent by earlier claims. */
    capSpentTokenKeys?: ReadonlySet<string>;
  }
  | { status: "BLOCKED"; reason: string; evidence: string };

export const tokenKey = (conditionId: string, tokenId: string) => `${conditionId}|${tokenId}`;

export function parseCandidateIdentity(identity: string): { conditionId: string; tokenId: string; decisionAt: string } | null {
  const parts = identity.split("::");
  if (parts.length !== 3 || parts.some((p) => p.trim() === "")) return null;
  return { conditionId: parts[0], tokenId: parts[1], decisionAt: parts[2] };
}

// ── 0. chronological, causal replay of a frozen selector ─────────────────────────────────────────────────────────

export type AvailabilityRow = { observed_at: string; ingested_at: string };
export type PrefixSelection<P> = {
  /** Picks per model id, as the frozen selector returns them for this causal prefix. */
  picks: ReadonlyMap<string, readonly P[]>;
  /** Per model id: condition|token keys that reached the model predicate / were rejected by its gate in this prefix. */
  predicateEvaluated: ReadonlyMap<string, ReadonlySet<string>>;
  gateRejected: ReadonlyMap<string, ReadonlySet<string>>;
};
export type ChronologicalClaims<P> = {
  claims: Map<string, Array<P & { claimInstant: string }>>;
  predicateEvaluated: Map<string, Set<string>>;
  gateRejected: Map<string, Set<string>>;
  instants: number;
  /** Rows whose observed_at is after their ingested_at (impossible availability): excluded, counted. */
  inconsistentAvailabilityN: number;
  /** Picks a later prefix selected after the cap was already spent by earlier claims (never claimed). */
  capExhaustedN: number;
  /** Per model: candidate identities counted in capExhaustedN (selected, but the per-model daily cap was already spent). */
  capSpentIdentities: Map<string, Set<string>>;
};

/**
 * Pure. Replays the selector over growing causal prefixes in ingest order: at each distinct ingested_at instant t
 * the selector sees ONLY rows with ingested_at <= t (observed_at <= ingested_at is required). A pick is claimed at the
 * first t whose prefix selects it; an already-claimed physical event or a spent per-model cap is never re-opened, so
 * observations that arrive later can neither replace, add to nor reorder an earlier decision.
 */
export function chronologicalClaims<R extends AvailabilityRow, P extends { candidateIdentity: string; physicalEventKey: string }>(
  rows: readonly R[],
  modelIds: readonly string[],
  cap: number,
  selector: (prefix: readonly R[]) => PrefixSelection<P>,
): ChronologicalClaims<P> {
  const valid = rows.filter((r) => Date.parse(r.observed_at) <= Date.parse(r.ingested_at));
  const ordered = [...valid].sort((a, b) => Date.parse(a.ingested_at) - Date.parse(b.ingested_at));
  const instants = [...new Set(ordered.map((r) => Date.parse(r.ingested_at)))];
  const claims = new Map(modelIds.map((m) => [m, [] as Array<P & { claimInstant: string }>]));
  const claimedEvents = new Map(modelIds.map((m) => [m, new Set<string>()]));
  const claimedIds = new Map(modelIds.map((m) => [m, new Set<string>()]));
  const predicateEvaluated = new Map(modelIds.map((m) => [m, new Set<string>()]));
  const gateRejected = new Map(modelIds.map((m) => [m, new Set<string>()]));
  const capSpentIdentities = new Map(modelIds.map((m) => [m, new Set<string>()]));
  let capExhaustedN = 0;
  let end = 0;
  for (const t of instants) {
    while (end < ordered.length && Date.parse(ordered[end].ingested_at) <= t) end++;
    const sel = selector(ordered.slice(0, end));
    for (const m of modelIds) {
      for (const k of sel.predicateEvaluated.get(m) ?? []) predicateEvaluated.get(m)!.add(k);
      for (const k of sel.gateRejected.get(m) ?? []) gateRejected.get(m)!.add(k);
      // The selector's own order is its rank (e.g. tier then time under a daily cap): spare cap slots go rank-first.
      for (const p of sel.picks.get(m) ?? []) {
        if (claimedIds.get(m)!.has(p.candidateIdentity) || claimedEvents.get(m)!.has(p.physicalEventKey)) continue;
        if (claims.get(m)!.length >= cap) { capExhaustedN++; capSpentIdentities.get(m)!.add(p.candidateIdentity); continue; }
        claimedIds.get(m)!.add(p.candidateIdentity);
        claimedEvents.get(m)!.add(p.physicalEventKey);
        claims.get(m)!.push({ ...p, claimInstant: new Date(t).toISOString() });
      }
    }
  }
  return { claims, predicateEvaluated, gateRejected, instants: instants.length, inconsistentAvailabilityN: rows.length - valid.length, capExhaustedN, capSpentIdentities };
}

// ── 1. per (event, model) outcome ─────────────────────────────────────────────────────────────────────────────────

export type DecisionOutcome = "BET" | "SKIP" | "BLOCKED" | "NOT_APPLICABLE";
export type ModelEventDecision = {
  physicalEventId: string; sportFamily: string; eventStartIso: string; t90CutoffIso: string;
  modelId: string; modelVersion: string; versionAuthority: VersionAuthority["state"]; family: ModelFamily;
  /** The single instant this decision was actually generated (runner clock, server-bounded). */
  decisionGeneratedAt: string;
  outcome: DecisionOutcome; reason: string;
  bet: (ModelBet & {
    outcomeLabel: string; oppositeTokenId: string; providerMarketType: string; providerEventId: string;
    /** The cohort's scored source row for the model's OWN token (never the anchor's or the opposite token's). It may be a
     *  different observation of that token than the model's selected row: the model's exact row is `sourceRow` above. */
    cohortSource: { score: number | null; entryPrice: number | null; observedAt: string; ingestedAt: string; itemObservationId: string };
    isCohortAnchor: boolean;
    minutesToStartAtDecision: number;
  }) | null;
};

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const inScope = (m: ModelRef, sport: string) => m.sportScope === "ALL" || m.sportScope === sport;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
}

/** Pure. The BET must cite the model's own exact source row; duplicates that disagree make the cited row ambiguous. */
export function sourceRowEdge(bet: Pick<ModelBet, "sourceRow" | "sourceIngestedAt">): string | null {
  const row = bet.sourceRow;
  if (!row || !row.observationId || !row.itemObservationId) return "UNPROVEN_MODEL_SOURCE_ROW";
  if (row.identityRowN > 1 && !row.selectorColumnsAgree) return "MODEL_SOURCE_ROW_AMBIGUOUS";
  if (bet.sourceIngestedAt !== row.ingestedAt) return "MODEL_SOURCE_ROW_INGEST_MISMATCH";
  return null;
}

/** Pure causal check of one pick against the decision-generation instant. Returns the first failed edge or null. */
export function causalEdge(bet: Pick<ModelBet, "observedAt" | "sourceIngestedAt" | "claimInstant">, eventStartIso: string, decisionGeneratedAtMs: number): string | null {
  const observed = Date.parse(bet.observedAt);
  const cutoff = t90CutoffMs(eventStartIso);
  if (!Number.isFinite(observed)) return "UNPROVEN_SOURCE_OBSERVED_AT";
  if (bet.sourceIngestedAt === null || !Number.isFinite(Date.parse(bet.sourceIngestedAt))) return "UNPROVEN_MODEL_SOURCE_INGEST_TIME";
  const ingested = Date.parse(bet.sourceIngestedAt);
  if (observed > ingested) return "SOURCE_OBSERVED_AFTER_INGEST";
  if (Date.parse(bet.claimInstant) < ingested) return "CLAIM_BEFORE_SOURCE_INGEST";
  if (!Number.isFinite(decisionGeneratedAtMs)) return "UNPROVEN_DECISION_GENERATION_TIME";
  if (ingested > decisionGeneratedAtMs) return "DECISION_BEFORE_SOURCE_INGEST";
  if (Date.parse(bet.claimInstant) > decisionGeneratedAtMs) return "CLAIM_AFTER_DECISION_GENERATION";
  if (decisionGeneratedAtMs >= cutoff) return "DECISION_GENERATED_AT_OR_AFTER_T90";
  return null;
}

/**
 * Pure. The cohort is frozen first; evaluations are produced by the frozen selectors over their OWN source universe
 * (not over the cohort), and joined to cohort events only by exact condition|token membership.
 */
export function decideCohortModels(
  cohort: Cohort,
  models: readonly ModelRef[],
  evaluations: ReadonlyMap<string, ModelEvaluation>,
  decisionGeneratedAtMs: number,
): {
  decisions: ModelEventDecision[]; digestBefore: string; digestAfter: string;
  /** Cohort digest read BEFORE and AFTER each model's evaluation: all must equal digestBefore. */
  digestBeforeByModel: Record<string, string>; digestByModel: Record<string, string>;
  outOfCohortBets: Record<string, number>; uniquenessViolations: string[];
} {
  deepFreeze(cohort);
  const digestBefore = cohortDigest(cohort);
  const generatedIso = Number.isFinite(decisionGeneratedAtMs) ? new Date(decisionGeneratedAtMs).toISOString() : "INVALID";
  const byToken = new Map<string, { event: CohortSelection; token: MeasuredToken }>();
  for (const event of cohort.selected) for (const token of event.inventory) byToken.set(tokenKey(token.conditionId, token.tokenId), { event, token });

  const decisions: ModelEventDecision[] = [];
  const outOfCohortBets: Record<string, number> = {};
  const digestByModel: Record<string, string> = {};
  const digestBeforeByModel: Record<string, string> = {};
  const uniquenessViolations: string[] = [];
  for (const model of models) {
    const key = modelKey(model);
    digestBeforeByModel[key] = cohortDigest(cohort);
    const evaluation = evaluations.get(key) ?? { status: "BLOCKED", reason: "MODEL_EVALUATION_MISSING", evidence: "no evaluation supplied for this model" } as const;
    // Chronological first claim per physical event, under THIS model only.
    const claims = new Map<string, ModelBet>();
    if (evaluation.status === "EVALUATED") {
      const ordered = [...evaluation.bets].sort((a, b) => Date.parse(a.claimInstant) - Date.parse(b.claimInstant) || Date.parse(a.observedAt) - Date.parse(b.observedAt) || cmp(a.candidateIdentity, b.candidateIdentity));
      for (const bet of ordered) {
        const hit = byToken.get(tokenKey(bet.conditionId, bet.tokenId));
        if (!hit) { outOfCohortBets[key] = (outOfCohortBets[key] ?? 0) + 1; continue; }
        const pid = hit.event.physicalEventId;
        if (claims.has(pid)) { uniquenessViolations.push(`${key}:${pid}`); continue; }
        claims.set(pid, bet);
      }
    }
    for (const event of cohort.selected) {
      const base = {
        physicalEventId: event.physicalEventId, sportFamily: event.sportFamily, eventStartIso: event.eventStartIso, t90CutoffIso: event.t90CutoffIso,
        modelId: model.modelId, modelVersion: model.modelVersion, versionAuthority: model.versionAuthority.state, family: model.family,
        decisionGeneratedAt: generatedIso, bet: null,
      };
      if (!inScope(model, event.sportFamily)) { decisions.push({ ...base, outcome: "NOT_APPLICABLE", reason: `SPORT_SCOPE:${model.sportScope}` }); continue; }
      if (evaluation.status === "BLOCKED") { decisions.push({ ...base, outcome: "BLOCKED", reason: evaluation.reason }); continue; }
      const bet = claims.get(event.physicalEventId);
      if (!bet) {
        const keys = event.inventory.map((t) => tokenKey(t.conditionId, t.tokenId));
        // Every SKIP is the model's OWN evaluation of one of this event's tokens: most specific evidence first.
        decisions.push(keys.some((k) => evaluation.capSpentTokenKeys?.has(k))
          ? { ...base, outcome: "SKIP", reason: "MODEL_SELECTED_DAILY_CAP_SPENT" }
          : keys.some((k) => evaluation.predicateEvaluatedTokenKeys.has(k))
            ? { ...base, outcome: "SKIP", reason: "MODEL_PREDICATE_EVALUATED_NOT_SELECTED" }
            : keys.some((k) => evaluation.gateRejectedTokenKeys.has(k))
              ? { ...base, outcome: "SKIP", reason: "MODEL_GATE_EVALUATED_REJECTED" }
              : { ...base, outcome: "BLOCKED", reason: "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT" });
        continue;
      }
      const token = byToken.get(tokenKey(bet.conditionId, bet.tokenId))!.token;
      if (!token.source) { decisions.push({ ...base, outcome: "BLOCKED", reason: "UNPROVEN_MODEL_TOKEN_HAS_NO_OWN_SOURCE_ROW" }); continue; }
      if (Date.parse(bet.eventStart) !== Date.parse(event.eventStartIso)) { decisions.push({ ...base, outcome: "BLOCKED", reason: "MODEL_EVENT_START_CONTRADICTS_COHORT" }); continue; }
      // Exactness before causality: the BET must cite the one source row the model itself selected from.
      const rowEdge = sourceRowEdge(bet);
      if (rowEdge) { decisions.push({ ...base, outcome: "BLOCKED", reason: rowEdge }); continue; }
      const causal = causalEdge(bet, event.eventStartIso, decisionGeneratedAtMs);
      if (causal) { decisions.push({ ...base, outcome: "BLOCKED", reason: causal }); continue; }
      decisions.push({
        ...base, outcome: "BET", reason: "MODEL_ELIGIBLE",
        bet: {
          ...bet, outcomeLabel: token.outcome, oppositeTokenId: token.oppositeTokenId, providerMarketType: token.providerMarketType, providerEventId: token.providerEventId,
          cohortSource: { score: token.source.score, entryPrice: token.source.entryPrice, observedAt: token.source.observedAt, ingestedAt: token.source.ingestedAt, itemObservationId: token.source.itemObservationId },
          isCohortAnchor: event.anchor.conditionId === bet.conditionId && event.anchor.tokenId === bet.tokenId,
          minutesToStartAtDecision: Math.round((Date.parse(event.eventStartIso) - decisionGeneratedAtMs) / 600) / 100,
        },
      });
    }
    digestByModel[key] = cohortDigest(cohort);
  }
  decisions.sort((a, b) => cmp(a.physicalEventId, b.physicalEventId) || cmp(a.modelId, b.modelId) || cmp(a.modelVersion, b.modelVersion));
  return { decisions, digestBefore, digestAfter: cohortDigest(cohort), digestBeforeByModel, digestByModel, outOfCohortBets, uniquenessViolations };
}

export const modelKey = (m: Pick<ModelRef, "modelId" | "modelVersion">) => `${m.modelId}@${m.modelVersion}`;

// ── 2. model-specific execution authority (per BET, on the model's OWN token) ─────────────────────────────────────

export type ExecutionTier = "MODEL_ELIGIBLE" | "EXECUTABLE" | "LIVE_QUEUE_ELIGIBLE";
/** Model-specific stake/price authority, keyed by modelKey. No entry exists today; an absent entry is never defaulted. */
export type ModelEconomicsAuthority = ReadonlyMap<string, { stakeUsd: number; maxEntryPrice: number; source: string }>;
export const REGISTERED_MODEL_ECONOMICS: ModelEconomicsAuthority = new Map();

/** Pure. An approval needs a provenance string, a positive stake and a price cap strictly inside (0, 1). Nothing is defaulted. */
export function economicsState(authority: ReturnType<ModelEconomicsAuthority["get"]>): "ABSENT" | "INVALID" | "REGISTERED" {
  if (!authority) return "ABSENT";
  return authority.source.trim() !== "" && authority.stakeUsd > 0 && authority.maxEntryPrice > 0 && authority.maxEntryPrice < 1 ? "REGISTERED" : "INVALID";
}

export type ModelFullStake = {
  stakeUsd: number; maxEntryPrice: number; authoritySource: string; state: string; executable: boolean;
  vwap: number | null; shares: number | null; worstAskPrice: number | null; venueMinOrderShares: number | null;
  feeRate: number | null; feeUsd: number | null; effectiveCostPerShare: number | null;
};
export type ExecutionAssessment = {
  tierReached: ExecutionTier;
  /** The first tier NOT reached and why; null only if every tier was reached (never, today). */
  blockedAt: { tier: ExecutionTier; reason: string } | null;
  /** Model-specific full-stake measurement; null when the model has no economics authority. */
  model: ModelFullStake | null;
  /** Diagnostic only: the PROVISIONAL cohort benchmark. It never grants EXECUTABLE. */
  researchDiagnostic: Pick<ResearchLiquidity, "contractId" | "stakeUsd" | "priceLimit" | "state" | "executable" | "vwap" | "shares" | "bestAsk" | "venueMinOrderShares" | "providerBookTimestampMs" | "quoteCompletedAtLocalMs" | "quoteAgeAtCompletionMs">;
  fee: { state: "KNOWN"; rate: number; formula: string } | { state: "UNKNOWN"; reason: string };
  liveQueue: "NOT_EVALUATED_NO_AUTHORITY";
};

/**
 * Pure. EXECUTABLE only when the model's OWN registered stake fully fills on its OWN token book at or under the model's
 * OWN price cap, meets the venue minimum order, with a fetched fee, on a quote taken after the source snapshot and
 * before T-90. The provisional research benchmark is reported as a diagnostic only.
 */
export function assessExecution(
  decision: ModelEventDecision,
  book: FetchOrderBookResult | null | undefined,
  fee: TokenFeeScheduleResult | null | undefined,
  snapshotReadCompletedLocalMs: number,
  economics: ModelEconomicsAuthority = REGISTERED_MODEL_ECONOMICS,
): ExecutionAssessment {
  if (decision.outcome !== "BET" || !decision.bet) throw new Error("ASSESS_EXECUTION_REQUIRES_BET");
  const bet = decision.bet;
  const r = measureResearchLiquidity(
    { conditionId: bet.conditionId, tokenId: bet.tokenId, outcome: bet.outcomeLabel, eventStartIso: decision.eventStartIso },
    book, snapshotReadCompletedLocalMs, RESEARCH_LIQUIDITY_CONTRACT,
  );
  const feeView: ExecutionAssessment["fee"] = fee?.ok ? { state: "KNOWN", rate: fee.takerRate, formula: fee.formulaVersion } : { state: "UNKNOWN", reason: fee && !fee.ok ? fee.errorCode : "NOT_FETCHED" };
  const researchDiagnostic = {
    contractId: r.contractId, stakeUsd: r.stakeUsd, priceLimit: r.priceLimit, state: r.state, executable: r.executable, vwap: r.vwap, shares: r.shares,
    bestAsk: r.bestAsk, venueMinOrderShares: r.venueMinOrderShares, providerBookTimestampMs: r.providerBookTimestampMs,
    quoteCompletedAtLocalMs: r.quoteCompletedAtLocalMs, quoteAgeAtCompletionMs: r.quoteAgeAtCompletionMs,
  };
  const out = (tierReached: ExecutionTier, blockedAt: ExecutionAssessment["blockedAt"], model: ModelFullStake | null = null): ExecutionAssessment =>
    ({ tierReached, blockedAt, model, researchDiagnostic, fee: feeView, liveQueue: "NOT_EVALUATED_NO_AUTHORITY" });
  const authority = economics.get(modelKey(decision));
  if (decision.versionAuthority === "UNPROVEN") return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "MODEL_DEFINITION_IDENTITY_UNPROVEN" });
  const approval = economicsState(authority);
  if (approval === "ABSENT") return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "MODEL_ECONOMICS_AUTHORITY_ABSENT" });
  if (approval === "INVALID" || !authority) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "MODEL_ECONOMICS_AUTHORITY_INVALID" });
  // The walk is taken ONLY on the BET token's own book. A book for any other token is never measured, never reported as depth.
  const ownBook = book?.ok && book.book && book.book.tokenId === bet.tokenId ? book : null;
  const model: ModelFullStake = {
    stakeUsd: authority.stakeUsd, maxEntryPrice: authority.maxEntryPrice, authoritySource: authority.source,
    state: "NO_OWN_TOKEN_BOOK", executable: false, vwap: null, shares: null, worstAskPrice: null, venueMinOrderShares: null,
    feeRate: null, feeUsd: null, effectiveCostPerShare: null,
  };
  if (!ownBook) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "MODEL_TOKEN_BOOK_MISSING" }, model);
  const cols = buildExecutableSiblingColumns({
    token: { conditionId: bet.conditionId, tokenId: bet.tokenId, side: bet.outcomeLabel }, result: ownBook, fee,
    stakeUsd: authority.stakeUsd, hardCap: authority.maxEntryPrice,
  });
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  Object.assign(model, {
    state: String(cols.executable_full_stake_state), executable: cols.executable_full_stake === true,
    vwap: n(cols.full_stake_executable_vwap), shares: n(cols.full_stake_shares), worstAskPrice: n(cols.full_stake_worst_ask_price),
    venueMinOrderShares: ownBook.book?.minimumOrderSize ?? null,
    feeRate: n(cols.taker_fee_rate), feeUsd: n(cols.taker_fee_usd), effectiveCostPerShare: n(cols.taker_effective_cost_per_share),
  });
  const completed = ownBook.responseCompletedAtMs ?? null;
  const providerTs = ownBook.book!.providerTimestampMs ?? null;
  const cutoff = t90CutoffMs(decision.eventStartIso);
  if (completed === null || providerTs === null) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "QUOTE_TIMESTAMP_UNKNOWN" }, model);
  if (completed < snapshotReadCompletedLocalMs) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "QUOTE_BEFORE_SOURCE_SNAPSHOT" }, model);
  if (completed > cutoff || providerTs > cutoff) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: "QUOTE_AFTER_T90" }, model);
  if (!model.executable) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: `MODEL_FULL_STAKE:${model.state}` }, model);
  if (feeView.state !== "KNOWN" || model.effectiveCostPerShare === null) return out("MODEL_ELIGIBLE", { tier: "EXECUTABLE", reason: `FEE_UNKNOWN:${feeView.state === "UNKNOWN" ? feeView.reason : "NO_EFFECTIVE_COST"}` }, model);
  return out("EXECUTABLE", { tier: "LIVE_QUEUE_ELIGIBLE", reason: "LIVE_QUEUE_AUTHORIZATION_NOT_INHERITED" }, model);
}

// ── 3. DB first-persistence readiness against the deployed FORWARD_BET_V1 contract (no write path here) ──────────

export type PersistenceEnvironment = {
  /** Live read-only probe: every FORWARD_BET_V1 column the producer would write exists on the deployed table. */
  deployedContractColumnsVerified: boolean;
  /** Physical event keys already holding a LEDGER row (legacy or contract) per model_id: the trigger would reject them. */
  existingEconomicUnitsByModelId: ReadonlyMap<string, ReadonlySet<string>>;
  /** Reporting only: token already persisted by that existing claim (model_id -> physical_event_key -> selected_token_id|null). */
  existingClaimTokensByModelId?: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  /** Approved application-owned FORWARD_BET_V1 writer reachable from this repository boundary (null = none). */
  approvedPersistenceRoute: string | null;
  /** Event start from a registered authoritative source (deployed CHECK set); a schedule never stands in. */
  authoritativeStartSource: string | null;
};

/** A decision generated now is a NEW forward BET only if no earlier claim exists and its input is fresh; a replay never is. */
export type ForwardStatus =
  | { state: "NEW_FORWARD" }
  | { state: "HISTORICAL_REPLAY"; reasons: Array<"ALREADY_CLAIMED_FOR_MODEL_ID" | "OBSERVATION_AGED_BEYOND_GUARD" | "PAST_T90_AT_CHECK"> }
  | { state: "NOT_A_BET" };
export type ExistingClaim = "NONE" | "SAME_TOKEN" | "DIFFERENT_TOKEN" | "TOKEN_UNKNOWN";

export type PersistenceReadiness = {
  ready: boolean; firstFailedEdge: string | null; failedEdges: string[]; observationLagAtCheckMs: number; leadToT90MsAtCheck: number;
  forward: ForwardStatus;
  /** The irreversible earlier claim for this model_id and event, and whether it is on the token this producer would pick. */
  existingClaim: ExistingClaim;
  /** VERIFIED eligibility is separate from insertability: a schedule-only start cannot be relabelled VERIFIED. Never a VERIFIED claim. */
  verification: { eligible: boolean; reason: string | null };
};

export const PERSISTENCE_EDGES = [
  "CONTRACT_DECISION_KIND", "MODEL_DEFINITION_IDENTITY", "EXECUTION_AUTHORITY", "AUTHORITATIVE_START_SOURCE_REGISTERED",
  "OBSERVATION_FRESH_FOR_GUARD", "BEFORE_T90_AT_CHECK", "ECONOMIC_UNIT_UNCLAIMED_FOR_MODEL_ID",
  "DEPLOYED_CONTRACT_COLUMNS", "APPROVED_PERSISTENCE_ROUTE",
] as const;

/** Pure. Classifies a BET as a new forward claim or a historical replay; replays are never counted as new forward BETs. */
export function classifyForwardStatus(decision: ModelEventDecision, env: PersistenceEnvironment, nowMs: number): ForwardStatus {
  if (decision.outcome !== "BET" || !decision.bet) return { state: "NOT_A_BET" };
  const reasons: Array<"ALREADY_CLAIMED_FOR_MODEL_ID" | "OBSERVATION_AGED_BEYOND_GUARD" | "PAST_T90_AT_CHECK"> = [];
  if (env.existingEconomicUnitsByModelId.get(decision.modelId)?.has(decision.bet.modelPhysicalEventKey)) reasons.push("ALREADY_CLAIMED_FOR_MODEL_ID");
  const lag = nowMs - Date.parse(decision.bet.observedAt);
  if (!(Number.isFinite(lag) && lag >= 0 && lag + PERSIST_MARGIN_MS <= GUARD_LATE_OR_REPLAY_MS)) reasons.push("OBSERVATION_AGED_BEYOND_GUARD");
  if (!(t90CutoffMs(decision.eventStartIso) - nowMs > PERSIST_MARGIN_MS)) reasons.push("PAST_T90_AT_CHECK");
  return reasons.length ? { state: "HISTORICAL_REPLAY", reasons } : { state: "NEW_FORWARD" };
}

function existingClaimOf(decision: ModelEventDecision, env: PersistenceEnvironment): ExistingClaim {
  if (!decision.bet || !env.existingEconomicUnitsByModelId.get(decision.modelId)?.has(decision.bet.modelPhysicalEventKey)) return "NONE";
  const token = env.existingClaimTokensByModelId?.get(decision.modelId)?.get(decision.bet.modelPhysicalEventKey);
  return token === undefined || token === null ? "TOKEN_UNKNOWN" : token === decision.bet.tokenId ? "SAME_TOKEN" : "DIFFERENT_TOKEN";
}

/** Pure. Every edge is evaluated; `firstFailedEdge` follows the business provenance order of PERSISTENCE_EDGES. */
export function persistenceReadiness(decision: ModelEventDecision, execution: ExecutionAssessment | null, env: PersistenceEnvironment, nowMs: number): PersistenceReadiness {
  const failed: string[] = [];
  const observedMs = decision.bet ? Date.parse(decision.bet.observedAt) : NaN;
  const lag = nowMs - observedMs;
  const lead = t90CutoffMs(decision.eventStartIso) - nowMs;
  const registeredStart = !!env.authoritativeStartSource && (FORWARD_CONTRACT.authoritativeStartSources as readonly string[]).includes(env.authoritativeStartSource);
  if (!FORWARD_CONTRACT.decisionKinds.includes(decision.outcome as "BET")) failed.push("CONTRACT_DECISION_KIND");
  if (decision.versionAuthority === "UNPROVEN") failed.push("MODEL_DEFINITION_IDENTITY");
  if (!execution || (execution.tierReached !== "EXECUTABLE" && execution.tierReached !== "LIVE_QUEUE_ELIGIBLE")) failed.push("EXECUTION_AUTHORITY");
  // A null authoritative start is insertable but never VERIFIED (deployed guard); a NON-null unregistered source is rejected.
  if (env.authoritativeStartSource && !registeredStart) failed.push("AUTHORITATIVE_START_SOURCE_REGISTERED");
  if (!(Number.isFinite(lag) && lag >= 0 && lag + PERSIST_MARGIN_MS <= GUARD_LATE_OR_REPLAY_MS)) failed.push("OBSERVATION_FRESH_FOR_GUARD");
  if (!(lead > PERSIST_MARGIN_MS)) failed.push("BEFORE_T90_AT_CHECK");
  if (decision.bet && env.existingEconomicUnitsByModelId.get(decision.modelId)?.has(decision.bet.modelPhysicalEventKey)) failed.push("ECONOMIC_UNIT_UNCLAIMED_FOR_MODEL_ID");
  if (!env.deployedContractColumnsVerified) failed.push("DEPLOYED_CONTRACT_COLUMNS");
  if (!env.approvedPersistenceRoute) failed.push("APPROVED_PERSISTENCE_ROUTE");
  const ordered = PERSISTENCE_EDGES.filter((e) => failed.includes(e));
  return {
    ready: ordered.length === 0, firstFailedEdge: ordered[0] ?? null, failedEdges: ordered, observationLagAtCheckMs: lag, leadToT90MsAtCheck: lead,
    forward: classifyForwardStatus(decision, env, nowMs), existingClaim: existingClaimOf(decision, env),
    verification: registeredStart ? { eligible: true, reason: null } : { eligible: false, reason: "AUTHORITATIVE_START_NOT_PROVEN_SCHEDULE_ONLY" },
  };
}

// ── 3b. model-level readiness (independent of any single BET) ────────────────────────────────────────────────────

export const MODEL_READINESS_EDGES = ["MODEL_INPUT", "MODEL_DEFINITION_IDENTITY", "EXECUTION_AUTHORITY", "APPROVED_PERSISTENCE_ROUTE"] as const;
export type ModelReadiness = {
  modelKey: string; family: ModelFamily; versionAuthority: VersionAuthority["state"];
  /** Ordered blockers that hold for this model before any BET exists (business provenance order). */
  blockers: string[]; firstBlocker: string | null;
  /** The deployed FORWARD_BET_V1 CHECK admits decision_kind='BET' only: an audited immutable SKIP has no persistence path. */
  skipPersistence: "BLOCKED_FORWARD_BET_V1_ADMITS_BET_ONLY";
};

export function modelReadiness(
  model: ModelRef, evaluation: ModelEvaluation | undefined, economics: ModelEconomicsAuthority, env: Pick<PersistenceEnvironment, "approvedPersistenceRoute">,
): ModelReadiness {
  const blockers: string[] = [];
  if (!evaluation || evaluation.status === "BLOCKED") blockers.push(`MODEL_INPUT:${evaluation ? evaluation.reason : "MODEL_EVALUATION_MISSING"}`);
  if (model.versionAuthority.state === "UNPROVEN") blockers.push(`MODEL_DEFINITION_IDENTITY:${model.versionAuthority.reason}`);
  const approval = economicsState(economics.get(modelKey(model)));
  if (approval !== "REGISTERED") blockers.push(`EXECUTION_AUTHORITY:MODEL_ECONOMICS_AUTHORITY_${approval}`);
  if (!env.approvedPersistenceRoute) blockers.push("APPROVED_PERSISTENCE_ROUTE:NONE");
  return { modelKey: modelKey(model), family: model.family, versionAuthority: model.versionAuthority.state, blockers, firstBlocker: blockers[0] ?? null, skipPersistence: "BLOCKED_FORWARD_BET_V1_ADMITS_BET_ONLY" };
}

// ── 4. aggregate receipt (no raw identities beyond the local receipt file) ───────────────────────────────────────

export function summarizeDecisions(decisions: readonly ModelEventDecision[]) {
  const byModel: Record<string, Record<DecisionOutcome, number>> = {};
  const reasonsByModel: Record<string, Record<string, number>> = {};
  const eventsBySport: Record<string, Set<string>> = {};
  for (const d of decisions) {
    const k = modelKey(d);
    byModel[k] ??= { BET: 0, SKIP: 0, BLOCKED: 0, NOT_APPLICABLE: 0 };
    byModel[k][d.outcome]++;
    const r = (reasonsByModel[k] ??= {});
    r[`${d.outcome}:${d.reason}`] = (r[`${d.outcome}:${d.reason}`] ?? 0) + 1;
    (eventsBySport[d.sportFamily] ??= new Set()).add(d.physicalEventId);
  }
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort((a, b) => cmp(a[0], b[0])));
  return {
    model_event_evaluations: decisions.filter((d) => d.outcome !== "NOT_APPLICABLE").length,
    selected_events_by_sport: sorted(Object.fromEntries(Object.entries(eventsBySport).map(([s, ids]) => [s, ids.size]))),
    outcomes_by_model: sorted(byModel), reasons_by_model: sorted(Object.fromEntries(Object.entries(reasonsByModel).map(([k, v]) => [k, sorted(v)]))),
    bet_on_cohort_anchor_n: decisions.filter((d) => d.bet?.isCohortAnchor).length,
    bet_on_non_anchor_token_n: decisions.filter((d) => d.bet && !d.bet.isCohortAnchor).length,
  };
}
