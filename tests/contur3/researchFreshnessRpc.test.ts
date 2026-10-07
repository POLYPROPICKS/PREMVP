// R1_TWO_COMPLETE_RESEARCH_GENERATIONS_FRESHNESS_V1 — RPC contract proof against a real throwaway PostgreSQL.
//   node --import tsx --test tests/contur3/researchFreshnessRpc.test.ts
// Skipped (not failed) when PostgreSQL server binaries are unavailable on the machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateApprovedMigrationRelease } from "../../scripts/control-plane/lib/premvp-application-migration-release.mjs";

const OLD = "supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql";
const NEW = "supabase/migrations/20261007100000_research_snapshot_runs_two_generation_freshness_v1.sql";

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

const FROM = "2026-10-08T00:00:00Z";
const TO = "2026-10-09T00:00:00Z";
const R = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function gsrs(run: number, snapAt: string, eventId: string, gameId: string, start: string, vol: number, family = "soccer") {
  const d = JSON.stringify({
    providerEventContext: { eventId, gameId }, parentEventVolume24hr: vol, providerSportFamily: family,
    providerSportCode: family, providerSportSource: "structured_sports_tag",
  });
  return `INSERT INTO public.generated_signal_research_snapshots VALUES ('${R(run)}','${snapAt}','${start}','${d}');`;
}
const mark = (run: number, completedAt: string, snapAt: string, rows = 3) =>
  `INSERT INTO public.research_snapshot_runs (snapshot_run_id, snapshot_at, completed_at, row_count) VALUES ('${R(run)}','${snapAt}','${completedAt}',${rows});`;
const rpc = () => psql(`SELECT provider_game_id, snapshot_run_id, event_start_iso, parent_event_volume_24h FROM public.research_precontract_t20_event_candidates('${FROM}','${TO}',800) ORDER BY provider_game_id`);
const reset = () => psql("TRUNCATE public.generated_signal_research_snapshots; TRUNCATE public.research_snapshot_runs;");

