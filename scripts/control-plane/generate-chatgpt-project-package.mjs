#!/usr/bin/env node
/**
 * generate-chatgpt-project-package.mjs
 *
 * premvp.command.chatgpt_project_package.v1
 *
 * Deterministically generates the ChatGPT Architect Project package from the LIVE
 * canonical control plane. There is exactly ONE direction of generation:
 *
 *   canonical control plane  →  generated snapshot / bundle / Project package
 *
 * A stale Project source can therefore never silently override canonical policy: --check
 * fails when the bundle, the snapshot, the Project Instructions or any uploaded Source
 * hash drifts, and when an active source contradicts canonical routing or prompt policy.
 *
 * Usage:
 *   node scripts/control-plane/generate-chatgpt-project-package.mjs           # write
 *   node scripts/control-plane/generate-chatgpt-project-package.mjs --check   # verify
 *   node scripts/control-plane/generate-chatgpt-project-package.mjs --root=<dir> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderBundle, BUNDLE_REL } from './generate-chatgpt-architect-bundle.mjs';
import { renderSnapshot, SNAPSHOT_REL } from './generate-architect-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIR = 'docs/ai-context/control-plane';
export const PACKAGE_REL = `${DIR}/chatgpt-architect/project-package`;
export const PACKAGE_SCHEMA_VERSION = '1.0';

/** The ONLY four files intended for routine upload to the Architect Project. */
export const ACTIVE_SOURCES = Object.freeze([
  { name: 'ARCHITECT_SNAPSHOT.md', canonical: `${DIR}/ARCHITECT_SNAPSHOT.md`, role: 'GENERATED_SNAPSHOT' },
  { name: 'CHATGPT_ARCHITECT_PROJECT_BUNDLE.md', canonical: BUNDLE_REL, role: 'GENERATED_BUNDLE' },
  { name: 'PROMPT__PROTOCOL.md', canonical: `${DIR}/PROMPT__PROTOCOL.md`, role: 'MISSION_CONTRACT' },
  { name: 'COMPLETION_ENVELOPE.schema.json', canonical: `${DIR}/COMPLETION_ENVELOPE.schema.json`, role: 'COMPLETION_CONTRACT' },
]);

/** Historical or non-current material that must never enter the active upload set. */
export const EXCLUDED_SOURCES = Object.freeze([
  { name: 'CHATGPT_PROJECT_SETUP.md', reason: 'SUPERSEDED — one-time Phase 2 setup guide, not current prompt policy' },
  { name: 'NEW_CONTOUR_3.md', reason: 'HISTORICAL — contour handoff, never current state' },
  { name: 'NEW_CONTOUR_4.md', reason: 'HISTORICAL — contour handoff, never current state' },
  { name: 'EVIDENCE_LEDGER.md', reason: 'HISTORICAL — append-only ledger, never current state' },
  { name: 'PASTED_COMPLETION_REPORTS', reason: 'HISTORICAL — superseded by COMPLETION_ENVELOPE.schema.json' },
  { name: 'PROMPT_FAILURE_POSTMORTEMS', reason: 'HISTORICAL — lessons, not policy' },
  { name: 'SECRETS_AND_ENV_FILES', reason: 'FORBIDDEN — secrets are never uploaded' },
]);

const EXCLUDED_NAME_PATTERNS = [
  /NEW_CONTOUR/i, /NEW_COUNTUR/i, /CHATGPT_PROJECT_SETUP/i, /EVIDENCE_LEDGER/i,
  /POSTMORTEM/i, /^\.env/i, /COMPLETION_REPORT/i,
];

/**
 * An active source that reintroduces retired policy is drift, not context.
 *
 * Each pattern anchors on an AFFIRMATIVE directive, and a match is discarded when the
 * preceding text negates it — otherwise the canonical prohibitions ("never treat
 * EVIDENCE_LEDGER.md as current state") would flag themselves.
 */
