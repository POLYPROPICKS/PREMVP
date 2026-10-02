#!/usr/bin/env node
// PROD_SHADOW scheduler entry. The DEV cron runners (scripts/contur3/run-*.mjs) hard-code the live
// base URL and the ambient EXECUTOR_CANDIDATES_SECRET, so the shadow MUST NOT use them. This runner
// reads only SHADOW_* names and calls the SHADOW web service's own cron routes.
//   node scripts/shadow/shadow-cycle.mjs reservations   POST /api/cron/night-event-reservations
//   node scripts/shadow/shadow-cycle.mjs rebalance      POST /api/cron/event-rebalance
// Env (names only): SHADOW_BASE_URL, SHADOW_EXECUTOR_CANDIDATES_SECRET. Refuses if any DEV binding is set.
// The signal producer/resolver are NOT here: they run in-process as `npm run shadow:signals` and
// `npm run shadow:resolve` (see ops/railway/prod-shadow-signals.toml) and write the shadow DB directly.

export const SHADOW_JOBS = {
  reservations: "/api/cron/night-event-reservations",
  rebalance: "/api/cron/event-rebalance",
};
export const DEV_AMBIENT = ["EXECUTOR_CANDIDATES_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESERVATION_TIMES_MINSK"];

/** @param {string} job @param {{ env?: Record<string, string | undefined>, fetchImpl: (url: string, init: any) => Promise<any> }} opts */
export async function runShadowJob(job, { env = process.env, fetchImpl } = {}) {
  const path = SHADOW_JOBS[job];
  if (!path) return { exitCode: 1, reason: "UNKNOWN_JOB" };
  const ambient = DEV_AMBIENT.filter((n) => (env[n] ?? "") !== "");
  if (ambient.length) return { exitCode: 1, reason: `AMBIENT_FOREIGN_BINDING_PRESENT:${ambient.join(",")}` };
  const base = env.SHADOW_BASE_URL;
  const secret = env.SHADOW_EXECUTOR_CANDIDATES_SECRET;
  if (!base || !secret) return { exitCode: 1, reason: "MISSING_SHADOW_BINDINGS" };
  const res = await fetchImpl(new URL(path, base).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-executor-secret": secret },
    body: JSON.stringify({ dryRun: false }),
  });
  const body = await res.json().catch(() => ({}));
  return { exitCode: res.ok && body.ok === true ? 0 : 1, status: res.status };
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runShadowJob(process.argv[2], { fetchImpl: fetch }).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.exitCode);
  });
}
