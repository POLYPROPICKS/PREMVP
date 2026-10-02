#!/usr/bin/env node
// PROD_SHADOW database bootstrap (repo-owned, idempotent, schema-only).
//   node scripts/shadow/shadow-bootstrap.mjs --plan            print the ordered file plan (no DB)
//   node scripts/shadow/shadow-bootstrap.mjs --apply           apply to the EMPTY shadow DB
//   node scripts/shadow/shadow-bootstrap.mjs --verify          check the required-schema inventory
//   node scripts/shadow/shadow-bootstrap.mjs --apply --verify  both
// Target: SHADOW_DATABASE_URL (a Postgres connection string for the SHADOW database only; the value
// lives in the operator's shell/Railway, never in the repo). Refuses when it equals DATABASE_URL or
// SUPABASE_DB_URL, so it cannot be pointed at the DEV database by an ambient variable.
// Applied files are recorded in public.shadow_bootstrap_ledger (file, sha256); a re-run skips them, and
// a changed already-applied file fails closed. No operational rows are ever read or copied.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHADOW_DIR = join(ROOT, "supabase", "shadow");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

export function buildPlan() {
  const { exclusions } = JSON.parse(readFileSync(join(SHADOW_DIR, "exclusions.json"), "utf8"));
  const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const name of Object.keys(exclusions)) {
    if (!migrations.includes(name)) throw new Error(`SHADOW_EXCLUSION_STALE: ${name} is not a migration`);
  }
  return [
    { name: "shadow/000_prehistory_baseline.sql", path: join(SHADOW_DIR, "000_prehistory_baseline.sql") },
    ...migrations.filter((f) => !(f in exclusions)).map((f) => ({ name: `migrations/${f}`, path: join(MIGRATIONS_DIR, f) })),
  ].map((f) => ({ ...f, sha256: createHash("sha256").update(readFileSync(f.path)).digest("hex") }));
}

function targetUrl() {
  const url = process.env.SHADOW_DATABASE_URL;
  if (!url) throw new Error("SHADOW_BOOTSTRAP_REFUSED: SHADOW_DATABASE_URL is not set");
  for (const other of ["DATABASE_URL", "SUPABASE_DB_URL"]) {
    if (process.env[other] && process.env[other] === url) throw new Error(`SHADOW_BOOTSTRAP_REFUSED: SHADOW_DATABASE_URL equals ${other}`);
  }
  return url;
}

function psql(url, args) {
  const r = spawnSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || "").split("\n").slice(0, 4).join(" | ")}`);
  return r.stdout;
}

export function apply() {
  const url = targetUrl();
  // Fresh-target guard: a database with no ledger must have NO public tables, so this can never be pointed at
  // an existing (e.g. DEV) database by a textually different connection string.
  const state = psql(url, ["-At", "-F", "|", "-c", "SELECT (to_regclass('public.shadow_bootstrap_ledger') IS NOT NULL), (SELECT count(*) FROM information_schema.tables WHERE table_schema='public')"]).trim().split("|");
  if (state[0] !== "t" && Number(state[1]) > 0) throw new Error("SHADOW_BOOTSTRAP_REFUSED: target has public tables but no bootstrap ledger (not an empty shadow database)");
  psql(url, ["-c", "CREATE TABLE IF NOT EXISTS public.shadow_bootstrap_ledger (file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"]);
  const done = new Map(psql(url, ["-At", "-F", "|", "-c", "SELECT file, sha256 FROM public.shadow_bootstrap_ledger"]).split("\n").filter(Boolean).map((l) => l.split("|")));
  let applied = 0, skipped = 0;
  for (const f of buildPlan()) {
    if (done.has(f.name)) {
      if (done.get(f.name) !== f.sha256) throw new Error(`SHADOW_BOOTSTRAP_DRIFT: ${f.name} changed after it was applied`);
      skipped++;
      continue;
    }
    // Not --single-transaction: some migrations use CREATE INDEX CONCURRENTLY. The ledger row is written
    // only after the whole file succeeded, so a failed file is simply re-applied on the next run.
    psql(url, ["-f", f.path, "-c", `INSERT INTO public.shadow_bootstrap_ledger(file, sha256) VALUES ('${f.name}', '${f.sha256}')`]);
    applied++;
  }
  return { applied, skipped };
}

export function verify() {
  const url = targetUrl();
  const inv = JSON.parse(readFileSync(join(SHADOW_DIR, "required-schema.json"), "utf8"));
  const q = (sql) => psql(url, ["-At", "-c", sql]).split("\n").filter(Boolean);
  const tables = new Set(q("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"));
  const cols = new Set(q("SELECT table_name||'.'||column_name FROM information_schema.columns WHERE table_schema='public'"));
  const fns = new Set(q("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"));
  const missing = [
    ...inv.tables.filter((t) => !tables.has(t)).map((t) => `table:${t}`),
    ...Object.entries(inv.columns).flatMap(([t, cs]) => cs.filter((c) => !cols.has(`${t}.${c}`)).map((c) => `column:${t}.${c}`)),
    ...inv.functions.filter((f) => !fns.has(f)).map((f) => `function:${f}`),
  ];
  // Contract parity for the reconstructed pre-history tables: type, NOT NULL and defaults of the FINAL schema
  // (after every later migration), compared to the live-schema-verified contract.
  const meta = new Map(q("SELECT table_name||'.'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public'")
    .map((l) => { const [k, type, nullable, def] = l.split("|"); return [k, { type, notNull: nullable === "NO", def }]; }));
  const drift = [];
  for (const [t, cs] of Object.entries(inv.columnContracts ?? {})) {
    for (const [c, want] of Object.entries(cs)) {
      const got = meta.get(`${t}.${c}`);
      if (!got) { drift.push(`${t}.${c}:absent`); continue; }
      if (got.type !== want.type) drift.push(`${t}.${c}:type ${got.type}!=${want.type}`);
      if (got.notNull !== want.notNull) drift.push(`${t}.${c}:notNull ${got.notNull}!=${want.notNull}`);
      if (want.default !== undefined && got.def !== want.default) drift.push(`${t}.${c}:default ${got.def}!=${want.default}`);
    }
  }
  for (const [t, cs] of Object.entries(inv.forbiddenColumns ?? {})) for (const c of cs) if (meta.has(`${t}.${c}`)) drift.push(`${t}.${c}:must not exist`);
  if (drift.length) throw new Error(`SHADOW_SCHEMA_DRIFT: ${drift.join("; ")}`);
  if (missing.length) throw new Error(`SHADOW_SCHEMA_INCOMPLETE: ${missing.join(", ")}`);
  // Startup probe: the reads the shadow runtime performs first must be executable.
  for (const t of inv.probeTables) psql(url, ["-c", `SELECT 1 FROM public.${t} LIMIT 0`]);
  return { tables: inv.tables.length, functions: inv.functions.length, contractColumns: Object.values(inv.columnContracts ?? {}).reduce((n, c) => n + Object.keys(c).length, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  try {
    if (!["--plan", "--apply", "--verify"].some((a) => args.has(a))) throw new Error("usage: --plan | --apply | --verify");
    if (args.has("--plan")) for (const f of buildPlan()) console.log(`${f.sha256.slice(0, 12)}  ${f.name}`);
    if (args.has("--apply")) console.log("apply", JSON.stringify(apply()));
    if (args.has("--verify")) console.log("verify", JSON.stringify(verify()));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
