import { sha256 } from "../types";
import type { InventoryMarket, RawPage } from "../inventory/gammaInventory";
export type RawObject = { rawObjectId: string; sourceContractId: string; sourceContractHash: string; payloadHash: string; pageIdentity: string; objectPath: string; receivedAt: string; recordCount: number };
export class FakeWeatherRepository {
  raw: RawObject[] = []; markets: Array<InventoryMarket & { rawObjectId: string }> = []; contracts: Array<{ rawObjectId: string; conditionId: string; tokenId: string }> = [];
  persist(page: RawPage, sourceContractId: string, sourceContractHash: string, receivedAt: string, markets: InventoryMarket[], forceFailure = false) {
    const duplicate = this.raw.find((raw) => raw.pageIdentity === page.pageIdentity && raw.payloadHash === page.payloadHash); if (duplicate) return { outcome: "IDEMPOTENT" as const, rawObject: duplicate };
    if (this.raw.some((raw) => raw.pageIdentity === page.pageIdentity)) return { outcome: "PAGE_CHANGED" as const, rawObject: null };
    const snapshot = { raw: [...this.raw], markets: [...this.markets], contracts: [...this.contracts] };
    try { const rawObject = { rawObjectId: `raw:${sha256([page.pageIdentity, page.payloadHash])}`, sourceContractId, sourceContractHash, payloadHash: page.payloadHash, pageIdentity: page.pageIdentity, objectPath: `weather/raw/${sourceContractId}/${page.payloadHash}.json`, receivedAt, recordCount: page.records.length }; this.raw.push(rawObject); for (const market of markets) { this.markets.push({ ...market, rawObjectId: rawObject.rawObjectId }); for (const outcome of market.outcomes) this.contracts.push({ rawObjectId: rawObject.rawObjectId, conditionId: market.conditionId, tokenId: outcome.tokenId }); } if (forceFailure) throw new Error("FORCED_TRANSACTION_FAILURE"); return { outcome: "COMMITTED" as const, rawObject }; } catch (error) { this.raw = snapshot.raw; this.markets = snapshot.markets; this.contracts = snapshot.contracts; throw error; }
  }
}
