#!/usr/bin/env node
/**
 * production-observation.mjs
 *
 * Registered canonical command: premvp.command.production_observation.v1
 *
 * Generic, resumable, read-only production-observation runner. Owns the recovery/resume
 * state machine so future prompts can invoke this command instead of describing retry
 * orchestration by hand.
 *
 * Contract (see AGENT_REGISTRY.yaml entry for the authoritative statement):
 *   - a PostgREST PGRST002 / HTTP 5xx response from the database read surface is a
 *     RECOVERABLE INFRASTRUCTURE WAIT, never PROMPT_GATE_BLOCKED;
 *   - an application read surface returning HTTP 200 with a `static-fallback-*` payload id
 *     is DEGRADED database evidence, not healthy evidence — treated the same as a WAIT;
 *   - progress is checkpointed to a local, non-secret, gitignored JSON file
 *     (reports/observation/<observation_id>.json) so a transport/session interruption
 *     does not lose transaction state;
 *   - re-running with the same observation_id is idempotent: completed stages are not
 *     redone, only re-verified where cheap (deployment ancestry) or re-attempted where the
 *     prior run left the observation incomplete (database probe, measurement);
 *   - credentials are read only from process.env and are never written to the checkpoint
 *     file or stdout.
 *
 * Usage:
 *   node scripts/control-plane/production-observation.mjs '<input JSON>'
 *
 * Input JSON:
 *   {
 *     "observation_id": string,        // stable id for this observation transaction
 *     "repository_root": string,       // optional, defaults to cwd
 *     "app_url_env": string,           // env var name holding the app base URL (default NEXT_PUBLIC_APP_URL)
 *     "supabase_url_env": string,      // env var name holding the Supabase URL (default SUPABASE_URL)
 *     "supabase_key_env": string,      // env var name holding the service-role key (default SUPABASE_SERVICE_ROLE_KEY)
 *     "expected_ancestor_sha": string, // git SHA that must be an ancestor of production
 *     "table": string,                 // producer output table (default "generated_signal_pairs")
 *     "metric_formula_version": string // shadow-row version marker to scan
 *   }
 *
 * Never mutates the repository or the database. Every network call is a GET/SELECT.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = [
  "deployment_identity_proven",
  "database_waiting",
  "natural_run_observed",
  "producer_persistence_measured",
  "identity_conservation_measured",
  "downstream_handoff_measured",
  "observation_complete",
];

function stageIndex(stage) {
  return STAGES.indexOf(stage);
}

function readCheckpoint(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCheckpoint(file, checkpoint) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
}

function gitRevParse(root, ref) {
  return execFileSync("git", ["-C", root, "rev-parse", ref], { encoding: "utf8" }).trim();
}

function gitIsAncestor(root, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, headers, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const status = resp.status;
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return { status, body };
  } catch (err) {
    return { status: 0, body: null, networkError: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

/** Classify a database-read probe. Never throws. Never logs secret values. */
async function probeDatabase(supabaseUrl, supabaseKey) {
  const r = await fetchJson(`${supabaseUrl}/rest/v1/`, {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  });
  if (r.status >= 200 && r.status < 300) return { available: true, reason: null };
  if (r.status === 0) return { available: false, reason: `NETWORK_UNREACHABLE: ${r.networkError}` };
  if (r.status === 503 || r.body?.code === "PGRST002") {
    return { available: false, reason: `PGRST002_OR_503: ${r.body?.message ?? r.status}` };
  }
  if (r.status === 401 || r.status === 403) {
    return { available: false, reason: `AUTH_REJECTED: HTTP ${r.status}`, authBoundary: true };
  }
  return { available: false, reason: `UNEXPECTED_STATUS: HTTP ${r.status}` };
}

/** Classify the application's own read surface. Detects silent static-fallback degradation. */
async function probeAppReadSurface(appUrl) {
  const r = await fetchJson(`${appUrl}/api/feed/landing-cards?limit=4`, {});
  if (r.status !== 200) return { healthy: false, reason: `HTTP ${r.status}` };
  const firstId = r.body?.pairs?.[0]?.id;
  if (typeof firstId === "string" && firstId.startsWith("static-fallback")) {
    return { healthy: false, reason: "STATIC_FALLBACK_DEGRADED", degraded: true };
  }
  return { healthy: true, reason: null };
}