before(() => {
  if (!CAN_RUN) return;
  dir = mkdtempSync(path.join(tmpdir(), "r1-fresh-"));
  chmodSync(dir, 0o755);
  if (IS_ROOT) chownSync(dir, Number(pgUser!.stdout.trim()), 0);
  run("initdb", ["-D", path.join(dir, "data"), "-A", "trust", "-U", "postgres"]);
  run("pg_ctl", ["-D", path.join(dir, "data"), "-o", `-k ${dir} -c listen_addresses=''`, "-l", path.join(dir, "log"), "-w", "start"]);
  psql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.generated_signal_research_snapshots (snapshot_run_id uuid, snapshot_at timestamptz, game_start_iso timestamptz, diagnostics jsonb);
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT SELECT ON public.generated_signal_research_snapshots TO service_role;`);
  psqlFile(OLD);
  psqlFile(NEW);
});
after(() => {
  if (!CAN_RUN || !dir) return;
  spawnSync(IS_ROOT ? "runuser" : path.join(BIN as string, "pg_ctl"), IS_ROOT ? ["-u", "postgres", "--", path.join(BIN as string, "pg_ctl"), "-D", path.join(dir, "data"), "-m", "immediate", "stop"] : ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
  rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: CAN_RUN ? false : "PostgreSQL server binaries unavailable" };

test("migration passes the approved-release validator (additive, no forbidden SQL)", () => {
  const sql = readFileSync(NEW, "utf8");
  assert.deepEqual(validateApprovedMigrationRelease({
    declaration: { mode: "PREMVP_APPLICATION_SCHEMA_MIGRATION_V1", migration_files: [NEW], safety_class: "ADDITIVE_COMPATIBLE", direct_raw_mutation: false, rollback_strategy: "COMPATIBILITY_RETAINED" },
    changedFiles: [NEW], readFile: () => sql,
  }), { ok: true, errors: [] });
});

test("4: warm-up fails closed - 0 and 1 completed generations return zero candidates (no historical fallback)", opts, () => {
  reset();
  psql(gsrs(1, "2026-10-07T10:00:00Z", "11", "G1", "2026-10-08T16:30:00Z", 500));
  assert.equal(rpc(), "", "0 completed runs");
  psql(mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"));
  assert.equal(rpc(), "", "1 completed run");
});

test("5: source is limited to the two completed run ids (an unmarked run never contributes)", opts, () => {
  reset();
  psql([
    gsrs(1, "2026-10-07T10:00:00Z", "11", "G1", "2026-10-08T16:30:00Z", 500),
    gsrs(2, "2026-10-07T10:30:00Z", "12", "G2", "2026-10-08T17:00:00Z", 400),
    gsrs(3, "2026-10-07T11:00:00Z", "13", "G3", "2026-10-08T18:00:00Z", 900), // run 3 never completed
    mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"), mark(2, "2026-10-07T10:31:00Z", "2026-10-07T10:30:00Z"),
  ].join("\n"));
  const rows = rpc().split("\n");
  assert.deepEqual(rows.map((r) => r.split("|")[0]), ["G1", "G2"]);
  assert.deepEqual(new Set(rows.map((r) => r.split("|")[1])), new Set([R(1), R(2)]));
});

test("6: bounded carry-forward - event only in the older of the two completed runs stays eligible", opts, () => {
  reset();
  psql([
    gsrs(1, "2026-10-07T10:00:00Z", "11", "G1", "2026-10-08T16:30:00Z", 500),
    gsrs(2, "2026-10-07T10:30:00Z", "12", "G2", "2026-10-08T17:00:00Z", 400),
    mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"), mark(2, "2026-10-07T10:31:00Z", "2026-10-07T10:30:00Z"),
  ].join("\n"));
  assert.match(rpc(), /^G1\|/m);
});

test("7: third-most-recent completed generation is excluded", opts, () => {
  reset();
  psql([
    gsrs(1, "2026-10-07T10:00:00Z", "11", "G1", "2026-10-08T16:30:00Z", 500), // only in the oldest run
    gsrs(2, "2026-10-07T10:30:00Z", "12", "G2", "2026-10-08T17:00:00Z", 400),
    gsrs(3, "2026-10-07T11:00:00Z", "13", "G3", "2026-10-08T18:00:00Z", 300),
    mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"), mark(2, "2026-10-07T10:31:00Z", "2026-10-07T10:30:00Z"), mark(3, "2026-10-07T11:01:00Z", "2026-10-07T11:00:00Z"),
  ].join("\n"));
  assert.deepEqual(rpc().split("\n").map((r) => r.split("|")[0]), ["G2", "G3"]);
});

test("8: same physical event in both current generations - newest snapshot_at owns start and volume (stale 16:30 loses to 16:50)", opts, () => {
  reset();
  psql([
    gsrs(1, "2026-10-07T10:00:00Z", "11", "G1", "2026-10-08T16:30:00Z", 500),
    gsrs(2, "2026-10-07T10:30:00Z", "11", "G1", "2026-10-08T16:50:00Z", 650),
    mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"), mark(2, "2026-10-07T10:31:00Z", "2026-10-07T10:30:00Z"),
  ].join("\n"));
  const rows = rpc().split("\n");
  assert.equal(rows.length, 1);
  const [, run, start, vol] = rows[0].split("|");
  assert.equal(run, R(2));
  assert.equal(Date.parse(start.replace(" ", "T").replace(/\+00$/, "Z")), Date.parse("2026-10-08T16:50:00Z"));
  assert.equal(Number(vol), 650);
});

test("RPC contract: signature, return columns, ceiling sentinel and grants preserved; table is insert-only for service_role", opts, () => {
  reset();
  assert.equal(psql("SELECT pg_get_function_arguments('public.research_precontract_t20_event_candidates'::regproc)"),
    "p_from timestamp with time zone, p_to timestamp with time zone, p_ceiling integer DEFAULT 800");
  assert.equal(psql("SELECT count(*) FROM pg_proc p, unnest(p.proargnames) n WHERE p.proname='research_precontract_t20_event_candidates'"), "17");
  const rows = Array.from({ length: 5 }, (_, i) => gsrs(1, "2026-10-07T10:00:00Z", `${20 + i}`, `X${i}`, "2026-10-08T16:30:00Z", 100 + i));
  psql([...rows, mark(1, "2026-10-07T10:01:00Z", "2026-10-07T10:00:00Z"), mark(2, "2026-10-07T10:31:00Z", "2026-10-07T10:30:00Z", 0)].join("\n"));
  assert.equal(psql("SELECT count(*) FROM public.research_precontract_t20_event_candidates('2026-10-08T00:00:00Z','2026-10-09T00:00:00Z',3)"), "4", "p_ceiling + 1 sentinel");
  assert.equal(psql("SELECT has_table_privilege('service_role','public.research_snapshot_runs','SELECT'), has_table_privilege('service_role','public.research_snapshot_runs','INSERT'), has_table_privilege('service_role','public.research_snapshot_runs','DELETE'), has_table_privilege('service_role','public.research_snapshot_runs','UPDATE'), has_table_privilege('anon','public.research_snapshot_runs','SELECT'), has_table_privilege('authenticated','public.research_snapshot_runs','INSERT')"), "t|t|f|f|f|f");
  assert.equal(psql("SELECT relrowsecurity FROM pg_class WHERE relname='research_snapshot_runs'"), "t");
});
