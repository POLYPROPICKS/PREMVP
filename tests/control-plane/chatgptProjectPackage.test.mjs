/**
 * chatgptProjectPackage.test.mjs
 *
 * CP-HARDENING-01 source-drift suite.
 *
 * There is exactly one direction of generation: canonical control plane → generated
 * Project package. These tests prove a stale or historical Project source cannot silently
 * contradict canonical policy, by mutating a temporary copy of the repository's
 * control-plane surface and asserting --check catches it.
 *
 * Run: node --test tests/control-plane/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ACTIVE_SOURCES,
  EXCLUDED_SOURCES,
  PACKAGE_REL,
  activeSourceSetViolations,
  buildPackage,
  checkPackage,
  sourceContradictions,
} from '../../scripts/control-plane/generate-chatgpt-project-package.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

/**
 * Copies the control-plane surface into a throwaway root, writes a fresh package there,
 * and hands the caller a clean baseline to perturb. The real repository is never mutated.
 */
function withTempPackage(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-package-'));
  try {
    fs.cpSync(path.join(root, 'docs/ai-context/control-plane'),
      path.join(tmp, 'docs/ai-context/control-plane'), { recursive: true });
    const { files } = buildPackage(tmp, { sourceCommit: 'DETERMINISTIC_TEST_COMMIT' });
    for (const [rel, text] of files) {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    }
    assert.deepEqual(checkPackage(tmp).errors, [], 'temp baseline must start clean');
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function errorsAfter(mutate) {
  return withTempPackage((tmp) => {
    mutate(tmp);
    return checkPackage(tmp).errors.join('\n');
  });
}

test('the committed package is current at this commit', () => {
  const { ok, errors } = checkPackage(root);
  assert.equal(ok, true, errors.join('\n'));
});

test('the package is deterministic — two builds are byte-identical', () => {
  const a = buildPackage(root, { sourceCommit: 'X' });
  const b = buildPackage(root, { sourceCommit: 'X' });
  assert.deepEqual([...a.files.entries()], [...b.files.entries()]);
});

test('exactly four active Project Sources are generated', () => {
  const { manifest } = buildPackage(root, { sourceCommit: 'X' });
  assert.equal(manifest.active_project_sources.length, 4);
  assert.deepEqual(manifest.active_project_sources.map((s) => s.name), [
    'ARCHITECT_SNAPSHOT.md',
    'CHATGPT_ARCHITECT_PROJECT_BUNDLE.md',
    'PROMPT__PROTOCOL.md',
    'COMPLETION_ENVELOPE.schema.json',
  ]);
  assert.equal(manifest.secrets_included, false);
  for (const s of manifest.active_project_sources) assert.match(s.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.project_instructions.sha256, /^[0-9a-f]{64}$/);
});

test('15. a stale generated bundle fails --check', () => {
  const errors = errorsAfter((tmp) => {
    fs.appendFileSync(
      path.join(tmp, 'docs/ai-context/control-plane/chatgpt-architect/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md'),
      '\nHand-edited drift.\n');
  });
  assert.match(errors, /STALE_GENERATED_BUNDLE/);
});

test('15b. a stale generated snapshot fails --check', () => {
  const errors = errorsAfter((tmp) => {
    fs.appendFileSync(path.join(tmp, 'docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md'),
      '\nHand-edited drift.\n');
  });
  assert.match(errors, /STALE_GENERATED_SNAPSHOT/);
});

test('16. stale PROJECT_INSTRUCTIONS.txt fails --check', () => {
  const errors = errorsAfter((tmp) => {
    fs.appendFileSync(path.join(tmp, PACKAGE_REL, 'PROJECT_INSTRUCTIONS.txt'),
      '\nOld instruction pasted back in.\n');
  });
  assert.match(errors, /STALE_PROJECT_INSTRUCTIONS/);
  assert.match(errors, /PROJECT_INSTRUCTIONS_HASH_MISMATCH/);
});

test('17. a stale Project Source or manifest hash fails --check', () => {
  const stale = errorsAfter((tmp) => {
    fs.appendFileSync(path.join(tmp, PACKAGE_REL, 'SOURCES/PROMPT__PROTOCOL.md'),
      '\nAll 25 sections must be populated.\n');
  });
  assert.match(stale, /STALE_PROJECT_SOURCE: PROMPT__PROTOCOL\.md/);
  assert.match(stale, /PROJECT_SOURCE_HASH_MISMATCH: PROMPT__PROTOCOL\.md/);

  const manifest = errorsAfter((tmp) => {
    const p = path.join(tmp, PACKAGE_REL, 'PROJECT_SOURCE_MANIFEST.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.active_project_sources[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  });
  assert.match(manifest, /STALE_PROJECT_SOURCE_MANIFEST/);
});

test('17b. a canonical policy edit that is not regenerated fails --check', () => {
  // The canonical file moves; the uploaded Source does not. That is precisely the drift
  // that let a stale ChatGPT Project override live policy.
  const errors = errorsAfter((tmp) => {
    fs.appendFileSync(path.join(tmp, 'docs/ai-context/control-plane/PROMPT__PROTOCOL.md'),
      '\n<!-- canonical policy moved forward -->\n');
  });
  assert.match(errors, /STALE_PROJECT_SOURCE: PROMPT__PROTOCOL\.md/);
});

test('18. historical policy sources can never enter the active SOURCES set', () => {
  const names = ACTIVE_SOURCES.map((s) => s.name);
  assert.deepEqual(activeSourceSetViolations(names), []);

  for (const historical of ['NEW_CONTOUR_3.md', 'NEW_CONTOUR_4.md', 'CHATGPT_PROJECT_SETUP.md', 'EVIDENCE_LEDGER.md']) {
    const violations = activeSourceSetViolations([...names, historical]);
    assert.match(violations.join('\n'), /EXCLUDED_HISTORICAL_SOURCE_IN_ACTIVE_SET/, historical);
  }

  // And they are recorded as explicit exclusions the Founder can act on.
  const excluded = EXCLUDED_SOURCES.map((e) => e.name);
  for (const n of ['CHATGPT_PROJECT_SETUP.md', 'NEW_CONTOUR_3.md', 'NEW_CONTOUR_4.md', 'EVIDENCE_LEDGER.md']) {
    assert.ok(excluded.includes(n), `${n} must be listed as an excluded historical source`);
  }
});

test('18b. an active source that reintroduces retired policy is rejected', () => {
  assert.match(
    sourceContradictions('X.md', 'Reminder: all 25 sections must be populated.').join('\n'),
    /ACTIVE_SOURCE_CONTRADICTS_CANONICAL_POLICY: X\.md — LEGACY_25_SECTION_MODEL/);
  assert.match(
    sourceContradictions('X.md', 'Invoke all agents for every task.').join('\n'),
    /ALL_AGENT_ROUTING/);
  assert.match(
    sourceContradictions('X.md', 'EVIDENCE_LEDGER.md is the current state of the system.').join('\n'),
    /EVIDENCE_LEDGER_AS_CURRENT_STATE/);
  assert.deepEqual(sourceContradictions('X.md', 'Write one compact Mission Contract.'), []);
});

test('the shipped active sources and instructions contain no retired policy', () => {
  const { files } = buildPackage(root, { sourceCommit: 'X' });
  for (const [rel, text] of files) {
    if (!rel.includes('/SOURCES/') && !rel.endsWith('PROJECT_INSTRUCTIONS.txt')) continue;
    assert.deepEqual(sourceContradictions(path.basename(rel), text), []);
  }
});

test('the package has an explicit LF checkout contract and no CRLF drift', () => {
  // Without this, a CRLF checkout would make --check fail on every non-LF host and the
  // drift guard would be unusable exactly where the Founder runs it.
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^docs\/ai-context\/control-plane\/chatgpt-architect\/\*\* text eol=lf$/m);

  const { files } = buildPackage(root, { sourceCommit: 'X' });
  for (const [rel, text] of files) {
    assert.ok(!text.includes('\r\n'), `${rel} generator must emit LF-only output`);
    const committed = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!committed.includes('\r\n'), `${rel} must be checked out LF-only`);
  }

  // The blanket *.json ignore rule must not swallow canonical control-plane artifacts.
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^!docs\/ai-context\/control-plane\/\*\*\/\*\.json$/m);
});

test('PROJECT_INSTRUCTIONS.txt stays within its length budget', () => {
  const { manifest } = buildPackage(root, { sourceCommit: 'X' });
  assert.ok(manifest.project_instructions.word_count <= 1600,
    `instructions are ${manifest.project_instructions.word_count} words, budget is 1600`);
  assert.ok(manifest.project_instructions.word_count >= 400,
    'instructions must still cover the full replacement contract');
});
