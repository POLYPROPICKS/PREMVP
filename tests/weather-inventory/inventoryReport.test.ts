import test from "node:test";
import assert from "node:assert/strict";
import { inventoryReport } from "../../lib/weather/reporting/inventoryReport";
test("report is deterministic and explicitly limited", () => { const input = { sourceContractId:"x",sourceContractHash:"a".repeat(64),fixtureSet:"v1",pageCount:1,inventory:{rawObjects:1,venueMarkets:2,contracts:4,attributionCounts:{ATTRIBUTED_EXACT:1}},traces:[],duplicate:"IDEMPOTENT",rollback:true }; const a=inventoryReport(input), b=inventoryReport(input); assert.equal(a.json,b.json); assert.match(a.markdown,/postgres_proven: NO/); });
