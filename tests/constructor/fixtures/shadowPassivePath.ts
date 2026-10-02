// Child-process fixture for runtimeBootstrap.test.ts. Runs as PROD_SHADOW with fake SHADOW_* env.
import { bootProcessRuntime } from "../../../lib/constructor/bootstrap";

async function main(): Promise<void> {
  const boot = bootProcessRuntime();
  if (boot.contour.profile.contourId !== "PROD_SHADOW") throw new Error("not shadow");
  // The shared admin client resolves through the shadow bindings; DEV names are absent.
  const { supabaseAdmin } = await import("../../../lib/supabase/server");
  if (!supabaseAdmin) throw new Error("no client");
  if (process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("DEV env leaked");
  const eq = await import("../../../lib/executor/eventExecutionQueue");
  let inserts = 0;
  const repo = { async insertQueueRow() { inserts += 1; } };
  let blocked = false;
  try {
    await eq.admitExecutableQueueRow(boot.contour, repo, {} as never);
  } catch (e) {
    blocked = /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/.test((e as Error).message);
  }
  console.log(JSON.stringify({ blocked, inserts, instance: boot.contract.instanceId }));
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
