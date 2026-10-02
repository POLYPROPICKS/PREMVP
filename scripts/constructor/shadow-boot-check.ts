// PROD_SHADOW boot check: the one authoritative answer to "can this process boot PROD_SHADOW safely?"
//   npm run shadow:boot-check
// Requires CONSTRUCTOR_ACTIVE_CONTOUR=PROD_SHADOW to be set EXPLICITLY (never inferred, so a missing
// variable can never make a shadow service silently become DEV_LIVE). No network, no DB writes, no
// secret values printed: it resolves the shadow's resources, runs the shared non-money path
// initialization, and proves the money boundary refuses. Exit 0 = safe to start; non-zero = refuse.

import { assertMoneyMovementEnabled } from "../../lib/constructor/contracts";
import { bootProcessRuntime } from "../../lib/constructor/bootstrap";
import { ACTIVE_CONTOUR_ENV } from "../../lib/constructor/registry";

async function main(): Promise<void> {
  if (process.env[ACTIVE_CONTOUR_ENV] !== "PROD_SHADOW") {
    throw new Error(`SHADOW_BOOT_REFUSED: ${ACTIVE_CONTOUR_ENV} must be explicitly set to PROD_SHADOW`);
  }
  const { contour, contract } = bootProcessRuntime();
  if (contour.profile.contourId !== "PROD_SHADOW" || contour.profile.capabilities.moneyMovement !== "disabled") {
    throw new Error("SHADOW_BOOT_REFUSED: selected contour is not a passive PROD_SHADOW");
  }

  // Shared non-money initialization: the process-wide admin client resolves through the shadow bindings.
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  if (!supabaseAdmin) throw new Error("SHADOW_BOOT_REFUSED: shadow Supabase client did not initialize");

  // The authoritative money boundary must refuse, and its downstream effect must not run.
  const { admitExecutableQueueRow } = await import("../../lib/executor/eventExecutionQueue");
  let inserts = 0;
  const repo = { async insertQueueRow() { inserts += 1; } };
  let blocked = false;
  try {
    await admitExecutableQueueRow(contour, repo, {} as never);
  } catch (e) {
    blocked = /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/.test((e as Error).message);
  }
  if (!blocked || inserts !== 0) throw new Error("SHADOW_BOOT_REFUSED: money boundary did not block");
  try {
    assertMoneyMovementEnabled(contour, "BOOT_CHECK");
    throw new Error("SHADOW_BOOT_REFUSED: capability guard did not throw");
  } catch (e) {
    if (!/CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/.test((e as Error).message)) throw e;
  }

  console.log(JSON.stringify({ ok: true, contract: contract }, null, 2));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
