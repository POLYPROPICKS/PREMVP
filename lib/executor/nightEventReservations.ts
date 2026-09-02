// lib/executor/nightEventReservations.ts
//
// Contur3 EVENT-FIRST night reservation planner.
//
// Around 17:00 Minsk this builds the frozen Night Portfolio Plan: it selects
// EVENTS/MATCHES (never individual markets) within the canonical 17:00→08:00
// operational window / ~18h horizon, and persists one row per event into
// night_event_reservations under a deterministic plan_run_id.
//
// It does NOT write the execution queue — per-event market selection happens later
// in eventExecutionQueue.ts at T-60/T-30 rebalance.
//
// Read input only via buildFireModelCandidates (raw universe). No 6h hardcoded
// eligibility: horizon is governed by nightWindow.ts.

import type {
  FireModelCandidate,
  FireModelSelectorMode,
  RawPlanningDiagnostics,
} from "./buildFireModelCandidates";
import {
  buildR0PlanningTrace,
  type R0PlanningTrace,
  type R0RawPlanningMetrics,
} from "./r0PlanningTrace";
import { compareCandidateQuality } from "./nightPortfolioPlanner";
import {
  createSupabaseSchedulerJobEvidencePort,
  sanitizeSchedulerErrorMessage,
  type SchedulerJobEvidencePort,
} from "./schedulerJobEvidence";
import {
  resolveNightWindow,
  buildPlanRunId,
  isWithinHorizon,
  formatMinskUtc,
  REBALANCE_MINUTES_BEFORE_START,
  PREFERRED_ENTRY_MINUTES_BEFORE,
  LATEST_ENTRY_MINUTES_BEFORE,
  type NightWindow,
} from "./nightWindow";
import type { NightEventReservationRow } from "./executorQueueTypes";
import type {
  ContractADecisionResult,
  ContractAPlanningDecision,
} from "./contractADecisions";
import {
  LIVE_RESERVATION_ALLOCATION_V1,
  rankAllocatableApprovedPhysicalEvents,
  type LiveReservationAllocationPolicy,
} from "./liveReservationAllocationPolicy";
import {
  resolvePlanningAnchorDecision,
  isEventLevelMatchupText,
  type PlanningAnchorDecision,
} from "./planningAnchor";
import {
  buildFullmatchRejectionEvidence,
  buildFullmatchRejectionPreview,
  type FullmatchRejectionCandidateCapture,
  type FullmatchRejectionEvidenceReport,
  type FullmatchRejectionGroupCapture,
  type FullmatchRejectionGroupEvidence,
} from "./fullmatchRejectionEvidence";
import {
  resolveMarketAnchorDecision,
  type MarketAnchorDecision,
  type MarketAnchorInput,
  type MarketAnchorReasonCode,
} from "@/lib/contur3/taxonomy";
import {
  buildIdentityBattleTraceId,
  buildPersistedIdentityDiagnostics,
  buildPersistedPlanningIdentityDiagnostics,
  resolveExecutableMarketIdentity,
  resolvePlanningEventIdentity,
  type ExecutableMarketIdentity,
  type PlanningEventIdentity,
  type PlanningEventIdentityReasonCode,
} from "./executableMarketIdentity";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

/** Canonical sha256/16-hex hash of a physical-event group key (canary targeting/preview only). */
export function hashPhysicalEventKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Planning universe is uncapped: buildFireModelCandidates paginates the full corpus
// in planningMode, and this ceiling only bounds the final slice. It must be far above
// the realistic candidate count so no physical match is dropped before reservation.
const PLAN_POOL = 100_000;

// Market-level terms that may appear in event_slug / match_family_key from Polymarket.
// A key containing any of these is a prop/market line, not an event reservation key.
const MARKET_LEVEL_KEY_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|halftime[\s-]result|\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|player\s+prop|goalscorer/i;

const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

// Anchor guards — applied at reservation selection to prevent forbidden live-market anchors.
// Only identity fields are inspected (market_slug, event_slug, match_family_key, diagnostics.marketTitle).
// Telemetry fields (price1hAgo, delta1hPp, etc.) are never checked here.
const CORNERS_ANCHOR_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;

const PROP_ANCHOR_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]prop|\boutright\b/i;

function isHalftimeMarket(c: FireModelCandidate): boolean {
  return (
    HALFTIME_MARKET_RE.test(c.market_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.event_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.match_family_key ?? "")
  );
}

function isCornersAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    CORNERS_ANCHOR_RE.test(c.market_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.event_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.match_family_key ?? "") ||
    CORNERS_ANCHOR_RE.test(diagTitle)
  );
}

function isPropAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    PROP_ANCHOR_RE.test(c.market_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.event_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.match_family_key ?? "") ||
    PROP_ANCHOR_RE.test(diagTitle)
  );
}

/**
 * True when the candidate is a forbidden live-market anchor.
 * Forbidden: halftime/1H, corners, exact score, goalscorer, props, outrights.
 * Allowed: full-match winner/moneyline, spread, full-match total goals.
 */
export function isForbiddenAnchorMarket(c: FireModelCandidate): boolean {
  return isHalftimeMarket(c) || isCornersAnchorMarket(c) || isPropAnchorMarket(c);
}

// Market-class and event-scope classification now live in the CANONICAL taxonomy
// (lib/contur3/taxonomy.ts). The former local ALLOWED_FULLMATCH_ANCHOR_RE and
// ESPORTS_SUBMARKET_RE lists were removed here: both were proven dead after
// fullMatchAnchorDecision was moved onto that single source of truth.
const ESPORTS_SERIES_TITLE_RE =
  /^(?:will\s+)?(?:counter-strike|dota\s*2|lol|league\s+of\s+legends|valorant)\s*:\s*(.+?)\s+(?:vs\.?|beat(?:s)?)\s+(.+?)\s*\(\s*bo(?:1|3|5)\s*\)(?:\s*[-?].*)?$/i;
// A main series-winner matchup with NO recognized game-name prefix at all
// ("Cloud9 vs LOUD (BO3)") is just as valid full-series evidence as the
// prefixed form above -- it must not be rejected merely because the provider
// didn't prefix the title with a game name. Deliberately separate from
// ESPORTS_SERIES_TITLE_RE (rather than making its prefix group optional) so a
// title carrying an UNRECOGNIZED colon-prefixed game name is still rejected,
// instead of being parsed as if the prefix were part of a competitor name.
const ESPORTS_SERIES_BARE_TITLE_RE = /^(.+?)\s+vs\.?\s+(.+?)\s*\(\s*bo(?:1|3|5)\s*\)$/i;

export type FullMatchAnchorRejectionReason =
  | "FULLMATCH_TWO_COMPETITORS_MISSING"
  | "FULLMATCH_SUBMARKET_REJECTED"
  | "FULLMATCH_SERIES_MARKER_MISSING"
  | "FULLMATCH_UNSUPPORTED_SPORT"
  | "FULLMATCH_IDENTITY_INVALID";

export type FullMatchAnchorDecision =
  | { allowed: true }
  | { allowed: false; reason: FullMatchAnchorRejectionReason };

function anchorTitle(c: FireModelCandidate): string {
  if (typeof c.providerMarketQuestion === "string" && c.providerMarketQuestion.trim()) return c.providerMarketQuestion.trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagnosticTitle: unknown = (c as any).diagnostics?.marketTitle;
  if (typeof diagnosticTitle === "string" && diagnosticTitle.trim()) return diagnosticTitle.trim();
  if (typeof c.event_slug === "string" && c.event_slug.trim()) return c.event_slug.trim();
  return typeof c.market_slug === "string" ? c.market_slug.trim() : "";
}

function providerSeriesTitle(c: FireModelCandidate): string {
  if (typeof c.providerEventTitle === "string" && c.providerEventTitle.trim()) return c.providerEventTitle.trim();
  return anchorTitle(c);
}

function canonicalEsportsSeriesCompetitors(c: FireModelCandidate): { a: string; b: string } | null {
  const title = providerSeriesTitle(c);
  const match = title.match(ESPORTS_SERIES_TITLE_RE) ?? (!title.includes(":") ? title.match(ESPORTS_SERIES_BARE_TITLE_RE) : null);
  if (!match) return null;
  const a = normTeam(match[1]);
  const b = normTeam(match[2]);
  return a && b && a !== b ? { a, b } : null;
}

/**
 * A bare two-competitor eSports matchup with NO series-length marker at all
 * ("Cloud9 vs LOUD") -- the same strict "A vs B and nothing else" shape the
 * baseball event-level planning anchor uses (isEventLevelMatchupText), so any
 * market wording, score, or segment qualifier after the matchup disqualifies
 * it identically. Only used together with a stable provider event identity
 * (event key + start time): a bare matchup with no series marker is never
 * strong enough evidence on its own.
 */
function canonicalEsportsBareMatchupCompetitors(c: FireModelCandidate): { a: string; b: string } | null {
  const title = providerSeriesTitle(c).trim();
  if (!isEventLevelMatchupText(title)) return null;
  const match = title.match(/^(.+?)\s+(?:vs\.?|v\.?)\s+(.+?)$/i);
  if (!match) return null;
  const a = normTeam(match[1]);
  const b = normTeam(match[2]);
  return a && b && a !== b ? { a, b } : null;
}

/**
 * Map the canonical anchor decision onto this module's existing rejection
 * reasons, so every downstream counter/diagnostic keeps its stable shape.
 */
function anchorReasonForCanonicalCode(
  code: MarketAnchorReasonCode
): FullMatchAnchorRejectionReason {
  switch (code) {
    case "ACTIVITY_LABEL":
    case "FORBIDDEN_MARKET_CLASS":
    case "PARTIAL_EVENT_SCOPE":
      return "FULLMATCH_SUBMARKET_REJECTED";
    case "ESPORTS_NON_POLICY":
      return "FULLMATCH_UNSUPPORTED_SPORT";
    case "UNKNOWN_MARKET_CLASS":
    default:
      return "FULLMATCH_UNSUPPORTED_SPORT";
  }
}

/** The canonical anchor evidence for a candidate (structured fields first). */
export function candidateAnchorInput(c: FireModelCandidate): MarketAnchorInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diag = ((c as any).diagnostics ?? {}) as Record<string, unknown>;
  return {
    providerMarketQuestion: c.providerMarketQuestion ?? null,
    marketTitle: typeof diag.marketTitle === "string" ? diag.marketTitle : null,
    eventTitle: c.providerEventTitle ?? (typeof diag.eventTitle === "string" ? diag.eventTitle : null),
    marketSlug: c.market_slug ?? null,
    eventSlug: c.event_slug ?? null,
    matchFamilyKey: c.match_family_key ?? null,
  };
}

/**
 * Full-match anchor eligibility, delegated to the CANONICAL taxonomy
 * (lib/contur3/taxonomy.ts) rather than a parallel regex list.
 *
 * The previous local list conflated market class with event scope: its
 * ESPORTS_SUBMARKET_RE (containing \bhandicap\b, \bo/u\b, \bover/under\b,
 * \bplayer\b, \brounds?\b) was applied to EVERY candidate regardless of sport,
 * so a full-match handicap or over/under market was rejected as a "submarket".
 * The same list simultaneously ALLOWED genuinely forbidden markets ("Total
 * cards over 4.5", "Winner group A", "CS2 major winner") because it only
 * searched for the words total/winner. Both directions are now decided by the
 * one canonical classifier.
 *
 * The canonical esports BO-series full-match allowance is preserved unchanged
 * and is still gated on inferred_sport === "esport" plus a real BO marker and
 * two identified competitors. Additionally, a bare main series-winner matchup
 * with NO series-length marker is admitted, but ONLY when the provider's own
 * structured event context supplies a stable event identity (event key +
 * start time) -- a bare matchup with neither a BO marker nor provider event
 * identity stays fail-closed exactly as before.
 */
export function fullMatchAnchorDecision(c: FireModelCandidate): FullMatchAnchorDecision {
  const canonical = resolveMarketAnchorDecision(candidateAnchorInput(c));

  // eSports approved policy admits ONLY the main series winner/moneyline
  // market class -- never a full-series spread/handicap or total, even
  // though the sport-agnostic taxonomy layer classifies those exactly like a
  // genuine full-match spread/total for every other sport (MLB/soccer/tennis
  // spread and total ARE approved there). This check runs BEFORE the generic
  // canonical.allowed shortcut below specifically so an already-canonically-
  // allowed eSports spread/total (e.g. "Series Handicap") cannot slip through
  // it.
  if (c.inferred_sport === "esport" && canonical.allowed && canonical.market_class !== "allowed_fullmatch_moneyline") {
    return { allowed: false, reason: anchorReasonForCanonicalCode("ESPORTS_NON_POLICY") };
  }

  if (canonical.allowed) return { allowed: true };

  if (c.inferred_sport === "esport" && canonical.event_scope === "full_match") {
    // Canonical esports series exception (unchanged): a real BO1/BO3/BO5
    // series between two identified competitors is a full-match anchor.
    if (/\(\s*bo(?:1|3|5)\s*\)/i.test(providerSeriesTitle(c))) {
      return canonicalEsportsSeriesCompetitors(c)
        ? { allowed: true }
        : { allowed: false, reason: "FULLMATCH_TWO_COMPETITORS_MISSING" };
    }
    // No series-length marker: admit a bare main-series matchup ONLY with a
    // stable provider event identity. providerEventKey is derived exclusively
    // from the provider's own structured event context (never a slug guess or
    // fuzzy title match) and requires a valid ISO event start time alongside
    // it -- see providerEventKeyOf in buildFireModelCandidates.ts.
    if (c.providerEventKey && c.authoritativeEventStart) {
      return canonicalEsportsBareMatchupCompetitors(c)
        ? { allowed: true }
        : { allowed: false, reason: "FULLMATCH_TWO_COMPETITORS_MISSING" };
    }
    return { allowed: false, reason: "FULLMATCH_SERIES_MARKER_MISSING" };
  }

  return { allowed: false, reason: anchorReasonForCanonicalCode(canonical.reason_code!) };
}

export function isAllowedFullMatchAnchor(c: FireModelCandidate): boolean {
  return fullMatchAnchorDecision(c).allowed;
}

/**
 * Canonical market-anchor policy used by reservation selection.
 *
 * Contract A stage candidates (PLANNING / FINAL_AUTHORITATIVE) were produced by
 * the authoritative selector, which already ran the SAME canonical helpers
 * (isActivityLabelText + fullMatchAnchorDecision) and encoded the verdict into
 * live_eligible / activity_label_detected. Read that verdict instead of
 * re-deriving it from strings -- but never blanket-allow it: a forbidden
 * activity-label / non-full-match market (the KC handicap regression) stays
 * rejected here even though its condition/token/side are fully populated.
 */
export function anchorDecisionForCandidate(c: FireModelCandidate): FullMatchAnchorDecision {
  // ── UPSTREAM AUTHORITY ────────────────────────────────────────────────────
  // A candidate carrying an explicit upstream market-policy verdict was already
  // decided by the planning selector, using this exact policy. CONSUME it. Any
  // re-derivation here would be a second, competing authority -- the defect that
  // produced NO_FULLMATCH_ANCHOR = 22 against 22 already-planned events.
  const policy = upstreamMarketPolicyOf(c);
  if (policy) {
    return policy.allowed
      ? { allowed: true }
      : { allowed: false, reason: "FULLMATCH_SUBMARKET_REJECTED" };
  }
  // An activity/volume label is never a market, at any stage.
  if (c.activity_label_detected) return { allowed: false, reason: "FULLMATCH_SUBMARKET_REJECTED" };
  // FINAL_AUTHORITATIVE candidates were produced by the authoritative selector,
  // which already ran the SAME canonical helpers (isActivityLabelText +
  // fullMatchAnchorDecision) and encoded the verdict into live_eligible. Read
  // that verdict rather than re-deriving it from strings.
  if (c.diagnostics?.contract_a_stage === "FINAL_AUTHORITATIVE") {
    if (!c.live_eligible) return { allowed: false, reason: "FULLMATCH_IDENTITY_INVALID" };
    return { allowed: true };
  }
  // PLANNING-stage candidates come from the broad 17:00 inventory: their
  // live_eligible flag reflects EXECUTION readiness (side mapping, token
  // presence) which legitimately is not settled hours before kickoff, so it
  // must not be used as an anchor verdict here. Classify the market itself.
  return fullMatchAnchorDecision(c);
}

/**
 * Fingerprint of the exact market surfaces a policy verdict was decided from.
 *
 * This is NOT a classification -- it derives no market class, no event scope
 * and no verdict. It answers one question: does this verdict still describe
 * this candidate? A consumer that rewrites a candidate's market text after the
 * planning selector stamped it is holding evidence about a different market,
 * and a verdict that no longer describes its candidate must not be trusted.
 *
 * Production never mutates a candidate between selector and reservation, so
 * this check is inert there. It exists so the authority boundary is
 * tamper-evident rather than merely conventional: a stale or hand-edited
 * verdict fails closed onto the pre-existing classification path instead of
 * waving an unexamined market through.
 */
