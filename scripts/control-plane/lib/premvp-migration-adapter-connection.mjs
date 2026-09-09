/**
 * premvp-migration-adapter-connection.mjs
 *
 * Establishes the Supabase project context for the registered PREMVP application-migration
 * adapter (apply-premvp-approved-migration.mjs) without requiring a pre-linked worktree.
 *
 * `supabase link` is an interactive/stateful step that mutates the worktree's
 * .supabase/project-ref file, and fetches PostgREST configuration from the Supabase
 * Management API to validate it — it is not required to run `db push` non-interactively,
 * and its Management API dependency (SUPABASE_ACCESS_TOKEN, platform reachability) is
 * exactly what the direct-DB route below exists to avoid. Per current Supabase CLI
 * documentation, `db push` supports a self-hosted-style `--db-url <connection-string>`
 * flag as the only documented non-interactive alternative to `--linked`: it opens a plain
 * Postgres wire-protocol connection and never calls the Management API. When no linked
 * project state exists we therefore fall back to `--db-url`, built either from an
 * explicitly provisioned SUPABASE_DB_URL or derived in-memory from
 * SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD using Supabase's documented direct
 * connection format (`postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`).
 * The derived URL is held only in memory for the single CLI invocation; it is never
 * logged, and any occurrence of it (or its password) in CLI output is redacted before
 * being surfaced (see sanitizeDiagnosticText / STRUCTURAL_SECRET_PATTERNS below).
 */

const NOT_LINKED_MARKERS = [
  'LegacyProjectNotLinkedError',
  'Cannot find project ref',
  'no project ref found',
  'not linked',
];

export function isNotLinkedError(error) {
  const text = `${error?.stdout || ''}${error?.stderr || ''}${error?.message || ''}`;
  return NOT_LINKED_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Resolves the direct Postgres connection URL for the fallback route, preferring an
 * explicitly provisioned SUPABASE_DB_URL and otherwise deriving it from
 * SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD using Supabase's documented direct
 * connection format. The database password is percent-encoded (encodeURIComponent) so a
 * password containing URI-reserved characters (`@`, `:`, `/`, `#`, `?`, etc.) still
 * produces a valid, unambiguous connection URI. Fails closed — never guesses — when
 * neither an explicit URL nor a complete ref+password pair is available.
 */
export function resolveDirectDbUrl(env = process.env) {
  if (env.SUPABASE_DB_URL) return env.SUPABASE_DB_URL;
  const projectRef = env.SUPABASE_PROJECT_REF;
  const dbPassword = env.SUPABASE_DB_PASSWORD;
  if (!projectRef || !dbPassword) {
    throw new Error('SUPABASE_PROJECT_CONTEXT_ENV_MISSING');
  }
  return `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${projectRef}.supabase.co:5432/postgres`;
}

/**
 * Builds the `db push` CLI args for the direct-DB fallback route: `--db-url <url>`, the
 * only documented non-interactive `db push` route that never depends on Management API
 * authorization. Superseded (and no longer produces) the legacy `--project-ref
 * --password` pairing, which is not a documented `db push` flag combination and — via
 * `supabase link` semantics — implies Management API involvement this route is required
 * to avoid.
 */
export function resolveProjectContextArgs(env = process.env) {
  return ['--db-url', resolveDirectDbUrl(env)];
}

export function redactSecrets(text, secrets) {
  return secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join('***REDACTED***') : acc),
    String(text ?? ''),
  );
}

/** Explicit marker returned when nothing more specific than progress output was captured. */
export const CAUSE_NOT_EXTRACTABLE = 'CAUSE_NOT_EXTRACTABLE';

/**
 * Structural redaction for authorization material that is not an exact known env value:
 * connection strings, inline `--password` / `password=` flags, access tokens and
 * authorization headers. Applied on top of the exact-value redaction so a rotated or
 * CLI-echoed credential can never reach the thrown message.
 */
