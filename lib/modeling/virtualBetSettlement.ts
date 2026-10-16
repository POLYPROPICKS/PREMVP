/**
 * Independent settlement authority for forward virtual BETs.
 *
 * Terminal proof comes from the exact CLOB winner token for the exact (condition, selected token) pair.
 * Gamma is auxiliary only: it may supply a provider resolution time and a cross-check, never a terminal result.
 * A missing, open or ambiguous provider answer is UNKNOWN / UNRESOLVED, never LOSS.
 */
import { createHash } from "node:crypto";

export type ClobToken = { token_id?: unknown; outcome?: unknown; price?: unknown; winner?: unknown };
export type ClobMarket = {
  condition_id?: unknown;
  closed?: unknown;
  is_50_50_outcome?: unknown;
  tokens?: unknown;
};
export type GammaAuxiliary = {
  conditionId?: unknown;
  closed?: unknown;
  closedTime?: unknown;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
};

export type SettlementBet = { conditionId: string; selectedTokenId: string };
export type SettlementCheckKind = "TERMINAL" | "PENDING" | "DIAGNOSTIC" | "CONFLICT";
export type SettlementOutcome = "WIN" | "LOSS" | "VOID" | "UNRESOLVED" | "UNKNOWN";
export type SettlementSource = "CLOB_WINNER_TOKEN" | "CLOB_5050" | "GAMMA_AUXILIARY" | "NONE";

export type SettlementCheck = {
  check_kind: SettlementCheckKind;
  outcome: SettlementOutcome;
  source_authority: SettlementSource;
  independent_of_selection: boolean;
  winner_token_id: string | null;
  provider_closed: boolean | null;
  provider_resolved_at: string | null;
  reason: string;
  provider_digest: string;
  provider_answer: Record<string, unknown> | null;
  conflicts_with_check_id?: number | null;
};

export type StoredSettlementCheck = Pick<SettlementCheck, "check_kind" | "outcome" | "reason" | "provider_digest"> & {
  check_id: number;
  checked_at: string;
};

function tokensOf(market: ClobMarket): Array<{ id: string; winner: boolean; price: number | null }> | null {
  if (!Array.isArray(market.tokens)) return null;
  return (market.tokens as ClobToken[]).map((token) => ({
    id: String(token.token_id ?? ""),
    winner: token.winner === true,
    price: token.price === null || token.price === undefined || token.price === "" ? null : Number.isFinite(Number(token.price)) ? Number(token.price) : null,
  }));
}

function digestOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Stable across post-resolution price noise: only structural resolution facts feed the digest. */
export function providerDigest(market: ClobMarket | null): string {
  if (!market) return digestOf({ market: null });
  const tokens = tokensOf(market) ?? [];
  return digestOf({
    condition: String(market.condition_id ?? "").toLowerCase(),
    closed: market.closed === true,
    fifty: market.is_50_50_outcome === true,
    tokens: tokens.map((t) => ({ id: t.id, winner: t.winner })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function gammaWinnerToken(gamma: GammaAuxiliary | null | undefined): string | null | "UNPARSEABLE" {
  if (!gamma || gamma.closed !== true) return null;
  try {
    const prices = (typeof gamma.outcomePrices === "string" ? JSON.parse(gamma.outcomePrices) : gamma.outcomePrices) as unknown[];
    const ids = (typeof gamma.clobTokenIds === "string" ? JSON.parse(gamma.clobTokenIds) : gamma.clobTokenIds) as unknown[];
    if (!Array.isArray(prices) || !Array.isArray(ids) || prices.length !== ids.length) return "UNPARSEABLE";
    const top = prices.map((p, i) => ({ p: Number(p), id: String(ids[i]) })).filter((x) => x.p >= 0.99);
    return top.length === 1 ? top[0].id : null;
  } catch {
    return "UNPARSEABLE";
  }
}

function resolvedTime(gamma: GammaAuxiliary | null | undefined): string | null {
  const raw = gamma?.closedTime;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw.replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function check(partial: Partial<SettlementCheck> & Pick<SettlementCheck, "check_kind" | "outcome" | "reason" | "provider_digest">): SettlementCheck {
  return {
    source_authority: "NONE",
    independent_of_selection: false,
    winner_token_id: null,
    provider_closed: null,
    provider_resolved_at: null,
    provider_answer: null,
    ...partial,
  };
}

/**
 * Classify the exact selected token against one CLOB market answer. `market === null` means the provider gave no
 * usable answer; callers persist nothing for transport failures (absence is UNKNOWN, never LOSS).
 */
export function classifyClobSettlement(bet: SettlementBet, market: ClobMarket | null, gamma?: GammaAuxiliary | null): SettlementCheck {
  const digest = providerDigest(market);
  if (!market) return check({ check_kind: "DIAGNOSTIC", outcome: "UNKNOWN", reason: "PROVIDER_NO_MARKET", provider_digest: digest });
  const answer = (extra: Record<string, unknown> = {}) => ({ closed: market.closed === true, is_50_50: market.is_50_50_outcome === true, tokens: tokensOf(market), ...extra });
  if (String(market.condition_id ?? "").toLowerCase() !== bet.conditionId.toLowerCase()) {
    return check({ check_kind: "DIAGNOSTIC", outcome: "UNRESOLVED", reason: "CONDITION_MISMATCH", provider_digest: digest, provider_closed: market.closed === true, provider_answer: answer() });
  }
  const tokens = tokensOf(market);
  if (!tokens || tokens.length < 2 || !tokens.some((t) => t.id === bet.selectedTokenId)) {
    return check({ check_kind: "DIAGNOSTIC", outcome: "UNRESOLVED", reason: "SELECTED_TOKEN_NOT_IN_MARKET", provider_digest: digest, provider_closed: market.closed === true, provider_answer: answer() });
  }
  if (market.closed !== true) {
    return check({ check_kind: "PENDING", outcome: "UNKNOWN", reason: "MARKET_NOT_CLOSED", provider_digest: digest, provider_closed: false, provider_answer: answer() });
  }
  const winners = tokens.filter((t) => t.winner);
  const auxiliary = gammaWinnerToken(gamma);
  const resolvedAt = resolvedTime(gamma);
  if (winners.length === 1) {
    const winner = winners[0].id;
    if (typeof auxiliary === "string" && auxiliary !== "UNPARSEABLE" && auxiliary !== winner) {
      return check({
        check_kind: "DIAGNOSTIC", outcome: "UNRESOLVED", reason: "GAMMA_CLOB_DISAGREE", provider_digest: digest,
        provider_closed: true, winner_token_id: winner, provider_answer: answer({ gamma_winner: auxiliary }),
      });
    }
    return check({
      check_kind: "TERMINAL", outcome: winner === bet.selectedTokenId ? "WIN" : "LOSS", reason: "CLOB_EXACT_WINNER_TOKEN",
      source_authority: "CLOB_WINNER_TOKEN", independent_of_selection: true, winner_token_id: winner, provider_closed: true,
      provider_resolved_at: resolvedAt, provider_digest: digest,
      provider_answer: answer({ gamma_agrees: auxiliary === winner ? true : auxiliary === null ? null : false, resolved_at_source: resolvedAt ? "GAMMA_closedTime_AUXILIARY" : null }),
    });
  }
  // VOID only on the provider's explicit 50-50 flag: a closed market whose prices merely sit at 0.5 is not a resolution.
  if (winners.length === 0 && market.is_50_50_outcome === true) {
    return check({
      check_kind: "TERMINAL", outcome: "VOID", reason: "PROVIDER_5050_RESOLUTION_NOT_A_WIN_OR_LOSS",
      source_authority: "CLOB_5050", independent_of_selection: true, provider_closed: true,
      provider_resolved_at: resolvedAt, provider_digest: digest, provider_answer: answer(),
    });
  }
  return check({
    check_kind: "DIAGNOSTIC", outcome: "UNRESOLVED", reason: winners.length === 0 ? "CLOSED_WITHOUT_WINNER" : "CLOSED_WITH_MULTIPLE_WINNERS",
    provider_digest: digest, provider_closed: true, provider_answer: answer(),
  });
}

export type ReconcileAction =
  | { action: "SKIP_IDENTICAL" }
  | { action: "INSERT"; check: SettlementCheck }
  | { action: "INSERT_CONFLICT"; check: SettlementCheck };

const PENDING_REPEAT_MS = 24 * 60 * 60_000;

/**
 * Idempotent reconciliation of a fresh provider answer against the stored history for one bet.
 * - same terminal answer again: skip (no second terminal economic outcome);
 * - any different answer after a terminal result: a CONFLICT row, the terminal row is never rewritten;
 * - non-terminal answers are recorded when they change, or once per 24h.
 */
export function reconcileSettlement(history: readonly StoredSettlementCheck[], fresh: SettlementCheck, nowMs: number): ReconcileAction {
  const terminal = history.find((row) => row.check_kind === "TERMINAL");
  if (terminal) {
    if (fresh.check_kind === "TERMINAL" && fresh.outcome === terminal.outcome) return { action: "SKIP_IDENTICAL" };
    if (fresh.check_kind === "TERMINAL" || fresh.check_kind === "DIAGNOSTIC" || fresh.check_kind === "PENDING") {
      const conflicted = history.some((row) => row.check_kind === "CONFLICT" && row.provider_digest === fresh.provider_digest && row.reason === `CONFLICT_WITH_TERMINAL:${fresh.reason}`);
      if (conflicted) return { action: "SKIP_IDENTICAL" };
      const outcome: SettlementOutcome = fresh.outcome === "UNKNOWN" ? "UNRESOLVED" : fresh.outcome;
      return {
        action: "INSERT_CONFLICT",
        check: { ...fresh, check_kind: "CONFLICT", outcome, reason: `CONFLICT_WITH_TERMINAL:${fresh.reason}`, conflicts_with_check_id: terminal.check_id },
      };
    }
    return { action: "SKIP_IDENTICAL" };
  }
  if (fresh.check_kind === "TERMINAL") return { action: "INSERT", check: fresh };
  const last = history[0];
  if (last && last.check_kind === fresh.check_kind && last.outcome === fresh.outcome && last.reason === fresh.reason &&
      last.provider_digest === fresh.provider_digest && nowMs - Date.parse(last.checked_at) < PENDING_REPEAT_MS) {
    return { action: "SKIP_IDENTICAL" };
  }
  return { action: "INSERT", check: fresh };
}
