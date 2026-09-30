/**
 * MARKET_PRIORITY_POLICY_V1 — pure, settlement-blind same-physical-event
 * market choice policies (research only; no DB, no settlement, no PnL).
 *
 * Choice set (PRE-SELECTION): for one physicalEventKey, all ORDINARY rows
 * (isOrdinaryHold: proven non-Exact-Score, resolved market type) that share
 * the event's FIRST decision timestamp T0 (the early-pin decision point).
 * Rows are decision-time data only; settlement is attached by the caller
 * AFTER selection.
 *
 * Tie-break (explicit, deterministic, decision-time-only), applied within
 * the highest-priority family present:
 *   decisionTimestamp asc -> entryPrice asc (cheaper = lower price... fixed
 *   convention, not outcome-derived) -> conditionId asc -> tokenId asc.
 * Fail-closed: row missing physicalEventKey/marketBucket UNRESOLVED/Exact
 * Score / entryPrice outside (0,1) is excluded before choice; an empty
 * choice set yields no bet.
 */
import { marketBucketOf, isOrdinaryHold, type MarketBucketId } from "./football-structural-authority";

export interface PolicyRow {
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  marketTypeRaw: string | null;
  conditionId: string;
  tokenId: string;
  candidateIdentity: string;
}

export type Family = Exclude<MarketBucketId, "UNRESOLVED" | "soccer_exact_score">;
export const FAMILIES: Family[] = ["spreads", "moneyline", "totals", "total_corners", "other_structured"];
export const CORE: Family[] = ["spreads", "moneyline", "totals"];

export interface Policy {
  id: string;
  /** Ordered family priority; families not listed are excluded from the domain. */
  priority: Family[];
  /** Domain: event enters only when every family in `requireAll` and at least one in `requireAny` is in the choice set. */
  requireAll?: Family[];
  requireAny?: Family[];
}

export function familyOf(r: PolicyRow): Family | null {
  if (!isOrdinaryHold(r.marketTypeRaw)) return null;
  const b = marketBucketOf(r.marketTypeRaw);
  return b === "UNRESOLVED" || b === "soccer_exact_score" ? null : b;
}

export function compareTie(a: PolicyRow, b: PolicyRow): number {
  if (a.decisionTimestamp !== b.decisionTimestamp) return a.decisionTimestamp < b.decisionTimestamp ? -1 : 1;
  if (a.entryPrice !== b.entryPrice) return a.entryPrice - b.entryPrice;
  if (a.conditionId !== b.conditionId) return a.conditionId < b.conditionId ? -1 : 1;
  if (a.tokenId !== b.tokenId) return a.tokenId < b.tokenId ? -1 : 1;
  return a.candidateIdentity < b.candidateIdentity ? -1 : a.candidateIdentity > b.candidateIdentity ? 1 : 0;
}

/** Group valid ordinary rows into per-event T0 choice sets. Order-independent. */
export function buildChoiceSets(rows: PolicyRow[]): Map<string, PolicyRow[]> {
  const valid = rows.filter((r) => r.physicalEventKey && r.entryPrice > 0 && r.entryPrice < 1 && familyOf(r) !== null);
  const t0 = new Map<string, string>();
  for (const r of valid) {
    const cur = t0.get(r.physicalEventKey);
    if (cur === undefined || r.decisionTimestamp < cur) t0.set(r.physicalEventKey, r.decisionTimestamp);
  }
  const out = new Map<string, PolicyRow[]>();
  for (const r of valid) {
    if (r.decisionTimestamp !== t0.get(r.physicalEventKey)) continue;
    const l = out.get(r.physicalEventKey);
    if (l) l.push(r); else out.set(r.physicalEventKey, [r]);
  }
  for (const l of out.values()) l.sort(compareTie);
  return out;
}

export function inDomain(set: PolicyRow[], p: Policy): boolean {
  const fams = new Set(set.map((r) => familyOf(r)!));
  if (p.requireAll && !p.requireAll.every((f) => fams.has(f))) return false;
  if (p.requireAny && !p.requireAny.some((f) => fams.has(f))) return false;
  return true;
}

/** Baseline = current early-pinned behaviour: first row by tie-break order over the whole ordinary T0 set. */
export function chooseBaseline(set: PolicyRow[]): PolicyRow | null {
  return set.length ? [...set].sort(compareTie)[0] : null;
}

/** Settlement-blind: signature takes rows without any outcome field. */
export function choosePolicy(set: PolicyRow[], p: Policy): PolicyRow | null {
  if (!inDomain(set, p)) return null;
  const sorted = [...set].sort(compareTie);
  for (const f of p.priority) {
    const hit = sorted.find((r) => familyOf(r) === f);
    if (hit) return hit;
  }
  return null;
}