export function marketPolicyFingerprint(input: {
  providerMarketQuestion?: string | null;
  providerEventTitle?: string | null;
  market_slug?: string | null;
  event_slug?: string | null;
  match_family_key?: string | null;
  inferred_sport?: string | null;
  activity_label_detected?: boolean;
  marketTitle?: string | null;
}): string {
  const surfaces = [
    input.providerMarketQuestion ?? "",
    input.providerEventTitle ?? "",
    input.marketTitle ?? "",
    input.market_slug ?? "",
    input.event_slug ?? "",
    input.match_family_key ?? "",
    input.inferred_sport ?? "",
    input.activity_label_detected ? "1" : "0",
  ].join(" ");
  return createHash("sha256").update(surfaces).digest("hex").slice(0, 16);
}

/** The fingerprint of the candidate as it stands right now. */
function candidateMarketPolicyFingerprint(c: FireModelCandidate): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diag = ((c as any).diagnostics ?? {}) as Record<string, unknown>;
  return marketPolicyFingerprint({
    providerMarketQuestion: c.providerMarketQuestion ?? null,
    providerEventTitle: c.providerEventTitle ?? null,
    marketTitle: typeof diag.marketTitle === "string" ? diag.marketTitle : null,
    market_slug: c.market_slug ?? null,
    event_slug: c.event_slug ?? null,
    match_family_key: c.match_family_key ?? null,
    inferred_sport: c.inferred_sport ?? null,
    activity_label_detected: c.activity_label_detected,
  });
}

/**
 * The upstream market-policy verdict carried by a planning candidate, or null
 * when this candidate predates the contract (legacy fixtures, CONTUR3_CURRENT
 * live path) or when the verdict no longer describes the candidate it is
 * attached to. Null is what keeps the pre-contract classification path alive;
 * a present, matching verdict is authoritative and is never re-derived.
 */
function upstreamMarketPolicyOf(c: FireModelCandidate) {
  const policy = c.diagnostics?.market_policy ?? null;
  if (policy === null) return null;
  if (policy.anchor_fingerprint !== candidateMarketPolicyFingerprint(c)) return null;
  return policy;
}

/** True when the planning selector explicitly APPROVED this candidate. */
function isUpstreamApproved(c: FireModelCandidate): boolean {
  return upstreamMarketPolicyOf(c)?.allowed === true;
}

/** True when the planning selector explicitly REJECTED this candidate. */
function isUpstreamRejected(c: FireModelCandidate): boolean {
  return upstreamMarketPolicyOf(c)?.allowed === false;
}

/**
 * The canonical anchor evidence for a candidate, WITHOUT re-classifying one
 * that upstream already decided. For an approved candidate the market class and
 * event scope are read verbatim from the upstream verdict, so the diagnostic
 * counters below describe the decision that was actually made rather than a
 * second opinion this stage has no authority to form.
 */
function anchorEvidenceForCandidate(c: FireModelCandidate): MarketAnchorDecision {
  const policy = upstreamMarketPolicyOf(c);
  if (policy) {
    return {
      market_class: policy.market_class,
      event_scope: policy.event_scope,
      allowed: policy.allowed,
      reason_code: policy.allowed ? null : (policy.reason_code as MarketAnchorReasonCode),
      evidence_source: "structured",
    };
  }
  return resolveMarketAnchorDecision(candidateAnchorInput(c));
}

// Founder live-slot policy: try to fill at least this many live slots when eligible
// candidates exist. Tier1 first; Tier2 then Tier3 only as explicit fallback to reach
// the target. Fallback never uses forbidden market classes.
const TARGET_LIVE_SLOTS = LIVE_RESERVATION_ALLOCATION_V1.targetReservationSlots;

function eventTierOf(c: FireModelCandidate): "TIER1" | "TIER2" | "TIER3" | "REJECTED" {
  if (c.strategy === "TIER1_CORE_STRICT_72_COV50") return "TIER1";
  if (c.strategy === "TIER2_SAFE_EXPAND_60_COV50") return "TIER2";
  if (c.strategy === "TIER3_MICRO_EXPAND_50_COV25") return "TIER3";
  return "REJECTED";
}

// Canonical physical-match-key forms. A single physical game can surface under several
// key shapes; all of them must collapse to ONE reservation:
//   pair:<team-a>-vs-<team-b>:<date>          (strong)
//   fifwc-...                                  (strong)
//   WEAK_SINGLE_TEAM_SPREAD:<team>:<date>      (spread side of a game — full-match)
//   WEAK_SINGLE_TEAM_MATCH_WINNER:<team>       (moneyline side of a game — full-match)
// Weak single-team keys are NOT discarded: when the opponent pair exists they merge into
// it; otherwise they remain their own physical match so the Tier1 full-match invariant
// still produces a reservation. Pure condition-id keys with no canonical identity (and no
// clean canonical_event_key) are the only forms that cannot become a reservation.
const PAIR_KEY_RE = /^pair:([\w-]+)-vs-([\w-]+):(\d{4}-\d{2}-\d{2})$/;
const RAW_VS_KEY_RE = /^(.+?)\s+vs\.?\s+(.+?)$/i;
const WEAK_SPREAD_KEY_RE = /^WEAK_SINGLE_TEAM_SPREAD:([\w-]+):(\d{4}-\d{2}-\d{2})$/;
const WEAK_MATCH_WINNER_KEY_RE = /^WEAK_SINGLE_TEAM_MATCH_WINNER:(.+)$/;

