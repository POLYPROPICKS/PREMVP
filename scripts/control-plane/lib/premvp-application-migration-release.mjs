import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_MODE = 'PREMVP_APPLICATION_SCHEMA_MIGRATION_V1';
const MIGRATION_PATH = /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/;
const STORAGE_RECLAIM_CLASS = 'STORAGE_RECLAIM_TRANSITION';
const EXACT_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const FORBIDDEN_SQL = [
  /\bDROP\s+(TABLE|SCHEMA|DATABASE|FUNCTION|TYPE|COLUMN|INDEX)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /^\s*UPDATE\s+[a-z_".]+/im,
  /\bSECURITY\s+DEFINER\b/i,
  /\b(CREATE|ALTER)\s+ROLE\b/i,
  /\bGRANT\b[\s\S]{0,160}\bTO\s+(PUBLIC|anon|authenticated)\b/i,
  /\bCREATE\s+EXTENSION\b/i,
];

export function validateMigrationReleaseDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== 'object') return { ok: true, errors };
  if (declaration.mode !== MIGRATION_MODE) errors.push('MIGRATION_MODE_INVALID');
  if (!Array.isArray(declaration.migration_files) || declaration.migration_files.length !== 1) errors.push('MIGRATION_EXACTLY_ONE_FILE_REQUIRED');
  for (const file of declaration.migration_files || []) if (!MIGRATION_PATH.test(String(file))) errors.push(`MIGRATION_PATH_INVALID: ${file}`);
  if (!['ADDITIVE_COMPATIBLE', 'COMPATIBILITY_TRANSITION', STORAGE_RECLAIM_CLASS].includes(declaration.safety_class)) errors.push('MIGRATION_SAFETY_CLASS_INVALID');
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