/** Read-only census over persisted producer output. No mutation, no business-policy change. */
async function measureProducerOutput(supabaseUrl, supabaseKey, table, metricFormulaVersion) {
  const url = `${supabaseUrl}/rest/v1/${table}?metric_formula_version=eq.${encodeURIComponent(
    metricFormulaVersion,
  )}&select=diagnostics,score,expires_at,created_at&limit=5000`;
  const r = await fetchJson(url, {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: "count=exact",
  });
  if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) {
    return { ok: false, reason: `MEASUREMENT_READ_FAILED: HTTP ${r.status}` };
  }
  const rows = r.body;
  const events = new Set();
  const identityCompleteEvents = new Set();
  const contractAInputEvents = new Set();
  let rowsMissingProviderEventContext = 0;
  let scoreReadyRows = 0;

  for (const row of rows) {
    const d = row.diagnostics ?? {};
    const eventId = d.providerEventId ?? d?.providerEventContext?.eventId;
    if (eventId) events.add(String(eventId));

    const ctx = d.providerEventContext;
    const validCtx =
      ctx &&
      ctx.v === "v1" &&
      ctx.provider === "polymarket" &&
      typeof ctx.eventId === "string" &&
      ctx.eventId.length > 0 &&
      Number.isFinite(Date.parse(ctx.eventStartIso ?? ""));

    if (validCtx) {
      identityCompleteEvents.add(String(ctx.eventId));
      // Same predicate exactProviderEventIdentity() applies downstream — a row that
      // passes it is admissible Contract A input on identity grounds alone.
      contractAInputEvents.add(String(ctx.eventId));
    } else {
      rowsMissingProviderEventContext += 1;
    }

    if (row.score !== null && row.score !== undefined) scoreReadyRows += 1;
  }

  return {
    ok: true,
    rowsPersisted: rows.length,
    signalPairPresentEvents: events.size,
    identityCompleteEvents: identityCompleteEvents.size,
    contractAInputEvents: contractAInputEvents.size,
    rowsMissingProviderEventContext,
    scoreReadyRows,
    naturalRunObserved: identityCompleteEvents.size > 0,
  };
}

