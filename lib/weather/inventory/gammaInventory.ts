import { hashCanonicalPayload } from "../../collector-kernel/payloadHash";
import { sha256 } from "../types";

export type AttributionStatus = "ATTRIBUTED_EXACT" | "UNATTRIBUTED" | "AMBIGUOUS" | "REJECTED";
export type InventoryTrace = { stage: string; inputCount: number; outputCount: number; targetEventPresent: boolean; targetConditionPresent: boolean; targetTokenPresent: boolean; rejectedTargets: number; firstRejectionReason: string | null };
export type RawPage = { records: Record<string, unknown>[]; pageIdentity: string; payloadHash: string; pagination: string | null };
export type InventoryMarket = { conditionId: string; venueEventId: string | null; venueMarketId: string | null; title: string | null; slug: string | null; active: boolean; closed: boolean; outcomes: Array<{ tokenId: string; canonicalContractId: string; outcome: string; outcomeIndex: number }>; attributionStatus: AttributionStatus; attributionReason: string | null };

const fail = (reason: string): never => { throw new Error(`GAMMA_ENVELOPE_INVALID:${reason}`); };
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) fail("record"); return value as Record<string, unknown>; };

export function validateGammaPage(value: unknown, pageIdentity: string): RawPage {
  const wrapper = Array.isArray(value) ? null : record(value);
  const records = Array.isArray(value) ? value : wrapper !== null && Array.isArray(wrapper.events) ? wrapper.events : wrapper !== null && Array.isArray(wrapper.data) ? wrapper.data : fail("body_not_array");
  if (!pageIdentity.trim() || !records.every((item) => item && typeof item === "object" && !Array.isArray(item))) fail("partial_records");
  const pagination = wrapper && typeof wrapper.next_cursor === "string" ? wrapper.next_cursor : null;
  return { records: records as Record<string, unknown>[], pageIdentity, payloadHash: hashCanonicalPayload(value), pagination };
}

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function values(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function tokenValues(value: unknown[]): string[] | null { const tokenIds: string[] = []; for (const tokenCandidate of value) { if (typeof tokenCandidate !== "string") return null; const tokenId = tokenCandidate.trim(); if (!tokenId) return null; tokenIds.push(tokenId); } return tokenIds; }

export function extractWeatherMarkets(page: RawPage): { markets: InventoryMarket[]; trace: InventoryTrace } {
  const markets: InventoryMarket[] = [];
  let first: string | null = null;
  for (const event of page.records) for (const marketRaw of values(event.markets)) {
    const market = record(marketRaw); const conditionId = text(market.condition_id ?? market.conditionId);
    const rawOutcomes = values(market.outcomes); const tokenIds = tokenValues(values(market.clobTokenIds ?? market.clob_token_ids));
    if (!conditionId) { first ||= "MISSING_CONDITION_ID"; continue; }
    if (!rawOutcomes.length || tokenIds === null || rawOutcomes.length !== tokenIds.length) { first ||= "MALFORMED_OUTCOMES_OR_TOKENS"; continue; }
    const outcomes = rawOutcomes.map((outcome, index) => { const tokenId = tokenIds[index]; return { tokenId, canonicalContractId: `weather-contract:${sha256({ conditionId, tokenId })}`, outcome: typeof outcome === "string" ? outcome : text(record(outcome).name) ?? "", outcomeIndex: index }; });
    if (outcomes.some((outcome) => !outcome.outcome)) { first ||= "MALFORMED_OUTCOMES_OR_TOKENS"; continue; }
    markets.push({ conditionId, venueEventId: text(event.id), venueMarketId: text(market.id), title: text(market.question ?? market.title), slug: text(market.slug), active: market.active !== false, closed: market.closed === true, outcomes, attributionStatus: "UNATTRIBUTED", attributionReason: null });
  }
  return { markets, trace: { stage: "identity", inputCount: page.records.length, outputCount: markets.length, targetEventPresent: page.records.some((e) => /KJFK/.test(String(e.title ?? ""))), targetConditionPresent: markets.some((m) => m.conditionId === "cond-kjfk"), targetTokenPresent: markets.some((m) => m.outcomes.some((o) => o.tokenId === "token-kjfk-yes")), rejectedTargets: first ? 1 : 0, firstRejectionReason: first } };
}

export function attributeWeatherMarkets(markets: InventoryMarket[], stationIds: string[]): { markets: InventoryMarket[]; trace: InventoryTrace } {
  const attributed = markets.map((market) => {
    const evidence = `${market.title ?? ""} ${market.slug ?? ""}`.toUpperCase();
    const matches = stationIds.filter((id) => new RegExp(`\\b${id}\\b`, "i").test(evidence));
    if (!/temperature|temp/i.test(evidence)) return { ...market, attributionStatus: "REJECTED" as const, attributionReason: "NON_WEATHER" };
    if (matches.length === 1) return { ...market, attributionStatus: "ATTRIBUTED_EXACT" as const, attributionReason: `CATALOG_STATION:${matches[0]}` };
    if (matches.length > 1) return { ...market, attributionStatus: "AMBIGUOUS" as const, attributionReason: "MULTIPLE_CATALOG_STATIONS" };
    return { ...market, attributionStatus: "UNATTRIBUTED" as const, attributionReason: "NO_EXACT_CATALOG_EVIDENCE" };
  });
  const rejected = attributed.filter((m) => m.attributionStatus !== "ATTRIBUTED_EXACT");
  return { markets: attributed, trace: { stage: "attribution", inputCount: markets.length, outputCount: attributed.length, targetEventPresent: attributed.some((m) => m.attributionStatus === "ATTRIBUTED_EXACT"), targetConditionPresent: attributed.some((m) => m.conditionId === "cond-kjfk"), targetTokenPresent: attributed.some((m) => m.outcomes.some((o) => o.tokenId === "token-kjfk-yes")), rejectedTargets: rejected.length, firstRejectionReason: rejected[0]?.attributionReason ?? null } };
}