function normTeam(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract (teamA, teamB, date) from a candidate whose key is a two-team game in any
 * shape: pair:a-vs-b:date, or a raw "a vs b"/"a vs. b" event slug (date from game_start).
 * Returns null for fifwc-*, weak single-team, and non-pair keys.
 */
function extractTeamsDate(c: FireModelCandidate): { a: string; b: string; date: string } | null {
  const k = c.match_family_key;
  if (k.startsWith("WEAK_") || k.startsWith("fifwc-")) return null;
  const pm = k.match(PAIR_KEY_RE);
  if (pm) return { a: pm[1], b: pm[2], date: pm[3] };
  const gameStart = c.diagnostics?.game_start_iso ?? "";
  const date = gameStart ? gameStart.slice(0, 10) : "nodate";
  const vs = k.match(RAW_VS_KEY_RE);
  if (vs) {
    const a = normTeam(vs[1]);
    const b = normTeam(vs[2]);
    if (a && b) return { a, b, date };
  }
  // eSports-only: canonicalEsportsBareMatchupCompetitors has no BO-marker
  // requirement, so gating it on inferred_sport === "esport" is required --
  // otherwise it would also match plain "A vs B" text for every other sport
  // and override a candidate's own explicitly-assigned match_family_key with
  // a re-derived representative key.
  if (c.inferred_sport === "esport") {
    const esports = canonicalEsportsSeriesCompetitors(c) ?? canonicalEsportsBareMatchupCompetitors(c);
    if (esports) return { ...esports, date };
  }
  return null;
}

/** Order-independent signature for a two-team game on a date. */
function teamsSig(a: string, b: string, date: string): string {
  return [a, b].slice().sort().join("--") + ":" + date;
}

/**
 * Build the physical-match index over the FULL universe. Every two-team game (regardless
 * of key shape or team order) maps to ONE canonical representative `pair:a-vs-b:date` key,
 * so duplicates and order-variants collapse to a single reservation. Weak single-team
 * SPREAD/MATCH_WINNER keys can then merge into the representative via team(+date).
 */
function buildPhysicalMatchIndex(universe: FireModelCandidate[]): {
  repBySig: Map<string, string>;
  repByTeamDate: Map<string, string>;
  repByTeam: Map<string, Set<string>>;
} {
  const repBySig = new Map<string, string>();
  const repByTeamDate = new Map<string, string>();
  const repByTeam = new Map<string, Set<string>>();
  for (const c of universe) {
    const td = extractTeamsDate(c);
    if (!td) continue;
    const sig = teamsSig(td.a, td.b, td.date);
    if (!repBySig.has(sig)) {
      const rep = `pair:${td.a}-vs-${td.b}:${td.date}`;
      repBySig.set(sig, rep);
      repByTeamDate.set(`${td.a}:${td.date}`, rep);
      repByTeamDate.set(`${td.b}:${td.date}`, rep);
      for (const t of [td.a, td.b]) {
        const set = repByTeam.get(t) ?? new Set<string>();
        set.add(rep);
        repByTeam.set(t, set);
      }
    }
  }
  return { repBySig, repByTeamDate, repByTeam };
}

/**
 * True when the candidate's key or slug is a market-level prop line, not an event identifier.
 * These must never become reservation keys — they are deferred to the rebalance market-selection.
 */
function isMarketLevelKey(c: FireModelCandidate): boolean {
  return (
    MARKET_LEVEL_KEY_RE.test(c.match_family_key) ||
    MARKET_LEVEL_KEY_RE.test(c.event_slug ?? "") ||
    MARKET_LEVEL_KEY_RE.test(c.market_slug ?? "")
  );
}

/**
 * Derive a clean human-readable event title from the canonical reservation key.
 * For pair:* keys, builds "<team a> vs <team b>" from the slug.
 * Falls back to stripping market-level suffixes from the candidate's own slug.
 */
const MARKET_LEVEL_SUFFIX_RE =
  /\s*[-:]\s*(halftime\s+result|half[\s-]time\s+result|first[\s-]half|1st[\s-]half|o\/u[\s\d.]*|over\/under[\s\d.]*|total\s+corners|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|goalscorer)\s*$/i;

function cleanReservationEventTitle(candidate: FireModelCandidate, canonicalKey: string): string {
  // Derive title from pair:<team-a>-vs-<team-b>:<date>
  const pairMatch = canonicalKey.match(/^pair:(.+):\d{4}-\d{2}-\d{2}$/);
  if (pairMatch) {
    const teamsPart = pairMatch[1];
    const vsIdx = teamsPart.indexOf("-vs-");
    if (vsIdx !== -1) {
      const teamA = teamsPart.slice(0, vsIdx).replace(/-/g, " ");
      const teamB = teamsPart.slice(vsIdx + 4).replace(/-/g, " ");
      return `${teamA} vs ${teamB}`;
    }
  }
  // Fallback: strip market-level suffixes from candidate slug
  const raw = candidate.event_slug ?? candidate.market_slug ?? canonicalKey;
  return raw.replace(MARKET_LEVEL_SUFFIX_RE, "").trim();
}

/**
 * Attempt to derive a canonical event group key for a market-level candidate.
 * Returns the canonical_event_key if it is clean (pair:* or fifwc-* prefix, no market-level text).
 * Returns null when no safe canonical key can be derived — caller should skip.
 */
function normalizedEventKey(c: FireModelCandidate): string | null {
  const ck = c.canonical_event_key;
  if (!ck) return null;
  if (MARKET_LEVEL_KEY_RE.test(ck)) return null;
  // Accept pair:* or fifwc-* as canonical
  if (ck.startsWith("pair:") || ck.startsWith("fifwc-")) return ck;
  return null;
}

/** Stage at which the planning funnel first reached zero (R0F diagnostics). */
export type PlanningFunnelStage =
  | "SOURCE_ROWS"
  | "NORMALIZED_PHYSICAL_EVENTS"
  // R0H: the gates buildReservationPlan actually applies, in application order.
  // A zero plan must name the gate that emptied it -- "PLANNING_ELIGIBLE_EVENTS"
  // conflated the executable-anchor, full-match-anchor and identity gates.
  | "EXECUTABLE_ANCHOR_ELIGIBLE"
  | "FULLMATCH_ANCHOR_ELIGIBLE"
  | "PLANNING_IDENTITY_ELIGIBLE"
  | "TIMING_ELIGIBLE"
  | "SLOT_ELIGIBLE"
  | "PLANNING_ELIGIBLE_EVENTS"
  | "RESERVATIONS_CREATED";

export interface ReservationPlan {
  plan_run_id: string;
  plan_date_minsk: string;
  window: NightWindow;
  reservations: NightEventReservationRow[];
  /**
   * R0I: complete bounded evidence for groups the full-match gate rejected.
   * Deliberately OUTSIDE `diagnostics` -- only the totals and a 3x3 preview
   * reach job_runs.diagnostics and the HTTP response; the full payload belongs
   * to the filesystem diagnostic report so the JSONB column is not enlarged.
   */
  fullmatch_rejection: FullmatchRejectionEvidenceReport;
  diagnostics: {
    universe_size: number;
    // ── Upstream authority boundary ──────────────────────────────────────
    // What reservation RECEIVED versus what it was allowed to consume. These
    // make the boundary auditable from one row: reservation can no longer
    // claim ownership of FULLMATCH_ANCHOR_ELIGIBLE / NO_FULLMATCH_ANCHOR for
    // input the planning selector already approved.
    upstream_approved_candidates: number;
    upstream_rejected_candidates_dropped: number;
    unique_physical_events: number;
    duplicate_events_removed: number;
    // slot_candidates_considered already exists in the R0H funnel block below
    // and is deliberately NOT duplicated here.
    slot_allocated: number;
    slot_remaining: number;
    event_groups: number;
    canonical_event_groups: number;
    reserved_count: number;
    by_sport: Record<string, number>;
    by_tier: Record<string, number>;
    skipped_outside_horizon: number;
    skipped_weak_key: number;
    skipped_non_tier1_event: number;
    skipped_no_executable_anchor: number;
    skipped_no_fullmatch_anchor: number;
    // R0F: physical-event groups with an allowed anchor but no complete
    // PLANNING identity, so they never consumed a slot.
    skipped_no_planning_identity: number;
    planning_rejection_reasons: Partial<Record<PlanningEventIdentityReasonCode, number>>;
    /** Groups whose authoritative T-90 identity already existed at plan time. */
    identity_complete_count: number;
    // ── R0F structured planning funnel (a zero plan names its first zero stage) ──
    source_rows: number;
    rows_after_horizon: number;
    normalized_physical_events: number;
    physical_event_groups: number;
    authoritative_candidates: number;
    planning_eligible_events: number;
    // ── R0H explicit funnel counts, in real gate order ────────────────────────
    executable_anchor_candidates: number;
    fullmatch_anchor_candidates: number;
    planning_identity_candidates: number;
    timing_eligible_events: number;
    slot_candidates_considered: number;
    slot_allocated_count: number;
    slot_not_allocated_count: number;
    reservations_created: number;
    rejected_by_anchor: number;
    rejected_by_scope: number;
    final_identity_available_at_planning: number;
    /** Every rejection path, keyed by explicit code (pipeline order). */
    rejection_counts_by_code: Record<string, number>;
    first_rejection_code: string | null;
    // ── R0G full-match anchor evidence (market class vs event scope) ────────
    groups_with_fullmatch_candidate: number;
    groups_only_partial_or_prop: number;
    /** Must stay 0: a valid full-match sibling existed but no representative was allowed. */
    groups_with_valid_sibling_but_wrong_rep: number;
    allowed_moneyline_count: number;
    allowed_spread_count: number;
    allowed_total_count: number;
    rejected_partial_count: number;
    rejected_prop_count: number;
    rejected_activity_label_count: number;
    first_zero_stage: PlanningFunnelStage | null;
    market_level_keys_skipped: number;
    market_level_keys_normalized: number;
    // Horizon/WC floor diagnostics exposed after build.
    horizon_end_iso: string;
    window_end_iso: string;
    reserved_wc_or_soccer_count: number;
    skipped_by_horizon_count: number;
    skipped_by_cap_count: number;
    // ── Tier1 full-match underfill invariant counters (capacity-audit aligned). ──
    tier1PhysicalMatchesSeen: number;
    tier1ReservationsPlanned: number;
    tier1AlreadyReserved: number;
    tier1ReservationGapsAfterBuild: number;
    weakKeysMerged: number;
    representativeTitleReplaced: number;
    completeCandidateUniverseUsed: boolean;
    underfillInvariantPass: boolean;
    // ── Founder slot-fill fallback ladder (Tier2/Tier3, allowed full-match only). ──
    targetLiveSlots: number;
    tier1ReservedCount: number;
    fallbackSlotFillReservedCount: number;
    fallbackTier2Reserved: number;
    fallbackTier3Reserved: number;
    fallbackEligibleGroupsSeen: number;
    fallbackSkippedNoAllowedFullmatch: number;
    fallback_rejection_reasons: Partial<Record<FullMatchAnchorRejectionReason, number>>;
    fullmatch_rejection_reasons: Partial<Record<FullMatchAnchorRejectionReason, number>>;
    // ── R0I bounded full-match rejection evidence (totals + 3x3 preview) ──────
    // ── R0J planning-anchor attribution (one count per physical event) ───────
    executable_fullmatch_anchor_count: number;
    structured_event_level_anchor_count: number;
    planning_anchor_rejected_count: number;
    planning_anchor_reason_counts: Record<string, number>;
    fullmatch_rejection_groups_total: number;
    fullmatch_rejection_candidates_total: number;
    fullmatch_rejection_evidence_preview: FullmatchRejectionGroupEvidence[];
    slotFillTargetReached: boolean;
    r0_trace?: R0PlanningTrace;
    // ── Canary single-event targeting (planning-stage only). ────────────────
    canary_target_requested: boolean;
    canary_target_matched_group_count: number;
    canary_target_group_key: string | null;
    // ── Contract A planning-decision authority (present only on that path) ──
    /** Which authority created these reservations. Absent on the legacy path. */
    reservation_authority?: "CONTRACT_A_PLANNING_DECISION";
    planning_decisions?: number;
    planning_decisions_approved?: number;
    planning_decisions_rejected?: number;
    duplicate_rejected?: number;
    cap_excluded?: number;
    allocation_policy_id?: string;
    allocation_min_start_lead_minutes?: number;
    allocation_target_reservation_slots?: number;
    allocation_ranking_order?: readonly string[];
    allocation_allocatable_after_time_guard?: number;
    allocation_minimum_lead_rejected?: number;
    allocation_missing_provider_volume?: number;
  };
}

type ReservationCandidateFetchResult = {
  candidates: FireModelCandidate[];
  rawDiagnostics?: Pick<
    RawPlanningDiagnostics,
    | "total_db_rows"
    | "raw_allowed_fullmatch_rows"
    | "raw_forbidden_rows"
    | "fullmatch_admitted_count"
    | "fullmatch_rejected_by_reason"
  > | null;
};

/**
 * Build the frozen event reservation plan (PURE — no DB writes).
 * Reserves an event when its best candidate is a Tier1 event opportunity within horizon.
 * Market-level halftime/side filtering is deliberately deferred to rebalance.
 */
export async function buildReservationPlan(
  nowMs: number,
  deps: {
    fetchCandidates?: () => Promise<ReservationCandidateFetchResult>;
    selectorMode?: FireModelSelectorMode;
    /** Canary single-event targeting: restrict admission to exactly one physical-event group. */
    targetPhysicalEventKeyHash?: string;
    /** Injectable only for deterministic ambiguity testing; production always uses hashPhysicalEventKey. */
    hashPhysicalEventKey?: (key: string) => string;
    // ── Contract A planning-decision path (see below) ──────────────────────
    /** Source-row seam for the Contract A path. Production loads the real planning universe. */
    fetchSourceRows?: () => Promise<readonly Record<string, unknown>[]>;
    /** Decision seam for the Contract A path. Production uses the real Contract A producer. */
    produceDecisions?: (
      rows: readonly Record<string, unknown>[]
    ) => Promise<ContractADecisionResult<ContractAPlanningDecision>[]>;
    /** Occurrences already holding a reservation, for active duplicate protection. */
    activeOccurrences?: readonly ReservationOccurrenceGuardRow[];
  } = {}
): Promise<ReservationPlan> {
  // ── CONTRACT A PLANNING AUTHORITY ─────────────────────────────────────────
  // In Contract A planning mode the authoritative Planning Decision -- not the
  // legacy candidate/filter/ranking path below -- creates the Reservation.
  // Contract A already owns sport policy, market policy, planning approval,
  // score, tier and rank; re-deriving any of them here would be a second model
  // authority one stage later, which is exactly the defect this replaces.
  //
  // The legacy candidate seam survives ONLY for callers that inject a finished
  // candidate list (funnel audits, evidence replays, planner unit tests). No
  // production caller injects candidates: every production entry point reaches
  // this function with selectorMode=CONTRACT_A_PLANNING_V1 and no fetchCandidates.
  if (
    (deps.selectorMode ?? "CONTUR3_CURRENT") === "CONTRACT_A_PLANNING_V1" &&
    deps.fetchCandidates === undefined
  ) {
    return buildContractAReservationPlan(nowMs, {
      fetchSourceRows: deps.fetchSourceRows,
      produceDecisions: deps.produceDecisions,
      activeOccurrences: deps.activeOccurrences,
      targetPhysicalEventKeyHash: deps.targetPhysicalEventKeyHash,
      hashPhysicalEventKey: deps.hashPhysicalEventKey,
    });
  }

  const window = resolveNightWindow(nowMs);
  const planRunId = buildPlanRunId(nowMs);
  const fetchCandidates =
    deps.fetchCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true, undefined, deps.selectorMode ?? "CONTUR3_CURRENT");
    });
  const { candidates: receivedCandidates, rawDiagnostics } = await fetchCandidates();

  // ── UPSTREAM AUTHORITY BOUNDARY ───────────────────────────────────────────
  // A candidate the planning selector explicitly REJECTED is not planning input
  // and never becomes reservation input -- not through ranking, not through the
  // fallback ladder, not through any local classification. Candidates with no
  // verdict at all predate the contract and keep the pre-existing path.
  const universe = receivedCandidates.filter((c) => !isUpstreamRejected(c));
  const upstreamRejectedDropped = receivedCandidates.length - universe.length;
  const upstreamApprovedCandidates = universe.filter(isUpstreamApproved).length;

  const bySport: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let skippedOutsideHorizon = 0;
  // Weak single-team keys are no longer discarded (they canonicalize/merge below);
  // retained at 0 so the diagnostics shape is unchanged for downstream readers.
  const skippedWeakKey = 0;
  let skippedNonTier1 = 0;
  let skippedNoExecutableAnchor = 0;
  let skippedNoFullmatchAnchor = 0;
  let skippedNoPlanningIdentity = 0;
  let finalIdentityAvailableAtPlanning = 0;
  let groupsAfterHorizon = 0;
  // ── R0G full-match anchor evidence ────────────────────────────────────────
  // A future 25 -> 0 run must distinguish "every event genuinely offered only
  // partial/prop markets" from "the classifier rejected valid siblings".
  let groupsWithFullmatchCandidate = 0;
  let groupsOnlyPartialOrProp = 0;
  let groupsWithValidSiblingButWrongRep = 0;
  let allowedMoneylineCount = 0;
  let allowedSpreadCount = 0;
  let allowedTotalCount = 0;
  let rejectedPartialCount = 0;
  let rejectedPropCount = 0;
  let rejectedActivityLabelCount = 0;
  const planningRejectionReasons: Partial<Record<PlanningEventIdentityReasonCode, number>> = {};
  // Stage 1 identity: resolved BEFORE a group may consume a reservation slot.
  const planningIdentityByGroupKey = new Map<string, PlanningEventIdentity>();
  // Stage 2 identity: only present when the authoritative T-90 decision already
  // exists at plan time. Never synthesized.
  const identityByGroupKey = new Map<string, ExecutableMarketIdentity>();
  let marketLevelKeysSkipped = 0;
  let marketLevelKeysNormalized = 0;
  let weakKeysMerged = 0;
  let representativeTitleReplaced = 0;

  // ── Canonical physical-match key (independent of market title). ──────────────
  // Every key shape that refers to the same physical game collapses to ONE group:
  // pair:*/fifwc-* are used directly; market-level lines fold into their clean
  // canonical_event_key; weak single-team SPREAD/MATCH_WINNER keys merge into the
  // opponent pair when it exists, otherwise stand alone (so the Tier1 invariant still
  // reserves them). Pure condition-id keys with no canonical identity return null → skip.
  const { repBySig, repByTeamDate, repByTeam } = buildPhysicalMatchIndex(universe);
  const canonicalPhysicalMatchKey = (c: FireModelCandidate): string | null => {
    // Contract A physical-event identity is authoritative: the frozen producer
    // already resolved which physical event this decision belongs to. Use that
    // ID rather than re-deriving a key from market/event slug text -- otherwise
    // a legitimately named full-match market ("...-moneyline", "spread: ...")
    // is misread as a market-level line and silently dropped from planning.
    const authoritativeEventKey = c.diagnostics?.authoritative_event_key;
    if (typeof authoritativeEventKey === "string" && authoritativeEventKey.trim() !== "") {
      return authoritativeEventKey.trim();
    }
    // Provider event identity is authoritative when present and already includes
    // a compatible event date. This collapses title variants before ranking.
    if (c.providerEventKey) return c.providerEventKey;
    const k = c.match_family_key;

    // Any two-team game (pair:* or raw "a vs b", any order) → single representative.
    const td = extractTeamsDate(c);
    if (td) {
      const rep = repBySig.get(teamsSig(td.a, td.b, td.date));
      if (rep && rep !== k) marketLevelKeysNormalized += 1;
      return rep ?? k;
    }

    if (k.startsWith("fifwc-")) return k;

    const spread = k.match(WEAK_SPREAD_KEY_RE);
    if (spread) {
      const merged = repByTeamDate.get(`${spread[1]}:${spread[2]}`);
      if (merged) { weakKeysMerged += 1; return merged; }
      return k; // own physical match — full-match spread still earns a reservation
    }

    const mw = k.match(WEAK_MATCH_WINNER_KEY_RE);
    if (mw) {
      const team = normTeam(mw[1]);
      const set = repByTeam.get(team);
      if (set && set.size === 1) { weakKeysMerged += 1; return [...set][0]; }
      return k; // own physical match — full-match moneyline still earns a reservation
    }

    if (isMarketLevelKey(c)) {
      const ck = normalizedEventKey(c);
      if (ck) { marketLevelKeysNormalized += 1; return ck; }
      return null; // market-level line with no clean canonical identity
    }
    return k; // event_slug-derived medium key (non-pair)
  };

  const groups = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    const key = canonicalPhysicalMatchKey(c);
    if (!key) {
      marketLevelKeysSkipped += 1;
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const reservations: NightEventReservationRow[] = [];
  const rankable: Array<{ best: FireModelCandidate; group: FireModelCandidate[]; groupKey: string }> = [];
  // Founder slot-fill ladder: physical matches whose best executable anchor is below
  // Tier1 but has a positively-allowed full-match market. Held back and only promoted
  // to fill live slots up to TARGET_LIVE_SLOTS, Tier2 before Tier3.
  const fallbackRankable: Array<{
    best: FireModelCandidate;
    group: FireModelCandidate[];
    groupKey: string;
    fallbackTier: "TIER2" | "TIER3";
  }> = [];
  let fallbackSkippedNoAllowedFullmatch = 0;
  const fallbackRejectionReasons: Partial<Record<FullMatchAnchorRejectionReason, number>> = {};
  const fullmatchRejectionReasons: Partial<Record<FullMatchAnchorRejectionReason, number>> = {};
  // R0I diagnostics: groups rejected by the full-match anchor gate, captured for
  // the report only. Never read by any admission, ranking or allocation path.
  const fullmatchRejectedGroups: FullmatchRejectionGroupCapture[] = [];
  // R0J planning-anchor attribution, by the kind of anchor that admitted (or
  // rejected) the GROUP -- one count per physical event, never per candidate.
  let executableFullmatchAnchorCount = 0;
  let structuredEventLevelAnchorCount = 0;
  let planningAnchorRejectedCount = 0;
  const planningAnchorReasonCounts: Record<string, number> = {};
  // Preview-only attribution: which admitted anchor kind reserved this group.
  const planningAnchorKindByGroupKey = new Map<string, "EXECUTABLE_MARKET" | "STRUCTURED_FULLMATCH_EVENT">();

  for (const [groupKey, arr] of groups.entries()) {
    const ranked = [...arr].sort(compareCandidateQuality);
    // Canonical per-market evidence for this physical event (market class and
    // event scope, decided by the single canonical taxonomy).
    let groupHasFullmatch = false;
    // R0I: buffer the decisions this loop ALREADY makes, so a group later
    // rejected by the full-match gate can be explained without re-running the
    // classifier. Purely observational -- nothing below reads this buffer.
    const groupAnchorCaptures: FullmatchRejectionCandidateCapture[] = [];
    for (const candidate of ranked) {
      const anchorInput = candidateAnchorInput(candidate);
      // Reads the upstream verdict when one exists; classifies only legacy
      // candidates that carry none.
      const canonical = anchorEvidenceForCandidate(candidate);
      groupAnchorCaptures.push({ anchorInput, decision: canonical });
      if (canonical.allowed) {
        groupHasFullmatch = true;
        if (canonical.market_class === "allowed_fullmatch_moneyline") allowedMoneylineCount += 1;
        else if (canonical.market_class === "allowed_fullmatch_spread") allowedSpreadCount += 1;
        else if (canonical.market_class === "allowed_fullmatch_total") allowedTotalCount += 1;
        continue;
      }
      // Attribute by AXIS, not by which check happened to fire first: any market
      // that does not settle over the full event is a partial-scope rejection,
      // even when its market class (e.g. forbidden_halftime) also encodes that.
      if (canonical.reason_code === "ACTIVITY_LABEL") rejectedActivityLabelCount += 1;
      else if (
        canonical.event_scope !== "full_match" ||
        canonical.market_class === "forbidden_halftime"
      ) {
        rejectedPartialCount += 1;
      } else if (canonical.reason_code === "FORBIDDEN_MARKET_CLASS") rejectedPropCount += 1;
    }
    if (groupHasFullmatch) groupsWithFullmatchCandidate += 1;
    else groupsOnlyPartialOrProp += 1;

    // Filter to executable anchors only: halftime/corners/props/exact-score/goalscorer
    // are forbidden as reservation anchors. NEVER fall back to a forbidden market, and
    // never let a forbidden-anchor candidate become the representative title.
    // An upstream-approved candidate already passed this exact class check at
    // the planning selector; re-running the slug regexes here would be the same
    // second authority, one gate earlier.
    const executableAnchorRanked = ranked.filter(
      (c) => isUpstreamApproved(c) || !isForbiddenAnchorMarket(c)
    );
    if (executableAnchorRanked.length === 0) {
      skippedNoExecutableAnchor += 1;
      continue;
    }
    const anchorDecisions = executableAnchorRanked.map((candidate) => ({
      candidate,
      decision: anchorDecisionForCandidate(candidate),
    }));
    // R0J: the PLANNING verdict. An already-allowed executable market is
    // admitted exactly as before; additionally a structured, event-level
    // full-match matchup for a supported non-eSports sport may reserve a slot
    // without yet naming its executable market class. The exact market is
    // resolved and validated at the T-70..T-3 rebalance, which is unchanged.
    const planningAnchorByCandidate = new Map<FireModelCandidate, PlanningAnchorDecision>();
    for (const { candidate, decision } of anchorDecisions) {
      const policy = upstreamMarketPolicyOf(candidate);
      planningAnchorByCandidate.set(
        candidate,
        policy
          ? // Upstream already ran resolvePlanningAnchorDecision to produce this
            // verdict. Consume its result -- including the anchor kind, so the
            // STRUCTURED_FULLMATCH_EVENT attribution survives the move upstream.
            {
              allowed_for_planning: policy.allowed,
              anchor_kind: policy.anchor_kind,
              reason_code: policy.reason_code,
            }
          : resolvePlanningAnchorDecision({
              existingAnchorAllowed: decision.allowed,
              canonical: resolveMarketAnchorDecision(candidateAnchorInput(candidate)),
              anchorInput: candidateAnchorInput(candidate),
              sport: candidate.inferred_sport ?? null,
            })
      );
    }
    const planningAllowed = (c: FireModelCandidate): boolean =>
      planningAnchorByCandidate.get(c)?.allowed_for_planning === true;

    // A valid full-match market existed but the anchor step still found no
    // allowed representative -- the exact "classifier discarded a valid
    // sibling" signature. Must stay 0.
    if (groupHasFullmatch && !anchorDecisions.some(({ decision }) => decision.allowed)) {
      groupsWithValidSiblingButWrongRep += 1;
    }
    const bestAllowedFullmatch = anchorDecisions.find(({ candidate }) => planningAllowed(candidate))?.candidate;
    if (!bestAllowedFullmatch) {
      skippedNoFullmatchAnchor += 1;
      planningAnchorRejectedCount += 1;
      // The representative's planning reason -- why this physical event could
      // not anchor at all.
      const planningReason =
        planningAnchorByCandidate.get(executableAnchorRanked[0])?.reason_code ?? "REJECTED";
      planningAnchorReasonCounts[planningReason] =
        (planningAnchorReasonCounts[planningReason] ?? 0) + 1;
      const rejection = anchorDecisions[0]?.decision;
      if (rejection && !rejection.allowed) {
        fullmatchRejectionReasons[rejection.reason] = (fullmatchRejectionReasons[rejection.reason] ?? 0) + 1;
      }
      // R0I: this group -- and only a group rejected HERE -- is explained in the
      // diagnostic report, from the decisions already taken above.
      fullmatchRejectedGroups.push({
        physicalEventKey: groupKey,
        sport: ranked[0]?.inferred_sport ?? null,
        candidates: groupAnchorCaptures,
      });
      continue;
    }

    const admittedKind = planningAnchorByCandidate.get(bestAllowedFullmatch)?.anchor_kind;
    if (admittedKind === "STRUCTURED_FULLMATCH_EVENT") {
      structuredEventLevelAnchorCount += 1;
      planningAnchorReasonCounts.PLANNING_EVENT_LEVEL_FULLMATCH =
        (planningAnchorReasonCounts.PLANNING_EVENT_LEVEL_FULLMATCH ?? 0) + 1;
    } else {
      executableFullmatchAnchorCount += 1;
    }
    planningAnchorKindByGroupKey.set(
      groupKey,
      admittedKind === "STRUCTURED_FULLMATCH_EVENT" ? "STRUCTURED_FULLMATCH_EVENT" : "EXECUTABLE_MARKET"
    );

    // R0F two-stage identity contract. At 17:00 a physical event may be reserved
    // as soon as it has a complete PLANNING identity -- a real physical event, a
    // canonical event key, a valid kickoff and an allowed market anchor. The
    // exact executable identity (condition/token/side) is NOT required here: for
    // a game hours away the authoritative T-90 decision does not exist yet, and
    // demanding it empties the whole plan. It is resolved at the T-70..T-3
    // rebalance through the stable canonical event key persisted below.
    let planningIdentity: PlanningEventIdentity | null = null;
    let best: FireModelCandidate | null = null;
    for (const candidate of executableAnchorRanked) {
      const decision = resolvePlanningEventIdentity({
        candidate,
        physicalEventKey: groupKey,
        sourceStage: "planning.representative_selection",
        anchorAllowed: planningAllowed(candidate),
        planningSelectorVersion: candidate.diagnostics?.selector_id ?? "CONTUR3_CURRENT",
      });
      if (decision.allowed) {
        const { allowed: _allowed, ...identity } = decision;
        planningIdentity = identity;
        best = candidate;
        break;
      }
      planningRejectionReasons[decision.reasonCode] = (planningRejectionReasons[decision.reasonCode] ?? 0) + 1;
    }
    if (planningIdentity === null || best === null) {
      skippedNoPlanningIdentity += 1;
      continue;
    }
    if (ranked[0] !== best) representativeTitleReplaced += 1;
    planningIdentityByGroupKey.set(groupKey, planningIdentity);

    // When this candidate ALREADY carries a complete authoritative execution
    // identity (a FINAL_AUTHORITATIVE candidate -- i.e. the T-90 decision exists
    // at plan time), persist it too so the rebalance validates exact IDs
    // directly instead of re-resolving. Absent identity is never synthesized.
    const executableDecision = resolveExecutableMarketIdentity({
      candidate: best,
      physicalEventKey: groupKey,
      sourceStage: "planning.executable_identity",
      anchorAllowed: true,
    });
    if (executableDecision.allowed && best.diagnostics?.contract_a_stage === "FINAL_AUTHORITATIVE") {
      const { allowed: _ok, ...executableIdentity } = executableDecision;
      identityByGroupKey.set(groupKey, executableIdentity);
      finalIdentityAvailableAtPlanning += 1;
    }
    const startMs = best.diagnostics.game_start_iso
      ? new Date(best.diagnostics.game_start_iso).getTime()
      : NaN;
    if (!Number.isFinite(startMs) || !isWithinHorizon(startMs, window, nowMs)) {
      skippedOutsideHorizon += 1;
      continue;
    }
    groupsAfterHorizon += 1;
    // Event-level eligibility: best candidate must be a Tier1 event opportunity.
    if (eventTierOf(best) === "TIER1") {
      rankable.push({ best, group: ranked, groupKey });
      continue;
    }
    // Tier1 absent for this real physical match. Per founder slot policy, hold it for the
    // explicit Tier2→Tier3 fallback ladder — but ONLY if a positively-allowed full-match
    // anchor exists. Pick the best executable anchor that is a real full-match market.
    const fbTier = eventTierOf(bestAllowedFullmatch);
    if (fbTier !== "TIER2" && fbTier !== "TIER3") {
      // No allowed full-match anchor → genuinely non-actionable, correct skip (NOT silent
      // when a forbidden-only inventory is the cause: counted for forensic visibility).
      skippedNonTier1 += 1;
      fallbackSkippedNoAllowedFullmatch += 1;
      const rejection = anchorDecisions[0]?.decision;
      if (rejection && !rejection.allowed) {
        fallbackRejectionReasons[rejection.reason] = (fallbackRejectionReasons[rejection.reason] ?? 0) + 1;
      }
      continue;
    }
    fallbackRankable.push({ best: bestAllowedFullmatch, group: ranked, groupKey, fallbackTier: fbTier });
  }

  // Cross-event ranking by best-candidate quality.
  rankable.sort((a, b) => compareCandidateQuality(a.best, b.best));
  // Fallback ranking: Tier2 strictly before Tier3, then by candidate quality.
  fallbackRankable.sort((a, b) => {
    if (a.fallbackTier !== b.fallbackTier) return a.fallbackTier === "TIER2" ? -1 : 1;
    return compareCandidateQuality(a.best, b.best);
  });

  // Promote fallback groups only to reach TARGET_LIVE_SLOTS (never beyond), Tier2 first.
  const tier1Count = rankable.length;
  const fallbackSlotsToFill = Math.max(0, TARGET_LIVE_SLOTS - tier1Count);
  const promotedFallback = fallbackRankable.slice(0, fallbackSlotsToFill);
  let fallbackTier2Reserved = 0;
  let fallbackTier3Reserved = 0;

  // ── Canary single-event targeting (planning-stage only; never fuzzy). ────
  // Applied only after every gate above (anchor admission, planning identity,
  // timing) has already run: rankable/fallbackRankable are the SAME admitted
  // sets the normal path uses. When a target hash is requested, normal
  // TARGET_LIVE_SLOTS slot-fill ranking is bypassed entirely in favor of
  // selecting the one matching group, so at most one Reservation is created.
  const canaryTargetHash = deps.targetPhysicalEventKeyHash ?? null;
  const hashFn = deps.hashPhysicalEventKey ?? hashPhysicalEventKey;
  let canaryMatchedGroupCount = 0;
  let canaryTargetGroupKey: string | null = null;
  if (canaryTargetHash) {
    const combined = [...rankable, ...fallbackRankable];
    const matches = combined.filter((g) => hashFn(g.groupKey) === canaryTargetHash);
    canaryMatchedGroupCount = matches.length;
    if (matches.length === 1) canaryTargetGroupKey = matches[0].groupKey;
  }

  const pushReservation = (
    best: FireModelCandidate,
    group: FireModelCandidate[],
    groupKey: string,
    tier: "TIER1" | "TIER2" | "TIER3",
    isFallback: boolean,
    idx: number
  ) => {
    bySport[best.inferred_sport] = (bySport[best.inferred_sport] ?? 0) + 1;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    // Contract A authoritative decision (CONTRACT_A_V1 selector mode): the
    // candidate already carries an immutable selector/identity provenance
    // block in its own diagnostics. Persist it verbatim into the reservation
    // diagnostics (no new column, no rerank) so rebalance can later locate
    // the exact authoritative market -- never a Contur3-reranked alternate.
    const selectorId = best.diagnostics.selector_id;
    const isContractAFinal = best.diagnostics.contract_a_stage === "FINAL_AUTHORITATIVE";
    const isContractAPlanning = best.diagnostics.contract_a_stage === "PLANNING";
    // Stage 1 identity: present for every reservation this function can be
    // reached with -- a group without a complete planning identity never reaches
    // pushReservation. Stage 2 identity is present only when the authoritative
    // T-90 decision already existed at plan time.
    const planningIdentity = planningIdentityByGroupKey.get(groupKey)!;
    const identity = identityByGroupKey.get(groupKey) ?? null;
    const reason = isContractAFinal
      ? `CONTRACT_A_AUTHORITATIVE: selector=${selectorId} observation=${best.diagnostics.authoritative_observation_id}`
      : isContractAPlanning
        ? `CONTRACT_A_PLANNING_EVENT: selector=${selectorId}`
      : isFallback
        ? `FALLBACK_SLOT_FILL_${tier}: score=${best.diagnostics.score} cov=${best.diagnostics.coverage} ` +
          `allowed_fullmatch_anchor markets_in_event=${group.length}`
        : `EVENT_FIRST_TIER1_OPPORTUNITY: score=${best.diagnostics.score} cov=${best.diagnostics.coverage} markets_in_event=${group.length}`;
    reservations.push({
      physical_event_id: groupKey,
      event_start_iso: best.diagnostics.game_start_iso,
      plan_run_id: planRunId,
      plan_date_minsk: window.planDateMinsk,
      window_start_iso: window.startIso,
      window_end_iso: window.endIso,
      // Canonical physical-match key (merged), not the per-candidate key — so exact-key
      // reservation matching downstream aligns with the capacity audit's physical groups.
      match_family_key: groupKey,
      event_slug: best.event_slug,
      event_title: cleanReservationEventTitle(best, groupKey),
      sport: best.inferred_sport,
      league: null,
      strategic_scope: best.strategic_scope,
      game_start_iso: best.diagnostics.game_start_iso,
      event_tier: tier,
      event_score: best.diagnostics.score,
      best_snapshot_id: best.signal_id,
      reservation_rank: idx + 1,
      status: "RESERVED",
      selection_reason: reason,
      diagnostics: {
        markets_in_event: group.length,
        scope_confidence: best.sport_classification_confidence,
        timing_bucket: best.timing_bucket,
        hours_to_start: best.diagnostics.hours_to_start_now,
        battle_trace_id: identity
          ? buildIdentityBattleTraceId(planRunId, identity)
          : `contur3:${planRunId}:${planningIdentity.planningEventKey}:pending-final-identity`,
        slot_fill: isFallback ? "FALLBACK_SLOT_FILL" : "TIER1_PRIMARY",
        fallback_tier: isFallback ? tier : undefined,
        planning_anchor_kind: planningAnchorKindByGroupKey.get(groupKey) ?? "EXECUTABLE_MARKET",
        // R0F stage 1: every reservation persists its structured planning event
        // identity, so the rebalance can resolve the final market through a
        // canonical-key join -- never through event_title / event_slug matching.
        ...buildPersistedPlanningIdentityDiagnostics(planningIdentity),
        // R0E stage 2: persisted verbatim ONLY when it genuinely exists at plan
        // time. Its absence is what makes the rebalance resolve it later; it is
        // never defaulted or synthesized.
        ...(identity ? buildPersistedIdentityDiagnostics(identity) : {}),
        ...(selectorId !== undefined ? { selector_id: selectorId } : {}),
        ...(isContractAFinal ? { contract_a_stage: "FINAL_AUTHORITATIVE" } : {}),
        ...(isContractAPlanning ? { contract_a_stage: "PLANNING" } : {}),
      },
    });
  };

  let rank = 0;
  if (canaryTargetHash) {
    // Canary mode: at most ONE reservation. Normal slot-fill promotion never
    // runs; the sole candidate is the exact hash match resolved above (or
    // none, if zero/ambiguous -- callers read canary_target_matched_group_count).
    if (canaryTargetGroupKey) {
      const tier1Match = rankable.find((g) => g.groupKey === canaryTargetGroupKey);
      if (tier1Match) {
        pushReservation(tier1Match.best, tier1Match.group, tier1Match.groupKey, "TIER1", false, rank);
        rank += 1;
      } else {
        const fbMatch = fallbackRankable.find((g) => g.groupKey === canaryTargetGroupKey)!;
        pushReservation(fbMatch.best, fbMatch.group, fbMatch.groupKey, fbMatch.fallbackTier, true, rank);
        rank += 1;
        if (fbMatch.fallbackTier === "TIER2") fallbackTier2Reserved += 1;
        else fallbackTier3Reserved += 1;
      }
    }
  } else {
    rankable.forEach(({ best, group, groupKey }) => {
      pushReservation(best, group, groupKey, "TIER1", false, rank);
      rank += 1;
    });
    promotedFallback.forEach(({ best, group, groupKey, fallbackTier }) => {
      pushReservation(best, group, groupKey, fallbackTier, true, rank);
      rank += 1;
      if (fallbackTier === "TIER2") fallbackTier2Reserved += 1;
      else fallbackTier3Reserved += 1;
    });
  }

  const reservedWcOrSoccerBuild = reservations.filter(
    (r) => r.strategic_scope === "WC" || r.strategic_scope === "SOCCER"
  ).length;

  // R0F: a zero plan is never allowed to be silent -- it must name the exact
  // stage at which the funnel first reached zero, so an empty night is
  // immediately attributable to source inventory, grouping, eligibility or
  // slot filling rather than being indistinguishable from a crash.
  const sourceRows = rawDiagnostics?.total_db_rows ?? universe.length;

  // Every rejection path, keyed by an explicit code, in pipeline order. This is
  // what makes a zero plan self-explanatory from one job_runs row: production
  // previously reported a bare rejected_count that omitted most of these paths.
  const rejectionCountsByCode: Record<string, number> = {};
  const addCode = (code: string, count: number) => {
    if (count > 0) rejectionCountsByCode[code] = (rejectionCountsByCode[code] ?? 0) + count;
  };
  addCode("MARKET_LEVEL_KEY_SKIPPED", marketLevelKeysSkipped);
  addCode("NO_EXECUTABLE_ANCHOR", skippedNoExecutableAnchor);
  addCode("NO_FULLMATCH_ANCHOR", skippedNoFullmatchAnchor);
  addCode("NO_PLANNING_IDENTITY", skippedNoPlanningIdentity);
  addCode("OUTSIDE_HORIZON", skippedOutsideHorizon);
  addCode("NOT_TIER1", skippedNonTier1);
  for (const [reason, count] of Object.entries(planningRejectionReasons)) {
    addCode(`PLANNING_IDENTITY_${reason}`, count ?? 0);
  }
  for (const [reason, count] of Object.entries(fullmatchRejectionReasons)) {
    addCode(`ANCHOR_${reason}`, count ?? 0);
  }

  // Pipeline-ordered: the earliest stage that rejected anything this run.
  const PIPELINE_ORDER = [
    "MARKET_LEVEL_KEY_SKIPPED",
    "NO_EXECUTABLE_ANCHOR",
    "NO_FULLMATCH_ANCHOR",
    "NO_PLANNING_IDENTITY",
    "OUTSIDE_HORIZON",
    "NOT_TIER1",
  ] as const;
  const firstRejectionCode: string | null =
    PIPELINE_ORDER.find((code) => (rejectionCountsByCode[code] ?? 0) > 0) ?? null;

  const authoritativeCandidatesAtPlanning = universe.filter(
    (c) =>
      typeof c.diagnostics?.authoritative_condition_id === "string" &&
      c.diagnostics.authoritative_condition_id.trim() !== ""
  ).length;

  // ── R0H funnel survivor sets, in real gate order ──────────────────────────
  // Each is the previous survivor set minus exactly what that gate rejected, so
  // an event dropped upstream is never counted as input to a later stage.
  const executableAnchorCandidates = Math.max(0, groups.size - skippedNoExecutableAnchor);
  const fullmatchAnchorCandidates = Math.max(0, executableAnchorCandidates - skippedNoFullmatchAnchor);
  const planningIdentityCandidates = Math.max(0, fullmatchAnchorCandidates - skippedNoPlanningIdentity);
  const timingEligibleEvents = Math.max(0, planningIdentityCandidates - skippedOutsideHorizon);
  const slotCandidatesConsidered = Math.max(0, timingEligibleEvents - skippedNonTier1);
  const slotNotAllocatedCount = Math.max(0, timingEligibleEvents - skippedNonTier1 - reservations.length);

  // A zero plan must name the exact gate that emptied it. Evaluated in the same
  // order the gates run, so the FIRST stage to reach zero is the one reported.
  const firstZeroStage: PlanningFunnelStage | null =
    reservations.length > 0
      ? null
      : sourceRows === 0
        ? "SOURCE_ROWS"
        : groups.size === 0
          ? "NORMALIZED_PHYSICAL_EVENTS"
          : executableAnchorCandidates === 0
            ? "EXECUTABLE_ANCHOR_ELIGIBLE"
            : fullmatchAnchorCandidates === 0
              ? "FULLMATCH_ANCHOR_ELIGIBLE"
              : planningIdentityCandidates === 0
                ? "PLANNING_IDENTITY_ELIGIBLE"
                : timingEligibleEvents === 0
                  ? "TIMING_ELIGIBLE"
                  : slotCandidatesConsidered === 0
                    ? "SLOT_ELIGIBLE"
                    : "RESERVATIONS_CREATED";

  const fullmatchRejection = buildFullmatchRejectionEvidence(fullmatchRejectedGroups);

  return {
    plan_run_id: planRunId,
    plan_date_minsk: window.planDateMinsk,
    window,
    reservations,
    fullmatch_rejection: fullmatchRejection,
    diagnostics: {
      universe_size: universe.length,
      upstream_approved_candidates: upstreamApprovedCandidates,
      upstream_rejected_candidates_dropped: upstreamRejectedDropped,
      unique_physical_events: groups.size,
      duplicate_events_removed: Math.max(0, universe.length - groups.size - marketLevelKeysSkipped),
      slot_allocated: reservations.length,
      slot_remaining: Math.max(0, TARGET_LIVE_SLOTS - reservations.length),
      event_groups: groups.size,
      canonical_event_groups: groups.size,
      reserved_count: reservations.length,
      by_sport: bySport,
      by_tier: byTier,
      skipped_outside_horizon: skippedOutsideHorizon,
      skipped_weak_key: skippedWeakKey,
      skipped_non_tier1_event: skippedNonTier1,
      skipped_no_executable_anchor: skippedNoExecutableAnchor,
      skipped_no_fullmatch_anchor: skippedNoFullmatchAnchor,
      skipped_no_planning_identity: skippedNoPlanningIdentity,
      planning_rejection_reasons: planningRejectionReasons,
      identity_complete_count: identityByGroupKey.size,
      // ── R0F planning funnel: a zero plan must name its first zero stage. ──
      source_rows: sourceRows,
      rows_after_horizon: groupsAfterHorizon,
      normalized_physical_events: groups.size,
      physical_event_groups: groups.size,
      authoritative_candidates: authoritativeCandidatesAtPlanning,
      planning_eligible_events: planningIdentityByGroupKey.size,
      // ── R0H explicit funnel counts, in real gate order ──────────────────
      executable_anchor_candidates: executableAnchorCandidates,
      fullmatch_anchor_candidates: fullmatchAnchorCandidates,
      planning_identity_candidates: planningIdentityCandidates,
      timing_eligible_events: timingEligibleEvents,
      slot_candidates_considered: slotCandidatesConsidered,
      slot_allocated_count: reservations.length,
      slot_not_allocated_count: slotNotAllocatedCount,
      reservations_created: reservations.length,
      rejected_by_anchor: skippedNoFullmatchAnchor + skippedNoExecutableAnchor,
      rejected_by_scope: skippedNonTier1 + skippedOutsideHorizon,
      final_identity_available_at_planning: finalIdentityAvailableAtPlanning,
      rejection_counts_by_code: rejectionCountsByCode,
      first_rejection_code: firstRejectionCode,
      groups_with_fullmatch_candidate: groupsWithFullmatchCandidate,
      groups_only_partial_or_prop: groupsOnlyPartialOrProp,
      groups_with_valid_sibling_but_wrong_rep: groupsWithValidSiblingButWrongRep,
      allowed_moneyline_count: allowedMoneylineCount,
      allowed_spread_count: allowedSpreadCount,
      allowed_total_count: allowedTotalCount,
      rejected_partial_count: rejectedPartialCount,
      rejected_prop_count: rejectedPropCount,
      rejected_activity_label_count: rejectedActivityLabelCount,
      first_zero_stage: firstZeroStage,
      market_level_keys_skipped: marketLevelKeysSkipped,
      market_level_keys_normalized: marketLevelKeysNormalized,
      horizon_end_iso: window.horizonEndIso,
      window_end_iso: window.endIso,
      reserved_wc_or_soccer_count: reservedWcOrSoccerBuild,
      skipped_by_horizon_count: skippedOutsideHorizon,
      skipped_by_cap_count: 0,
      // Each rankable group is a Tier1 full-match physical match that passed horizon +
      // executable-anchor gates; the builder reserves exactly one per group, so planned
      // equals seen and the post-build gap is 0 by construction.
      tier1PhysicalMatchesSeen: rankable.length,
      tier1ReservationsPlanned: rankable.length,
      tier1AlreadyReserved: 0,
      tier1ReservationGapsAfterBuild: 0,
      weakKeysMerged,
      representativeTitleReplaced,
      completeCandidateUniverseUsed: true,
      // Every Tier1 physical match is reserved (gap 0 by construction); the slot-fill
      // ladder only adds eligible Tier2/Tier3 allowed-full-match matches on top.
      underfillInvariantPass: true,
      targetLiveSlots: TARGET_LIVE_SLOTS,
      tier1ReservedCount: tier1Count,
      fallbackSlotFillReservedCount: promotedFallback.length,
      fallbackTier2Reserved,
      fallbackTier3Reserved,
      fallbackEligibleGroupsSeen: fallbackRankable.length,
      fallbackSkippedNoAllowedFullmatch,
      fallback_rejection_reasons: fallbackRejectionReasons,
      fullmatch_rejection_reasons: fullmatchRejectionReasons,
      // ── R0I: bounded totals + a 3x3 preview only. The complete evidence is
      // written to the filesystem diagnostic report, never into this object.
      executable_fullmatch_anchor_count: executableFullmatchAnchorCount,
      structured_event_level_anchor_count: structuredEventLevelAnchorCount,
      planning_anchor_rejected_count: planningAnchorRejectedCount,
      planning_anchor_reason_counts: planningAnchorReasonCounts,
      fullmatch_rejection_groups_total: fullmatchRejection.fullmatch_rejection_groups_total,
      fullmatch_rejection_candidates_total: fullmatchRejection.fullmatch_rejection_candidates_total,
      fullmatch_rejection_evidence_preview: buildFullmatchRejectionPreview(fullmatchRejection),
      slotFillTargetReached: reservations.length >= TARGET_LIVE_SLOTS,
      canary_target_requested: canaryTargetHash !== null,
      canary_target_matched_group_count: canaryMatchedGroupCount,
      canary_target_group_key: canaryTargetGroupKey,
      ...(rawDiagnostics
        ? {
            r0_trace: buildR0PlanningTrace({
              runId: planRunId,
              asOfIso: new Date(nowMs).toISOString(),
              raw: rawDiagnostics as R0RawPlanningMetrics,
              plan: {
                universe_size: universe.length,
                event_groups: groups.size,
                reserved_count: reservations.length,
                skipped_outside_horizon: skippedOutsideHorizon,
                skipped_non_tier1_event: skippedNonTier1,
                skipped_no_executable_anchor: skippedNoExecutableAnchor,
                // R0H: without these two the slot_eligible residual silently
                // relabels anchor/identity rejections as SLOT_NOT_ALLOCATED.
                skipped_no_fullmatch_anchor: skippedNoFullmatchAnchor,
                skipped_no_planning_identity: skippedNoPlanningIdentity,
                fallbackEligibleGroupsSeen: fallbackRankable.length,
                fallbackSlotFillReservedCount: promotedFallback.length,
                target_live_slots: TARGET_LIVE_SLOTS,
                tier1_reserved_count: tier1Count,
                // buildReservationPlan always plans a fresh replacement set; any
                // pre-existing rows are reconciled by persist/force-rebuild, so
                // the builder's own existing-slot consumption is zero.
                existing_reservation_count: 0,
                quota_by_scope: { ...bySport },
                target_plan_window_start_iso: window.startIso,
                target_plan_window_end_iso: window.endIso,
              },
              reservationsCreated: null,
            }),
          }
        : {}),
    },
  };
}