const CONTRADICTION_PATTERNS = [
  { id: 'LEGACY_25_SECTION_MODEL', re: /all 25 sections must be populated|all 25 sections (must be |are )?present|25-section (prompt )?(contract|template) (is|remains) (required|mandatory)/gi },
  { id: 'ALL_AGENT_ROUTING', re: /invoke all agents|all[- ]agent (routing|invocation) (is )?(required|enabled)/gi },
  { id: 'EVIDENCE_LEDGER_AS_CURRENT_STATE', re: /\b(treat|use|read|cite|is)\b[^\n]{0,60}EVIDENCE_LEDGER(\.md)?[^\n]{0,30}\bas (the )?current state\b|EVIDENCE_LEDGER(\.md)? is (the )?current state\b/gi },
  { id: 'INCOMPLETE_AS_HARD_STOP', re: /\bimplementation (unfinished|incomplete)\b[^.\n]{0,40}\b(hard stop|PROMPT_GATE_BLOCKED|BLOCKED)\b/gi },
];

const NEGATION_WINDOW = 90;
const NEGATION_RE = /\b(never|not|no longer|retired|superseded|must not|cannot|can't|do not|don't|forbidden|prohibited|is history)\b/i;

function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function readCanonical(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/**
 * Generated package files are pinned to LF (see .gitattributes). Canonical sources may be
 * checked out CRLF on a Windows host, so copies are normalized — otherwise the manifest
 * hashes, and therefore --check, would differ per host instead of per content.
 */
function lf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/** Resolves the commit the package is generated from. Never fabricated. */
function resolveSourceCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'RESOLVE_AT_RUNTIME';
  }
}

/** Test 18's guard: the active upload set can never contain historical policy sources. */
export function activeSourceSetViolations(names) {
  const errors = [];
  for (const n of names) {
    for (const re of EXCLUDED_NAME_PATTERNS) {
      if (re.test(n)) errors.push(`EXCLUDED_HISTORICAL_SOURCE_IN_ACTIVE_SET: ${n}`);
    }
  }
  if (names.length !== ACTIVE_SOURCES.length) {
    errors.push(`ACTIVE_SOURCE_COUNT: expected ${ACTIVE_SOURCES.length}, got ${names.length}`);
  }
  return errors;
}

export function sourceContradictions(name, text) {
  const out = [];
  for (const p of CONTRADICTION_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of String(text).matchAll(p.re)) {
      const before = String(text).slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      if (NEGATION_RE.test(before)) continue;
      out.push(`ACTIVE_SOURCE_CONTRADICTS_CANONICAL_POLICY: ${name} — ${p.id}`);
      break;
    }
  }
  return out;
}

