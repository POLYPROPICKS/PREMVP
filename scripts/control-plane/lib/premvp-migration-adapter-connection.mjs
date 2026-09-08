/**
 * premvp-migration-adapter-connection.mjs
 *
 * Establishes the Supabase project context for the registered PREMVP application-migration
 * adapter (apply-premvp-approved-migration.mjs) without requiring a pre-linked worktree.
 *
 * `supabase link` is an interactive/stateful step that mutates the worktree's
 * .supabase/project-ref file; it is not required to run `db push` non-interactively.
 * The Supabase CLI's `db push` command accepts `--project-ref` and `--password` directly,
 * so when no linked project state exists we pass those instead of `--linked`, sourced from
 * the already-provisioned environment (SUPABASE_ACCESS_TOKEN is read by the CLI itself from
 * the environment; SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD are passed explicitly).
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

export function resolveProjectContextArgs(env = process.env) {
  const projectRef = env.SUPABASE_PROJECT_REF;
  const dbPassword = env.SUPABASE_DB_PASSWORD;
  if (!projectRef || !dbPassword) {
    throw new Error('SUPABASE_PROJECT_CONTEXT_ENV_MISSING');
  }
  return ['--project-ref', projectRef, '--password', dbPassword];
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
 * Runs `supabase db push` preferring an already-linked worktree, and falling back to
 * explicit `--project-ref` / `--password` connection args (from env) only when the
 * failure is specifically an absent-link condition. Any failure of the fallback itself
 * is re-thrown with secret values redacted — never surfaced verbatim.
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
      const secrets = [env.SUPABASE_DB_PASSWORD, env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_URL];
      const cause = extractCausalFailure(fallbackError, secrets);
      throw new Error(`SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED: ${cause}`);
    }
  }
}
