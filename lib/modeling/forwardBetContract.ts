/**
 * Forward virtual-BET contract (FORWARD_BET_V1) for the DBClone research ledger.
 *
 * Pure, side-effect-free helpers. The database trigger in
 * ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql is the authority for
 * first_persisted_at, lead times, timing_class and contract_status; the classifier here mirrors those
 * rules for reporting and is parity-tested against the real trigger. Nothing here reads settlement data.
 */

export const FORWARD_BET_CONTRACT_VERSION = "FORWARD_BET_V1" as const;
/** An observation older than this at DB first-save time is a replay, never a fresh forward decision. */
export const FORWARD_MAX_OBSERVATION_LAG_SECONDS = 7200;
export const REFERENCE_PRICE_SOURCE = "research_evidence_page_rows.entry_price_num";
export const REFERENCE_PRICE_TYPE = "EVIDENCE_REFERENCE_NOT_EXECUTABLE";

export type TimingClass =
  | "HISTORICAL_REPLAY"
  | "PRE_START_AUTHORITATIVE"
  | "LATE_AUTHORITATIVE"
  | "PRE_START_SCHEDULED_ONLY"
  | "LATE_SCHEDULED"
  | "START_UNKNOWN";

export type MarketFamily = "MONEYLINE" | "SPREAD" | "TOTAL" | "HANDICAP" | "BTTS" | "COMPLETED_MATCH" | "PROP" | "OTHER";

export type ForwardEvidenceSource = {
  condition_id: string;
  selected_token_id: string;
  observed_at: string;
  provider_event_id: string | null;
  provider_sport_family: string | null;
  market_type: string | null;
  event_title: string | null;
  market_question: string | null;
  selected_outcome?: string | null;
  game_start_iso: string | null;
};

export type ForwardCandidate = {
  candidateIdentity: string;
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  sportFamily: string;
};

/** Contract columns the writer supplies. Lead times, timing_class, contract_status and first_persisted_at are DB-computed. */
export type ForwardBetColumns = {
  contract_version: typeof FORWARD_BET_CONTRACT_VERSION;
  canonical_game_key: string | null;
  provider_event_id: string | null;
  market_family: MarketFamily;
  market_type: string | null;
  line_value: number | null;
  period_scope: string;
  selected_outcome: string | null;
  observed_at: string;
  decision_generated_at: string;
  scheduled_start_at: string | null;
  authoritative_start_at: null;
  authoritative_start_source: null;
  reference_price: number;
  reference_price_source: string;
  reference_price_type: string;
  reference_price_acquired_at: string;
  provider_quote_at: null;
  executable_buy_price: null;
  executable_price_authority: null;
  executable_quote_at: null;
  model_version: string;
  selection_reason: string;
  decision_kind: "BET";
  economic_unit_key: string | null;
};

const SELECTION_REASONS: Record<string, string> = {
  P50_52_SAFE: "SAFE universe; reference price in [0.50,0.52); earliest qualifying observation claims the physical game; daily cap 30",
  PORTFOLIO_BROAD_SAFE: "SAFE universe; PORTFOLIO_BROAD tiers; earliest qualifying observation claims the physical game; daily cap 30",
  QUALITY_FILL_A_SAFE: "SAFE universe; QUALITY_FILL_A portfolio with live mix allocation; daily cap 30",
  QUALITY_FILL_D_SAFE: "SAFE universe; QUALITY_FILL_D portfolio; daily cap 30",
  TENNIS_P50_52_SAFE: "SAFE universe; tennis only; reference price in [0.50,0.52); daily cap 30",
};

export function modelVersionFor(modelId: string): string {
  return `${modelId}@prospective-selection-shadow-v1`;
}

export function selectionReasonFor(modelId: string): string | null {
  return SELECTION_REASONS[modelId] ?? null;
}

/** One physical game per model, independent of the Minsk day or observation instant (cross-date reselection is the same unit). */
export function canonicalGameKey(sportFamily: string | null | undefined, providerEventId: string | null | undefined): string | null {
  const event = (providerEventId ?? "").trim();
  if (!event) return null;
  return `${(sportFamily ?? "unknown").trim().toLowerCase() || "unknown"}:${event}`;
}

