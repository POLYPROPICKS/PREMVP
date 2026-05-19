// Phase B2 — Signal outcome resolver helper
// Read-only helper: no DB logic. Used by scripts/resolve-signals.ts and debug endpoint.

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

export type ResolverState =
  | "active_unresolved"
  | "closed_unknown"
  | "resolved_candidate"
  | "lookup_failed"
  | "invalid_snapshot";

export interface GammaMarket {
  conditionId?: string;
  question?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  outcomes?: unknown;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
}

export interface ResolveSignalOutcomeInput {
  conditionId: string;
  selectedTokenId: string | null;
  entryPriceNum: number | null;
  market: GammaMarket | null;
}

export interface ResolvedSignalOutcome {
  resolverState: ResolverState;
  selectedOutcomeIndexByToken: number | null;
  candidateWinningOutcome: string | null;
  candidateWinningTokenId: string | null;
  outcomes: string[] | null;
  outcomePrices: number[] | null;
  clobTokenIds: string[] | null;
  gamma_question: string | null;
  gamma_slug: string | null;
  active: boolean | null;
  closed: boolean | null;
  archived: boolean | null;
  signalResult: "won" | "lost" | null;
  realizedReturnPct: number | null;
  skipReason: string | null;
}

function safeParseJsonArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function safeParseNumberArray(value: unknown): number[] | null {
  const arr = safeParseJsonArray(value);
  if (!arr) return null;
  const nums = arr.map((v) => parseFloat(String(v)));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

export async function fetchGammaMarketByConditionId(
  conditionId: string
): Promise<GammaMarket | null> {
  try {
    const url = `${GAMMA_API_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.markets)
      ? data.markets
      : null;
    return arr && arr.length > 0 ? (arr[0] as GammaMarket) : null;
  } catch {
    return null;
  }
}

export function resolveSignalOutcome(
  input: ResolveSignalOutcomeInput
): ResolvedSignalOutcome {
  const { conditionId, selectedTokenId, entryPriceNum, market } = input;

  if (!market) {
    return {
      resolverState: "lookup_failed",
      selectedOutcomeIndexByToken: null,
      candidateWinningOutcome: null,
      candidateWinningTokenId: null,
      outcomes: null,
      outcomePrices: null,
      clobTokenIds: null,
      gamma_question: null,
      gamma_slug: null,
      active: null,
      closed: null,
      archived: null,
      signalResult: null,
      realizedReturnPct: null,
      skipReason: `Gamma returned no market for conditionId=${conditionId}`,
    };
  }

  const closed = market.closed === true;
  const active = market.active === true;
  const archived = market.archived === true;
  const gamma_question =
    typeof market.question === "string" ? market.question : null;
  const gamma_slug = typeof market.slug === "string" ? market.slug : null;

  const outcomes = safeParseJsonArray(market.outcomes);
  const outcomePrices = safeParseNumberArray(market.outcomePrices);
  const clobTokenIds = safeParseJsonArray(market.clobTokenIds);

  // Compute token index before any early return — available for all states
  const normalizedSelectedToken = selectedTokenId
    ? String(selectedTokenId).trim()
    : null;
  let selectedOutcomeIndexByToken: number | null = null;
  if (normalizedSelectedToken && clobTokenIds) {
    const idx = clobTokenIds
      .map(String)
      .findIndex((t) => t.trim() === normalizedSelectedToken);
    if (idx !== -1) selectedOutcomeIndexByToken = idx;
  }

  if (!closed) {
    return {
      resolverState: "active_unresolved",
      selectedOutcomeIndexByToken,
      candidateWinningOutcome: null,
      candidateWinningTokenId: null,
      outcomes,
      outcomePrices,
      clobTokenIds,
      gamma_question,
      gamma_slug,
      active,
      closed,
      archived,
      signalResult: null,
      realizedReturnPct: null,
      skipReason: "Market is still open — not resolved yet",
    };
  }

  // Closed market — find winner by exactly one outcomePrice >= 0.99
  let winnerIndex: number | null = null;
  if (outcomePrices) {
    const highCount = outcomePrices.filter((p) => p >= 0.99).length;
    const highIdx = outcomePrices.findIndex((p) => p >= 0.99);
    if (highCount === 1) winnerIndex = highIdx;
  }

  if (winnerIndex === null) {
    return {
      resolverState: "closed_unknown",
      selectedOutcomeIndexByToken,
      candidateWinningOutcome: null,
      candidateWinningTokenId: null,
      outcomes,
      outcomePrices,
      clobTokenIds,
      gamma_question,
      gamma_slug,
      active,
      closed,
      archived,
      signalResult: null,
      realizedReturnPct: null,
      skipReason: "Market closed but no single outcomePrice >= 0.99 found",
    };
  }

  const candidateWinningOutcome = outcomes?.[winnerIndex] ?? null;
  const candidateWinningTokenId = clobTokenIds?.[winnerIndex] ?? null;

  if (
    !selectedTokenId ||
    !entryPriceNum ||
    entryPriceNum <= 0 ||
    entryPriceNum >= 1
  ) {
    return {
      resolverState: "invalid_snapshot",
      selectedOutcomeIndexByToken,
      candidateWinningOutcome,
      candidateWinningTokenId,
      outcomes,
      outcomePrices,
      clobTokenIds,
      gamma_question,
      gamma_slug,
      active,
      closed,
      archived,
      signalResult: null,
      realizedReturnPct: null,
      skipReason:
        "Row missing selected_token_id or valid entry_price_num (0 < price < 1)",
    };
  }

  const normalizedWinnerToken = candidateWinningTokenId
    ? String(candidateWinningTokenId).trim()
    : null;
  const won =
    normalizedWinnerToken !== null &&
    String(selectedTokenId).trim() === normalizedWinnerToken;

  const signalResult: "won" | "lost" = won ? "won" : "lost";
  const realizedReturnPct = won
    ? Math.round(((1 - entryPriceNum) / entryPriceNum) * 10000) / 100
    : -100;

  return {
    resolverState: "resolved_candidate",
    selectedOutcomeIndexByToken,
    candidateWinningOutcome,
    candidateWinningTokenId,
    outcomes,
    outcomePrices,
    clobTokenIds,
    gamma_question,
    gamma_slug,
    active,
    closed,
    archived,
    signalResult,
    realizedReturnPct,
    skipReason: null,
  };
}
