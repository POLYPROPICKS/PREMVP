/**
 * premvp-migration-https-transport.mjs
 *
 * HTTPS fallback transport for the EXISTING registered PREMVP approved-migration adapter
 * (scripts/control-plane/apply-premvp-approved-migration.mjs). It is NOT an alternate migration
 * authority: the adapter still owns declaration validation, the project allowlist, the SHA-256 pin,
 * target-only semantics, the explicit --apply --confirm gates and secret redaction. This module only
 * replaces the Supabase CLI / direct-Postgres TRANSPORT when that transport is proven unavailable
 * (no IPv6 / no raw TCP egress), using the official Supabase Management API over HTTPS:
 *
 *   GET  /v1/projects/{ref}/database/migrations            applied migration history   (database_migrations_read)
 *   POST /v1/projects/{ref}/database/migrations            apply a migration natively  (database_migrations_write)
 *   POST /v1/projects/{ref}/database/query/read-only       schema / ledger verification
 *   POST /v1/projects/{ref}/database/query                 transactional dry-run (and clone-schema apply)
 *
 * Hard properties:
 *  - There is NO generic "run SQL" export. Every request body is built here from either a fixed template,
 *    values validated against a strict grammar (14-digit version, [a-z0-9_] name, SQL identifiers), or the
 *    exact reviewed SQL file text the adapter already SHA-256-pinned. Declaration text is never interpolated.
 *  - The dry-run's ROLLBACK is only trustworthy if the SQL cannot end the transaction itself, so the SQL is
 *    run through a faithful single-pass PostgreSQL lexer (nested comments, E'' strings, dollar quotes, quoted
 *    identifiers) and refused on any transaction-control statement. This guard does not rely on the SHA pin.
 *  - HTTPS only, fixed origin; the access token travels only in the Authorization header and is redacted from
 *    every message this module produces.
 *  - Dry-run is real: it first PROVES the endpoint preserves explicit-transaction semantics on ONE session (a
 *    temp table must be visible inside the transaction and gone after ROLLBACK), then runs
 *    BEGIN; SET LOCAL timeouts; <exact SQL>; ROLLBACK; and verifies the schema fingerprint (columns, defaults,
 *    comments, indexes, constraints, functions, triggers, policies, RLS, ACLs, enums, extensions) and the
 *    migration history are unchanged. Not proven => HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN and the target SQL
 *    is never sent.
 *  - Apply uses the NATIVE migrations endpoint (which owns history recording) and then verifies BOTH that the
 *    ledger contains the EXACT target version AND that the declared columns exist. Only if the endpoint recorded
 *    exactly one new entry under a different version (the server stamps its own timestamp) and returned no error
 *    is that single entry re-versioned, fail-closed, so the ledger matches the repository file.
 *
 * Manual recovery (state is always reported in the failure detail): if apply fails after the DDL ran
 * (HTTPS_APPLY_LEDGER_UNEXPECTED / TARGET_ONLY_APPLY_NOT_RECORDED), re-run the dry-run; the migrations are
 * additive/idempotent, so the DDL is not re-applied destructively, and the ledger entry is reconciled through the
 * same adapter, never by hand.
 */
import { sha256OfText } from './premvp-target-only-migration.mjs';

export const MANAGEMENT_API_ORIGIN = 'https://api.supabase.com';
export const HTTPS_TRANSPORT_ID = 'SUPABASE_MANAGEMENT_API_HTTPS_V1';

/** Research-clone project refs — the only allowlisted clone-schema targets. */
export const PREMVP_RESEARCH_CLONE_PROJECT_REFS = Object.freeze(['nppznoujvnyjargjkmnv']);
export const CLONE_SCHEMA_MODE = 'PREMVP_RESEARCH_CLONE_SCHEMA_V1';
const CLONE_SCHEMA_FILE = /^ops\/research-clone\/[a-z0-9-]+-schema\.sql$/;

const PROJECT_REF = /^[a-z0-9]{20}$/;
const MIGRATION_BASENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const VERSION = /^\d{14}$/;
const NAME = /^[a-z0-9_]{1,120}$/;

export class HttpsTransportError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'HttpsTransportError';
    this.code = code;
    this.detail = detail;
  }
}

// ── fallback eligibility ─────────────────────────────────────────────────────

