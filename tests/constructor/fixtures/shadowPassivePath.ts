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
  const fx = await import("./rebalanceFixture");
  // Real shared engine, process runtime, in-memory deps: selection + live guard run, then the money
  // boundary must refuse before any writer is invoked.
  const { repo, calls } = fx.spyRepo();
  let guard = 0;
  const deps = { ...fx.writeDeps(repo), runtime: boot };
  const book = deps.fetchExactTokenOrderbook;
  deps.fetchExactTokenOrderbook = async (t: string) => { guard += 1; return book(t); };
  let blocked = false;
  try {
    await eq.runEventRebalance(fx.IN_WINDOW_MS, { write: true }, deps);
  } catch (e) {
    blocked = /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/.test((e as Error).message);
  }
  const inserts = calls.insert + calls.markQueued;
  console.log(JSON.stringify({ blocked, inserts, guard, instance: boot.contract.instanceId }));
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
