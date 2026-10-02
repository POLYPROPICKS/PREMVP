// The shadow signal pipeline (producer writes -> serving projection -> evidence publication -> job
// evidence -> reads) runs against the supplied ContourRuntime's client ONLY. The process selector is
// poisoned and no SUPABASE_* env exists, so any fall-through to the process-global client would throw.
// Fake clients only: no network, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CONSTRUCTOR_ACTIVE_CONTOUR = "POISONED_NOT_A_CONTOUR";
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EXECUTOR_CANDIDATES_SECRET"]) delete process.env[k];

import { bootContourRuntime, type ContourRuntimeV1 } from "../../lib/constructor/bootstrap";
import { runWithContourRuntime, scopedSupabaseAdmin } from "../../lib/constructor/runtimeScope";
import { writeFireModel1_1ResearchPairsWithDetail, writeJobRun, readCurrentServingSignalPairs } from "../../lib/feed/cacheGeneratedSignals";
import { refreshCurrentSignalPairServing, pruneCurrentSignalPairServing } from "../../lib/feed/currentSignalPairServing";
import { publishPrimaryEvidenceToServing } from "../../lib/feed/primaryEvidenceServing";

const DEV_ENV = { EXECUTOR_CANDIDATES_SECRET: "d", SUPABASE_URL: "http://dev.invalid", SUPABASE_SERVICE_ROLE_KEY: "d" };
const SHADOW_ENV = {
  CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "s",
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "s",
};

/** Recording fake: every table/rpc touched is logged; all calls resolve empty-success. */
function recorder(label: string, log: string[]) {
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      return () => chain;
    },
  });
  return {
    from(table: string) { log.push(`${label}:from:${table}`); return chain; },
    rpc(name: string) { log.push(`${label}:rpc:${name}`); return chain; },
  };
}

function runtimeWith(base: ContourRuntimeV1, client: unknown): ContourRuntimeV1 {
  return { ...base, resources: { supabaseAdmin: () => client as never } } as ContourRuntimeV1;
}

test("scoped client is the runtime's; two runtimes in one process never cross", async () => {
  const log: string[] = [];
  const shadow = runtimeWith(bootContourRuntime(SHADOW_ENV), recorder("SHADOW", log));
  const dev = runtimeWith(bootContourRuntime(DEV_ENV), recorder("DEV", log));
  await Promise.all([
    runWithContourRuntime(shadow, async () => { await new Promise((r) => setTimeout(r, 5)); await writeJobRun({ source: "s", formulaVersion: "v", startedAt: "", finishedAt: "", status: "success", generatedCount: 0, rejectedCount: 0, durationMs: 0 }); }),
    runWithContourRuntime(dev, async () => { await writeJobRun({ source: "d", formulaVersion: "v", startedAt: "", finishedAt: "", status: "success", generatedCount: 0, rejectedCount: 0, durationMs: 0 }); }),
  ]);
  assert.deepEqual(log.filter((l) => l.startsWith("SHADOW")), ["SHADOW:from:job_runs"]);
  assert.deepEqual(log.filter((l) => l.startsWith("DEV")), ["DEV:from:job_runs"]);
});

test("shadow producer -> serving projection -> evidence -> reads touch the SHADOW client only", async () => {
  const log: string[] = [];
  const shadow = runtimeWith(bootContourRuntime(SHADOW_ENV), recorder("SHADOW", log));
  await runWithContourRuntime(shadow, async () => {
    await refreshCurrentSignalPairServing(["00000000-0000-0000-0000-000000000001"]);
    await pruneCurrentSignalPairServing({ resolvedSourceIds: ["00000000-0000-0000-0000-000000000001"] } as never).catch(() => undefined);
    await readCurrentServingSignalPairs(5).catch(() => undefined);
    await publishPrimaryEvidenceToServing({ observationId: "o", observedAt: new Date().toISOString(), input: { pairs: [], source: "s", formulaVersion: "v", expiresAt: new Date().toISOString() } } as never).catch(() => undefined);
    await writeFireModel1_1ResearchPairsWithDetail([], new Date().toISOString());
  });
  assert.ok(log.length >= 3, `expected shadow client traffic, saw ${log.join(",")}`);
  assert.ok(log.every((l) => l.startsWith("SHADOW:")), log.join(","));
  assert.ok(log.includes("SHADOW:rpc:refresh_current_signal_pair_serving"));
  assert.ok(log.includes("SHADOW:from:primary_evidence_outbox") || log.includes("SHADOW:rpc:publish_primary_signal_observation") || log.some((l) => l.includes("current_signal_pair_serving")));
});

test("outside any scope the process-global path is used (DEV unchanged) and is poisoned here", async () => {
  await assert.rejects(scopedSupabaseAdmin(), /CONSTRUCTOR_CONTOUR_UNKNOWN/);
});

test("a shadow scope never reaches the poisoned process-global client", async () => {
  const log: string[] = [];
  const shadow = runtimeWith(bootContourRuntime(SHADOW_ENV), recorder("SHADOW", log));
  await runWithContourRuntime(shadow, async () => { assert.equal(await scopedSupabaseAdmin(), shadow.resources.supabaseAdmin()); });
});
