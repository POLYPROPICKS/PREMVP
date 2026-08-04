import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("night-plan-email production writer explicitly selects Contract A before it may create Reservations", async () => {
  const route = await readFile(
    new URL("../../app/api/cron/night-plan-email/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    route,
    /ensureAndLoadReservations\(Date\.now\(\),\s*\{\s*allowCreate: mode === "plan",\s*selectorMode: "CONTRACT_A_PLANNING_V1",\s*\}\)[\s\S]*/
  );
});
