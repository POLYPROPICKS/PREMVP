import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import gamma from "../../lib/weather/source-contracts/polymarketGammaWeather.v1.ts";
import inventory from "../../lib/weather/inventory/gammaInventory.ts";
import persistence from "../../lib/weather/persistence/fakeWeatherRepository.ts";
import reporting from "../../lib/weather/reporting/inventoryReport.ts";
const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/weather/gamma/inventory.v1.json", import.meta.url), "utf8"));
const page=inventory.validateGammaPage(fixture,"fixture:active:0"), identified=inventory.extractWeatherMarkets(page), attributed=inventory.attributeWeatherMarkets(identified.markets,["KJFK","KLGA","KORD","KDFW","KDEN","KLAX"]), repo=new persistence.FakeWeatherRepository();
repo.persist(page,gamma.POLYMARKET_GAMMA_WEATHER_V1.id,gamma.POLYMARKET_GAMMA_WEATHER_V1.contractHash,"2026-07-24T00:00:00.000Z",attributed.markets); const duplicate=repo.persist(page,gamma.POLYMARKET_GAMMA_WEATHER_V1.id,gamma.POLYMARKET_GAMMA_WEATHER_V1.contractHash,"2026-07-24T00:00:00.000Z",attributed.markets).outcome;
let rollback=false; try { new persistence.FakeWeatherRepository().persist(page,"x","a".repeat(64),"2026-07-24T00:00:00.000Z",[],true); } catch { rollback=true; }
const out=reporting.inventoryReport({sourceContractId:gamma.POLYMARKET_GAMMA_WEATHER_V1.id,sourceContractHash:gamma.POLYMARKET_GAMMA_WEATHER_V1.contractHash,fixtureSet:"inventory.v1",pageCount:1,inventory:repo.queryWeatherInventory(),traces:[identified.trace,attributed.trace],duplicate,rollback}); const dir=new URL("../../reports/weather/inventory/",import.meta.url); mkdirSync(dir,{recursive:true}); writeFileSync(new URL("latest.json",dir),out.json); writeFileSync(new URL("latest.md",dir),out.markdown); console.log("WEATHER_INVENTORY_FIXTURE PASS");
