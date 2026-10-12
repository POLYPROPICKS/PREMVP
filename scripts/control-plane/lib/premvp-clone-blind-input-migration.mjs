import { sha256OfText } from './premvp-target-only-migration.mjs';
import { assertNoTransactionControl, lexSql, runHttpsTargetOnly } from './premvp-migration-https-transport.mjs';
import { SHADOW_CLONE_LEDGER_BASELINE, SHADOW_MIGRATION_FILE } from './premvp-clone-shadow-migration.mjs';

export const BLIND_MIGRATION_MODE = 'PREMVP_CLONE_BLIND_MODEL_INPUT_V1';
export const BLIND_CLONE_REF = 'nppznoujvnyjargjkmnv';
export const BLIND_MIGRATION_FILE = 'ops/research-clone/migrations/20261012160000_blind_model_input_authority.sql';
// Reviewed-delta pin. Changing one byte of the SQL requires changing this constant in a reviewed commit; a declaration
// hash alone can never authorize a different file. This mode is NOT a general executor and shares no allow-list with
// `clone-schema` (which cannot create roles/views/ACLs) or `clone-shadow` (which stays pinned to its own SQL).
export const BLIND_MIGRATION_SHA256 = 'dd8b9b4812bcf690db6ca293d358f7f5d8a6efbf862e48a547431f7793ab2978';

const BLIND_VIEWS = Object.freeze({
  prematch_observations_v1: 'reservation_market_observations',
  t20_observations_v1: 'research_precontract_t20_observations',
  inplay_observations_v1: 'research_inplay_core_path_observations',
});
const VIEW_NAMES = Object.keys(BLIND_VIEWS).join('|');
const RAW_TABLES = Object.values(BLIND_VIEWS).join('|');

// Ledger accepted by this mode: the reviewed baseline, with or without the (separately released) shadow migration.
const SHADOW_VERSION = SHADOW_MIGRATION_FILE.split('/').at(-1).split('_')[0];
const ACCEPTED_LEDGERS = Object.freeze([
  SHADOW_CLONE_LEDGER_BASELINE,
  Object.freeze([...SHADOW_CLONE_LEDGER_BASELINE, SHADOW_VERSION]),
]);

// The ONLY top-level statements the file may contain (judged on lexed code: comments gone, strings/DO bodies blanked).
const STATEMENT_ALLOWLIST = Object.freeze([
  /^do \$\$$/,
  /^alter role blind_model_reader set (?:default_transaction_read_only = on|statement_timeout = ''|search_path = blind_obs, pg_catalog)$/,
  /^create schema if not exists blind_obs$/,
  /^revoke all on schema blind_obs from public, anon, authenticated, service_role$/,
  /^create table if not exists blind_obs\.model_horizon \([a-z_ ,()0-9]+\)$/,
  new RegExp(`^revoke all on blind_obs\\.(?:model_horizon|${VIEW_NAMES}) from public, anon, authenticated, service_role$`),
  new RegExp(`^create or replace view blind_obs\\.(${VIEW_NAMES}) with \\(security_barrier = true\\) as select [a-z0-9_., ]+ from public\\.(${RAW_TABLES}) o join blind_obs\\.model_horizon h on h\\.singleton where o\\.observed_at <= h\\.as_of(?: and o\\.observed_at < o\\.event_start_iso)?$`),
  /^grant usage on schema blind_obs to (?:blind_model_reader|blind_horizon_writer)$/,
  new RegExp(`^grant select on blind_obs\\.(?:${VIEW_NAMES}) to blind_model_reader$`),
  /^grant select, insert, update on blind_obs\.model_horizon to blind_horizon_writer$/,
  /^revoke execute on function public\.record_football_execution_matrix_s1s2s3_evidence\(jsonb\) from public$/,
]);

// Defence in depth inside DO bodies (their statements are invisible to the top-level allow-list).
const DO_BODY_FORBIDDEN = /\b(?:drop|delete|truncate|insert|update|copy|alter|grant|revoke|set_config|security_invoker|bypassrls|login|password)\b/i;
const ROLE_CREATE_CLAUSE = "create role %I nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls";

