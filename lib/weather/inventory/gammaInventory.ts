import { hashCanonicalPayload } from "../../collector-kernel/payloadHash";
import { sha256 } from "../types";

export type AttributionStatus = "ATTRIBUTED_EXACT" | "UNATTRIBUTED" | "AMBIGUOUS" | "REJECTED";
export type InventoryTrace = { stage: string; inputCount: number; outputCount: number; targetEventPresent: boolean; targetConditionPresent: boolean; targetTokenPresent: boolean; rejectedTargets: number; firstRejectionReason: string | null };
export type RawPage = { records: Record<string, unknown>[]; recordForm: "EVENT" | "KEYSET_MARKET"; pageIdentity: string; payloadHash: string; pagination: string | null };
export type InventoryMarket = { conditionId: string; venueEventId: string | null; venueMarketId: string | null; title: string | null; slug: string | null; active: boolean; closed: boolean; outcomes: Array<{ tokenId: string; canonicalContractId: string; outcome: string; outcomeIndex: number }>; attributionStatus: AttributionStatus; attributionReason: string | null };

const fail = (reason: string): never => { throw new Error(`GAMMA_ENVELOPE_INVALID:${reason}`); };
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) fail("record"); return value as Record<string, unknown>; };

export function validateGammaPage(value: unknown, pageIdentity: string): RawPage {
  const wrapper = Array.isArray(value) ? null : record(value);
  const hasKeysetMarkets = wrapper !== null && Object.prototype.hasOwnProperty.call(wrapper, "markets");
  if (hasKeysetMarkets && !Array.isArray(wrapper.markets)) fail("keyset_markets_not_array");
  if (hasKeysetMarkets && Object.prototype.hasOwnProperty.call(wrapper, "next_cursor") && typeof wrapper.next_cursor !== "string") fail("keyset_cursor_not_string");
  const records = Array.isArray(value) ? value : wrapper !== null && Array.isArray(wrapper.events) ? wrapper.events : wrapper !== null && Array.isArray(wrapper.data) ? wrapper.data : wrapper !== null && Array.isArray(wrapper.markets) ? wrapper.markets : fail("body_not_array");
  if (!pageIdentity.trim() || !records.every((item) => item && typeof item === "object" && !Array.isArray(item))) fail("partial_records");
  const pagination = wrapper && typeof wrapper.next_cursor === "string" ? wrapper.next_cursor : null;
  return { records: records as Record<string, unknown>[], recordForm: hasKeysetMarkets ? "KEYSET_MARKET" : "EVENT", pageIdentity, payloadHash: hashCanonicalPayload(value), pagination };
}

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function values(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function identityValues(value: unknown): string[] | null {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? (() => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; } })() : null;
  if (!candidates?.length) return null;
  const normalized: string[] = [];
  for (const candidate of candidates) { if (typeof candidate !== "string" || !candidate.trim()) return null; normalized.push(candidate.trim()); }
  return normalized;
}

export function extractWeatherMarkets(page: RawPage): { markets: InventoryMarket[]; trace: InventoryTrace } {
  const markets: InventoryMarket[] = [];
  let first: string | null = null;
  for (const event of page.records) for (const marketRaw of page.recordForm === "KEYSET_MARKET" ? [event] : values(event.markets)) {
    const market = record(marketRaw); const conditionId = text(market.condition_id ?? market.conditionId);
    const rawOutcomes = identityValues(market.outcomes); const tokenIds = identityValues(market.clobTokenIds ?? market.clob_token_ids);
    if (!conditionId) { first ||= "MISSING_CONDITION_ID"; continue; }
    if (rawOutcomes === null || tokenIds === null || rawOutcomes.length !== tokenIds.length) { first ||= "MALFORMED_OUTCOMES_OR_TOKENS"; continue; }
    const outcomes = rawOutcomes.map((outcome, index) => { const tokenId = tokenIds[index]; return { tokenId, canonicalContractId: `weather-contract:${sha256({ conditionId, tokenId })}`, outcome, outcomeIndex: index }; });
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
