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

/**
 * Timing authority is five separate facts, never one flag:
 *  DB_FIRST_PERSISTED          first_persisted_at exists (database clock) - true for every stored row, proves nothing about the start;
 *  PRE_START_SCHEDULED_ONLY    saved before the SCHEDULED start; the actual start is unproven;
 *  PRE_START_AUTHORITATIVE     saved before an independently sourced actual start (needs authoritative_start_source);
 *  LATE_OR_REPLAY              saved after the known start, or from an observation older than the replay bound;
 *  TIMING_UNPROVEN             no start known, or a row that predates the contract.
 */
export type TimingClass = "PRE_START_AUTHORITATIVE" | "PRE_START_SCHEDULED_ONLY" | "LATE_OR_REPLAY" | "TIMING_UNPROVEN";
export type TimingDetail = "LATE_SCHEDULED" | "LATE_AUTHORITATIVE" | "HISTORICAL_REPLAY" | "START_UNKNOWN";
/** The only sources that may establish an authoritative start. A scheduled time can never be one. */
export const AUTHORITATIVE_START_SOURCES = ["OFFICIAL_SOURCE_CONFIRMED_START", "PROVIDER_PUBLISHED_ACTUAL_START"] as const;

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
  /** Provider-published root game id, when the evidence source carries one (research_evidence_page_rows does not yet). */
  provider_game_id?: string | null;
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
/**
 *  PROVIDER_ROOT_CONFIRMED  a provider-published root game id was supplied with the evidence (independent physical-game proof);
 *  TEAM_PAIR_START_DEDUP    deterministic competitor-pair + scheduled-start text match: valid for conservative merging and
 *                           duplicate detection, NOT independent proof of the physical game;
 *  PROVIDER_EVENT_ONLY      only a provider event (market shard) id: identity unresolved.
 */
export type GameIdentityBasis = "PROVIDER_ROOT_CONFIRMED" | "TEAM_PAIR_START_DEDUP" | "PROVIDER_EVENT_ONLY";
export type ScopeBasis = "STRUCTURED_MONEYLINE" | "TEXT_HEURISTIC";