export interface CanaryPreviewGroup {
  physical_event_key_hash: string;
  event_title: string;
  sport: string;
  game_start_iso: string;
  minutes_to_start: number;
  planning_anchor_kind: string;
  rebalance_window_eligible_now: boolean;
}

/**
 * Read-only canary preview, derived from an already-built plan
 * (buildReservationPlan performs zero writes). Bounded to 20 groups, nearest
 * start first. Never includes raw physical_event_key, condition_id,
 * token_id, headers, env values, source payloads or secrets.
 */
export function buildCanaryPreview(
  plan: ReservationPlan,
  nowMs: number,
  hashFn: (key: string) => string = hashPhysicalEventKey
): CanaryPreviewGroup[] {
  return [...plan.reservations]
    .sort((a, b) => Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso))
    .slice(0, 20)
    .map((r) => {
      const startMs = Date.parse(r.game_start_iso);
      const minutesToStart = Number.isFinite(startMs) ? Math.round((startMs - nowMs) / 60_000) : NaN;
      const diag = (r.diagnostics ?? {}) as Record<string, unknown>;
      return {
        physical_event_key_hash: hashFn(r.match_family_key),
        event_title: r.event_title ?? "unknown",
        sport: r.sport ?? "unknown",
        game_start_iso: r.game_start_iso,
        minutes_to_start: minutesToStart,
        planning_anchor_kind:
          typeof diag.planning_anchor_kind === "string" ? diag.planning_anchor_kind : "EXECUTABLE_MARKET",
        rebalance_window_eligible_now: minutesToStart <= REBALANCE_MINUTES_BEFORE_START,
      };
    });
}

