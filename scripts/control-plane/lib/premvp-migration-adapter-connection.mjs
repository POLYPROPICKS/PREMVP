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
      const secrets = [env.SUPABASE_DB_PASSWORD, env.SUPABASE_ACCESS_TOKEN];
      const sanitized = redactSecrets(
        `${fallbackError?.stderr || ''}\n${fallbackError?.message || ''}`,
        secrets,
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-1)[0] || 'unknown';
      throw new Error(`SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED: ${sanitized}`);
    }
  }
}
