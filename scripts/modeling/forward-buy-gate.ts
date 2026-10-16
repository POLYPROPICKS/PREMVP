import { fetchOrderBook, fetchTokenFeeSchedule } from "@/lib/liquidity/polymarketClient";
import {
  evaluateForwardBuy,
  gateBuyIdentity,
  isForwardBuyModel,
  type BuyEvaluation,
  type BuyFeeAuthority,
  type BuyQuote,
} from "@/lib/modeling/forwardBuyAuthority";
import type { ForwardCandidate, ForwardEvidenceSource } from "@/lib/modeling/forwardBetContract";
import type { ShadowOrigin } from "./live-shadow-cycle";

/** Read-only network seams (public CLOB book + Gamma fee schedule). Injectable so tests never touch the network. */
export type BuyIO = {
  fetchBook: typeof fetchOrderBook;
  fetchFee: typeof fetchTokenFeeSchedule;
  nowMs: () => number;
};

export const LIVE_BUY_IO: BuyIO = { fetchBook: fetchOrderBook, fetchFee: fetchTokenFeeSchedule, nowMs: () => Date.now() };

/**
 * `--forward-buy` is research-only and only valid with the explicit clone origin (no Production read, no real BET).
 * Any other `--forward-buy...` spelling fails closed.
 */
export function resolveForwardBuy(argv: readonly string[], origin: ShadowOrigin): boolean {
  const flags = argv.filter((arg) => arg.startsWith("--forward-buy"));
  if (flags.length === 0) return false;
  if (flags.length !== 1 || flags[0] !== "--forward-buy") throw new Error("UNKNOWN_FORWARD_BUY_FLAG");
  if (origin !== "CLONE_ORIGIN") throw new Error("FORWARD_BUY_REQUIRES_CLONE_ORIGIN");
  return true;
}

/**
 * Identity gate first (no network for ineligible candidates), then book and fee, then the decision time is stamped AFTER both
 * responses are in hand, so the execution decision can never precede the quote receipt.
 */
export async function acquireAndEvaluateBuy(input: {
  model: string;
  source: ForwardEvidenceSource;
  candidate: ForwardCandidate;
  heldEconomicUnits?: ReadonlySet<string>;
  io?: BuyIO;
}): Promise<BuyEvaluation> {
  const io = input.io ?? LIVE_BUY_IO;
  if (isForwardBuyModel(input.model)) {
    const pre = gateBuyIdentity({ model: input.model, source: input.source, candidate: input.candidate, decisionGeneratedAt: new Date(io.nowMs()).toISOString(), heldEconomicUnits: input.heldEconomicUnits });
    if (!pre.ok) return { ok: false, rejection: pre.rejection };
  }
  const [bookResult, feeResult] = await Promise.all([
    io.fetchBook(input.source.selected_token_id),
    io.fetchFee(input.source.selected_token_id),
  ]);
  const quote: BuyQuote = bookResult.ok && bookResult.book
    ? { book: bookResult.book, requestStartedAtMs: bookResult.requestStartedAtMs ?? null, receivedAtMs: bookResult.responseCompletedAtMs ?? null }
    : { book: null, requestStartedAtMs: null, receivedAtMs: null };
  const fee: BuyFeeAuthority = feeResult.ok
    ? { ok: true, tokenId: feeResult.tokenId, conditionId: feeResult.conditionId, feesEnabled: feeResult.feesEnabled, takerRate: feeResult.takerRate, formulaVersion: feeResult.formulaVersion, source: feeResult.source, observedAtIso: feeResult.observedAtIso }
    : { ok: false, errorCode: feeResult.errorCode };
  const decisionAtIso = new Date(io.nowMs()).toISOString();
  return evaluateForwardBuy({ model: input.model, source: input.source, candidate: input.candidate, quote, fee, decisionAtIso, heldEconomicUnits: input.heldEconomicUnits });
}