export interface PersistReservationsResult {
  plan_run_id: string;
  already_exists: boolean;
  written_count: number;
  reserved_count: number;
  reservations: NightEventReservationRow[];
  diagnostics: ReservationPlan["diagnostics"];
}

/**
 * Injectable persistence boundary for night_event_reservations. The real
 * implementation (createSupabaseReservationRepoPort) reproduces the exact
 * read/delete/insert calls persistReservationPlan always made; tests inject
 * an in-memory fake instead of a live Supabase connection.
 */
export interface ReservationRepoPort {
  findByPlanRunId(planRunId: string): Promise<NightEventReservationRow[]>;
  // Optional only for older in-memory test ports. The production adapter always
  // provides this canonical lookup; it must never fall back to plan-run reuse.
  findByPhysicalEventId?(physicalEventId: string): Promise<NightEventReservationRow | null>;
  deleteByPlanRunId(planRunId: string): Promise<void>;
  insert(rows: NightEventReservationRow[]): Promise<void>;
}

function legacyDateOnlyPhysicalEventId(physicalEventId: string, eventStartMs: number): string | null {
  const match = physicalEventId.match(/^event:(.+):(\d{4}-\d{2}-\d{2})T/);
  if (!match) return null;
  return `event:${match[1].trim().toLowerCase()}:${new Date(eventStartMs).toISOString().slice(0, 10)}`;
}

async function findExistingReservationOccurrence(
  repo: ReservationRepoPort,
  current: { physicalEventId: string; eventStartMs: number; eventStartIso: string },
  existing: readonly NightEventReservationRow[]
): Promise<NightEventReservationRow | null> {
  const exact = repo.findByPhysicalEventId
    ? await repo.findByPhysicalEventId(current.physicalEventId)
    : existing.find((row) => row.physical_event_id === current.physicalEventId) ?? null;
  if (exact) return exact;

  // Only historical slug/date identities may use this fallback. Provider-native
  // and other exact identities remain exact-key lookups and are never downgraded.
  const legacyId = legacyDateOnlyPhysicalEventId(current.physicalEventId, current.eventStartMs);
  if (!legacyId || !repo.findByPhysicalEventId) return null;
  const legacy = await repo.findByPhysicalEventId(legacyId);
  if (!legacy || !RESERVATION_ACTIVE_STATUSES.has(String(legacy.status ?? "RESERVED"))) return null;

  const legacyStartMs = Date.parse(legacy.event_start_iso ?? "");
  if (!Number.isFinite(legacyStartMs)) {
    throw new Error(
      `LEGACY_OCCURRENCE_IDENTITY_UNRESOLVED: physical_event_id=${current.physicalEventId} legacy_physical_event_id=${legacyId}`
    );
  }
  return legacyStartMs === current.eventStartMs ? legacy : null;
}

export function createSupabaseReservationRepoPort(): ReservationRepoPort {
  return {
    async findByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .select("*")
        .eq("plan_run_id", planRunId)
        .order("reservation_rank", { ascending: true });
      if (error) throw new Error(`reservation read failed: ${error.message}`);
      return (data ?? []) as unknown as NightEventReservationRow[];
    },
    async findByPhysicalEventId(physicalEventId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .select("*")
        .eq("physical_event_id", physicalEventId)
        .maybeSingle();
      if (error) throw new Error(`reservation physical-event read failed: ${error.message}`);
      return (data as unknown as NightEventReservationRow | null) ?? null;
    },
    async deleteByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin
        .from("night_event_reservations")
        .delete()
        .eq("plan_run_id", planRunId);
      if (error) throw new Error(`reservation force-delete failed: ${error.message}`);
    },
    async insert(rows) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin.from("night_event_reservations").insert(rows);
      if (error) throw new Error(`reservation insert failed: ${error.message}`);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT A APPROVED PLANNING DECISION -> RESERVATION
//
// Authority split enforced by this section:
//   Contract A owns  — sport policy, market policy, planning approval,
//                      planning score, tier, rank, rejection evidence.
//   Reservation owns — exact physical occurrence identity, live allocation
//                      order, active duplicate protection, the cap,
//                      persistence, lifecycle, lineage.
//
// Nothing here scores, reclassifies a market, or resolves an executable
// identity. The allocation policy orders already-approved physical events.
// condition_id / token_id / side belong to the later Final Identity Decision
// and are deliberately NOT carried into a Reservation.
// ═══════════════════════════════════════════════════════════════════════════

/** Reservation lifecycle states that still hold a physical occurrence. */
const RESERVATION_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "RESERVED",
  "REBALANCE_PENDING",
  "QUEUED",
]);

/** Every deterministic reason a Planning Decision does not become a Reservation. */
export type PlanningDecisionReservationReasonCode =
  | "PLANNING_DECISION_REJECTED"
  | "MALFORMED_EVENT_START_ISO"
  | "OUTSIDE_RESERVATION_HORIZON"
  | "MIN_START_LEAD_NOT_MET"
  | "DUPLICATE_PHYSICAL_EVENT"
  | "OCCURRENCE_IDENTITY_CONFLICT"
  | "ACTIVE_DUPLICATE"
  | "CAP_EXCLUDED"
  | "PERSISTENCE_VALIDATION_FAILED";

/**
 * One bounded rejection record. Carries operational identity and a stable code
 * only — never a provider payload, market identity, token or env value.
 */
export interface PlanningDecisionReservationRejection {
  reason_code: PlanningDecisionReservationReasonCode;
  physical_event_id: string | null;
  decision_version: string | null;
  detail: string | null;
}

/** The minimum an existing reservation must expose to guard an occurrence. */
export interface ReservationOccurrenceGuardRow {
  physical_event_id?: string | null;
  event_start_iso?: string | null;
  status?: string | null;
}

export interface PlanningDecisionReservationResult {
  reservations: NightEventReservationRow[];
  rejections: PlanningDecisionReservationRejection[];
  /** Distinct allocatable occurrence ids in policy order, before the cap. */
  admittedOccurrenceIds: string[];
  approvedCount: number;
  rejectedCount: number;
  duplicateRejected: number;
  capExcluded: number;
  minimumLeadRejected: number;
  allocatableAfterTimeGuard: number;
  missingProviderVolume: number;
}

/**
 * Transform ONE accepted Planning Decision into ONE Reservation row.
 *
 * Every persisted value is carried from the decision — nothing is re-derived,
 * re-classified or defaulted. `event_title` stays null rather than substituting
 * a slug for a title, and the exact market identity is deliberately absent.
 */