export function renderProjectInstructions(root = REPO_ROOT) {
  const policy = JSON.parse(readCanonical(root, `${DIR}/ARCHITECT_CONTROL_PLANE.yaml`));
  const taxonomy = JSON.parse(readCanonical(root, `${DIR}/EXECUTION_ESCALATION_TAXONOMY.json`));
  const hardStops = (taxonomy.classes?.HARD_SAFETY_STOP?.identifiers || []).join(', ');

  return `PolyProPicks — Architect Control Plane
GENERATED FILE. Regenerate with: npm run control-plane:project-package
Package schema ${PACKAGE_SCHEMA_VERSION} · policy ${policy.policy_version}

ROLE
You are the PREMVP Architect and mission compiler. You do not edit the PREMVP repository
yourself. You classify the Founder's intent, resolve authority, and emit exactly one
Mission Contract for one registered executor.

AUTHORITY
Live docs/ai-context/control-plane/** is canonical. CURRENT_STATE.yaml is the only current
operational state artifact. The four uploaded Project Sources are fallback context and are
never stronger than live repository evidence or live Git output. When an uploaded source
and the live control plane disagree, the live control plane wins and you say so.

TWO AUTHORITY TREES
Keep them separate. Runtime facts rank: live runtime evidence > accepted CURRENT_STATE
entry > tracked documentation > executor self-report > chat memory. Product decisions rank:
current Founder decision > control-plane policy > locked product decisions > historical
checkpoint > chat memory. A Founder statement is authority over product decisions; it never
by itself proves a runtime PASS.

THIN ARCHITECT
You define WHAT, WHY and ACCEPTANCE:
  MISSION, BUSINESS RESULT, REPOSITORY, SCOPE, HARD BOUNDARIES, ACCEPTANCE.
Emit FOUNDER AUTHORIZATION, RUNTIME EVIDENCE, DATABASE, REVIEWER, RELEASE, PRODUCTION
OBSERVATION or LIVE MONEY only when directly relevant.
You do NOT reproduce generic executor orchestration: worktree procedure, fetch mechanics,
dependency installation, PR or merge mechanics, CI or deployment polling, reviewer polling,
state reconciliation, resume mechanics, or long generic stop lists. Those belong to
registered commands and the executor runtime.

MISSION FIRST
Produce one compact Mission Contract, not the retired 25-section implementation procedure.
No fixed-template enforcement exists any more. Short is correct.

RUNTIME RESOLUTION
Never guess a SHA, path, capability verdict, command id, model, reviewer binding, executor
or deployment fact. Write RESOLVE_AT_RUNTIME where the value is legitimately unknown at
compile time.

ACTION -> CAPABILITY
A capability is required only when the selected executor performs a direct action that
needs it. A downstream consequence in another system creates no requirement: PREMVP writing
a Queue that Ireland later consumes does not require Ireland runtime access. Risk class
controls authority, safety and reviewer requirement only — it never injects a capability,
and R5 does not mean "require everything". Application-owned persistence is the application
writing through its own code path; it is not raw database mutation and does not require
DATABASE_WRITE.

ONE REPOSITORY BOUNDARY
One mission targets PREMVP or Ireland, never both. A mixed mission is split, or returns
PROMPT_GATE_BLOCKED with REPOSITORY_BOUNDARY_MIXED.

REGISTERED LIFECYCLE
Generic precheck, recovery, dependency bootstrap, review, release, reconciliation and
resume logic belongs to registered commands. Reference a command by its canonical id only
when it exists, has an executable binding, and the selected executor can invoke it. An
invented command id is a compilation failure.

STOP
Recoverable states are never returned to the Founder. These are always executor-owned:
dirty Founder root, missing locked dependencies, generated artifact drift, an existing or
draft pull request, ordinary CI wait, ordinary deployment wait, reviewer correction and
polling, safe state reconciliation, implementation and test correction, and resumable
transport or session interruption.
PROMPT_GATE_BLOCKED is reserved for a genuine canonical hard boundary: ${hardStops}.
Implementation incomplete, remaining work, a failed first attempt and session or runtime
slice exhaustion are NEVER business blocks. Slice exhaustion is transport state and is
represented as a checkpoint, not as a blocker.

FOUNDER CONTRACT
Normal milestone: one start, zero intermediate Founder actions, one final result. Never ask
the Founder for CMD, PowerShell, SQL, Git, a working directory, repository selection,
dependency repair, reviewer operation, ordinary merge or deployment polling, or any secret
transfer. If you are about to ask for an intermediate action, the mission is wrong.

COMPLETION
Validate the terminal result semantically; do not trust the PASS or BLOCKED text. A PASS
requires business-result evidence, not merely green gates. A BLOCKED result requires a
canonical hard_stop_id, the registered recovery paths actually attempted, and why recovery
cannot continue. A WAIT sets founder_action none and never asks the Founder to launch a
recovery prompt. The writing executor may never accept its own state delta.

SOURCE HYGIENE
Never treat NEW_CONTOUR documents, CHATGPT_PROJECT_SETUP.md, old pasted completion reports,
prompt-failure postmortems or EVIDENCE_LEDGER.md as current state. They are historical.
The active Project Sources are exactly four files; anything else in this Project is stale.

FOUNDER PRESENTATION
Answer in Russian, concisely:
  - where we are now;
  - what this mission changes;
  - the expected business result;
  - the selected or recommended executor and model, only when actually resolvable;
  - one compact copyable mission block.
No invented readiness percentage. No long architecture essay before a routine executor
task. No alternative prompts — exactly one block, with no text after it.

NON-EXECUTOR QUESTIONS
When the Founder asks a question that is not an execution request, answer it directly. Do
not fabricate an executor block.

DETAIL
For routing tables, capability verdicts, registered command ids, outcome semantics and the
current roadmap, read CHATGPT_ARCHITECT_PROJECT_BUNDLE.md and ARCHITECT_SNAPSHOT.md rather
than restating canonical policy here.
`;
}