export type ForwardBetColumns = {
  contract_version: typeof FORWARD_BET_CONTRACT_VERSION;
  canonical_game_key: string | null;
  game_identity_basis: GameIdentityBasis;
  provider_root_game_id: string | null;
  provider_root_game_source: "POLYMARKET_GAMMA_GAME_ID" | null;
  scope_basis: ScopeBasis;
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

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normTeam(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(/^will\s+/, "").replace(/\s+(end in a draw|win|to win)\b.*$/, "").replace(/[?.]+$/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Text heuristic: the two competitor names from "Prefix: A vs B - suffix" style titles. It can only fail to merge
 * (an unparsed shard keeps a provider-event key and is reported as unverified); two different fixtures never share a
 * normalized sorted pair AND the same scheduled start, so it cannot invent a false merge of distinct games.
 */
export function extractTeamPair(...texts: Array<string | null | undefined>): [string, string] | null {
  for (const text of texts) {
    if (!text) continue;
    const afterPrefix = /:\s*[^:]*\s+vs\.?\s+/i.test(text) ? text.slice(text.indexOf(":") + 1) : text;
    const match = /^\s*(.+?)\s+vs\.?\s+(.+?)\s*(?:\(|\s-\s|:|\?|$)/i.exec(afterPrefix);
    if (!match) continue;
    const a = normTeam(match[1]);
    const b = normTeam(match[2]);
    if (a && b && a !== b) return a <= b ? [a, b] : [b, a];
  }
  return null;
}

/**
 * Root physical game identity. Provider event ids are market-shard ids (soccer "more markets" events carry their own
 * id), so the key is the competitor pair plus the scheduled start. Without a parseable pair or start the key falls
 * back to the provider event and is flagged PROVIDER_EVENT_ONLY, which keeps the row out of "independent proven games".
 */
export function canonicalGame(input: { sportFamily: string | null | undefined; providerEventId: string | null | undefined; providerRootGameId?: string | null; eventTitle?: string | null; marketQuestion?: string | null; scheduledStartIso?: string | null }): { key: string | null; basis: GameIdentityBasis; providerRootGameId: string | null } {
  const sport = (input.sportFamily ?? "unknown").trim().toLowerCase() || "unknown";
  const pair = extractTeamPair(input.eventTitle, input.marketQuestion);
  const start = input.scheduledStartIso ? Date.parse(input.scheduledStartIso) : NaN;
  const root = (input.providerRootGameId ?? "").trim() || null;
  // A provider-published root game id IS the physical-game identity: the key follows it, so every market shard of one game
  // collapses to one economic unit and two root ids never merge by a shared pair/start. Without a root the key stays the
  // conservative pair+start dedup (or the provider-event fallback), which never upgrades the identity basis.
  if (root) return { key: `${sport}:root:${root}`, basis: "PROVIDER_ROOT_CONFIRMED", providerRootGameId: root };
  if (pair && Number.isFinite(start)) return { key: `${sport}:${pair[0]}|${pair[1]}@${new Date(start).toISOString()}`, basis: "TEAM_PAIR_START_DEDUP", providerRootGameId: null };
  const event = (input.providerEventId ?? "").trim();
  return { key: event ? `${sport}:pe:${event}` : null, basis: "PROVIDER_EVENT_ONLY", providerRootGameId: null };
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
    // A side we cannot name (or a Yes/No/Over/Under answer) never gets a guessed sign.
    if (!side || ["yes", "no", "over", "under"].includes(side)) return null;
    const own = pairs.find((p) => p.team === side || side.includes(p.team) || p.team.includes(side));
    if (own && own.line !== null) return own.line;
    const first = pairs[0];
    if (pairs.length === 1 && first.line !== null) return -first.line;
    return null;
  }
  return null;
}

export function classifyForwardTiming(input: {
  observedAt: string;
  firstPersistedAt: string;
  scheduledStartAt: string | null;
  authoritativeStartAt: string | null;
}): { timingClass: TimingClass; timingDetail: TimingDetail | null; observationLagSeconds: number; leadTimeScheduledSeconds: number | null; leadTimeAuthoritativeSeconds: number | null } {
  const persisted = Date.parse(input.firstPersistedAt);
  const lag = (persisted - Date.parse(input.observedAt)) / 1000;
  const scheduled = input.scheduledStartAt ? Date.parse(input.scheduledStartAt) : null;
  const authoritative = input.authoritativeStartAt ? Date.parse(input.authoritativeStartAt) : null;
  let timingClass: TimingClass;
  let timingDetail: TimingDetail | null = null;
  if (lag > FORWARD_MAX_OBSERVATION_LAG_SECONDS) { timingClass = "LATE_OR_REPLAY"; timingDetail = "HISTORICAL_REPLAY"; }
  else if (authoritative !== null) { if (persisted < authoritative) timingClass = "PRE_START_AUTHORITATIVE"; else { timingClass = "LATE_OR_REPLAY"; timingDetail = "LATE_AUTHORITATIVE"; } }
  else if (scheduled !== null) { if (persisted < scheduled) timingClass = "PRE_START_SCHEDULED_ONLY"; else { timingClass = "LATE_OR_REPLAY"; timingDetail = "LATE_SCHEDULED"; } }
  else { timingClass = "TIMING_UNPROVEN"; timingDetail = "START_UNKNOWN"; }
  return {
    timingClass, timingDetail,
    observationLagSeconds: lag,
    leadTimeScheduledSeconds: scheduled === null ? null : (scheduled - persisted) / 1000,
    leadTimeAuthoritativeSeconds: authoritative === null ? null : (authoritative - persisted) / 1000,
  };
}

/** Saved before the SCHEDULED start only. Never counts as authoritative prematch proof. */
export const isScheduledOnlyPreMatch = (timingClass: string | null | undefined): boolean => timingClass === "PRE_START_SCHEDULED_ONLY";
/** Saved before an independently sourced actual start. The only timing class that is authoritative prematch proof. */
export const isAuthoritativePreMatch = (timingClass: string | null | undefined): boolean => timingClass === "PRE_START_AUTHORITATIVE";

/** Mirror of the database's verification_status: VERIFIED only when timing, game identity and scope are each proven. */
export function classifyVerification(input: { contractStatus: string | null; timingClass: string | null; gameIdentityBasis: string | null; scopeBasis: string | null }): { verified: boolean; status: string; unprovenLinks: string[] } {
  const links: string[] = [];
  if (input.contractStatus !== "COMPLETE") links.push("contract_incomplete");
  if (input.timingClass === "PRE_START_SCHEDULED_ONLY") links.push("timing_scheduled_only");
  else if (input.timingClass === "LATE_OR_REPLAY") links.push("timing_late_or_replay");
  else if (input.timingClass !== "PRE_START_AUTHORITATIVE") links.push("timing_unproven");
  if (input.gameIdentityBasis === "TEAM_PAIR_START_DEDUP") links.push("game_identity_dedup_only");
  else if (input.gameIdentityBasis !== "PROVIDER_ROOT_CONFIRMED") links.push("game_identity_provider_event_only");
  if (input.scopeBasis !== "STRUCTURED_MONEYLINE") links.push("scope_text_heuristic");
  return { verified: links.length === 0, status: links.length === 0 ? "VERIFIED" : `UNVERIFIED:${links.join(",")}`, unprovenLinks: links };
}

export function buildForwardBetColumns(input: {
  model: string;
  source: ForwardEvidenceSource;
  candidate: ForwardCandidate;
  decisionGeneratedAt: string;
}): ForwardBetColumns {
  const { source, candidate } = input;
  const family = classifyMarketFamily(source.market_type, source.market_question);
  const game = canonicalGame({
    sportFamily: source.provider_sport_family ?? candidate.sportFamily, providerEventId: source.provider_event_id, providerRootGameId: source.provider_game_id ?? null,
    eventTitle: source.event_title, marketQuestion: source.market_question, scheduledStartIso: source.game_start_iso,
  });
  const gameKey = game.key;
  const line = parseSelectedLine(family, source.market_question, source.selected_outcome ?? null);
  const period = classifyPeriodScope(source.market_type, source.market_question);
  return {
    contract_version: FORWARD_BET_CONTRACT_VERSION,
    canonical_game_key: gameKey,
    game_identity_basis: game.basis,
    provider_root_game_id: game.providerRootGameId,
    provider_root_game_source: game.providerRootGameId ? "POLYMARKET_GAMMA_GAME_ID" : null,
    scope_basis: source.market_type === "moneyline" && family === "MONEYLINE" && line === null && period === "FULL_MATCH" ? "STRUCTURED_MONEYLINE" : "TEXT_HEURISTIC",
    provider_event_id: source.provider_event_id,
    market_family: family,
    market_type: source.market_type,
    line_value: line,
    period_scope: period,
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
 * whether the earlier row is legacy-shaped or a contract row, and whether it came through the same provider event or
 * another market shard of the same fixture.
 */
export function excludeExistingEconomicUnits<T extends { physicalEventKey: string }>(
  model: string,
  chosen: readonly T[],
  existing: ReadonlyArray<{ model_id: string; physicalEventKey: string; canonical_game_key?: string | null }>,
  gameKeyOf: (candidate: T) => string | null = () => null,
): { fresh: T[]; blockedDuplicateUnitN: number } {
  const heldEvents = new Set<string>();
  const heldGames = new Set<string>();
  for (const row of existing) {
    if (row.model_id !== model) continue;
    heldEvents.add(row.physicalEventKey);
    if (row.canonical_game_key) heldGames.add(row.canonical_game_key);
  }
  const fresh: T[] = [];
  let blocked = 0;
  for (const candidate of chosen) {
    const game = gameKeyOf(candidate);
    if (heldEvents.has(candidate.physicalEventKey) || (game !== null && heldGames.has(game))) { blocked += 1; continue; }
    heldEvents.add(candidate.physicalEventKey);
    if (game !== null) heldGames.add(game);
    fresh.push(candidate);
  }
  return { fresh, blockedDuplicateUnitN: blocked };
}

/** Executable PnL / Net ROI exists only with a non-null executable BUY authority; a missing book never becomes a price. */
export function hasExecutableAuthority(row: { executable_buy_price?: number | string | null; executable_price_authority?: string | null }): boolean {
  return row.executable_buy_price !== null && row.executable_buy_price !== undefined && !!row.executable_price_authority;
}