function planningDecisionReservationRow(
  decision: ContractAPlanningDecision,
  ctx: { planRunId: string; window: NightWindow },
  allocation: {
    policy: LiveReservationAllocationPolicy;
    providerMarketVolume: number | null;
  },
  reservationRank: number
): NightEventReservationRow {
  return {
    physical_event_id: decision.physical_event_id,
    event_start_iso: decision.event_start_iso,
    plan_run_id: ctx.planRunId,
    plan_date_minsk: ctx.window.planDateMinsk,
    window_start_iso: ctx.window.startIso,
    window_end_iso: ctx.window.endIso,
    // The canonical occurrence identity IS the reservation key: downstream
    // exact-key joins and the capacity audit both address a physical event.
    match_family_key: decision.physical_event_id,
    event_slug: decision.source_lineage.event_slug,
    event_title: null,
    sport: decision.inferred_sport,
    league: decision.league,
    strategic_scope: decision.strategic_scope,
    game_start_iso: decision.event_start_iso,
    event_tier: decision.planning_tier,
    event_score: decision.planning_score,
    best_snapshot_id: decision.source_lineage.observation_id,
    reservation_rank: reservationRank,
    status: "RESERVED",
    selection_reason:
      `CONTRACT_A_PLANNING_DECISION: contract=${decision.contract_a_version} ` +
      `decision=${decision.decision_version} rank=${decision.planning_rank} ` +
      `tier=${decision.planning_tier}`,
    diagnostics: {
      reservation_authority: "CONTRACT_A_PLANNING_DECISION",
      contract_a_stage: "PLANNING",
      contract_a_version: decision.contract_a_version,
      contract_a_decision_version: decision.decision_version,
      selector_id: decision.contract_a_version,
      // Model authority, persisted verbatim so nothing downstream recomputes it.
      planning_score: decision.planning_score,
      planning_tier: decision.planning_tier,
      planning_rank: decision.planning_rank,
      planning_policy_verdict: decision.planning_policy_verdict,
      allocation_policy_id: allocation.policy.policyId,
      allocation_min_start_lead_minutes: allocation.policy.minStartLeadMinutes,
      allocation_target_reservation_slots: allocation.policy.targetReservationSlots,
      allocation_ranking_order: [...allocation.policy.rankingOrder],
      allocation_sport_priority: allocation.policy.preferredStrategicScopes.includes(decision.strategic_scope)
        ? "PREFERRED"
        : "STANDARD",
      provider_market_volume: allocation.providerMarketVolume,
      // Time and metadata provenance.
      event_start_iso_source: decision.event_start_iso_source,
      sport_metadata_source: decision.sport_metadata_source,
      league: decision.league,
      timing_bucket: decision.execution_window.timing_bucket,
      stale_after: decision.execution_window.stale_after,
      no_trade_after: decision.execution_window.no_trade_after,
      // Source lineage, preserved exactly as Contract A resolved it. A non-UUID
      // generated_signal_pair_id stays lineage data in this JSONB column and is
      // never written into a uuid column.
      source_lineage: { ...decision.source_lineage },
      // Planning may already hold exact market evidence; persist it verbatim
      // as lineage, never as a new selection or a later fallback.
      planning_final_identity_evidence: decision.final_identity_evidence,
      // Stage 2 identity does not exist yet and is never synthesized here.
      battle_trace_id: `contur3:${ctx.planRunId}:${decision.physical_event_id}:pending-final-identity`,
    },
  };
}

/**
 * PURE. Turns Contract A Planning Decision results into Reservation rows, and
 * returns a deterministic reason for every decision that did not become one.
 *
 * Gate order is fixed: planning verdict -> canonical event time -> reservation
 * horizon -> Contract A planning order -> active duplicate -> cap.
 */
export function buildReservationsFromPlanningDecisions(
  results: readonly ContractADecisionResult<ContractAPlanningDecision>[],
  ctx: { planRunId: string; window: NightWindow; nowMs: number },
  activeOccurrences: readonly ReservationOccurrenceGuardRow[] = [],
  opts: {
    restrictToOccurrenceIds?: ReadonlySet<string>;
    allocationPolicy?: LiveReservationAllocationPolicy;
    providerVolumeByPhysicalEventId?: ReadonlyMap<string, number | null>;
  } = {}
): PlanningDecisionReservationResult {
  const rejections: PlanningDecisionReservationRejection[] = [];
  const reject = (
    reason_code: PlanningDecisionReservationReasonCode,
    physical_event_id: string | null,
    decision_version: string | null,
    detail: string | null = null
  ) => {
    rejections.push({ reason_code, physical_event_id, decision_version, detail });
  };

  // 1. Contract A owns approval. A rejected decision never reaches Reservation.
  const approved: ContractAPlanningDecision[] = [];
  let rejectedCount = 0;
  for (const result of results) {
    if (!result.accepted) {
      rejectedCount += 1;
      reject(
        "PLANNING_DECISION_REJECTED",
        result.rejection.physical_event_id,
        result.rejection.decision_version,
        result.rejection.reason_code
      );
      continue;
    }
    approved.push(result.decision);
  }

  // 2. Reservation owns the occurrence's validity in time. The event start is
  //    validated, never reconstructed.
  const admitted: ContractAPlanningDecision[] = [];
  for (const decision of approved) {
    const startMs = Date.parse(decision.event_start_iso);
    if (!Number.isFinite(startMs)) {
      reject(
        "MALFORMED_EVENT_START_ISO",
        decision.physical_event_id,
        decision.decision_version
      );
      continue;
    }
    if (!isWithinHorizon(startMs, ctx.window, ctx.nowMs)) {
      reject(
        "OUTSIDE_RESERVATION_HORIZON",
        decision.physical_event_id,
        decision.decision_version
      );
      continue;
    }
    admitted.push(decision);
  }

  // 3. LIVE_RESERVATION_ALLOCATION_V1 orders already-approved physical events.
  const allocationPolicy = opts.allocationPolicy ?? LIVE_RESERVATION_ALLOCATION_V1;
  const allocation = rankAllocatableApprovedPhysicalEvents(
    admitted.map((decision) => ({
      decision,
      providerMarketVolume:
        opts.providerVolumeByPhysicalEventId?.get(decision.physical_event_id) ?? null,
    })),
    ctx.window.startMs,
    allocationPolicy,
  );
  for (const decision of allocation.excludedBeforeMinimumLead) {
    reject("MIN_START_LEAD_NOT_MET", decision.physical_event_id, decision.decision_version);
  }
  for (const decision of allocation.duplicateDecisionsRemoved) {
    reject("DUPLICATE_PHYSICAL_EVENT", decision.physical_event_id, decision.decision_version);
  }

  const targeted =
    opts.restrictToOccurrenceIds === undefined
      ? allocation.rankedDistinct
      : allocation.rankedDistinct.filter((candidate) =>
          opts.restrictToOccurrenceIds!.has(candidate.decision.physical_event_id)
        );

  // 4. Active duplicate protection. A TERMINAL reservation (SKIPPED / EXPIRED /
  //    CANCELLED) holds no occurrence, so it never blocks a new one.
  const activeStartByOccurrence = new Map<string, string | null>();
  for (const row of activeOccurrences) {
    const id = row.physical_event_id?.trim();
    if (!id) continue;
    if (!RESERVATION_ACTIVE_STATUSES.has(String(row.status ?? "RESERVED"))) continue;
    activeStartByOccurrence.set(id, row.event_start_iso ?? null);
  }

  const reservations: NightEventReservationRow[] = [];
  const admittedOccurrenceIds = targeted.map((candidate) => candidate.decision.physical_event_id);
  let duplicateRejected = allocation.duplicatesRemoved;
  let capExcluded = 0;

  for (const candidate of targeted) {
    const decision = candidate.decision;
    const occurrenceId = decision.physical_event_id;
    if (activeStartByOccurrence.has(occurrenceId)) {
      const heldStart = activeStartByOccurrence.get(occurrenceId) ?? "";
      const heldMs = Date.parse(heldStart);
      const currentMs = Date.parse(decision.event_start_iso);
      duplicateRejected += 1;
      if (Number.isFinite(heldMs) && heldMs !== currentMs) {
        // Same identity, different start: the identity is wrong, not the plan.
        reject(
          "OCCURRENCE_IDENTITY_CONFLICT",
          occurrenceId,
          decision.decision_version,
          "held_start_differs"
        );
      } else {
        reject("ACTIVE_DUPLICATE", occurrenceId, decision.decision_version);
      }
      continue;
    }
    if (reservations.length >= allocationPolicy.targetReservationSlots) {
      capExcluded += 1;
      reject("CAP_EXCLUDED", occurrenceId, decision.decision_version);
      continue;
    }
    activeStartByOccurrence.set(occurrenceId, decision.event_start_iso);
    reservations.push(
      planningDecisionReservationRow(
        decision,
        ctx,
        {
          policy: allocationPolicy,
          providerMarketVolume: candidate.providerMarketVolume,
        },
        reservations.length + 1,
      )
    );
  }

  return {
    reservations,
    rejections,
    admittedOccurrenceIds,
    approvedCount: approved.length,
    rejectedCount,
    duplicateRejected,
    capExcluded,
    minimumLeadRejected: allocation.excludedBeforeMinimumLead.length,
    allocatableAfterTimeGuard: allocation.rankedDistinct.length,
    missingProviderVolume: allocation.rankedDistinct.filter(
      (candidate) => candidate.providerMarketVolume === null,
    ).length,
  };
}

/**
 * The full ReservationPlan diagnostics block for the Contract A path.
 *
 * Legacy candidate-funnel counters have no meaning here — this path never runs
 * anchor classification, tier classification or the fallback ladder — so they
 * are reported as 0 rather than fabricated. The stages that DO exist carry real
 * counts, and `first_rejection_code` still names the first gate that fired.
 */
function contractAPlanDiagnostics(input: {
  window: NightWindow;
  sourceRowCount: number;
  decisionCount: number;
  built: PlanningDecisionReservationResult;
  canaryRequested: boolean;
  canaryMatchedGroupCount: number;
  canaryTargetGroupKey: string | null;
}): ReservationPlan["diagnostics"] {
  const { built } = input;
  const bySport: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const r of built.reservations) {
    if (r.sport) bySport[r.sport] = (bySport[r.sport] ?? 0) + 1;
    if (r.event_tier) byTier[r.event_tier] = (byTier[r.event_tier] ?? 0) + 1;
  }
  const rejectionCountsByCode: Record<string, number> = {};
  for (const rejection of built.rejections) {
    rejectionCountsByCode[rejection.reason_code] =
      (rejectionCountsByCode[rejection.reason_code] ?? 0) + 1;
  }
  const outsideHorizon = rejectionCountsByCode.OUTSIDE_RESERVATION_HORIZON ?? 0;
  const reservedCount = built.reservations.length;

  return {
    // ── Contract A authority ────────────────────────────────────────────────
    reservation_authority: "CONTRACT_A_PLANNING_DECISION",
    planning_decisions: input.decisionCount,
    planning_decisions_approved: built.approvedCount,
    planning_decisions_rejected: built.rejectedCount,
    duplicate_rejected: built.duplicateRejected,
    cap_excluded: built.capExcluded,
    allocation_policy_id: LIVE_RESERVATION_ALLOCATION_V1.policyId,
    allocation_min_start_lead_minutes: LIVE_RESERVATION_ALLOCATION_V1.minStartLeadMinutes,
    allocation_target_reservation_slots: LIVE_RESERVATION_ALLOCATION_V1.targetReservationSlots,
    allocation_ranking_order: [...LIVE_RESERVATION_ALLOCATION_V1.rankingOrder],
    allocation_allocatable_after_time_guard: built.allocatableAfterTimeGuard,
    allocation_minimum_lead_rejected: built.minimumLeadRejected,
    allocation_missing_provider_volume: built.missingProviderVolume,
    // ── Real stage counts for this path ─────────────────────────────────────
    universe_size: input.decisionCount,
    upstream_approved_candidates: built.approvedCount,
    upstream_rejected_candidates_dropped: built.rejectedCount,
    unique_physical_events: new Set(built.admittedOccurrenceIds).size,
    duplicate_events_removed: built.duplicateRejected,
    slot_allocated: reservedCount,
    slot_remaining: Math.max(0, TARGET_LIVE_SLOTS - reservedCount),
    event_groups: built.admittedOccurrenceIds.length,
    canonical_event_groups: new Set(built.admittedOccurrenceIds).size,
    reserved_count: reservedCount,
    by_sport: bySport,
    by_tier: byTier,
    skipped_outside_horizon: outsideHorizon,
    skipped_weak_key: 0,
    skipped_non_tier1_event: 0,
    skipped_no_executable_anchor: 0,
    skipped_no_fullmatch_anchor: 0,
    skipped_no_planning_identity: 0,
    planning_rejection_reasons: {},
    identity_complete_count: 0,
    source_rows: input.sourceRowCount,
    rows_after_horizon: built.admittedOccurrenceIds.length,
    normalized_physical_events: built.approvedCount,
    physical_event_groups: new Set(built.admittedOccurrenceIds).size,
    authoritative_candidates: built.approvedCount,
    planning_eligible_events: built.admittedOccurrenceIds.length,
    executable_anchor_candidates: 0,
    fullmatch_anchor_candidates: 0,
    planning_identity_candidates: built.approvedCount,
    timing_eligible_events: built.admittedOccurrenceIds.length,
    slot_candidates_considered: built.admittedOccurrenceIds.length,
    slot_allocated_count: reservedCount,
    slot_not_allocated_count: built.capExcluded,
    reservations_created: reservedCount,
    rejected_by_anchor: 0,
    rejected_by_scope: 0,
    final_identity_available_at_planning: 0,
    rejection_counts_by_code: rejectionCountsByCode,
    first_rejection_code: built.rejections[0]?.reason_code ?? null,
    groups_with_fullmatch_candidate: 0,
    groups_only_partial_or_prop: 0,
    groups_with_valid_sibling_but_wrong_rep: 0,
    allowed_moneyline_count: 0,
    allowed_spread_count: 0,
    allowed_total_count: 0,
    rejected_partial_count: 0,
    rejected_prop_count: 0,
    rejected_activity_label_count: 0,
    first_zero_stage:
      input.sourceRowCount === 0
        ? "SOURCE_ROWS"
        : built.approvedCount === 0
          ? "NORMALIZED_PHYSICAL_EVENTS"
          : built.admittedOccurrenceIds.length === 0
            ? "TIMING_ELIGIBLE"
            : reservedCount === 0
              ? "RESERVATIONS_CREATED"
              : null,
    market_level_keys_skipped: 0,
    market_level_keys_normalized: 0,
    horizon_end_iso: input.window.horizonEndIso,
    window_end_iso: input.window.endIso,
    reserved_wc_or_soccer_count: 0,
    skipped_by_horizon_count: outsideHorizon,
    skipped_by_cap_count: built.capExcluded,
    tier1PhysicalMatchesSeen: 0,
    tier1ReservationsPlanned: 0,
    tier1AlreadyReserved: 0,
    tier1ReservationGapsAfterBuild: 0,
    weakKeysMerged: 0,
    representativeTitleReplaced: 0,
    completeCandidateUniverseUsed: true,
    underfillInvariantPass: true,
    targetLiveSlots: TARGET_LIVE_SLOTS,
    tier1ReservedCount: 0,
    fallbackSlotFillReservedCount: 0,
    fallbackTier2Reserved: 0,
    fallbackTier3Reserved: 0,
    fallbackEligibleGroupsSeen: 0,
    fallbackSkippedNoAllowedFullmatch: 0,
    fallback_rejection_reasons: {},
    fullmatch_rejection_reasons: {},
    executable_fullmatch_anchor_count: 0,
    structured_event_level_anchor_count: 0,
    planning_anchor_rejected_count: 0,
    planning_anchor_reason_counts: {},
    fullmatch_rejection_groups_total: 0,
    fullmatch_rejection_candidates_total: 0,
    fullmatch_rejection_evidence_preview: [],
    slotFillTargetReached: reservedCount >= TARGET_LIVE_SLOTS,
    canary_target_requested: input.canaryRequested,
    canary_target_matched_group_count: input.canaryMatchedGroupCount,
    canary_target_group_key: input.canaryTargetGroupKey,
  };
}

function structuredProviderMarketVolume(row: Record<string, unknown>): number | null {
  const diagnostics = row.diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const value = (diagnostics as Record<string, unknown>).parentEventVolume24hr;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerVolumeByPhysicalEventId(
  rows: readonly Record<string, unknown>[],
  results: readonly ContractADecisionResult<ContractAPlanningDecision>[],
): Map<string, number | null> {
  const rowsById = new Map<string, Record<string, unknown>>();
  const rowsByObservation = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id) rowsById.set(row.id, row);
    const conditionId = typeof row.condition_id === "string" ? row.condition_id : "";
    const tokenId = typeof row.selected_token_id === "string" ? row.selected_token_id : "";
    if (conditionId && tokenId) rowsByObservation.set(`${conditionId}::${tokenId}`, row);
  }

  const volumes = new Map<string, number | null>();
  for (const result of results) {
    if (!result.accepted) continue;
    const lineage = result.decision.source_lineage;
    const row =
      (lineage.generated_signal_pair_id
        ? rowsById.get(lineage.generated_signal_pair_id)
        : undefined) ??
      (lineage.observation_id ? rowsByObservation.get(lineage.observation_id) : undefined);
    const volume = row ? structuredProviderMarketVolume(row) : null;
    const prior = volumes.get(result.decision.physical_event_id) ?? null;
    if (volume !== null && (prior === null || volume > prior)) {
      volumes.set(result.decision.physical_event_id, volume);
    } else if (!volumes.has(result.decision.physical_event_id)) {
      volumes.set(result.decision.physical_event_id, null);
    }
  }
  return volumes;
}

/**
 * Build the frozen reservation plan from AUTHORITATIVE Contract A Planning
 * Decisions (PURE — no DB writes).
 *
 * Production path: real planning source rows -> the real Contract A producer
 * (`produceContractAPlanningDecisions`, which itself enters
 * `buildFireModelCandidates`) -> Planning Decisions -> Reservations.
 */