/** Causes that mean the direct DB TRANSPORT is unavailable. An ALLOW-LIST: nothing else may route around the CLI path. */
const DIRECT_TRANSPORT_CAUSES = [
  /hostname resolving error/i, /no such host/i, /network is unreachable/i, /address family not supported/i,
  /connection refused/i, /i\/o timeout/i, /dial tcp/i, /\bENETUNREACH\b/, /\bEAI_AGAIN\b/, /\bECONNREFUSED\b/, /\bETIMEDOUT\b/,
];
/** Identity / authorization / policy-class failures: real gate failures, never a transport gap (checked FIRST). */
const DIRECT_GATE_FAILURES = [
  /password authentication failed/i, /\bSASL\b/, /authentication (?:failed|errors?)/i, /tenant or user not found/i, /pg_hba/i,
  /circuit breaker/i, /role ".*" does not exist/i, /database ".*" does not exist/i, /\b(?:ssl|tls)\b/i, /certificate/i,
  /invalid (?:api |access )?token/i, /unauthorized/i, /forbidden/i, /permission denied/i,
];

/**
 * True ONLY when the existing CLI/direct-Postgres path failed because the direct DB TRANSPORT is unavailable
 * (DNS / no route / refused / timeout). Identity, authorization or policy failures never qualify.
 */
export function isDirectTransportUnavailable(failure) {
  const text = [failure?.stdout, failure?.stderr, failure?.message, typeof failure === 'string' ? failure : '']
    .filter(Boolean).join('\n');
  if (!text) return false;
  if (DIRECT_GATE_FAILURES.some((m) => m.test(text))) return false;
  return /DbConnectError|failed to connect to postgres/i.test(text) && DIRECT_TRANSPORT_CAUSES.some((m) => m.test(text));
}

// ── declaration / precondition gates (pure) ──────────────────────────────────

/**
 * Preconditions for ANY HTTPS operation. The adapter has already validated the declaration; these re-check the
 * facts this transport depends on so it can never be driven with a mismatched project, hash or missing token.
 */
export function assertHttpsPreconditions({ token, projectRef, allowlist, declaredProjectRef, expectedSha256, actualSha256 }) {
  if (typeof token !== 'string' || token.trim().length < 8) throw new HttpsTransportError('HTTPS_ACCESS_TOKEN_MISSING');
  if (typeof projectRef !== 'string' || !PROJECT_REF.test(projectRef)) throw new HttpsTransportError('HTTPS_PROJECT_REF_INVALID');
  if (!Array.isArray(allowlist) || !allowlist.includes(projectRef)) throw new HttpsTransportError('HTTPS_PROJECT_REF_NOT_ALLOWLISTED');
  if (declaredProjectRef !== projectRef) throw new HttpsTransportError('HTTPS_PROJECT_REF_MISMATCH');
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256) || expectedSha256 !== actualSha256) {
    throw new HttpsTransportError('HTTPS_TARGET_SHA256_MISMATCH');
  }
  return true;
}

/** Same two explicit gates as the CLI path: --apply --confirm AND PREMVP_TARGET_ONLY_APPLY_CONFIRM=1. */
export function assertApplyConfirmation(args, env) {
  if (!args.includes('--apply')) return false;
  if (!args.includes('--confirm') || env?.PREMVP_TARGET_ONLY_APPLY_CONFIRM !== '1') {
    throw new HttpsTransportError('TARGET_ONLY_APPLY_CONFIRMATION_REQUIRED', 'pass --confirm and set PREMVP_TARGET_ONLY_APPLY_CONFIRM=1');
  }
  return true;
}

export function parseTargetBasename(targetBasename) {
  const m = MIGRATION_BASENAME.exec(String(targetBasename));
  if (!m) throw new HttpsTransportError('HTTPS_TARGET_BASENAME_INVALID');
  return { version: m[1], name: m[2] };
}

/** Declaration for the research-clone schema lifecycle (no ledger; exact idempotent ops file, allowlisted clone ref). */
export function validateCloneSchemaDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== 'object') return { ok: false, errors: ['DECLARATION_NOT_OBJECT'] };
  if (declaration.mode !== CLONE_SCHEMA_MODE) errors.push('CLONE_SCHEMA_MODE_INVALID');
  if (typeof declaration.schema_file !== 'string' || !CLONE_SCHEMA_FILE.test(declaration.schema_file)) errors.push('CLONE_SCHEMA_FILE_INVALID');
  if (typeof declaration.target_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(declaration.target_sha256)) errors.push('TARGET_SHA256_REQUIRED');
  if (!PREMVP_RESEARCH_CLONE_PROJECT_REFS.includes(declaration.project_ref)) errors.push('PROJECT_REF_NOT_ALLOWLISTED');
  if (declaration.idempotent !== true) errors.push('CLONE_SCHEMA_IDEMPOTENT_REQUIRED');
  if (declaration.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  errors.push(...validateVerifyColumns(declaration.verify_columns, true));
  return { ok: errors.length === 0, errors };
}