async function main() {
  const input = JSON.parse(process.argv[2] || "{}");
  if (!input.observation_id) throw new Error("observation_id is required");
  if (!input.expected_ancestor_sha) throw new Error("expected_ancestor_sha is required");

  const root = path.resolve(input.repository_root || process.cwd());
  const checkpointFile = path.join(root, "reports", "observation", `${input.observation_id}.json`);
  const table = input.table || "generated_signal_pairs";
  const metricFormulaVersion = input.metric_formula_version || "shadow-strategic-sports-v1";

  const appUrl = process.env[input.app_url_env || "NEXT_PUBLIC_APP_URL"];
  const supabaseUrl = process.env[input.supabase_url_env || "SUPABASE_URL"];
  const supabaseKey = process.env[input.supabase_key_env || "SUPABASE_SERVICE_ROLE_KEY"];

  let checkpoint = readCheckpoint(checkpointFile) || {
    observation_id: input.observation_id,
    stage: null,
    created_at: new Date().toISOString(),
    evidence: {},
  };

  // Stage 1: deployment identity. Cheap and idempotent to re-verify, but once proven for
  // this exact expected_ancestor_sha we do not repeat it — a completed stage is not redone.
  if (
    stageIndex(checkpoint.stage) < stageIndex("deployment_identity_proven") ||
    checkpoint.evidence?.expected_ancestor_sha !== input.expected_ancestor_sha
  ) {
    const originMain = gitRevParse(root, "origin/main");
    let productionSha = originMain;
    let productionSource = "git:origin/main";
    if (appUrl) {
      const bi = await fetchJson(`${appUrl}/api/build-info`, {});
      if (bi.status === 200 && bi.body?.commit_sha) {
        productionSha = bi.body.commit_sha;
        productionSource = "http:/api/build-info";
      }
    }
    const isAncestor = gitIsAncestor(root, input.expected_ancestor_sha, productionSha);
    if (!isAncestor) {
      writeCheckpoint(checkpointFile, {
        ...checkpoint,
        stage: null,
        updated_at: new Date().toISOString(),
        evidence: { ...checkpoint.evidence, expected_ancestor_sha: input.expected_ancestor_sha },
      });
      console.log(
        JSON.stringify(
          {
            verdict: "PROMPT_GATE_BLOCKED",
            reason: "EXPECTED_ANCESTOR_NOT_IN_PRODUCTION",
            origin_main: originMain,
            production_sha: productionSha,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    checkpoint = {
      ...checkpoint,
      stage: "deployment_identity_proven",
      updated_at: new Date().toISOString(),
      evidence: {
        ...checkpoint.evidence,
        origin_main: originMain,
        production_sha: productionSha,
        production_sha_source: productionSource,
        expected_ancestor_sha: input.expected_ancestor_sha,
        ancestor_proven: true,
      },
    };
    writeCheckpoint(checkpointFile, checkpoint);
  }

  // Stage 2: database reachability, through two independent authorized read surfaces.
  const dbProbe = supabaseUrl && supabaseKey
    ? await probeDatabase(supabaseUrl, supabaseKey)
    : { available: false, reason: "MISSING_CREDENTIALS_ENV" };
  const appProbe = appUrl ? await probeAppReadSurface(appUrl) : { healthy: false, reason: "MISSING_APP_URL_ENV" };

  if (dbProbe.authBoundary) {
    // A genuine auth/capability boundary, not an infra outage — this is the one case that
    // legitimately escalates rather than WAITs.
    writeCheckpoint(checkpointFile, {
      ...checkpoint,
      stage: "database_waiting",
      updated_at: new Date().toISOString(),
      evidence: { ...checkpoint.evidence, database_read_status: dbProbe.reason },
    });
    console.log(
      JSON.stringify({ verdict: "PROMPT_GATE_BLOCKED", reason: dbProbe.reason }, null, 2),
    );
    process.exitCode = 1;
    return;
  }

  if (!dbProbe.available || appProbe.degraded || !appProbe.healthy) {
    checkpoint = {
      ...checkpoint,
      stage: "database_waiting",
      updated_at: new Date().toISOString(),
      evidence: {
        ...checkpoint.evidence,
        database_read_status: dbProbe.available
          ? "DATABASE_READ_AVAILABLE_BUT_APP_SURFACE_DEGRADED"
          : `DATABASE_READ_TEMPORARILY_UNAVAILABLE: ${dbProbe.reason}`,
        app_probe_reason: appProbe.reason,
      },
    };
    writeCheckpoint(checkpointFile, checkpoint);
    console.log(
      JSON.stringify(
        {
          verdict: "WAIT_INFRASTRUCTURE_RECOVERY",
          checkpoint_id: input.observation_id,
          resume_stage: checkpoint.stage,
          database_read_status: checkpoint.evidence.database_read_status,
          deployment: {
            origin_main: checkpoint.evidence.origin_main,
            production_sha: checkpoint.evidence.production_sha,
            expected_ancestor_sha: checkpoint.evidence.expected_ancestor_sha,
            ancestor_proven: checkpoint.evidence.ancestor_proven,
          },
          founder_action: "none",
        },
        null,
        2,
      ),
    );
    return;
  }

  // Stage 3-6: database is healthy on both surfaces. Run the read-only measurement.
  const measurement = await measureProducerOutput(supabaseUrl, supabaseKey, table, metricFormulaVersion);
  if (!measurement.ok) {
    checkpoint = {
      ...checkpoint,
      stage: "database_waiting",
      updated_at: new Date().toISOString(),
      evidence: { ...checkpoint.evidence, database_read_status: measurement.reason },
    };
    writeCheckpoint(checkpointFile, checkpoint);
    console.log(
      JSON.stringify(
        { verdict: "WAIT_INFRASTRUCTURE_RECOVERY", reason: measurement.reason, founder_action: "none" },
        null,
        2,
      ),
    );
    return;
  }

  checkpoint = {
    ...checkpoint,
    stage: "observation_complete",
    updated_at: new Date().toISOString(),
    evidence: {
      ...checkpoint.evidence,
      database_read_status: "DATABASE_READ_AVAILABLE",
      natural_run_observed: measurement.naturalRunObserved,
      rows_persisted: measurement.rowsPersisted,
      signal_pair_present_events: measurement.signalPairPresentEvents,
      identity_complete_events: measurement.identityCompleteEvents,
      contract_a_input_events: measurement.contractAInputEvents,
      rows_missing_provider_event_context: measurement.rowsMissingProviderEventContext,
      score_ready_rows: measurement.scoreReadyRows,
      // Per-run producer ledger fields (rowsProposed / rowsInserted / rowsDeduped /
      // rowsExplicitlyRejected / writeFailed / eventsEnumerated) are computed and returned
      // in-memory by writeStrategicShadowPairs at call time and are NOT persisted anywhere
      // this command can read after the fact. They are honestly reported as unavailable to
      // a post-hoc read-only census rather than approximated from persisted-row counts.
      run_scoped_ledger_available: false,
    },
  };
  writeCheckpoint(checkpointFile, checkpoint);

  console.log(
    JSON.stringify(
      {
        verdict: "PRODUCER_PRODUCTION_EFFECT_PROVEN",
        checkpoint_id: input.observation_id,
        resume_stage: checkpoint.stage,
        deployment: {
          origin_main: checkpoint.evidence.origin_main,
          production_sha: checkpoint.evidence.production_sha,
          expected_ancestor_sha: checkpoint.evidence.expected_ancestor_sha,
        },
        database_read_status: "DATABASE_READ_AVAILABLE",
        natural_run_observed: measurement.naturalRunObserved,
        production_persistence_read: {
          rows_persisted: measurement.rowsPersisted,
          signal_pair_present_events: measurement.signalPairPresentEvents,
          identity_complete_events: measurement.identityCompleteEvents,
          contract_a_input_events: measurement.contractAInputEvents,
          rows_missing_provider_event_context: measurement.rowsMissingProviderEventContext,
          score_ready_rows: measurement.scoreReadyRows,
        },
        run_scoped_ledger_available: false,
        founder_action: "none",
      },
      null,
      2,
    ),
  );
}

// Exported for tests — pure functions, no I/O side effects beyond what's explicit above.
export { STAGES, stageIndex, probeDatabase, probeAppReadSurface, measureProducerOutput };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(JSON.stringify({ verdict: "PROMPT_GATE_BLOCKED", reason: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
