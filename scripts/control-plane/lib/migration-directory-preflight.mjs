/**
 * migration-directory-preflight.mjs
 *
 * The smallest deterministic guard that keeps SQL helpers, preview/audit scripts and
 * debug files out of `supabase/migrations/` before the Supabase CLI is ever invoked.
 *
 * Rationale: `supabase db push` executes *every* `*.sql` file in the migrations
 * directory. A read-only preview script (e.g. `preview_track_record_shown_history_flow.sql`)
 * silently living there is a latent production hazard. This preflight fails closed with a
 * single machine-readable reason (`NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY`) before any
 * CLI call.
 *
 * Scope boundary:
 * - This guard only asserts that every file in the migrations directory *is a migration*.
 *   It deliberately does NOT impose the strict modern `\d{14}_name.sql` declaration rule on
 *   historical migrations — valid legacy filenames use shorter date stamps
 *   (e.g. `20260518_whop_v0_1_payment_foundation.sql`). The strict rule for NEW approved
 *   application migrations stays in premvp-application-migration-release.mjs and is unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const PREFLIGHT_REASON = 'NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY';

/**
 * A migration filename is any `*.sql` whose basename begins with an 8+ digit date/timestamp
 * stamp, optionally followed by `_`-separated lowercase identifier segments. This admits
 * every historical and modern migration in the repository and rejects preview/helper/debug
 * SQL such as `preview_*.sql`, `debug_*.sql`, `scratch.sql`, `_probe.sql`.
 */
const MIGRATION_FILENAME = /^\d{8,}[a-z0-9]*(?:_[a-z0-9]+)*\.sql$/i;

/** Names that are never migrations even if a future contributor prefixes a datestamp. */
const NON_MIGRATION_MARKERS = /^(preview|debug|scratch|sandbox|adhoc|audit|report|explain|check|_)/i;

export function classifyMigrationDirEntry(basename) {
  if (!basename.toLowerCase().endsWith('.sql')) return { basename, migration: true, ignored: true };
  if (NON_MIGRATION_MARKERS.test(basename)) return { basename, migration: false };
  return { basename, migration: MIGRATION_FILENAME.test(basename) };
}

/**
 * @param {string[]} basenames - files present in `supabase/migrations/`
 * @returns {{ ok: boolean, reason: string|null, offenders: string[] }}
 */
export function evaluateMigrationDirectory(basenames) {
  const offenders = basenames
    .map((b) => classifyMigrationDirEntry(b))
    .filter((entry) => !entry.migration && !entry.ignored)
    .map((entry) => entry.basename)
    .sort();
  return offenders.length
    ? { ok: false, reason: PREFLIGHT_REASON, offenders }
    : { ok: true, reason: null, offenders: [] };
}

/**
 * Reads the on-disk migrations directory and evaluates it. `root` is the repository root.
 * A missing directory is treated as `ok` (nothing to push).
 */
export function preflightMigrationDirectory(root, dir = MIGRATIONS_DIR) {
  const abs = path.resolve(root, dir);
  let basenames = [];
  try {
    basenames = fs.readdirSync(abs).filter((name) => fs.statSync(path.join(abs, name)).isFile());
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, reason: null, offenders: [] };
    throw error;
  }
  return evaluateMigrationDirectory(basenames);
}

/** Throws a single machine-readable Error when the directory contains non-migration SQL. */
export function assertCleanMigrationDirectory(root, dir = MIGRATIONS_DIR) {
  const result = preflightMigrationDirectory(root, dir);
  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.offenders.join(', ')}`);
  }
  return result;
}
