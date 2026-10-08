import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_MODE = 'PREMVP_APPLICATION_SCHEMA_MIGRATION_V1';
const MIGRATION_PATH = /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/;
const STORAGE_RECLAIM_CLASS = 'STORAGE_RECLAIM_TRANSITION';
const BOUNDED_PRUNE_CLASS = 'BOUNDED_PRUNE_FUNCTION_TRANSITION';
const BOUNDED_PRUNE_TARGET = 'public.prune_current_signal_pair_serving';
const EXACT_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const DELETE_FROM_PATTERN = /\bDELETE\s+FROM\b/i;
const FORBIDDEN_SQL = [
  /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION|TYPE|COLUMN|INDEX)\b/i,
  /\bTRUNCATE\b/i,
  DELETE_FROM_PATTERN,
  /^\s*UPDATE\s+[a-z_".]+/im,
  /\bSECURITY\s+DEFINER\b/i,
  /\b(CREATE|ALTER)\s+ROLE\b/i,
  /\bGRANT\b[\s\S]{0,160}\bTO\s+(PUBLIC|anon|authenticated)\b/i,
  /\bCREATE\s+EXTENSION\b/i,
];

// The only SQL (after comment stripping and whitespace normalisation) the bounded prune class may carry.
// DELETE FROM is permitted solely because it lives inside this exact, validated function body.
const BOUNDED_PRUNE_EXACT_SQL = `
CREATE OR REPLACE FUNCTION public.prune_current_signal_pair_serving(
  p_batch_size integer DEFAULT 25,
  p_resolved_source_generated_signal_pair_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 500';
  END IF;

  IF p_resolved_source_generated_signal_pair_ids IS NOT NULL THEN
    WITH candidates AS (
      SELECT serving.ctid
      FROM public.current_signal_pair_serving serving
      JOIN public.generated_signal_pairs source
        ON source.id = serving.source_generated_signal_pair_id
      WHERE serving.source_generated_signal_pair_id = ANY(p_resolved_source_generated_signal_pair_ids)
        AND source.signal_result IS NOT NULL
      ORDER BY serving.source_generated_signal_pair_id
      LIMIT p_batch_size
      FOR UPDATE OF serving SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.current_signal_pair_serving serving
      USING candidates
      WHERE serving.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;
  ELSE
    WITH candidates AS (
      SELECT serving.ctid
      FROM public.current_signal_pair_serving serving
      WHERE serving.projection_status = 'ACTIVE'
        AND serving.expires_at <= now()
      ORDER BY serving.expires_at ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM public.current_signal_pair_serving serving
      USING candidates
      WHERE serving.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;
  END IF;

  RETURN deleted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prune_current_signal_pair_serving(integer, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_current_signal_pair_serving(integer, uuid[]) TO service_role;
`;

function normalizeSql(sql) {
  return String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/ ?([(),;]) ?/g, '$1').trim();
}

const BOUNDED_PRUNE_NORMALIZED = normalizeSql(BOUNDED_PRUNE_EXACT_SQL);

export function validateMigrationReleaseDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== 'object') return { ok: true, errors };
  if (declaration.mode !== MIGRATION_MODE) errors.push('MIGRATION_MODE_INVALID');
  if (!Array.isArray(declaration.migration_files) || declaration.migration_files.length !== 1) errors.push('MIGRATION_EXACTLY_ONE_FILE_REQUIRED');
  for (const file of declaration.migration_files || []) if (!MIGRATION_PATH.test(String(file))) errors.push(`MIGRATION_PATH_INVALID: ${file}`);
  if (!['ADDITIVE_COMPATIBLE', 'COMPATIBILITY_TRANSITION', STORAGE_RECLAIM_CLASS, BOUNDED_PRUNE_CLASS].includes(declaration.safety_class)) errors.push('MIGRATION_SAFETY_CLASS_INVALID');
  if (declaration.safety_class === 'COMPATIBILITY_TRANSITION' && typeof declaration.constraint_drop_justification !== 'string') errors.push('MIGRATION_CONSTRAINT_DROP_JUSTIFICATION_REQUIRED');
  if (declaration.safety_class === STORAGE_RECLAIM_CLASS) {
    if (!Array.isArray(declaration.storage_reclaim_targets) || declaration.storage_reclaim_targets.length !== 1 ||
        !declaration.storage_reclaim_targets.every((target) => typeof target === 'string' && EXACT_TABLE.test(target))) {
      errors.push('STORAGE_RECLAIM_EXACT_TARGET_REQUIRED');
    }
    if (typeof declaration.storage_reclaim_justification !== 'string' || !declaration.storage_reclaim_justification.trim()) {
      errors.push('STORAGE_RECLAIM_JUSTIFICATION_REQUIRED');
    }
  }
  if (declaration.safety_class === BOUNDED_PRUNE_CLASS && declaration.bounded_prune_target !== BOUNDED_PRUNE_TARGET) {
    errors.push('BOUNDED_PRUNE_EXACT_TARGET_REQUIRED');
  }
  if (declaration.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  if (declaration.rollback_strategy !== (declaration.safety_class === STORAGE_RECLAIM_CLASS ? 'REGENERABLE_SOURCE' : 'COMPATIBILITY_RETAINED')) errors.push('MIGRATION_ROLLBACK_STRATEGY_INVALID');
  return { ok: errors.length === 0, errors };
}