/** Post-apply column proof request: [{schema, table, columns:[...]}], identifiers only. */
export function validateVerifyColumns(verify, required = false) {
  if (verify === undefined || verify === null) return required ? ['VERIFY_COLUMNS_REQUIRED'] : [];
  if (!Array.isArray(verify) || verify.length === 0 || verify.length > 8) return ['VERIFY_COLUMNS_INVALID'];
  const errors = [];
  for (const entry of verify) {
    const ok = entry && typeof entry === 'object' && IDENTIFIER.test(entry.schema ?? '') && IDENTIFIER.test(entry.table ?? '') &&
      Array.isArray(entry.columns) && entry.columns.length > 0 && entry.columns.length <= 64 && entry.columns.every((c) => IDENTIFIER.test(c));
    if (!ok) errors.push('VERIFY_COLUMNS_IDENTIFIER_INVALID');
  }
  return errors;
}

/** Strict ledger -> local-file resolver (exact `<version>.sql` or `<version>_*.sql`; no loose prefix matching). */
export function resolveTrackedStrict(versions, fileNames) {
  const missing = versions.filter((v) => !fileNames.some((f) => f === `${v}.sql` || f.startsWith(`${v}_`)));
  return { resolved: versions.filter((v) => !missing.includes(v)), missing };
}

// ── faithful PostgreSQL lexer + SQL guards (pure) ────────────────────────────

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z\u0080-￿_][A-Za-z0-9\u0080-￿_]*)?\$/;

/**
 * Single-pass PostgreSQL lexer. Returns the residual CODE with comments removed and every string / quoted
 * identifier / dollar-quoted body replaced by a placeholder, so statement starts can be inspected honestly.
 * Models: `--` line comments, NESTED block comments, '' strings (standard_conforming_strings=on, the server
 * default; `SET` is refused so a file cannot change it), E'' strings with backslash escapes, "" identifiers,
 * `$tag$ ... $tag$` quotes (only where a `$` cannot be part of an identifier). Anything unterminated is a lex
 * error and fails closed — nothing would execute on the server either.
 */
export function lexSql(sql) {
  const s = String(sql);
  if (s.includes('\0')) throw new HttpsTransportError('HTTPS_SQL_LEX_UNTERMINATED', 'nul byte');
  const n = s.length;
  let i = 0;
  let code = '';
  const unterminated = (what) => { throw new HttpsTransportError('HTTPS_SQL_LEX_UNTERMINATED', what); };
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && s[i] !== '\n') i += 1;
      code += ' ';
    } else if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth += 1; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
      if (depth > 0) unterminated('block comment');
      code += ' ';
    } else if (c === "'") {
      const prev = s[i - 1];
      const escapes = (prev === 'E' || prev === 'e') && !(i >= 2 && IDENT_CHAR.test(s[i - 2]));
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (escapes && s[j] === '\\') j += 2;
        else if (s[j] === "'") {
          if (s[j + 1] === "'") j += 2;
          else { closed = true; j += 1; break; }
        } else j += 1;
      }
      if (!closed) unterminated('string');
      i = j;
      code += "''";
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') j += 2;
          else { closed = true; j += 1; break; }
        } else j += 1;
      }
      if (!closed) unterminated('quoted identifier');
      i = j;
      code += '""';
    } else if (c === '$' && (i === 0 || !IDENT_CHAR.test(s[i - 1])) && DOLLAR_TAG.test(s.slice(i, i + 80))) {
      const tag = DOLLAR_TAG.exec(s.slice(i, i + 80))[0];
      const end = s.indexOf(tag, i + tag.length);
      if (end === -1) unterminated('dollar-quoted body');
      i = end + tag.length;
      code += '$$';
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, statements: code.split(';').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean) };
}

// Whole-word statement starts only (COMMENT is not COMMIT); SET is allowed only as SET LOCAL (transaction-scoped).
const TRANSACTION_CONTROL = /^(?:(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|reset)\b|set\s+(?!local\b)|\\)/i;

/**
 * The dry-run's ROLLBACK (and the apply's COMMIT) only mean something if the SQL cannot end/replace the
 * transaction itself. Fail closed on any transaction-control statement, judged on the LEXED code.
 */
