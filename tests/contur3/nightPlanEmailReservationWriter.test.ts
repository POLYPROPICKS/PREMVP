import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_LIVE_PROFILE } from "../../lib/constructor/devLive";

test("night-plan-email production writer explicitly selects Contract A before it may create Reservations", async () => {
  const route = await readFile(
    new URL("../../app/api/cron/night-plan-email/route.ts", import.meta.url),
    "utf8"
  );

  // Constructor V1: the selector is supplied by the DEV_LIVE contour profile instead of a literal.
  // The invariant is unchanged: the production writer explicitly selects Contract A planning.
  assert.match(
    route,
    /ensureAndLoadReservations\(nowMs,\s*\{\s*allowCreate: mode === "plan",\s*selectorMode: contour\.profile\.selectors\.planning,/
  );
  assert.equal(DEV_LIVE_PROFILE.selectors.planning, "CONTRACT_A_PLANNING_V1");
});