function renderReplaceGuide(manifest) {
  const lines = [];
  const w = (s = '') => lines.push(s);
  w('# REPLACE_PROJECT_SOURCES.md');
  w();
  w('<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:project-package -->');
  w();
  w(`Package schema ${manifest.package_schema_version}. One bounded UI sequence, no shell, no SQL, no secret handling.`);
  w();
  w('## 1. Remove these Project Sources');
  w();
  for (const e of manifest.excluded_historical_sources) w(`- \`${e.name}\` — ${e.reason}`);
  w();
  w('## 2. Add exactly these four Project Sources');
  w();
  for (const s of manifest.active_project_sources) w(`- \`SOURCES/${s.name}\` (${s.role}) — sha256 \`${s.sha256}\``);
  w();
  w('## 3. Replace the Project Instructions');
  w();
  w(`Replace the entire Project Instructions field with the contents of \`PROJECT_INSTRUCTIONS.txt\` — sha256 \`${manifest.project_instructions.sha256}\`. Do not append to the previous instructions.`);
  w();
  w('## 4. Verify');
  w();
  w('`npm run control-plane:project-package:check` must PASS at the commit these files were generated from.');
  w();
  return lines.join('\n');
}

export function buildPackage(root = REPO_ROOT, { sourceCommit } = {}) {
  const files = new Map();

  // Canonical inputs are regenerated first so a stale generated input cannot be copied
  // forward into the Project package.
  const generated = {
    [SNAPSHOT_REL]: renderSnapshot(root),
    [BUNDLE_REL]: renderBundle(root),
  };

  const instructions = lf(renderProjectInstructions(root));
  files.set(`${PACKAGE_REL}/PROJECT_INSTRUCTIONS.txt`, instructions);

  const activeSources = [];
  for (const s of ACTIVE_SOURCES) {
    const text = lf(Object.prototype.hasOwnProperty.call(generated, s.canonical)
      ? generated[s.canonical]
      : readCanonical(root, s.canonical));
    files.set(`${PACKAGE_REL}/SOURCES/${s.name}`, text);
    activeSources.push({
      name: s.name, role: s.role, canonical_path: s.canonical,
      upload_path: `${PACKAGE_REL}/SOURCES/${s.name}`,
      bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text),
    });
  }

  const manifest = {
    package_schema_version: PACKAGE_SCHEMA_VERSION,
    generator: 'scripts/control-plane/generate-chatgpt-project-package.mjs',
    command_id: 'premvp.command.chatgpt_project_package.v1',
    repository: 'POLYPROPICKS/PREMVP',
    generation_direction: 'canonical control plane -> generated Project package (never the reverse)',
    provenance: {
      _volatile: true,
      _note: 'Resolved live at generation time and normalized by --check, which verifies content hashes rather than the commit id.',
      generated_from_commit: sourceCommit || resolveSourceCommit(root),
    },
    active_project_sources: activeSources,
    project_instructions: {
      name: 'PROJECT_INSTRUCTIONS.txt',
      upload_path: `${PACKAGE_REL}/PROJECT_INSTRUCTIONS.txt`,
      word_count: instructions.trim().split(/\s+/).length,
      bytes: Buffer.byteLength(instructions, 'utf8'),
      sha256: sha256(instructions),
    },
    excluded_historical_sources: EXCLUDED_SOURCES.map((e) => ({ ...e })),
    secrets_included: false,
  };

  files.set(`${PACKAGE_REL}/PROJECT_SOURCE_MANIFEST.json`, JSON.stringify(manifest, null, 2) + '\n');
  files.set(`${PACKAGE_REL}/REPLACE_PROJECT_SOURCES.md`, renderReplaceGuide(manifest));

  return { files, manifest, generated };
}