export function economicUnitKey(gameKey: string | null): string | null {
  return gameKey;
}

function numberFrom(text: string): number | null {
  const value = Number(text.replace(/^\+/, ""));
  return Number.isFinite(value) ? value : null;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function classifyMarketFamily(marketType: string | null, question: string | null): MarketFamily {
  const type = norm(marketType);
  const text = norm(question);
  if (!type && !text) return "OTHER";
  if (/both_teams_to_score|btts/.test(type) || /both teams to score/.test(text)) return "BTTS";
  if (/completed_match|completed match/.test(type + " " + text)) return "COMPLETED_MATCH";
  if (/handicap/.test(type)) return "HANDICAP";
  if (/spread/.test(type)) return "SPREAD";
  if (/total|over_under|o\/u/.test(type) || /\bo\/u\b|over\/under/.test(text)) return "TOTAL";
  if (/moneyline|match_winner|set_winner|first_set_winner|halftime_result|child_moneyline/.test(type)) return "MONEYLINE";
  if (/anytime|prop|touchdown/.test(type)) return "PROP";
  return "OTHER";
}

export function classifyPeriodScope(marketType: string | null, question: string | null): string {
  const text = `${norm(marketType)} ${norm(question)}`;
  if (/second_half|2h\b|2nd half|second half/.test(text)) return "SECOND_HALF";
  if (/first_half|halftime|1h\b|1st half|first half/.test(text)) return "FIRST_HALF";
  if (/first_set|set 1\b|set_1\b/.test(text)) return "SET_1";
  const set = /\bset[_ ](\d)\b/.exec(text);
  if (set) return `SET_${set[1]}`;
  const unit = /(map|game)[_ ](\d+)/.exec(text);
  if (unit) return `${unit[1].toUpperCase()}_${unit[2]}`;
  return "FULL_MATCH";
}

/**
 * Signed line for the SELECTED side. Totals: the printed line (side is in selected_outcome). Spreads/handicaps: the
 * line printed next to the selected team, or the opposite of the printed line when the selected side is the other team.
 * Returns null when the market carries no line or the line cannot be parsed (the DB marks line-bearing markets INCOMPLETE).
 */
export function parseSelectedLine(family: MarketFamily, question: string | null, selectedOutcome: string | null): number | null {
  const text = question ?? "";
  if (family === "TOTAL") {
    const match = /(?:O\/U|Over\/Under)\s*(\d+(?:\.\d+)?)/i.exec(text) ?? /(\d+(?:\.\d+)?)\s*(?:goals|corners|rounds)?\s*$/i.exec(text);
    return match ? numberFrom(match[1]) : null;
  }
  if (family === "SPREAD" || family === "HANDICAP") {
    const pairs = [...text.matchAll(/([^():]+?)\s*\(([+-]\d+(?:\.\d+)?)\)/g)].map((m) => ({ team: norm(m[1].replace(/^.*?:\s*/, "").replace(/\bvs\.?\s*$/i, "")), line: numberFrom(m[2]) }));
    if (pairs.length === 0) return null;
    const side = norm(selectedOutcome);
    const own = pairs.find((p) => p.team === side || side.includes(p.team) || p.team.includes(side));
    if (own && own.line !== null) return own.line;
    const first = pairs[0];
    if (pairs.length === 1 && first.line !== null && side) return -first.line;
    return null;
  }
  return null;
}

export function classifyForwardTiming(input: {
  observedAt: string;
  firstPersistedAt: string;
  scheduledStartAt: string | null;
  authoritativeStartAt: string | null;
}): { timingClass: TimingClass; observationLagSeconds: number; leadTimeScheduledSeconds: number | null; leadTimeAuthoritativeSeconds: number | null } {
  const persisted = Date.parse(input.firstPersistedAt);
  const lag = (persisted - Date.parse(input.observedAt)) / 1000;
  const scheduled = input.scheduledStartAt ? Date.parse(input.scheduledStartAt) : null;
  const authoritative = input.authoritativeStartAt ? Date.parse(input.authoritativeStartAt) : null;
  let timingClass: TimingClass;
  if (lag > FORWARD_MAX_OBSERVATION_LAG_SECONDS) timingClass = "HISTORICAL_REPLAY";
  else if (authoritative !== null) timingClass = persisted < authoritative ? "PRE_START_AUTHORITATIVE" : "LATE_AUTHORITATIVE";
  else if (scheduled !== null) timingClass = persisted < scheduled ? "PRE_START_SCHEDULED_ONLY" : "LATE_SCHEDULED";
  else timingClass = "START_UNKNOWN";
  return {
    timingClass,
    observationLagSeconds: lag,
    leadTimeScheduledSeconds: scheduled === null ? null : (scheduled - persisted) / 1000,
    leadTimeAuthoritativeSeconds: authoritative === null ? null : (authoritative - persisted) / 1000,
  };
}

/** Only these classes may be counted as a pre-match forward decision; scheduled-only is reported separately, never as proven kickoff. */
export function isForwardPreMatch(timingClass: string | null | undefined): boolean {
  return timingClass === "PRE_START_AUTHORITATIVE" || timingClass === "PRE_START_SCHEDULED_ONLY";
}

export function buildForwardBetColumns(input: {
  model: string;
  source: ForwardEvidenceSource;
  candidate: ForwardCandidate;
  decisionGeneratedAt: string;
}): ForwardBetColumns {
  const { source, candidate } = input;
  const family = classifyMarketFamily(source.market_type, source.market_question);
  const gameKey = canonicalGameKey(source.provider_sport_family ?? candidate.sportFamily, source.provider_event_id);
  return {
    contract_version: FORWARD_BET_CONTRACT_VERSION,
    canonical_game_key: gameKey,
    provider_event_id: source.provider_event_id,
    market_family: family,
    market_type: source.market_type,
    line_value: parseSelectedLine(family, source.market_question, source.selected_outcome ?? null),
    period_scope: classifyPeriodScope(source.market_type, source.market_question),
    selected_outcome: source.selected_outcome ?? null,
    observed_at: source.observed_at,
    decision_generated_at: input.decisionGeneratedAt,
    scheduled_start_at: source.game_start_iso,
    authoritative_start_at: null,
    authoritative_start_source: null,
    reference_price: candidate.entryPrice,
    reference_price_source: REFERENCE_PRICE_SOURCE,
    reference_price_type: REFERENCE_PRICE_TYPE,
    reference_price_acquired_at: source.observed_at,
    provider_quote_at: null,
    executable_buy_price: null,
    executable_price_authority: null,
    executable_quote_at: null,
    model_version: modelVersionFor(input.model),
    selection_reason: selectionReasonFor(input.model) ?? "UNREGISTERED_MODEL",
    decision_kind: "BET",
    economic_unit_key: economicUnitKey(gameKey),
  };
}

/**
 * Cross-date reselection guard: a model never takes a second independent bet on a physical game it already holds,
 * whether the earlier row is legacy-shaped or a contract row.
 */
export function excludeExistingEconomicUnits<T extends { physicalEventKey: string }>(
  model: string,
  chosen: readonly T[],
  existing: ReadonlyArray<{ model_id: string; physicalEventKey: string }>,
): { fresh: T[]; blockedDuplicateUnitN: number } {
  const held = new Set(existing.filter((row) => row.model_id === model).map((row) => row.physicalEventKey));
  const fresh: T[] = [];
  let blocked = 0;
  for (const candidate of chosen) {
    if (held.has(candidate.physicalEventKey)) { blocked += 1; continue; }
    held.add(candidate.physicalEventKey);
    fresh.push(candidate);
  }
  return { fresh, blockedDuplicateUnitN: blocked };
}

/** Executable PnL / Net ROI exists only with a non-null executable BUY authority; a missing book never becomes a price. */
export function hasExecutableAuthority(row: { executable_buy_price?: number | string | null; executable_price_authority?: string | null }): boolean {
  return row.executable_buy_price !== null && row.executable_buy_price !== undefined && !!row.executable_price_authority;
}