export function assertBlindSqlShape(sql) {
  const errors = [];
  const text = String(sql).replace(/\r\n/g, '\n');
  let lexed;
  try { lexed = lexSql(text); } catch (error) { return [`BLIND_SQL_LEX_FAILED:${error?.code ?? 'error'}`]; }
  let doCount = 0;
  const viewPairs = [];
  for (const statement of lexed.statements) {
    const lower = statement.toLowerCase();
    const matched = STATEMENT_ALLOWLIST.findIndex((re) => re.test(lower));
    if (matched < 0) { errors.push(`BLIND_SQL_STATEMENT_NOT_ALLOWED:${lower.slice(0, 60)}`); continue; }
    if (lower === 'do $$') doCount += 1;
    const view = /^create or replace view blind_obs\.([a-z0-9_]+) .* from public\.([a-z0-9_]+) o /.exec(lower);
    if (view) {
      viewPairs.push(view[1]);
      if (BLIND_VIEWS[view[1]] !== view[2]) errors.push(`BLIND_VIEW_SOURCE_MISMATCH:${view[1]}`);
      if (lower.includes('*') || lower.includes('security_invoker')) errors.push(`BLIND_VIEW_WILDCARD_OR_INVOKER:${view[1]}`);
    }
  }
  if (doCount !== 5) errors.push(`BLIND_SQL_DO_BLOCK_COUNT:${doCount}`);
  if (viewPairs.length !== 3 || new Set(viewPairs).size !== 3) errors.push('BLIND_SQL_VIEW_SET_INVALID');
  if (/set_config/i.test(text)) errors.push('BLIND_SQL_GUC_FUNCTION_FORBIDDEN');
  if (!text.includes(ROLE_CREATE_CLAUSE)) errors.push('BLIND_SQL_ROLE_ATTRIBUTES_NOT_EXACT');
  for (const [, body] of text.matchAll(/\bdo \$\$([\s\S]*?)\$\$;/gi)) {
    let code;
    try { code = lexSql(body).code; } catch { errors.push('BLIND_SQL_DO_BODY_LEX_FAILED'); continue; }
    const hit = DO_BODY_FORBIDDEN.exec(code);
    if (hit) errors.push(`BLIND_SQL_DO_BODY_TOKEN_FORBIDDEN:${hit[0].toLowerCase()}`);
  }
  return errors;
}

export function validateBlindInputMigration(declaration, sql) {
  const errors = [];
  if (declaration?.mode !== BLIND_MIGRATION_MODE) errors.push('BLIND_MODE_INVALID');
  if (declaration?.project_ref !== BLIND_CLONE_REF) errors.push('BLIND_PROJECT_REF_INVALID');
  if (declaration?.migration_file !== BLIND_MIGRATION_FILE) errors.push('BLIND_FILE_INVALID');
  if (declaration?.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  if (declaration?.idempotent !== true) errors.push('BLIND_IDEMPOTENCY_DECLARATION_REQUIRED');
  const actual = sha256OfText(String(sql));
  if (!/^[0-9a-f]{64}$/.test(declaration?.target_sha256 ?? '') || declaration.target_sha256 !== actual) errors.push('BLIND_SHA256_MISMATCH');
  if (actual !== BLIND_MIGRATION_SHA256) errors.push('BLIND_SQL_NOT_EXACT_REVIEWED_DELTA');
  try { assertNoTransactionControl(sql); } catch { errors.push('BLIND_TRANSACTION_CONTROL_FORBIDDEN'); }
  errors.push(...assertBlindSqlShape(sql));
  return { ok: errors.length === 0, errors };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const verifyColumns = Object.keys(BLIND_VIEWS).map((table) => ({ schema: 'blind_obs', table, columns: ['id', 'observed_at', 'condition_id', 'token_id'] }));

// Expected read-back of the fixed catalog query (transport.readBlindInputCatalog). Any other value = NOT PROVEN.
export const BLIND_CATALOG_EXPECTED = Object.freeze({
  roles_present_n: 4, roles_unsafe_n: 0, role_membership_n: 0, relation_exposure_n: 0, sequence_exposure_n: 0,
  definer_function_exposure_n: 0, schema_create_exposure_n: 0, views_ok_n: 3, reader_view_select_n: 3,
  reader_forbidden_named_n: 0, view_json_or_outcome_columns_n: 0, blind_schema_relations_n: 4, blind_public_or_api_grants_n: 0,
});

export function evaluateBlindCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return ['BLIND_CATALOG_MISSING'];
  return Object.entries(BLIND_CATALOG_EXPECTED).filter(([key, want]) => Number(catalog[key]) !== want).map(([key]) => `BLIND_CATALOG_${key.toUpperCase()}`);
}

export async function runBlindInputMigration({ transport, declaration, sql, apply = false }) {
  const validation = validateBlindInputMigration(declaration, sql);
  if (!validation.ok) throw new Error(validation.errors.join(';'));
  if (transport.projectRef !== BLIND_CLONE_REF) throw new Error('BLIND_TRANSPORT_PROJECT_MISMATCH');
  const evidence = await runHttpsTargetOnly({
    transport,
    targetBasename: BLIND_MIGRATION_FILE.split('/').at(-1),
    targetSql: sql,
    targetSha256: declaration.target_sha256,
    resolveTracked: (versions) => ({ missing: ACCEPTED_LEDGERS.some((ledger) => sameList(versions, ledger)) ? [] : ['BLIND_CLONE_LEDGER_DRIFT'] }),
    nativeLocalTimeouts: true,
    verify: verifyColumns,
    apply,
  });
  if (!apply) return { ...evidence, runtime_privilege_proof: 'RUNTIME_UNVERIFIED' };
  const catalog = await transport.readBlindInputCatalog();
  const failures = evaluateBlindCatalog(catalog);
  if (failures.length) throw new Error(`BLIND_INPUT_CATALOG_NOT_PROVEN:${failures.join(',')}`);
  return { ...evidence, blind_input_catalog: catalog, runtime_privilege_proof: 'CATALOG_PROVEN_LOGIN_PROBE_PENDING' };
}