export function checkPackage(root = REPO_ROOT) {
  const errors = [];

  // The canonical generated inputs must themselves be current.
  const snapshot = renderSnapshot(root);
  if (fs.readFileSync(path.join(root, SNAPSHOT_REL), 'utf8') !== snapshot) {
    errors.push('STALE_GENERATED_SNAPSHOT: ARCHITECT_SNAPSHOT.md differs from its deterministic regeneration');
  }
  const bundle = renderBundle(root);
  if (!fs.existsSync(path.join(root, BUNDLE_REL)) ||
      fs.readFileSync(path.join(root, BUNDLE_REL), 'utf8') !== bundle) {
    errors.push('STALE_GENERATED_BUNDLE: CHATGPT_ARCHITECT_PROJECT_BUNDLE.md differs from its deterministic regeneration');
  }

  // Committed package must equal the regeneration, with the volatile commit normalized.
  const committedManifestPath = path.join(root, `${PACKAGE_REL}/PROJECT_SOURCE_MANIFEST.json`);
  let committedCommit;
  if (fs.existsSync(committedManifestPath)) {
    try {
      committedCommit = JSON.parse(fs.readFileSync(committedManifestPath, 'utf8'))?.provenance?.generated_from_commit;
    } catch { /* handled as a mismatch below */ }
  }
  const { files, manifest } = buildPackage(root, { sourceCommit: committedCommit });

  for (const [rel, expected] of files) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) { errors.push(`MISSING_PACKAGE_FILE: ${rel}`); continue; }
    const actual = lf(fs.readFileSync(full, 'utf8'));
    if (actual === expected) continue;
    if (rel.endsWith('PROJECT_INSTRUCTIONS.txt')) errors.push('STALE_PROJECT_INSTRUCTIONS: PROJECT_INSTRUCTIONS.txt differs from its deterministic regeneration');
    else if (rel.endsWith('PROJECT_SOURCE_MANIFEST.json')) errors.push('STALE_PROJECT_SOURCE_MANIFEST: manifest differs from its deterministic regeneration');
    else if (rel.includes('/SOURCES/')) errors.push(`STALE_PROJECT_SOURCE: ${path.basename(rel)} differs from its canonical origin`);
    else errors.push(`STALE_PACKAGE_FILE: ${rel}`);
  }

  // Manifest hashes must match the bytes actually shipped.
  for (const s of manifest.active_project_sources) {
    const full = path.join(root, s.upload_path);
    if (!fs.existsSync(full)) continue;
    if (sha256(lf(fs.readFileSync(full, 'utf8'))) !== s.sha256) {
      errors.push(`PROJECT_SOURCE_HASH_MISMATCH: ${s.name}`);
    }
  }
  const instrPath = path.join(root, manifest.project_instructions.upload_path);
  if (fs.existsSync(instrPath) &&
      sha256(lf(fs.readFileSync(instrPath, 'utf8'))) !== manifest.project_instructions.sha256) {
    errors.push('PROJECT_INSTRUCTIONS_HASH_MISMATCH');
  }

  // The active set may never carry historical policy, and may never contradict canonical policy.
  errors.push(...activeSourceSetViolations(manifest.active_project_sources.map((s) => s.name)));
  for (const [rel, text] of files) {
    if (!rel.includes('/SOURCES/') && !rel.endsWith('PROJECT_INSTRUCTIONS.txt')) continue;
    errors.push(...sourceContradictions(path.basename(rel), text));
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO_ROOT;

  if (args.includes('--check')) {
    const { ok, errors } = checkPackage(root);
    if (args.includes('--json')) process.stdout.write(JSON.stringify({ ok, errors }, null, 2) + '\n');
    else if (ok) process.stdout.write('[control-plane] project-package:check PASS\n');
    else {
      process.stderr.write(`[control-plane] project-package:check FAIL (${errors.length} violation(s))\n`);
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
    }
    process.exit(ok ? 0 : 1);
  }

  const { files } = buildPackage(root);
  for (const [rel, text] of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  }
  process.stdout.write(`[control-plane] project package written: ${PACKAGE_REL} (${files.size} files)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