export function validateApprovedMigrationRelease({ declaration, changedFiles, readFile }) {
  const declarationResult = validateMigrationReleaseDeclaration(declaration);
  if (!declaration) {
    const migrations = changedFiles.filter((file) => file.startsWith('supabase/migrations/'));
    return migrations.length ? { ok: false, errors: ['MIGRATION_RELEASE_DECLARATION_REQUIRED'] } : declarationResult;
  }
  const errors = [...declarationResult.errors];
  const expected = declaration.migration_files || [];
  const actual = changedFiles.filter((file) => file.startsWith('supabase/migrations/'));
  if (actual.length !== 1 || actual[0] !== expected[0]) errors.push('MIGRATION_CHANGESET_MISMATCH');
  if (errors.length) return { ok: false, errors };
  const sql = readFile(expected[0]);
  if (!/^\s*--\s*PREMVP_APPLICATION_MIGRATION_V1\b/m.test(sql)) errors.push('MIGRATION_HEADER_REQUIRED');
  if (declaration.safety_class === STORAGE_RECLAIM_CLASS) {
    const target = declaration.storage_reclaim_targets[0];
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const space = '\\s+';
    const gap = '\\s*';
    const exactSql = new RegExp(
      `^${gap}--${space}PREMVP_APPLICATION_MIGRATION_V1${gap}` +
      `DO${space}\\$\\$${gap}BEGIN${gap}IF${space}EXISTS${gap}\\(${gap}` +
      `SELECT${space}1${space}FROM${space}${escaped}${space}WHERE${space}expires_at${space}>=${space}now\\(\\)${gap}` +
      `\\)${space}THEN${gap}RAISE${space}EXCEPTION${space}'SPORTS_INVENTORY_UNEXPIRED_ROWS_PRESENT';${gap}` +
      `END${space}IF;${gap}END${gap}\\$\\$;${gap}` +
      `TRUNCATE${space}TABLE${space}${escaped};${gap}$`, 'i',
    );
    if (!exactSql.test(sql)) errors.push('STORAGE_RECLAIM_SQL_SHAPE_INVALID');
    return { ok: errors.length === 0, errors };
  }
  if (declaration.safety_class === BOUNDED_PRUNE_CLASS) {
    // Every FORBIDDEN_SQL rule except the DELETE FROM ban (allowed only inside the exact function body below).
    for (const pattern of FORBIDDEN_SQL) if (pattern.source !== DELETE_FROM_PATTERN.source && pattern.test(sql)) errors.push(`MIGRATION_SQL_FORBIDDEN: ${pattern}`);
    if (normalizeSql(sql) !== BOUNDED_PRUNE_NORMALIZED) errors.push('BOUNDED_PRUNE_SQL_SHAPE_INVALID');
    return { ok: errors.length === 0, errors };
  }
  for (const pattern of FORBIDDEN_SQL) if (pattern.test(sql)) errors.push(`MIGRATION_SQL_FORBIDDEN: ${pattern}`);
  if (/\bALTER\s+TABLE\b[\s\S]{0,100}\bDROP\s+CONSTRAINT\b/i.test(sql) &&
      (declaration.safety_class !== 'COMPATIBILITY_TRANSITION' || !declaration.constraint_drop_justification.trim())) {
    errors.push('MIGRATION_CONSTRAINT_DROP_UNAUTHORIZED');
  }
  return { ok: errors.length === 0, errors };
}

export function migrationPathFromRepo(root, migrationFile) {
  const target = path.resolve(root, migrationFile);
  const migrationsRoot = path.resolve(root, 'supabase', 'migrations') + path.sep;
  if (!target.startsWith(migrationsRoot)) throw new Error('MIGRATION_PATH_ESCAPES_REPOSITORY');
  return target;
}

export function readAndValidateMigration(root, declaration) {
  const declared = validateMigrationReleaseDeclaration(declaration);
  if (!declared.ok) throw new Error(declared.errors.join('; '));
  const migrationFile = declaration.migration_files[0];
  const result = validateApprovedMigrationRelease({
    declaration,
    changedFiles: [migrationFile],
    readFile: (file) => fs.readFileSync(migrationPathFromRepo(root, file), 'utf8'),
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return migrationFile;
}