const STRUCTURAL_SECRET_PATTERNS = [
  [/\bpostgres(?:ql)?:\/\/\S+/gi, 'postgresql://***REDACTED***'],
  [/(--password[=\s]+)\S+/gi, '$1***REDACTED***'],
  [/(\bpassword\s*[=:]\s*)\S+/gi, '$1***REDACTED***'],
  [/\bsbp_[A-Za-z0-9._-]+/g, '***REDACTED***'],
  [/(\b(?:authorization|bearer|api[-_]?key)\s*[=:]\s*)\S+/gi, '$1***REDACTED***'],
];

/** Exact-value redaction plus structural redaction of authorization material. */
export function sanitizeDiagnosticText(text, secrets = []) {
  return STRUCTURAL_SECRET_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    redactSecrets(text, secrets),
  );
}

/** Lines that describe what the CLI was doing, never why it failed. */
const PROGRESS_ONLY_LINE = /^(?:connecting to remote database|initialising|initializing|linking project|applying migration|remote database is up to date|supabase db push|skipping migration|using workdir|[-\\|/*•….\s]*)\.*$/i;

/** Concrete causes worth surfacing ahead of any other surviving line. */
const CONCRETE_CAUSE = /(timeout|timed out|etimedout|connection refused|econnrefused|dns|enotfound|eai_again|getaddrinfo|authentication|auth failed|unauthorized|forbidden|invalid (?:api |access )?(?:key|token)|401|403|project (?:not found|ref)|invalid project|permission denied|sasl|certificate|tls|ssl|enoent|einval|spawn|exit code|command failed|panic|fatal|error)/i;

const MAX_CAUSE_LINES = 3;
const MAX_LINE_CHARS = 200;

/**
 * Builds a bounded, sanitized causal excerpt from a failed CLI invocation.
 *
 * Reads stdout, stderr and the process error message — the Supabase CLI writes its real
 * failure to stdout on several paths, which is why stdout may not be dropped. Progress-only
 * lines are discarded; lines naming a concrete cause are preferred over the rest; the result
 * is capped in both line count and line length so a diagnostic can never become a raw log
 * dump. When nothing but progress output survives, returns CAUSE_NOT_EXTRACTABLE rather than
 * presenting a progress line as the cause.
 */
export function extractCausalFailure(error, secrets = []) {
  const streams = [error?.stdout, error?.stderr, error?.message];
  const lines = [];
  for (const stream of streams) {
    for (const raw of sanitizeDiagnosticText(stream ?? '', secrets).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || PROGRESS_ONLY_LINE.test(line)) continue;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  if (!lines.length) return CAUSE_NOT_EXTRACTABLE;
  const concrete = lines.filter((line) => CONCRETE_CAUSE.test(line));
  const chosen = (concrete.length ? concrete : lines).slice(0, MAX_CAUSE_LINES);
  return chosen
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line))
    .join(' | ');
}

/**
 * Runs `supabase db push` preferring an already-linked worktree, and falling back to the
 * direct-DB `--db-url` route (from env, see resolveDirectDbUrl) only when the failure is
 * specifically an absent-link condition — the direct route never requires Management API
 * authorization. There is no further fallback after a direct-route failure: any failure
 * of the fallback itself is re-thrown once, with secret values (including the resolved
 * connection URL, which embeds the password) redacted — never surfaced verbatim.
 */
export function runDbPushWithFallback({ run, extraArgs, env = process.env }) {
  try {
    return run(['db', 'push', '--linked', ...extraArgs]);
  } catch (error) {
    if (!isNotLinkedError(error)) throw error;
    let contextArgs;
    try {
      contextArgs = resolveProjectContextArgs(env);
    } catch (envError) {
      throw envError;
    }
    try {
      return run(['db', 'push', ...contextArgs, ...extraArgs]);
    } catch (fallbackError) {
      const secrets = [env.SUPABASE_DB_PASSWORD, env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_URL, contextArgs[1]];
      const cause = extractCausalFailure(fallbackError, secrets);
      throw new Error(`SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED: ${cause}`);
    }
  }
}
