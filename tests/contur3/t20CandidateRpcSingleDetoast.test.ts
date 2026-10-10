// T20_CANDIDATE_RPC_SINGLE_DETOAST_V1 — the performance rewrite must return exactly what the previous RPC returned.
//   node --import tsx --test tests/contur3/t20CandidateRpcSingleDetoast.test.ts
// Differential proof against a real throwaway PostgreSQL: previous function body (extracted verbatim from the freshness migration,
// renamed) vs the migrated function, over edge-case diagnostics. Skipped (not failed) when PostgreSQL server binaries are unavailable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateApprovedMigrationRelease } from "../../scripts/control-plane/lib/premvp-application-migration-release.mjs";
import { SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA } from "../../lib/executor/precontractT20Research";

const OLD = "supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql";
const FRESH = "supabase/migrations/20261007174425_research_snapshot_runs_two_generation_freshness_v1.sql";
const FIX = "supabase/migrations/20261010120000_t20_candidate_rpc_single_detoast_v1.sql";
const FN = "public.research_precontract_t20_event_candidates";
const REF = "public.research_t20_prev_ref";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/15/bin", "/usr/local/bin"].find((d) =>
  existsSync(path.join(d, "initdb")),
);
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const pgUser = IS_ROOT ? spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }) : null;
const CAN_RUN = Boolean(BIN) && (!IS_ROOT || pgUser?.status === 0);

let dir = "";
function run(cmd: string, args: string[], input?: string) {
  const bin = path.join(BIN as string, cmd);
  const r = IS_ROOT ? spawnSync("runuser", ["-u", "postgres", "--", bin, ...args], { encoding: "utf8", input }) : spawnSync(bin, args, { encoding: "utf8", input });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}