export async function buildContractAReservationPlan(
  nowMs: number,
  deps: {
    fetchSourceRows?: () => Promise<readonly Record<string, unknown>[]>;
    produceDecisions?: (
      rows: readonly Record<string, unknown>[]
    ) => Promise<ContractADecisionResult<ContractAPlanningDecision>[]>;
    activeOccurrences?: readonly ReservationOccurrenceGuardRow[];
    targetPhysicalEventKeyHash?: string;
    hashPhysicalEventKey?: (key: string) => string;
  } = {}
): Promise<ReservationPlan> {
  const window = resolveNightWindow(nowMs);
  const planRunId = buildPlanRunId(nowMs);

  const rows = deps.fetchSourceRows
    ? await deps.fetchSourceRows()
    : await (async () => {
        const { loadContractAPlanningSourceRows } = await import("./buildFireModelCandidates");
        return loadContractAPlanningSourceRows();
      })();

  const produce =
    deps.produceDecisions ??
    (async (sourceRows: readonly Record<string, unknown>[]) => {
      const { produceContractAPlanningDecisions } = await import("./contractADecisions");
      return produceContractAPlanningDecisions(sourceRows);
    });
  const results = await produce(rows);

  const ctx = { planRunId, window, nowMs };
  const activeOccurrences = deps.activeOccurrences ?? [];
  const providerVolumes = providerVolumeByPhysicalEventId(rows, results);
  let built = buildReservationsFromPlanningDecisions(results, ctx, activeOccurrences, {
    allocationPolicy: LIVE_RESERVATION_ALLOCATION_V1,
    providerVolumeByPhysicalEventId: providerVolumes,
  });

  // ── Canary single-event targeting (planning-stage only; never fuzzy) ──────
  // Matched against the FULL admitted set, before the cap, so a CEO-approved
  // target outside the top slots is still addressable. Zero or ambiguous
  // matches reserve nothing; callers read canary_target_matched_group_count.
  const canaryRequested = deps.targetPhysicalEventKeyHash !== undefined;
  const hashFn = deps.hashPhysicalEventKey ?? hashPhysicalEventKey;
  let canaryMatchedGroupCount = 0;
  let canaryTargetGroupKey: string | null = null;
  if (canaryRequested) {
    const matches = built.admittedOccurrenceIds.filter(
      (id) => hashFn(id) === deps.targetPhysicalEventKeyHash
    );
    canaryMatchedGroupCount = matches.length;
    canaryTargetGroupKey = matches.length === 1 ? matches[0] : null;
    built = buildReservationsFromPlanningDecisions(results, ctx, activeOccurrences, {
      restrictToOccurrenceIds: new Set(canaryTargetGroupKey ? [canaryTargetGroupKey] : []),
      allocationPolicy: LIVE_RESERVATION_ALLOCATION_V1,
      providerVolumeByPhysicalEventId: providerVolumes,
    });
  }

  // Bounded structured trace: stage, counts and stable reason codes only —
  // never a provider payload, market identity, token or env value.
  console.log(
    "[contract-a] planning_decision_reservation",
    JSON.stringify({
      stage: "RESERVATION_FROM_PLANNING_DECISION",
      plan_run_id: planRunId,
      source_rows: rows.length,
      planning_decisions: results.length,
      approved: built.approvedCount,
      rejected: built.rejectedCount,
      reservation_candidates: built.admittedOccurrenceIds.length,
      duplicate_rejected: built.duplicateRejected,
      cap_excluded: built.capExcluded,
      reservations_created: built.reservations.length,
      cap: TARGET_LIVE_SLOTS,
      first_rejection_code: built.rejections[0]?.reason_code ?? null,
    })
  );

  return {
    plan_run_id: planRunId,
    plan_date_minsk: window.planDateMinsk,
    window,
    reservations: built.reservations,
    fullmatch_rejection: buildFullmatchRejectionEvidence([]),
    diagnostics: contractAPlanDiagnostics({
      window,
      sourceRowCount: rows.length,
      decisionCount: results.length,
      built,
      canaryRequested,
      canaryMatchedGroupCount,
      canaryTargetGroupKey,
    }),
  };
}

/**
 * Persist a reservation plan idempotently. If the plan_run_id already has rows and
 * force is false, the existing frozen plan is returned untouched.
 */
export async function persistReservationPlan(
  plan: ReservationPlan,
  opts: { force?: boolean } = {},
  repo: ReservationRepoPort = createSupabaseReservationRepoPort()
): Promise<PersistReservationsResult> {
  const existing = await repo.findByPlanRunId(plan.plan_run_id);

  if (plan.reservations.length === 0) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: false,
      written_count: 0,
      reserved_count: 0,
      reservations: [],
      diagnostics: plan.diagnostics,
    };
  }

  const canonicalRows = plan.reservations.map((reservation) => {
    const physicalEventId = reservation.physical_event_id?.trim() ?? "";
    const eventStartIso = reservation.event_start_iso?.trim() ?? "";
    const eventStartMs = Date.parse(eventStartIso);
    if (!physicalEventId || !Number.isFinite(eventStartMs)) {
      throw new Error(
        `RESERVATION_OCCURRENCE_IDENTITY_MISSING: plan_run_id=${plan.plan_run_id} match_family_key=${reservation.match_family_key}`
      );
    }
    return { reservation, physicalEventId, eventStartIso, eventStartMs };
  });

  if (!opts.force) {
    const reused: NightEventReservationRow[] = [];
    const toInsert: NightEventReservationRow[] = [];

    for (const current of canonicalRows) {
      const found = await findExistingReservationOccurrence(repo, current, existing);
      if (found) {
        const foundStartMs = Date.parse(found.event_start_iso ?? "");
        if (!Number.isFinite(foundStartMs) || foundStartMs !== current.eventStartMs) {
          throw new Error(
            `OCCURRENCE_IDENTITY_CONFLICT: reservation_id=${found.id ?? "unknown"} physical_event_id=${current.physicalEventId} existing_event_start_iso=${found.event_start_iso ?? "null"} current_event_start_iso=${current.eventStartIso}`
          );
        }
        reused.push(found);
      } else {
        toInsert.push(current.reservation);
      }
    }

    if (toInsert.length === 0) {
      return {
        plan_run_id: plan.plan_run_id,
        already_exists: true,
        written_count: 0,
        reserved_count: reused.length,
        reservations: reused,
        diagnostics: plan.diagnostics,
      };
    }

    await repo.insert(toInsert);
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: reused.length > 0,
      written_count: toInsert.length,
      reserved_count: reused.length + toInsert.length,
      reservations: [...reused, ...toInsert],
      diagnostics: plan.diagnostics,
    };
  }

  if (existing.length > 0 && opts.force) {
    await repo.deleteByPlanRunId(plan.plan_run_id);
  }

  await repo.insert(plan.reservations);

  return {
    plan_run_id: plan.plan_run_id,
    already_exists: false,
    written_count: plan.reservations.length,
    reserved_count: plan.reservations.length,
    reservations: plan.reservations,
    diagnostics: plan.diagnostics,
  };
}

/**
 * Full reservation cron orchestration: build the plan, persist it
 * idempotently, and record job_runs evidence for both success and failure.
 * This is the entry point app/api/cron/night-event-reservations/route.ts
 * calls for its standard (non-status, non-forceRebuild) write path.
 */
export async function runReservationCronWithEvidence(
  nowMs: number,
  opts: { force?: boolean; selectorMode?: FireModelSelectorMode } = {},
  deps: {
    fetchCandidates?: () => Promise<ReservationCandidateFetchResult>;
    fetchSourceRows?: () => Promise<readonly Record<string, unknown>[]>;
    produceDecisions?: (
      rows: readonly Record<string, unknown>[]
    ) => Promise<ContractADecisionResult<ContractAPlanningDecision>[]>;
    selectorMode?: FireModelSelectorMode;
    repo?: ReservationRepoPort;
    jobEvidence?: SchedulerJobEvidencePort;
    targetPhysicalEventKeyHash?: string;
    hashPhysicalEventKey?: (key: string) => string;
  } = {}
): Promise<{ plan: ReservationPlan; persisted: PersistReservationsResult }> {
  const jobEvidence = deps.jobEvidence ?? createSupabaseSchedulerJobEvidencePort();
  const startedAt = new Date().toISOString();
  try {
    const plan = opts.selectorMode === "CONTRACT_A_PLANNING_V1"
      ? await buildContractAReservationPlan(nowMs, {
          fetchSourceRows: deps.fetchSourceRows,
          produceDecisions: deps.produceDecisions,
          targetPhysicalEventKeyHash: deps.targetPhysicalEventKeyHash,
          hashPhysicalEventKey: deps.hashPhysicalEventKey,
        })
      : await buildReservationPlan(nowMs, {
          fetchCandidates: deps.fetchCandidates,
          selectorMode: opts.selectorMode,
          targetPhysicalEventKeyHash: deps.targetPhysicalEventKeyHash,
          hashPhysicalEventKey: deps.hashPhysicalEventKey,
        });
    const persisted = deps.repo
      ? await persistReservationPlan(plan, opts, deps.repo)
      : await persistReservationPlan(plan, opts);
    const finishedAt = new Date().toISOString();
    await jobEvidence.writeJobRun({
      source: "night-event-reservations",
      formulaVersion: "reservation-v1",
      startedAt,
      finishedAt,
      status: persisted.written_count > 0 || persisted.already_exists ? "success" : "empty",
      generatedCount: persisted.written_count,
      rejectedCount: planningRejectedCount(plan),
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      diagnostics: {
        ...buildPlanningJobDiagnostics(plan),
        plan_run_id: persisted.plan_run_id,
        already_exists: persisted.already_exists,
        reserved_count: persisted.reserved_count,
      },
    });
    return { plan, persisted };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const msg = err instanceof Error ? err.message : "Unknown error";
    const sanitizedMsg = sanitizeSchedulerErrorMessage(msg);
    // job_runs.diagnostics is NOT NULL. The error path previously omitted
    // this field entirely, which made the writeJobRun insert itself throw
    // (23502), and that secondary failure was swallowed as non-fatal by
    // createSupabaseSchedulerJobEvidencePort -- silently erasing every
    // Reservation failure from job_runs. A minimal non-null failure-context
    // object satisfies the schema without inventing new evidence shape.
    await jobEvidence.writeJobRun({
      source: "night-event-reservations",
      formulaVersion: "reservation-v1",
      startedAt,
      finishedAt,
      status: "error",
      generatedCount: 0,
      rejectedCount: 0,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      errorMessage: sanitizedMsg,
      diagnostics: {
        error_message: sanitizedMsg,
        selector_mode: opts.selectorMode ?? null,
      },
    });
    throw err;
  }
}


/**
 * The planning funnel persisted into job_runs.diagnostics (existing JSONB
 * column -- no migration). A production run that reports status=empty must be
 * fully explainable from this one row: every stage count, every rejection code,
 * the first stage that reached zero and the first rejection that fired.
 *
 * Deliberately carries counts and stable code names only -- never provider
 * payloads, request headers, env values, tokens or condition/token ids.
 *
 * NOTE on rejected_count (the legacy scalar column): it is the sum of exactly
 * three counters (non_tier1 + outside_horizon + no_executable_anchor) and omits
 * every other rejection path, so it must never be read as "candidates rejected".
 * rejection_counts_by_code below is the complete picture.
 */
export function buildPlanningJobDiagnostics(plan: ReservationPlan): Record<string, unknown> {
  const d = plan.diagnostics;
  return {
    plan_run_id: plan.plan_run_id,
    source_rows: d.source_rows,
    rows_after_horizon: d.rows_after_horizon,
    normalized_physical_events: d.normalized_physical_events,
    physical_event_groups: d.physical_event_groups,
    authoritative_candidates: d.authoritative_candidates,
    planning_eligible_events: d.planning_eligible_events,
    reservations_created: d.reservations_created,
    rejected_count: planningRejectedCount(plan),
    rejection_counts_by_code: d.rejection_counts_by_code,
    first_zero_stage: d.first_zero_stage,
    first_rejection_code: d.first_rejection_code,
    final_identity_available_at_planning: d.final_identity_available_at_planning,
    // R0I: aggregate counts plus a 3x3 preview, so a status=empty row names what
    // the full-match gate actually saw. The complete bounded evidence stays in
    // the filesystem report -- this column is not enlarged with it.
    executable_fullmatch_anchor_count: d.executable_fullmatch_anchor_count,
    structured_event_level_anchor_count: d.structured_event_level_anchor_count,
    planning_anchor_rejected_count: d.planning_anchor_rejected_count,
    planning_anchor_reason_counts: d.planning_anchor_reason_counts,
    fullmatch_rejection_groups_total: d.fullmatch_rejection_groups_total,
    fullmatch_rejection_candidates_total: d.fullmatch_rejection_candidates_total,
    fullmatch_rejection_evidence_preview: d.fullmatch_rejection_evidence_preview,
  };
}

/**
 * The legacy job_runs.rejected_count scalar, kept byte-identical to the value
 * production has always written so historical rows stay comparable. Its exact
 * (narrow) semantics are documented in buildPlanningJobDiagnostics.
 */
export function planningRejectedCount(plan: ReservationPlan): number {
  return (
    plan.diagnostics.skipped_non_tier1_event +
    plan.diagnostics.skipped_outside_horizon +
    plan.diagnostics.skipped_no_executable_anchor
  );
}

/**
 * Persist reservation plan diagnostics to filesystem under modeling/fire_runs/contur3-reservations/.
 * Failure does NOT fail the business cron; it logs a warning and continues.
 */
export async function persistReservationPlanDiagnostics(
  plan: ReservationPlan,
  opts?: { context?: string }
): Promise<{ path: string | null; error: string | null }> {
  try {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runIdSafe = plan.plan_run_id.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${runIdSafe}_${timestamp}.json`;

    const dirPath = path.join(process.cwd(), "modeling", "fire_runs", "contur3-reservations");
    await mkdir(dirPath, { recursive: true });

    const filePath = path.join(dirPath, filename);
    const payload = {
      generated_at: new Date().toISOString(),
      plan_run_id: plan.plan_run_id,
      plan_date_minsk: plan.plan_date_minsk,
      commit,
      context: opts?.context || "persistReservationPlan",
      diagnostics: plan.diagnostics,
      // R0I: the complete bounded evidence for every group the full-match gate
      // rejected. A zero-Reservation night must be explainable from this file
      // alone -- previously it carried aggregate counts and nothing else.
      ...plan.fullmatch_rejection,
      reservation_count: plan.reservations.length,
      reserved_events: plan.reservations.map((r) => ({
        rank: r.reservation_rank,
        event_title: r.event_title,
        match_family_key: r.match_family_key,
        sport: r.sport,
        tier: r.event_tier,
        score: r.event_score,
      })),
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[persistReservationPlanDiagnostics] Diagnostic write failed (non-fatal):", msg);
    return { path: null, error: msg };
  }
}

// ── Founder email (rendered from frozen reservations, NOT stateless slots) ──────

function reservationRebalanceIso(gameStartIso: string): string {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return gameStartIso;
  return new Date(ms - REBALANCE_MINUTES_BEFORE_START * 60_000).toISOString();
}

function reservationExecWindowIso(gameStartIso: string): { from: string; to: string } {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return { from: gameStartIso, to: gameStartIso };
  return {
    from: new Date(ms - PREFERRED_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
    to: new Date(ms - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
  };
}

export function nightReservationEmail(
  planRunId: string,
  reservations: NightEventReservationRow[]
): { subject: string; text: string } {
  const L: string[] = [];
  const windowStart = reservations[0]?.window_start_iso ?? null;
  const windowEnd = reservations[0]?.window_end_iso ?? null;
  L.push(`PolyProPicks Night Portfolio Plan (frozen reservations)`);
  L.push(`plan_run_id: ${planRunId}`);
  if (windowStart && windowEnd) {
    L.push(`Window: ${formatMinskUtc(windowStart)} -> ${formatMinskUtc(windowEnd)}`);
  }
  L.push(`Reserved events: ${reservations.length}`);
  L.push("");
  L.push("CONTROL MODEL: Ireland AUTO-STARTS at 18:00 Minsk. This email is informational +");
  L.push("emergency-override only - NO approval required. Market selection per event happens");
  L.push("later at T-60/T-30 rebalance; Ireland reads only the execution queue.");
  L.push("");
  if (reservations.length === 0) {
    L.push("(no events reserved for tonight)");
  } else {
    L.push("Reserved events (event-level; one market chosen later per event):");
    reservations.forEach((r) => {
      const ew = reservationExecWindowIso(r.game_start_iso);
      L.push(
        `  #${r.reservation_rank} [${r.event_tier}] ${r.event_title} ` +
          `(${r.strategic_scope}/${r.sport ?? "?"})`
      );
      L.push(`      start:     ${formatMinskUtc(r.game_start_iso)}`);
      L.push(`      rebalance: ${formatMinskUtc(reservationRebalanceIso(r.game_start_iso))}`);
      L.push(`      exec win:  ${formatMinskUtc(ew.from)} -> ${formatMinskUtc(ew.to)}`);
    });
  }
  L.push("");
  L.push("NOTE: one reserved event = at most one live position after rebalance.");
  const subject = `PolyProPicks Night Plan — ${reservations.length} events reserved — ${planRunId}`;
  return { subject, text: L.join("\n") };
}

