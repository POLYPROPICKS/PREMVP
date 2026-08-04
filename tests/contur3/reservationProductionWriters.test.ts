import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

test("night portfolio writer explicitly selects Contract A before it may create Reservations", async () => {
  const script = await readFile(
    new URL("../../scripts/send-night-portfolio-plan.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    script,
    /ensureAndLoadReservations\(Date\.now\(\),\s*\{\s*allowCreate,\s*selectorMode: "CONTRACT_A_PLANNING_V1",\s*\}\)/
  );
});

test("night reservation preview explicitly selects Contract A before it may write Reservations", async () => {
  const script = await readFile(
    new URL("../../scripts/preview-night-event-reservations.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    script,
    /buildReservationPlan\(Date\.now\(\),\s*\{\s*selectorMode: "CONTRACT_A_PLANNING_V1"\s*\}\)/
  );
});
