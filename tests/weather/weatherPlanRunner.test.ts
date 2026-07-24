import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
test("plan runner has zero I/O and prints one summary", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/weather/run-weather-auto-capture.mjs", "--plan", "--days", "7"], { encoding: "utf8" });
  assert.equal(result.status, 0); const lines = result.stdout.trim().split("\n"); assert.equal(lines.length, 1); assert.match(lines[0], /^WEATHER_CAPTURE_PLAN_SUMMARY /); assert.match(lines[0], /"plan_only":true/);
});
test("station catalog is loadable from its clean-checkout repository path", () => {
  const catalog = JSON.parse(readFileSync(resolve(process.cwd(), "config/weather/us-daily-max-stations.v1.json"), "utf8"));
  assert.equal(catalog.catalogVersion, "us-daily-max-stations.v1");
  assert.ok(catalog.stations.every((station: { venueAliasHint: unknown }) => station.venueAliasHint === null));
});