/**
 * Ensure a frozen plan exists for the current run, then return its reservations.
 * Used by the email path so the email always reflects persisted reservations.
 */
export async function ensureAndLoadReservations(
  nowMs: number,
  opts: { allowCreate?: boolean; selectorMode?: FireModelSelectorMode } = {}
): Promise<{ planRunId: string; reservations: NightEventReservationRow[]; created: boolean }> {
  const planRunId = buildPlanRunId(nowMs);
  let reservations = await loadReservations(planRunId);
  let created = false;
  if (reservations.length === 0 && opts.allowCreate) {
    const plan = await buildReservationPlan(nowMs, { selectorMode: opts.selectorMode });
    await persistReservationPlan(plan, { force: false });
    reservations = await loadReservations(planRunId);
    created = true;
  }
  return { planRunId, reservations, created };
}

/** Read frozen reservations for a plan_run_id, rank-ordered. */
export async function loadReservations(planRunId: string): Promise<NightEventReservationRow[]> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`reservation load failed: ${error.message}`);
  return (data ?? []) as NightEventReservationRow[];
}

// ── Plan health diagnostics ────────────────────────────────────────────────

// Minimum overnight battle WC/soccer event floor. If fewer are reserved than this
// threshold and the plan has rows, needs_rebuild is set to true so founders see the signal.
const BATTLE_WC_MIN_FLOOR = 2;

export interface PlanHealth {
  has_rows: boolean;
  total_count: number;
  reserved_count: number;
  queued_count: number;
  skipped_count: number;
  expired_count: number;
  bad_market_level_count: number;
  active_future_count: number;
  earliest_game_start_iso: string | null;
  latest_game_start_iso: string | null;
  is_expired_only: boolean;
  needs_rebuild: boolean;
  rebuild_allowed: boolean;
  // Horizon diagnostics — populated from resolveNightWindow at status-read time.
  window_end_iso: string;
  horizon_end_iso: string;
  // WC/soccer floor diagnostics.
  reserved_wc_or_soccer_count: number;
  // eligible_wc_or_soccer_count = reserved count when loaded from DB (no rebuild);
  // it equals the actual eligible count only during a fresh build run.
  eligible_wc_or_soccer_count: number;
  wc_floor_below_minimum: boolean;
  // skipped_by_horizon_count and skipped_by_cap_count are only available during a
  // fresh buildReservationPlan run; 0 when loaded from existing DB rows.
  skipped_by_horizon_count: number;
  skipped_by_cap_count: number;
}

/**
 * Read existing plan rows from DB and compute health diagnostics.
 * Pure read — no writes. Returns zero-counts when the plan does not exist yet.
 */
export async function loadPlanStatus(planRunId: string, nowMs: number): Promise<PlanHealth> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`loadPlanStatus: ${error.message}`);

  const rows = (data ?? []) as NightEventReservationRow[];
  const total = rows.length;

  const statusBuckets: Record<string, number> = {};
  for (const r of rows) statusBuckets[r.status] = (statusBuckets[r.status] ?? 0) + 1;

  const reservedCount = statusBuckets["RESERVED"] ?? 0;
  const rebalancePendingCount = statusBuckets["REBALANCE_PENDING"] ?? 0;
  const queuedCount = statusBuckets["QUEUED"] ?? 0;
  const skippedCount = (statusBuckets["SKIPPED"] ?? 0) + (statusBuckets["CANCELLED"] ?? 0);
  const expiredCount = statusBuckets["EXPIRED"] ?? 0;

  const ACTIVE_STATUSES = new Set(["RESERVED", "REBALANCE_PENDING", "QUEUED"]);
  const activeFutureRows = rows.filter(
    (r) => ACTIVE_STATUSES.has(r.status) && !!r.game_start_iso && Date.parse(r.game_start_iso) > nowMs
  );
  const activeFutureCount = activeFutureRows.length;

  // Post-hoc check: rows whose match_family_key looks like a market-level prop line.
  const badMarketLevelCount = rows.filter((r) => MARKET_LEVEL_KEY_RE.test(r.match_family_key)).length;

  const gameStartTimes = rows
    .map((r) => r.game_start_iso)
    .filter((s): s is string => !!s)
    .sort();

  const isExpiredOnly = total > 0 && activeFutureCount === 0;

  // WC/soccer floor: count active reservations with WC or SOCCER strategic_scope.
  const reservedWcOrSoccer = rows.filter(
    (r) =>
      ACTIVE_STATUSES.has(r.status) &&
      (r.strategic_scope === "WC" || r.strategic_scope === "SOCCER")
  ).length;
  const wcFloorBelowMinimum = total > 0 && reservedWcOrSoccer < BATTLE_WC_MIN_FLOOR;

  // needs_rebuild: expired-only, bad market keys, or WC floor below minimum battle threshold.
  const needsRebuild = isExpiredOnly || badMarketLevelCount > 0 || wcFloorBelowMinimum;

  // Horizon bounds computed from current window (read-time, not build-time).
  const nightWindow = resolveNightWindow(nowMs);

  return {
    has_rows: total > 0,
    total_count: total,
    reserved_count: reservedCount + rebalancePendingCount,
    queued_count: queuedCount,
    skipped_count: skippedCount,
    expired_count: expiredCount,
    bad_market_level_count: badMarketLevelCount,
    active_future_count: activeFutureCount,
    earliest_game_start_iso: gameStartTimes[0] ?? null,
    latest_game_start_iso: gameStartTimes[gameStartTimes.length - 1] ?? null,
    is_expired_only: isExpiredOnly,
    needs_rebuild: needsRebuild,
    rebuild_allowed: true,
    window_end_iso: nightWindow.endIso,
    horizon_end_iso: nightWindow.horizonEndIso,
    reserved_wc_or_soccer_count: reservedWcOrSoccer,
    eligible_wc_or_soccer_count: reservedWcOrSoccer,
    wc_floor_below_minimum: wcFloorBelowMinimum,
    skipped_by_horizon_count: 0,
    skipped_by_cap_count: 0,
  };
}

export interface ForceRebuildResult {
  // REBUILT: replacement plan was non-empty; existing rows were deleted and
  // replaced. ABORTED_NO_REPLACEMENT: replacement plan was empty; nothing was
  // deleted and the prior reservation (if any) is untouched.
  result: "REBUILT" | "ABORTED_NO_REPLACEMENT";
  plan_run_id: string;
  deleted_queue_count: number;
  deleted_reservation_count: number;
  plan: ReservationPlan;
  persist: PersistReservationsResult;
  plan_health: PlanHealth;
}

// ── bounded retry (reads and idempotent deletes ONLY -- never inserts) ─────
export interface BoundedRetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

export interface StageRetryError extends Error {
  stage: string;
  attempts: number;
}

const DEFAULT_SAFE_RETRY_POLICY: BoundedRetryPolicy = {
  maxAttempts: 3,
  backoffMs: (attempt) => Math.min(200 * attempt, 1000),
};

/**
 * Retries a read or idempotent-delete operation up to `policy.maxAttempts`
 * times with bounded backoff. Never used for inserts -- an insert failure is
 * handled by persistReservationPlanWithReconciliation instead, which reads
 * back canonical identities rather than blindly repeating the write.
 */
async function withBoundedRetry<T>(
  stage: string,
  op: () => Promise<T>,
  policy: BoundedRetryPolicy = DEFAULT_SAFE_RETRY_POLICY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  let lastMessage = "unknown error";
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt < policy.maxAttempts) {
        await sleep(policy.backoffMs(attempt));
      }
    }
  }
  const retryError = new Error(
    `${stage} failed after ${policy.maxAttempts} attempts: ${sanitizeSchedulerErrorMessage(lastMessage)}`
  ) as StageRetryError;
  retryError.stage = stage;
  retryError.attempts = policy.maxAttempts;
  throw retryError;
}

// ── force-rebuild delete boundary (idempotent -- safe to retry) ────────────
export interface ForceRebuildRepoPort {
  deleteQueueByPlanRunId(planRunId: string): Promise<{ deletedCount: number }>;
  deleteReservationsByPlanRunId(planRunId: string): Promise<{ deletedCount: number }>;
}

export function createSupabaseForceRebuildRepoPort(): ForceRebuildRepoPort {
  return {
    async deleteQueueByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .delete()
        .eq("plan_run_id", planRunId)
        .select("id");
      if (error) throw new Error(`forceRebuild queue delete: ${error.message}`);
      return { deletedCount: data?.length ?? 0 };
    },
    async deleteReservationsByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .delete()
        .eq("plan_run_id", planRunId)
        .select("id");
      if (error) throw new Error(`forceRebuild reservation delete: ${error.message}`);
      return { deletedCount: data?.length ?? 0 };
    },
  };
}

export interface AmbiguousInsertError extends Error {
  stage: string;
  ambiguous: true;
}

/**
 * Persists a reservation plan, but never blindly retries the insert itself.
 * If persistReservationPlan throws (e.g. a network-shaped error where the
 * database may have accepted the write despite the client seeing a failure),
 * this reconciles by reading back the plan_run_id's existing rows and
 * checking whether every planned reservation identity
 * (match_family_key + reservation_rank -- the same pair the DB's own
 * night_event_reservations_plan_event_uniq / *_reservation_rank_uniq
 * constraints key on) is already present. Only then is the run reported as
 * successful; otherwise it fails closed with sanitized stage context, and no
 * second insert is ever attempted.
 */
async function persistReservationPlanWithReconciliation(
  plan: ReservationPlan,
  repo: ReservationRepoPort
): Promise<PersistReservationsResult> {
  try {
    return await persistReservationPlan(plan, { force: false }, repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const existing = await repo.findByPlanRunId(plan.plan_run_id);
    const reservationIdentity = (r: NightEventReservationRow) => `${r.match_family_key}::${r.reservation_rank}`;
    const expectedKeys = new Set(plan.reservations.map(reservationIdentity));
    const presentKeys = new Set(existing.map(reservationIdentity));
    const allPresent = plan.reservations.length > 0 && [...expectedKeys].every((k) => presentKeys.has(k));
    if (allPresent) {
      return {
        plan_run_id: plan.plan_run_id,
        already_exists: false,
        written_count: plan.reservations.length,
        reserved_count: existing.length,
        reservations: existing,
        diagnostics: plan.diagnostics,
      };
    }
    const reconciliationError = new Error(
      `force_rebuild_insert_reconciliation failed: ${sanitizeSchedulerErrorMessage(msg)}`
    ) as AmbiguousInsertError;
    reconciliationError.stage = "force_rebuild_insert_reconciliation";
    reconciliationError.ambiguous = true;
    throw reconciliationError;
  }
}

/**
 * CEO-approved force rebuild for the current plan_run_id.
 * Deletes event_execution_queue rows AND night_event_reservations rows for this plan,
 * then rebuilds fresh from the current universe.
 * Only touches the two Contur3 tables for the current plan_run_id.
 *
 * This is the exact function the production night-reservation cron invokes
 * (the runner always calls the route with ?forceRebuild=CEO_APPROVED). Reads
 * and the two idempotent deletes are bounded-retried; the reservation insert
 * is never blindly retried (see persistReservationPlanWithReconciliation);
 * job_runs evidence is recorded for both success and terminal failure.
 */
export async function executeForceRebuild(
  nowMs: number,
  deps: {
    fetchCandidates?: () => Promise<ReservationCandidateFetchResult>;
    selectorMode?: FireModelSelectorMode;
    repo?: ReservationRepoPort;
    forceRebuildRepo?: ForceRebuildRepoPort;
    jobEvidence?: SchedulerJobEvidencePort;
    loadPlanStatus?: (planRunId: string, nowMs: number) => Promise<PlanHealth>;
  } = {}
): Promise<ForceRebuildResult> {
  const repo = deps.repo ?? createSupabaseReservationRepoPort();
  const forceRebuildRepo = deps.forceRebuildRepo ?? createSupabaseForceRebuildRepoPort();
  const jobEvidence = deps.jobEvidence ?? createSupabaseSchedulerJobEvidencePort();
  const loadPlanStatusFn = deps.loadPlanStatus ?? loadPlanStatus;
  const planRunId = buildPlanRunId(nowMs);
  const startedAt = new Date().toISOString();

  try {
    // 1. Build the replacement plan FIRST (PURE -- no DB writes; candidate-page
    //    reads already retry internally via fetchAllPlanningRows' own bounded
    //    per-page retry+timeout). The delete below must never run until we
    //    already know the replacement plan is non-empty -- this closes the
    //    incident where an empty replacement plan silently deleted a real
    //    existing reservation with nothing to take its place.
    const plan = await buildReservationPlan(nowMs, { fetchCandidates: deps.fetchCandidates, selectorMode: deps.selectorMode });

    if (plan.reservations.length === 0) {
      const planHealth = await withBoundedRetry("force_rebuild_plan_health_read_aborted", () =>
        loadPlanStatusFn(planRunId, nowMs)
      );
      const finishedAt = new Date().toISOString();
      await jobEvidence.writeJobRun({
        source: "night-event-reservations-force-rebuild",
        formulaVersion: "force-rebuild-v1",
        startedAt,
        finishedAt,
        status: "empty",
        generatedCount: 0,
        rejectedCount: planningRejectedCount(plan),
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        diagnostics: {
          ...buildPlanningJobDiagnostics(plan),
          plan_run_id: planRunId,
          deleted_queue_count: 0,
          deleted_reservation_count: 0,
          reserved_count: 0,
          aborted_reason: "EMPTY_REPLACEMENT_PLAN",
        },
      });

      return {
        result: "ABORTED_NO_REPLACEMENT",
        plan_run_id: planRunId,
        deleted_queue_count: 0,
        deleted_reservation_count: 0,
        plan,
        persist: {
          plan_run_id: planRunId,
          already_exists: false,
          written_count: 0,
          reserved_count: 0,
          reservations: [],
          diagnostics: plan.diagnostics,
        },
        plan_health: planHealth,
      };
    }

    // 2. Delete event_execution_queue rows for this plan_run_id (idempotent, retry-safe).
    //    Only reached once the replacement plan above is known to be non-empty.
    const { deletedCount: deletedQueueCount } = await withBoundedRetry("force_rebuild_queue_delete", () =>
      forceRebuildRepo.deleteQueueByPlanRunId(planRunId)
    );

    // 3. Delete night_event_reservations rows for this plan_run_id (idempotent, retry-safe).
    const { deletedCount: deletedResCount } = await withBoundedRetry("force_rebuild_reservation_delete", () =>
      forceRebuildRepo.deleteReservationsByPlanRunId(planRunId)
    );

    // 4. Persist -- insert is never blindly retried; an ambiguous failure is
    //    reconciled by reading back canonical identities, never re-inserted.
    const persist = await persistReservationPlanWithReconciliation(plan, repo);

    // 5. Read back health of the new plan (read, retry-safe).
    const planHealth = await withBoundedRetry("force_rebuild_plan_health_read", () =>
      loadPlanStatusFn(planRunId, nowMs)
    );

    const finishedAt = new Date().toISOString();
    await jobEvidence.writeJobRun({
      source: "night-event-reservations-force-rebuild",
      formulaVersion: "force-rebuild-v1",
      startedAt,
      finishedAt,
      status: "success",
      generatedCount: persist.written_count,
      rejectedCount: planningRejectedCount(plan),
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      diagnostics: {
        ...buildPlanningJobDiagnostics(plan),
        plan_run_id: planRunId,
        deleted_queue_count: deletedQueueCount,
        deleted_reservation_count: deletedResCount,
        reserved_count: persist.reserved_count,
      },
    });

    return {
      result: "REBUILT",
      plan_run_id: planRunId,
      deleted_queue_count: deletedQueueCount,
      deleted_reservation_count: deletedResCount,
      plan,
      persist,
      plan_health: planHealth,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const msg = err instanceof Error ? err.message : "Unknown error";
    await jobEvidence.writeJobRun({
      source: "night-event-reservations-force-rebuild",
      formulaVersion: "force-rebuild-v1",
      startedAt,
      finishedAt,
      status: "error",
      generatedCount: 0,
      rejectedCount: 0,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      errorMessage: sanitizeSchedulerErrorMessage(msg),
    });
    throw err;
  }
}