export function assertNoTransactionControl(sql) {
  for (const statement of lexSql(sql).statements) {
    if (TRANSACTION_CONTROL.test(statement)) throw new HttpsTransportError('HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN');
  }
  return true;
}

const splitTopLevelCommas = (text) => {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; } else current += ch;
  }
  out.push(current.trim());
  return out;
};

/**
 * Clone schema SQL is an ALLOW-LIST of idempotent structural statements only. Anything else (DML, DROP, UPDATE,
 * INSERT, COPY, MERGE, functions, policies, GRANT to anything but service_role, ...) is refused, so "no row
 * mutation" and "idempotent" are structural properties of the accepted file, not declared ones.
 */
export function assertCloneSqlSafe(sql) {
  assertNoTransactionControl(sql);
  const kinds = {};
  const statements = lexSql(sql).statements.map((st) => st.toLowerCase());
  for (const st of statements) {
    let kind = null;
    if (/^create table if not exists [a-z0-9_."]+ \(/.test(st)) kind = 'create_table_if_not_exists';
    else if (/^create (?:unique )?index if not exists [a-z0-9_."]+ on [a-z0-9_."]+ /.test(st)) kind = 'create_index_if_not_exists';
    else if (/^alter table [a-z0-9_."]+ enable row level security$/.test(st)) kind = 'enable_row_level_security';
    else if (/^alter table [a-z0-9_."]+ add column if not exists /.test(st)) {
      const clauses = splitTopLevelCommas(st.replace(/^alter table [a-z0-9_."]+ /, ''));
      if (clauses.every((c) => c.startsWith('add column if not exists ') && !/\b(drop|rename|using|generated)\b/.test(c))) kind = 'add_column_if_not_exists';
    } else if (/^revoke [a-z, ]+ on [a-z0-9_."]+ from [a-z_, ]+$/.test(st)) kind = 'revoke';
    else if (/^grant [a-z, ]+ on [a-z0-9_."]+ to service_role$/.test(st)) kind = 'grant_to_service_role';
    if (!kind) throw new HttpsTransportError('CLONE_SQL_STATEMENT_NOT_ALLOWED', st.slice(0, 60));
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  if (statements.length === 0) throw new HttpsTransportError('CLONE_SQL_EMPTY');
  return { statements_n: statements.length, statement_kinds: kinds };
}

// ── fixed SQL templates ──────────────────────────────────────────────────────

export const SQL_LEDGER_VERSIONS = 'select version from supabase_migrations.schema_migrations order by version';

/**
 * Transaction-semantics probe. A TEMP table can leave no persistent object whatever the endpoint does. The DO
 * block is the positive control: the table MUST be visible after CREATE and before ROLLBACK, which proves BEGIN,
 * CREATE and the check ran on ONE session; a request that is split across connections raises and fails closed.
 * Only then does `rolled_back` (gone after ROLLBACK) prove explicit-transaction semantics are honoured.
 */
export const SQL_TRANSACTION_PROBE =
  "BEGIN; CREATE TEMPORARY TABLE premvp_txn_probe(x int); " +
  "DO $premvp$ BEGIN IF to_regclass('pg_temp.premvp_txn_probe') IS NULL THEN RAISE EXCEPTION 'PREMVP_PROBE_SESSION_SPLIT'; END IF; END $premvp$; " +
  "ROLLBACK; SELECT to_regclass('pg_temp.premvp_txn_probe') IS NULL AS rolled_back;";

/** md5 over everything a migration can persist in the user schemas; changes iff DDL persisted. */
export const SQL_SCHEMA_FINGERPRINT = `
select md5(coalesce(string_agg(x, '|' order by x), '')) as fingerprint, count(*)::int as n from (
  select format('rel:%s.%s:%s:%s:%s:%s:%s', n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, ''), coalesce(obj_description(c.oid, 'pg_class'), '')) as x
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','v','m','p','f','S') and n.nspname not in ('pg_catalog','information_schema','realtime') and n.nspname not like 'pg_toast%'
  union all
  select format('col:%s.%s.%s:%s:%s:%s:%s', n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), ''), coalesce(col_description(c.oid, a.attnum), ''))
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','p','f','S') and n.nspname not in ('pg_catalog','information_schema','realtime') and n.nspname not like 'pg_toast%'
  union all
  select format('idx:%s.%s:%s', schemaname, indexname, indexdef) from pg_indexes where schemaname not in ('pg_catalog','information_schema','realtime')
  union all
  select format('con:%s:%s:%s:%s', conrelid::regclass::text, conname, contype, pg_get_constraintdef(oid)) from pg_constraint where conrelid <> 0 and connamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
  union all
  select format('fn:%s.%s(%s):%s:%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc), coalesce(p.proacl::text, ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog','information_schema')
  union all
  select format('trg:%s:%s', tgrelid::regclass::text, pg_get_triggerdef(oid)) from pg_trigger where not tgisinternal
  union all
  select format('pol:%s:%s:%s:%s:%s', polrelid::regclass::text, polname, polcmd, coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '')) from pg_policy
  union all
  select format('enum:%s:%s:%s', t.typname, e.enumsortorder, e.enumlabel) from pg_enum e join pg_type t on t.oid = e.enumtypid
  union all
  select format('ext:%s:%s', extname, extversion) from pg_extension
) t`.trim();

export function sqlColumnsProof(schema, table, columns) {
  const errors = validateVerifyColumns([{ schema, table, columns }]);
  if (errors.length) throw new HttpsTransportError('HTTPS_VERIFY_COLUMNS_INVALID');
  return `select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type, (not a.attnotnull) as is_nullable
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${schema}' and c.relname = '${table}' and a.attnum > 0 and not a.attisdropped
  and a.attname in (${columns.map((c) => `'${c}'`).join(', ')}) order by a.attname`;
}

export function sqlRepairLedgerVersion(from, to, name) {
  if (!VERSION.test(from) || !VERSION.test(to) || !NAME.test(name)) throw new HttpsTransportError('HTTPS_LEDGER_REPAIR_ARGS_INVALID');
  return `update supabase_migrations.schema_migrations set version = '${to}' where version = '${from}' and name = '${name}'`;
}

export const DRY_RUN_MARKER = 'PREMVP_DRYRUN_COMPLETE';
export const CLONE_APPLY_MARKER = 'PREMVP_CLONE_APPLY_COMPLETE';
/** Transaction-scoped guards: a DDL that cannot get its lock fails fast instead of queueing behind live traffic. */
const SQL_LOCAL_TIMEOUTS = "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';";

const withTrailingNewline = (sql) => (String(sql).endsWith('\n') ? String(sql) : `${sql}\n`);
export const sqlDryRun = (sql) => `BEGIN;\n${SQL_LOCAL_TIMEOUTS}\n${withTrailingNewline(sql)}ROLLBACK;\nSELECT '${DRY_RUN_MARKER}' AS premvp_marker;`;
export const sqlCloneApply = (sql) => `BEGIN;\n${SQL_LOCAL_TIMEOUTS}\n${withTrailingNewline(sql)}COMMIT;\nSELECT '${CLONE_APPLY_MARKER}' AS premvp_marker;`;

// ── response parsing (fail closed on an unknown shape) ───────────────────────

const shapeOf = (value) => {
  if (Array.isArray(value)) return `array(len=${value.length}${value[0] && typeof value[0] === 'object' ? `;keys=${Object.keys(value[0]).join(',')}` : ''})`;
  if (value && typeof value === 'object') return `object(keys=${Object.keys(value).join(',')})`;
  return typeof value;
};

export function rowsOf(json) {
  const candidate = Array.isArray(json) ? json : Array.isArray(json?.result) ? json.result : Array.isArray(json?.rows) ? json.rows : null;
  if (!candidate) throw new HttpsTransportError('HTTPS_RESPONSE_SHAPE_UNKNOWN', shapeOf(json));
  return candidate.flatMap((r) => (Array.isArray(r) ? r : [r]));
}

export function parseMigrationHistory(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.migrations) ? json.migrations : Array.isArray(json?.data) ? json.data : null;
  if (!list) throw new HttpsTransportError('HTTPS_MIGRATION_HISTORY_SHAPE_UNKNOWN', shapeOf(json));
  const versions = list.map((entry) => (typeof entry === 'string' || typeof entry === 'number' ? String(entry) : entry?.version === undefined ? null : String(entry.version)));
  if (versions.some((v) => v === null || !/^\d+$/.test(v))) throw new HttpsTransportError('HTTPS_MIGRATION_HISTORY_SHAPE_UNKNOWN', shapeOf(json));
  return [...new Set(versions)].sort();
}

const hasMarker = (json, marker) => {
  try { return rowsOf(json).some((r) => r && typeof r === 'object' && r.premvp_marker === marker); } catch { return false; }
};

// ── transport ────────────────────────────────────────────────────────────────

/**
 * @param {{token:string, projectRef:string, allowlist:readonly string[], fetchImpl?:typeof fetch, timeoutMs?:number,
 *          redact?:(text:string, secrets:string[])=>string}} options
 * `redact` is the adapter's own sanitizeDiagnosticText, injected so there is exactly one redaction authority.
 */
export function createHttpsMigrationTransport({ token, projectRef, allowlist, fetchImpl = globalThis.fetch, timeoutMs = 60_000, redact = (t) => String(t) }) {
  if (typeof token !== 'string' || token.trim().length < 8) throw new HttpsTransportError('HTTPS_ACCESS_TOKEN_MISSING');
  if (!PROJECT_REF.test(projectRef ?? '')) throw new HttpsTransportError('HTTPS_PROJECT_REF_INVALID');
  if (!allowlist.includes(projectRef)) throw new HttpsTransportError('HTTPS_PROJECT_REF_NOT_ALLOWLISTED');
  if (typeof fetchImpl !== 'function') throw new HttpsTransportError('HTTPS_FETCH_UNAVAILABLE');
  const base = `${MANAGEMENT_API_ORIGIN}/v1/projects/${projectRef}/database`;
  const clean = (text) => String(redact(String(text ?? ''), [token]) ?? '').replaceAll(token, '***REDACTED***').slice(0, 400);

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HttpsTransportError('HTTPS_REQUEST_FAILED', clean(error?.name === 'TimeoutError' ? 'timeout' : error?.message));
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new HttpsTransportError(`HTTPS_API_STATUS_${res.status}`, clean(text));
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new HttpsTransportError('HTTPS_RESPONSE_NOT_JSON', clean(text)); }
  }

  const readOnly = (query) => request('POST', '/query/read-only', { query, parameters: [] });
  const writable = (query) => request('POST', '/query', { query, parameters: [], read_only: false });

  return {
    projectRef,

    /** Applied-migration versions from the NATIVE history endpoint, cross-checked against the ledger table itself. */
    async readLedger() {
      const native = parseMigrationHistory(await request('GET', '/migrations'));
      const viaSql = [...new Set(rowsOf(await readOnly(SQL_LEDGER_VERSIONS)).map((r) => String(r?.version)))].sort();
      if (native.length !== viaSql.length || native.some((v, i) => v !== viaSql[i])) {
        throw new HttpsTransportError('HTTPS_LEDGER_SOURCES_DISAGREE', `native=${native.length} table=${viaSql.length}`);
      }
      return native;
    },

    async readSchemaFingerprint() {
      const row = rowsOf(await readOnly(SQL_SCHEMA_FINGERPRINT))[0];
      if (!row || typeof row.fingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(row.fingerprint)) throw new HttpsTransportError('HTTPS_FINGERPRINT_UNPARSEABLE');
      return { fingerprint: row.fingerprint, n: Number(row.n) };
    },

    /** Proves BEGIN..ROLLBACK is honoured, on ONE session, by the /query endpoint BEFORE any target SQL is sent. */
    async proveTransactionSemantics() {
      let rows;
      try { rows = rowsOf(await writable(SQL_TRANSACTION_PROBE)); }
      catch (error) { throw new HttpsTransportError('HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN', `probe failed: ${error?.code ?? 'error'}`); }
      const flags = rows.filter((r) => r && typeof r === 'object' && 'rolled_back' in r).map((r) => r.rolled_back);
      if (flags.length === 0 || !flags.every((f) => f === true)) throw new HttpsTransportError('HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN', 'explicit transaction not preserved');
      return true;
    },

    /** Executes BEGIN; SET LOCAL timeouts; <exact reviewed SQL>; ROLLBACK;  — callers MUST have proven transaction semantics first. */
    async dryRunExactSql(sql) {
      assertNoTransactionControl(sql);
      const json = await writable(sqlDryRun(sql));
      if (!hasMarker(json, DRY_RUN_MARKER)) throw new HttpsTransportError('HTTPS_DRY_RUN_COMPLETION_NOT_PROVEN');
      return true;
    },

    /** Native apply: the endpoint owns migration-history recording. */
    async applyNative({ sql, name }) {
      if (!NAME.test(name)) throw new HttpsTransportError('HTTPS_MIGRATION_NAME_INVALID');
      assertNoTransactionControl(sql);
      await request('POST', '/migrations', { query: sql, name });
      return true;
    },

    /** Re-version exactly one ledger entry (precondition proven by the caller). */
    async repairLedgerVersion({ from, to, name }) {
      await writable(sqlRepairLedgerVersion(from, to, name));
      return true;
    },

    /** Clone-schema apply: the exact allow-listed idempotent ops file inside one transaction. No ledger. */
    async applyCloneSql(sql) {
      assertCloneSqlSafe(sql);
      const json = await writable(sqlCloneApply(sql));
      if (!hasMarker(json, CLONE_APPLY_MARKER)) throw new HttpsTransportError('CLONE_APPLY_COMPLETION_NOT_PROVEN');
      return true;
    },

    async readColumns(schema, table, columns) {
      return rowsOf(await readOnly(sqlColumnsProof(schema, table, columns))).filter((r) => r && typeof r === 'object').map((r) => ({
        column_name: String(r.column_name), data_type: String(r.data_type), is_nullable: r.is_nullable === true,
      }));
    },
  };
}

// ── orchestration (the adapter's HTTPS lifecycles) ───────────────────────────

export function columnsProof(rows, entry) {
  const found = new Map(rows.map((r) => [r.column_name, r]));
  const missing = entry.columns.filter((c) => !found.has(c));
  const notNullable = entry.columns.filter((c) => found.has(c) && found.get(c).is_nullable !== true);
  return {
    schema: entry.schema, table: entry.table,
    expected_n: entry.columns.length, present_n: entry.columns.length - missing.length,
    missing, not_nullable: notNullable,
    all_present_nullable: missing.length === 0 && notNullable.length === 0,
    columns: rows,
  };
}

async function verifyColumns(transport, verify) {
  const proofs = [];
  for (const entry of verify ?? []) proofs.push(columnsProof(await transport.readColumns(entry.schema, entry.table, entry.columns), entry));
  return proofs;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const proofDetail = (proofs) => JSON.stringify(proofs.map((p) => ({ table: p.table, missing: p.missing, not_nullable: p.not_nullable })));

/**
 * Target-only lifecycle over HTTPS. `resolveTracked(versions)` returns {missing} for remote-ledger versions that have
 * no local file (remote-ledger consistency gate). Apply REQUIRES verify columns and ENFORCES them.
 */
export async function runHttpsTargetOnly({ transport, targetBasename, targetSql, targetSha256, resolveTracked, apply = false, verify = null }) {
  const { version, name } = parseTargetBasename(targetBasename);
  if (sha256OfText(targetSql) !== targetSha256) throw new HttpsTransportError('HTTPS_TARGET_SHA256_MISMATCH');
  if (apply && validateVerifyColumns(verify, true).length) throw new HttpsTransportError('TARGET_ONLY_VERIFY_COLUMNS_REQUIRED');
  assertNoTransactionControl(targetSql);

  // 1. remote ledger, local compatibility, target not already recorded
  const ledgerBefore = await transport.readLedger();
  const { missing } = resolveTracked(ledgerBefore);
  if (missing.length) throw new HttpsTransportError('TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY', missing.join(','));
  if (ledgerBefore.includes(version)) throw new HttpsTransportError('TARGET_VERSION_ALREADY_RECORDED', version);

  // 2. real dry-run: prove transactions, execute exact SQL inside BEGIN..ROLLBACK, prove nothing persisted
  const fingerprintBefore = await transport.readSchemaFingerprint();
  await transport.proveTransactionSemantics();
  await transport.dryRunExactSql(targetSql);
  const fingerprintAfterDry = await transport.readSchemaFingerprint();
  const ledgerAfterDry = await transport.readLedger();
  if (fingerprintAfterDry.fingerprint !== fingerprintBefore.fingerprint) throw new HttpsTransportError('HTTPS_DRY_RUN_SCHEMA_NOT_ROLLED_BACK');
  if (!sameList(ledgerAfterDry, ledgerBefore)) throw new HttpsTransportError('HTTPS_DRY_RUN_LEDGER_CHANGED');

  const evidence = {
    transport: HTTPS_TRANSPORT_ID, project_ref: transport.projectRef, target_migration: targetBasename, target_version: version,
    target_sha256: targetSha256, ledger_before_n: ledgerBefore.length, target_not_in_ledger: true, exactly_one_pending_is_target: true,
    dry_run: {
      transaction_semantics_proven: true, executed_exact_sql_sha256: sha256OfText(targetSql), script_completed: true,
      schema_fingerprint_before: fingerprintBefore.fingerprint, schema_fingerprint_after: fingerprintAfterDry.fingerprint,
      schema_unchanged: true, ledger_unchanged: true,
    },
    applied: false, native_endpoint_used: false, ledger_repair_used: false, ledger_version_repaired: false,
    historical_migration_replayed: false, include_all_used: false,
  };
  if (!apply) return { mode: 'dry_run', ...evidence };

  // 3. apply through the native endpoint, then verify DDL AND ledger
  let applyError = null;
  try { await transport.applyNative({ sql: targetSql, name }); } catch (error) { applyError = error; }
  const ledgerAfter = await transport.readLedger();
  const added = ledgerAfter.filter((v) => !ledgerBefore.includes(v));
  const removed = ledgerBefore.filter((v) => !ledgerAfter.includes(v));
  let repaired = false;
  if (removed.length) throw new HttpsTransportError('HTTPS_APPLY_LEDGER_ENTRY_REMOVED', removed.join(','));
  if (added.length === 1 && added[0] === version) {
    // exact version recorded by the native endpoint
  } else if (added.length === 1 && !applyError) {
    // the server stamped its own timestamp: re-version that single new entry to the repository file's version
    await transport.repairLedgerVersion({ from: added[0], to: version, name });
    repaired = true;
  } else {
    throw new HttpsTransportError('HTTPS_APPLY_LEDGER_UNEXPECTED', `added=${added.join(',') || 'none'} apply_error=${applyError?.code ?? 'none'}`);
  }
  const ledgerFinal = repaired ? await transport.readLedger() : ledgerAfter;
  if (!ledgerFinal.includes(version) || ledgerFinal.length !== ledgerBefore.length + 1) throw new HttpsTransportError('TARGET_ONLY_APPLY_NOT_RECORDED', version);
  const fingerprintApplied = await transport.readSchemaFingerprint();
  const columns = await verifyColumns(transport, verify);
  if (!columns.every((c) => c.all_present_nullable)) throw new HttpsTransportError('TARGET_ONLY_COLUMNS_NOT_PROVEN', `ledger_recorded=true ${proofDetail(columns)}`);
  return {
    mode: 'applied', ...evidence, applied: true, native_endpoint_used: true, ledger_repair_used: repaired, ledger_version_repaired: repaired,
    apply_response_error_recovered: applyError ? applyError.code : null,
    schema_fingerprint_applied: fingerprintApplied.fingerprint, schema_changed: fingerprintApplied.fingerprint !== fingerprintBefore.fingerprint,
    ledger_after: ledgerFinal, columns_proof: columns,
  };
}

/** Research-clone schema lifecycle over HTTPS: exact allow-listed idempotent ops file, rolled-back dry-run, one transaction. */
export async function runHttpsCloneSchema({ transport, schemaSql, schemaSha256, schemaFile, apply = false, verify }) {
  if (sha256OfText(schemaSql) !== schemaSha256) throw new HttpsTransportError('HTTPS_TARGET_SHA256_MISMATCH');
  const guard = assertCloneSqlSafe(schemaSql);
  if (validateVerifyColumns(verify, true).length) throw new HttpsTransportError('VERIFY_COLUMNS_REQUIRED');
  const fingerprintBefore = await transport.readSchemaFingerprint();
  await transport.proveTransactionSemantics();
  await transport.dryRunExactSql(schemaSql);
  const fingerprintAfterDry = await transport.readSchemaFingerprint();
  if (fingerprintAfterDry.fingerprint !== fingerprintBefore.fingerprint) throw new HttpsTransportError('HTTPS_DRY_RUN_SCHEMA_NOT_ROLLED_BACK');
  const evidence = {
    transport: HTTPS_TRANSPORT_ID, project_ref: transport.projectRef, schema_file: schemaFile, target_sha256: schemaSha256,
    statement_allowlist_enforced: true, statements_n: guard.statements_n, statement_kinds: guard.statement_kinds,
    dry_run: {
      transaction_semantics_proven: true, executed_exact_sql_sha256: sha256OfText(schemaSql), script_completed: true,
      schema_fingerprint_before: fingerprintBefore.fingerprint, schema_fingerprint_after: fingerprintAfterDry.fingerprint, schema_unchanged: true,
    },
    applied: false,
  };
  if (!apply) return { mode: 'dry_run', ...evidence };
  await transport.applyCloneSql(schemaSql);
  const fingerprintApplied = await transport.readSchemaFingerprint();
  const columns = await verifyColumns(transport, verify);
  if (!columns.every((c) => c.all_present_nullable)) throw new HttpsTransportError('CLONE_SCHEMA_COLUMNS_NOT_PROVEN', proofDetail(columns));
  return { mode: 'applied', ...evidence, applied: true, schema_fingerprint_applied: fingerprintApplied.fingerprint, schema_changed: fingerprintApplied.fingerprint !== fingerprintBefore.fingerprint, columns_proof: columns };
}
