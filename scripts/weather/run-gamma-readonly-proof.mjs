import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import proofModule from "../../lib/weather/reporting/gammaReadOnlyProof.ts";
const { runGammaReadOnlyProof, buildGammaProofReport } = proofModule;
try {
  const catalog = JSON.parse(await readFile(new URL("../../config/weather/us-daily-max-stations.v1.json", import.meta.url), "utf8"));
  const proof = await runGammaReadOnlyProof({ stationIds: catalog.stations.map((station) => station.id) });
  const report = buildGammaProofReport(proof); const directory = new URL("../../reports/weather/gamma-proof/", import.meta.url);
  mkdirSync(directory, { recursive: true }); writeFileSync(new URL("latest.json", directory), report.json); writeFileSync(new URL("latest.md", directory), report.markdown);
  console.log(`WEATHER_GAMMA_READONLY_PROOF ${JSON.stringify({ http_status: proof.httpStatus, response_bytes: proof.responseBytes, response_sha256: proof.responseSha256, raw_markets: proof.snapshot.rawMarkets, accepted_markets: proof.snapshot.acceptedMarkets, contracts: proof.snapshot.contracts, database_writes: 0, supabase_access: 0 })}`);
} catch (error) { console.error(`WEATHER_GAMMA_READONLY_PROOF_FAIL ${JSON.stringify({ stage: "proof", error: error instanceof Error ? error.message : "UNKNOWN" })}`); process.exitCode = 1; }
