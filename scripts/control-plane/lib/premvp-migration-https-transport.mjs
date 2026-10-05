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
 *  - HTTPS only, fixed origin; the access token travels only in the Authorization header and is redacted from
 *    every message this module produces.
 *  - Dry-run is real: it first PROVES the endpoint preserves explicit-transaction semantics (temp-table probe),
 *    then runs BEGIN; <exact SQL>; ROLLBACK; and verifies the schema fingerprint and migration history are
 *    unchanged. If transactional semantics are not proven it fails closed (HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN)
 *    and the target SQL is never sent.
 *  - Apply uses the NATIVE migrations endpoint (which owns history recording) and then verifies that the ledger
 *    contains the EXACT target version. Only if the endpoint recorded exactly one new entry under a different
 *    version (the server stamps its own timestamp) is that single entry re-versioned, fail-closed, so the
 *    ledger matches the repository file.
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

const DIRECT_TRANSPORT_MARKERS = [
  /hostname resolving error/i, /no such host/i, /network is unreachable/i, /address family not supported/i,
  /connection refused/i, /i\/o timeout/i, /dial tcp/i, /\bENETUNREACH\b/, /\bEAI_AGAIN\b/, /\bECONNREFUSED\b/, /\bETIMEDOUT\b/,
  /failed to connect to `host=/i,
];
const DIRECT_AUTH_MARKERS = [/password authentication failed/i, /\bSASL\b/, /authentication failed/i, /invalid (?:api |access )?token/i, /unauthorized/i, /forbidden/i, /permission denied/i];

/**
 * True ONLY when the existing CLI/direct-Postgres path failed because the direct DB TRANSPORT is unavailable
 * (DNS / no route / refused / timeout). Authentication or authorization failures never qualify: those are real
 * gate failures, not transport gaps, and must not be routed around.
 */
export function isDirectTransportUnavailable(failure) {
  const text = [failure?.stdout, failure?.stderr, failure?.message, typeof failure === 'string' ? failure : '']
    .filter(Boolean).join('\n');
  if (!text) return false;
  if (DIRECT_AUTH_MARKERS.some((m) => m.test(text))) return false;
  return /DbConnectError|failed to connect to postgres/i.test(text) && DIRECT_TRANSPORT_MARKERS.some((m) => m.test(text));
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

/** Optional/required post-apply column proof request: [{schema, table, columns:[...]}], identifiers only. */
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

// ── SQL guards (pure) ────────────────────────────────────────────────────────

const CLONE_FORBIDDEN_SQL = [
  /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION|TYPE|COLUMN|INDEX)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /^\s*UPDATE\s+[a-z_".]+/im,
  /\bSECURITY\s+DEFINER\b/i,
  /\b(CREATE|ALTER)\s+ROLE\b/i,
  /\bGRANT\b[\s\S]{0,160}\bTO\s+(PUBLIC|anon|authenticated)\b/i,
  /\bCREATE\s+EXTENSION\b/i,
];

/** Comments, quoted strings and dollar-quoted bodies removed, so statement starts can be inspected honestly. */
function stripSqlNoise(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

// Whole-word statement starts only (COMMENT is not COMMIT); SET is allowed only as SET LOCAL (transaction-scoped).
const TRANSACTION_CONTROL = /^(?:(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|reset)\b|set\s+(?!local\b)|\\)/i;

/**
 * The dry-run's ROLLBACK (and the apply's COMMIT) only mean something if the SQL cannot end/replace the
 * transaction itself. Fail closed on any transaction-control statement.
 */
export function assertNoTransactionControl(sql) {
  for (const statement of stripSqlNoise(sql).split(';').map((s) => s.trim()).filter(Boolean)) {
    if (TRANSACTION_CONTROL.test(statement)) throw new HttpsTransportError('HTTPS_SQL_TRANSACTION_CONTROL_FORBIDDEN');
  }
  return true;
}

export function assertCloneSqlSafe(sql) {
  assertNoTransactionControl(sql);
  for (const pattern of CLONE_FORBIDDEN_SQL) if (pattern.test(sql)) throw new HttpsTransportError('CLONE_SQL_FORBIDDEN', String(pattern));
  return true;
}

// ── fixed SQL templates ──────────────────────────────────────────────────────

export const SQL_LEDGER_VERSIONS = 'select version from supabase_migrations.schema_migrations order by version';

/** Transaction-semantics probe: a TEMP table can leave no persistent object whatever the endpoint does. */
export const SQL_TRANSACTION_PROBE =
  "BEGIN; CREATE TEMPORARY TABLE premvp_txn_probe(x int); ROLLBACK; SELECT to_regclass('pg_temp.premvp_txn_probe') IS NULL AS rolled_back;";

/** md5 over every user-schema column (type, nullability, comment), index and constraint: changes iff DDL persisted. */
export const SQL_SCHEMA_FINGERPRINT = `
select md5(coalesce(string_agg(x, '|' order by x), '')) as fingerprint, count(*)::int as n from (
  select format('col:%s.%s.%s:%s:%s:%s', n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(col_description(c.oid, a.attnum), '')) as x
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r','v','m','p','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
  union all
  select format('idx:%s.%s:%s', schemaname, indexname, indexdef) from pg_indexes where schemaname not in ('pg_catalog','information_schema')
  union all
  select format('con:%s:%s:%s', conrelid::regclass::text, conname, contype) from pg_constraint where conrelid <> 0 and connamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
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

const withTrailingNewline = (sql) => (String(sql).endsWith('\n') ? String(sql) : `${sql}\n`);
export const sqlDryRun = (sql) => `BEGIN;\n${withTrailingNewline(sql)}ROLLBACK;`;
export const sqlCloneApply = (sql) => `BEGIN;\n${withTrailingNewline(sql)}COMMIT;`;

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

    /** Proves BEGIN..ROLLBACK is honoured by the /query endpoint BEFORE any target SQL is sent. */
    async proveTransactionSemantics() {
      let rows;
      try { rows = rowsOf(await writable(SQL_TRANSACTION_PROBE)); }
      catch (error) { throw new HttpsTransportError('HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN', `probe failed: ${error?.code ?? 'error'}`); }
      const flags = rows.filter((r) => r && typeof r === 'object' && 'rolled_back' in r).map((r) => r.rolled_back);
      if (flags.length === 0 || !flags.every((f) => f === true)) throw new HttpsTransportError('HTTPS_TRANSACTIONAL_DRY_RUN_NOT_PROVEN', 'explicit transaction not preserved');
      return true;
    },

    /** Executes BEGIN; <exact reviewed SQL>; ROLLBACK;  — callers MUST have proven transaction semantics first. */
    async dryRunExactSql(sql) {
      assertNoTransactionControl(sql);
      await writable(sqlDryRun(sql));
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

    /** Clone-schema apply: the exact idempotent ops file inside one transaction. No ledger. */
    async applyCloneSql(sql) {
      assertCloneSqlSafe(sql);
      await writable(sqlCloneApply(sql));
      return true;
    },

    async readColumns(schema, table, columns) {
      return rowsOf(await readOnly(sqlColumnsProof(schema, table, columns))).map((r) => ({
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

/**
 * Target-only lifecycle over HTTPS. `resolveTracked(versions)` is the adapter's existing
 * resolveTrackedLocalFiles bound to the local migrations directory (remote-ledger consistency gate).
 */
export async function runHttpsTargetOnly({ transport, targetBasename, targetSql, targetSha256, resolveTracked, apply = false, verify = null }) {
  const { version, name } = parseTargetBasename(targetBasename);
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
    target_sha256: targetSha256, ledger_before_n: ledgerBefore.length, target_not_in_ledger: true,
    dry_run: {
      transaction_semantics_proven: true, executed_exact_sql_sha256: sha256OfText(targetSql),
      schema_fingerprint_before: fingerprintBefore.fingerprint, schema_fingerprint_after: fingerprintAfterDry.fingerprint,
      schema_unchanged: true, ledger_unchanged: true,
    },
    applied: false, native_endpoint_used: false, ledger_version_repaired: false, historical_migration_replayed: false, include_all_used: false,
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
  return {
    mode: 'applied', ...evidence, applied: true, native_endpoint_used: true, ledger_version_repaired: repaired,
    apply_response_error_recovered: applyError ? applyError.code : null,
    schema_fingerprint_applied: fingerprintApplied.fingerprint, schema_changed: fingerprintApplied.fingerprint !== fingerprintBefore.fingerprint,
    ledger_after: ledgerFinal, columns_proof: await verifyColumns(transport, verify),
  };
}

/** Research-clone schema lifecycle over HTTPS: exact idempotent ops file, rolled-back dry-run, then one transaction. */
export async function runHttpsCloneSchema({ transport, schemaSql, schemaSha256, schemaFile, apply = false, verify }) {
  assertCloneSqlSafe(schemaSql);
  const fingerprintBefore = await transport.readSchemaFingerprint();
  await transport.proveTransactionSemantics();
  await transport.dryRunExactSql(schemaSql);
  const fingerprintAfterDry = await transport.readSchemaFingerprint();
  if (fingerprintAfterDry.fingerprint !== fingerprintBefore.fingerprint) throw new HttpsTransportError('HTTPS_DRY_RUN_SCHEMA_NOT_ROLLED_BACK');
  const evidence = {
    transport: HTTPS_TRANSPORT_ID, project_ref: transport.projectRef, schema_file: schemaFile, target_sha256: schemaSha256,
    dry_run: {
      transaction_semantics_proven: true, executed_exact_sql_sha256: sha256OfText(schemaSql),
      schema_fingerprint_before: fingerprintBefore.fingerprint, schema_fingerprint_after: fingerprintAfterDry.fingerprint, schema_unchanged: true,
    },
    applied: false, production_rows_mutated: false, historical_backfill: false,
  };
  if (!apply) return { mode: 'dry_run', ...evidence };
  await transport.applyCloneSql(schemaSql);
  const fingerprintApplied = await transport.readSchemaFingerprint();
  const columns = await verifyColumns(transport, verify);
  if (!columns.every((c) => c.all_present_nullable)) throw new HttpsTransportError('CLONE_SCHEMA_COLUMNS_NOT_PROVEN', JSON.stringify(columns.map((c) => ({ table: c.table, missing: c.missing, not_nullable: c.not_nullable }))));
  return { mode: 'applied', ...evidence, applied: true, schema_fingerprint_applied: fingerprintApplied.fingerprint, schema_changed: fingerprintApplied.fingerprint !== fingerprintBefore.fingerprint, columns_proof: columns };
}