const psql = (q: string) => run("psql", ["-h", dir, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-c", q]).trim();
const psqlFile = (f: string) => run("psql", ["-h", dir, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", path.resolve(f)]);

const FROM = "2026-10-12T00:00:00Z";
const TO = "2026-10-13T00:00:00Z";
const R = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const call = (fn: string, ceiling = 800) => `SELECT string_agg(t::text, E'\\n') FROM ${fn}('${FROM}','${TO}',${ceiling}) t`;

before(() => {
  if (!CAN_RUN) return;
  dir = mkdtempSync(path.join(tmpdir(), "t20-detoast-"));
  chmodSync(dir, 0o755);
  if (IS_ROOT) chownSync(dir, Number(pgUser!.stdout.trim()), 0);
  run("initdb", ["-D", path.join(dir, "data"), "-A", "trust", "-U", "postgres"]);
  run("pg_ctl", ["-D", path.join(dir, "data"), "-o", `-k ${dir} -c listen_addresses=''`, "-l", path.join(dir, "log"), "-w", "start"]);
  psql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.generated_signal_research_snapshots (snapshot_run_id uuid, snapshot_at timestamptz, game_start_iso timestamptz, diagnostics jsonb);
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT SELECT ON public.generated_signal_research_snapshots TO service_role;`);
  psqlFile(OLD);
  psqlFile(FRESH);
  // Previous (pre-fix) function, verbatim, under a reference name.
  const fresh = readFileSync(FRESH, "utf8");
  const start = fresh.indexOf("CREATE OR REPLACE FUNCTION public.research_precontract_t20_event_candidates(");
  const end = fresh.indexOf("$$;", start) + 3;
  assert.ok(start > 0 && end > start);
  psql(fresh.slice(start, end).replace("public.research_precontract_t20_event_candidates(", "public.research_t20_prev_ref("));
  psqlFile(FIX);
  psqlFile(FIX); // idempotent re-apply
});
after(() => {
  if (!CAN_RUN || !dir) return;
  spawnSync(IS_ROOT ? "runuser" : path.join(BIN as string, "pg_ctl"), IS_ROOT ? ["-u", "postgres", "--", path.join(BIN as string, "pg_ctl"), "-D", path.join(dir, "data"), "-m", "immediate", "stop"] : ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
  rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: CAN_RUN ? false : "PostgreSQL server binaries unavailable" };

test("migration passes the approved-release validator and is function-only (no index, no table, no data change)", () => {
  const sql = readFileSync(FIX, "utf8");
  assert.deepEqual(validateApprovedMigrationRelease({
    declaration: { mode: "PREMVP_APPLICATION_SCHEMA_MIGRATION_V1", migration_files: [FIX], safety_class: "ADDITIVE_COMPATIBLE", direct_raw_mutation: false, rollback_strategy: "COMPATIBILITY_RETAINED" },
    changedFiles: [FIX], readFile: () => sql,
  }), { ok: true, errors: [] });
  assert.equal(/\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(sql), false);
  assert.equal(sql.split("CREATE OR REPLACE FUNCTION").length - 1, 1);
});

test("rewrite reads diagnostics exactly once per row: no direct accessor on g.diagnostics remains in the RPC body", () => {
  const sql = readFileSync(FIX, "utf8");
  const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION"));
  assert.equal((body.match(/g\.diagnostics/g) ?? []).length, 1, "only the single detoast site references g.diagnostics");
  assert.equal(body.includes("CROSS JOIN LATERAL (SELECT g.diagnostics || '{}'::jsonb AS d OFFSET 0) x"), true);
  assert.equal((body.match(/x\.d\b/g) ?? []).length, 7);
});

test("semantics frozen: filters, gates, ordering, ceiling clamp and 40/20/40 allocation unchanged", () => {
  const prev = readFileSync(FRESH, "utf8");
  const next = readFileSync(FIX, "utf8");
  const fnOf = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION"), s.indexOf("$$;", s.indexOf("CREATE OR REPLACE FUNCTION")) + 3);
  const normalise = (s: string) => s.replace(/\bx\.d\b/g, "g.diagnostics").replace(/\s*CROSS JOIN LATERAL \(SELECT g\.diagnostics \|\| '\{\}'::jsonb AS d OFFSET 0\) x/, "");
  assert.equal(normalise(fnOf(next)), fnOf(prev), "function body is identical to the previous body apart from the single-detoast fence");
  for (const needle of ["g.game_start_iso >= p_from", "g.game_start_iso < p_to", "(SELECT count(*) FROM completed_runs) = 2", "LIMIT least(greatest(p_ceiling, 1), 900) + 1",
    "ORDER BY a.parent_event_volume_24h DESC NULLS LAST, a.event_start_iso ASC, a.physical_key ASC"]) {
    assert.equal(next.includes(needle), true, needle);
  }
  assert.deepEqual([SOCCER_QUOTA, TENNIS_QUOTA, OTHER_QUOTA], [40, 20, 40]);
});

test("differential: edge-case diagnostics return the identical ordered result set as the previous RPC", opts, () => {
  psql("TRUNCATE public.generated_signal_research_snapshots; TRUNCATE public.research_snapshot_runs;");
  psql(`INSERT INTO public.research_snapshot_runs (snapshot_run_id, snapshot_at, completed_at, row_count) VALUES
    ('${R(1)}','2026-10-12T01:00:00Z','2026-10-12T01:01:00Z',0), ('${R(2)}','2026-10-12T02:00:00Z','2026-10-12T02:01:00Z',0)`);
  const edge: Array<[number, string]> = [
    [1, `{"providerEventContext":{"eventId":"E1","gameId":"G1"},"parentEventVolume24hr":100.5,"providerSportFamily":" Soccer ","providerSportCode":"s","providerSportSource":"tag"}`],
    [2, `{"providerEventContext":{"eventId":"E1","gameId":"g1"},"parentEventVolume24hr":"100.5","providerSportFamily":"soccer","providerSportCode":"s2","providerSportSource":"tag"}`],
    [2, `{"providerEventContext":{"eventId":"E1","gameId":"g1"},"parentEventVolume24hr":200,"providerSportFamily":"tennis"}`], // volume contradiction
    [2, `{"providerEventContext":{"eventId":"E2"},"parentEventVolume24hr":"abc"}`],                                        // non-numeric volume -> NULL
    [2, `{"providerEventContext":{"eventId":"E3","gameId":"  "},"parentEventVolume24hr":1e5,"providerSportFamily":null}`], // blank gameId -> event key
    [2, `{"providerEventContext":{"eventId":"  "},"parentEventVolume24hr":5}`],                                           // blank eventId -> dropped
    [2, `"scalar"`], [2, `[1,2,3]`], [2, `null`], [2, `{}`],                                                               // non-object documents
    [2, `{"providerEventContext":"x","parentEventVolume24hr":-3.5E+2}`],
    [2, `{"providerEventContext":{"eventId":"E4","gameId":"G4"},"parentEventVolume24hr":true,"providerSportCode":{"a":1}}`],
    [1, `{"providerEventContext":{"eventId":"E5","gameId":"G5"},"parentEventVolume24hr":7}`],
    [2, `{"providerEventContext":{"eventId":"E5","gameId":"G5"},"parentEventVolume24hr":8}`],
    [2, `{"providerEventContext":{"eventId":"E5","gameId":"G5"},"parentEventVolume24hr":9}`],
  ];
  edge.forEach(([runN, doc], i) =>
    psql(`INSERT INTO public.generated_signal_research_snapshots VALUES ('${R(runN)}','2026-10-12T0${runN}:00:00Z','2026-10-12T12:00:00Z',$j$${doc}$j$::jsonb)`.replace("12:00:00Z", `12:0${i % 10}:00Z`)));
  const prev = psql(call(REF));
  assert.notEqual(prev, "", "edge fixture must produce candidates");
  assert.equal(psql(call(FN)), prev);
  assert.equal(psql(`SELECT count(*) FROM ${FN}('${FROM}','${TO}',2)`), "3", "p_ceiling + 1 sentinel preserved");
  assert.equal(psql(`SELECT count(*) FROM ${REF}('${FROM}','${TO}',2)`), "3");
});

test("differential: wide TOASTed diagnostics (production shape) return the identical ordered result set", opts, () => {
  psql("TRUNCATE public.generated_signal_research_snapshots; TRUNCATE public.research_snapshot_runs;");
  psql(`INSERT INTO public.research_snapshot_runs (snapshot_run_id, snapshot_at, completed_at, row_count) VALUES
    ('${R(1)}','2026-10-12T01:00:00Z','2026-10-12T01:01:00Z',0), ('${R(2)}','2026-10-12T02:00:00Z','2026-10-12T02:01:00Z',0)`);
  psql(`INSERT INTO public.generated_signal_research_snapshots
    SELECT ('00000000-0000-4000-8000-00000000000' || r)::uuid, ('2026-10-12T0' || r || ':00:00Z')::timestamptz, '2026-10-12T12:00:00Z'::timestamptz + (e % 60) * interval '1 minute',
      jsonb_build_object('providerEventContext', jsonb_build_object('eventId','ev'||e,'gameId','g'||e), 'parentEventVolume24hr', (e * 137 % 1000) + k,
        'providerSportFamily', (ARRAY['soccer','tennis','basketball'])[1 + e % 3], 'providerSportCode','x', 'providerSportSource','structured_sports_tag',
        'book', (SELECT jsonb_agg(md5(i::text || e::text || random()::text)) FROM generate_series(1, 120) i))
    FROM generate_series(1,2) r, generate_series(1,150) e, generate_series(1,3) k`);
  assert.equal(psql("SELECT bool_and(pg_column_size(diagnostics) > 2000) FROM public.generated_signal_research_snapshots"), "t", "fixture rows exceed the TOAST threshold");
  assert.equal(psql(call(FN)), psql(call(REF)));
});

test("RPC contract preserved: signature, 14 result columns, service_role-only EXECUTE, comment retained", opts, () => {
  assert.equal(psql(`SELECT pg_get_function_arguments('${FN}'::regproc)`), "p_from timestamp with time zone, p_to timestamp with time zone, p_ceiling integer DEFAULT 800");
  assert.equal(psql("SELECT count(*) FROM pg_proc p, unnest(p.proargnames) n WHERE p.proname='research_precontract_t20_event_candidates'"), "17");
  assert.equal(psql(`SELECT has_function_privilege('service_role','${FN}(timestamptz,timestamptz,integer)','EXECUTE'), has_function_privilege('anon','${FN}(timestamptz,timestamptz,integer)','EXECUTE'), has_function_privilege('authenticated','${FN}(timestamptz,timestamptz,integer)','EXECUTE')`), "t|f|f");
  assert.equal(psql(`SELECT obj_description('${FN}(timestamptz,timestamptz,integer)'::regprocedure) LIKE 'PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1%'`), "t");
});
