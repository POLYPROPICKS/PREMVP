import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateStopGate,
  collectEvidenceState,
  isEvolutionEvidencePath,
  parsePorcelainPaths,
  HOOK_ID,
  CANONICALIZE_COMMAND,
} from '../../.claude/hooks/evolution-governor-stop-gate.mjs';
import {
  CYCLES_PREFIX,
  PROPOSALS_PREFIX,
} from '../../scripts/control-plane/lib/evolution-canonicalize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------------------
// Deterministic fake git + fake canonicalizer. Nothing here touches a real repo or spawns
// a real process — the hook delegates its verdict, it never re-implements the canonicalizer.
// ---------------------------------------------------------------------------------------

function fakeGit({ branch = 'claude/evolution-lineage', hasOriginMain = true, porcelain = '', diffFiles = [] } = {}) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return `${branch}\n`;
    if (args[0] === 'rev-parse' && args.includes('origin/main')) return hasOriginMain ? 'abc123\n' : '';
    if (args[0] === 'rev-parse' && args.includes('main')) return 'abc123\n';
    if (args[0] === 'status') return porcelain;
    if (args[0] === 'diff' && args.includes('--name-only')) return `${diffFiles.join('\n')}\n`;
    return '';
  };
  runGit.calls = calls;
  return runGit;
}

function admitOk(admitted) {
  return () => ({ status: 0, stdout: JSON.stringify({ ok: true, command_id: 'premvp.command.evolution_canonicalize.v1', ...admitted }), stderr: '' });
}
function admitFail(errors) {
  return () => ({ status: 1, stdout: JSON.stringify({ ok: false, errors }), stderr: '' });
}
function admitHardFailure() {
  return () => ({ status: 2, stdout: '', stderr: 'fatal: bad revision \'origin/main...HEAD\'' });
}
function admitNeverCalled() {
  return () => { throw new Error('runAdmit must not be called when there is no committed evidence'); };
}

const CYCLE_JSON = `${CYCLES_PREFIX}2026-08-29__real.json`;
const CYCLE_REPORT = `${CYCLES_PREFIX}2026-08-29__real.report.md`;
const GOV_JSON = `${PROPOSALS_PREFIX}GOV-REAL-1.json`;
const GOV_REPORT = `${PROPOSALS_PREFIX}GOV-REAL-1.report.md`;

// ---------------------------------------------------------------------------------------
// path classification
// ---------------------------------------------------------------------------------------

test('only cycle / roadmap-proposal json + report paths count as Evolution evidence', () => {
  assert.equal(isEvolutionEvidencePath(CYCLE_JSON), true);
  assert.equal(isEvolutionEvidencePath(CYCLE_REPORT), true);
  assert.equal(isEvolutionEvidencePath(GOV_JSON), true);
  assert.equal(isEvolutionEvidencePath(GOV_REPORT), true);
  assert.equal(isEvolutionEvidencePath(`${CYCLES_PREFIX}README.md`), false);
  assert.equal(isEvolutionEvidencePath('docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml'), false);
  assert.equal(isEvolutionEvidencePath('lib/feed/buildLandingCards.ts'), false);
});

test('parsePorcelainPaths handles modified, untracked and renamed entries', () => {
  const porcelain = [
    ` M ${CYCLE_JSON}`,
    `?? ${CYCLE_REPORT}`,
    `R  old/path.json -> ${GOV_JSON}`,
  ].join('\n');
  assert.deepEqual(parsePorcelainPaths(porcelain), [CYCLE_JSON, CYCLE_REPORT, GOV_JSON]);
});

// ---------------------------------------------------------------------------------------
// TERMINAL — a validated cycle that has not completed terminal persistence blocks Stop
// ---------------------------------------------------------------------------------------

test('TERMINAL: validated Evolution cycle, not yet canonical -> Stop is blocked', () => {
  const runGit = fakeGit({ diffFiles: [CYCLE_JSON, CYCLE_REPORT] });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitOk({ cycles: ['2026-08-29__real'], governor_results: [] }) });
  assert.equal(verdict.decision, 'BLOCK');
  assert.equal(verdict.code, 2);
  assert.equal(verdict.reason, 'CASE_3_VALIDATED_NOT_CANONICAL');
  assert.match(verdict.message, /control-plane:evolution:canonicalize -- --canonicalize --branch claude\/evolution-lineage --executor <selected-executor>/);
  assert.match(verdict.message, /mandatory/i);
});

// ---------------------------------------------------------------------------------------
// TERMINAL — same behaviour for a Governor result
// ---------------------------------------------------------------------------------------

test('TERMINAL: validated Governor result, not yet canonical -> Stop is blocked', () => {
  const runGit = fakeGit({ branch: 'claude/governor-lineage', diffFiles: [GOV_JSON, GOV_REPORT] });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitOk({ cycles: [], governor_results: ['GOV-REAL-1'] }) });
  assert.equal(verdict.decision, 'BLOCK');
  assert.equal(verdict.reason, 'CASE_3_VALIDATED_NOT_CANONICAL');
  assert.match(verdict.message, /governor result GOV-REAL-1/);
  assert.match(verdict.message, /--branch claude\/governor-lineage/);
});

test('TERMINAL: an Evolution artifact produced but not yet committed also blocks Stop', () => {
  const runGit = fakeGit({ porcelain: `?? ${CYCLE_JSON}\n?? ${CYCLE_REPORT}\n` });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitNeverCalled() });
  assert.equal(verdict.decision, 'BLOCK');
  assert.equal(verdict.reason, 'CASE_3_EVIDENCE_UNCOMMITTED');
  assert.match(verdict.message, /not yet committed/);
});

// ---------------------------------------------------------------------------------------
// TERMINAL — after registered canonicalization terminal proof, Stop is allowed
// ---------------------------------------------------------------------------------------

test('TERMINAL: once the lineage is canonical on origin/main, Stop is allowed', () => {
  // lineage merged -> `origin/main...HEAD` reports no evidence, working tree clean
  const runGit = fakeGit({ porcelain: '', diffFiles: [] });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitNeverCalled() });
  assert.equal(verdict.decision, 'ALLOW');
  assert.equal(verdict.code, 0);
  assert.equal(verdict.reason, 'CASE_1_OR_4_NO_PENDING_EVOLUTION_PERSISTENCE');
});

// ---------------------------------------------------------------------------------------
// TERMINAL — invalid / unvalidated artifacts are not canonicalized
// ---------------------------------------------------------------------------------------

test('TERMINAL: an artifact that fails admission is NOT canonicalized and Stop is allowed', () => {
  const runGit = fakeGit({ diffFiles: [CYCLE_JSON, CYCLE_REPORT] });
  const errors = ['MALFORMED_ARTIFACT: ' + CYCLE_JSON + ': founder_practices is required'];
  const verdict = evaluateStopGate({ runGit, runAdmit: admitFail(errors) });
  assert.equal(verdict.decision, 'ALLOW');
  assert.equal(verdict.reason, 'CASE_2_ADMISSION_FAILED');
  assert.match(verdict.message, /NOT canonicalized/);
  assert.match(verdict.message, /MALFORMED_ARTIFACT/);
});

// ---------------------------------------------------------------------------------------
// TERMINAL — sessions unrelated to Evolution/Governor are unaffected
// ---------------------------------------------------------------------------------------

test('TERMINAL: a session that touched no Evolution/Governor evidence is unaffected', () => {
  const runGit = fakeGit({
    porcelain: ' M lib/feed/buildLandingCards.ts\n?? scripts/build-public-t90-v1.mjs\n',
    diffFiles: ['lib/feed/types.ts', 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'],
  });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitNeverCalled() });
  assert.equal(verdict.decision, 'ALLOW');
  assert.equal(verdict.reason, 'CASE_1_OR_4_NO_PENDING_EVOLUTION_PERSISTENCE');
});

// ---------------------------------------------------------------------------------------
// TERMINAL — no duplicate canonicalization for an already-terminal lineage
// ---------------------------------------------------------------------------------------

test('TERMINAL: no canonicalization is driven for an already-terminal lineage', () => {
  // HEAD is an ancestor of origin/main: three-dot diff is empty even though the branch ref exists
  const runGit = fakeGit({ porcelain: '', diffFiles: [] });
  let admitCalls = 0;
  const verdict = evaluateStopGate({ runGit, runAdmit: () => { admitCalls += 1; return { status: 0, stdout: '{}', stderr: '' }; } });
  assert.equal(verdict.decision, 'ALLOW');
  assert.equal(admitCalls, 0, 'the canonicalizer must not be probed when there is nothing pending');
});

// ---------------------------------------------------------------------------------------
// TERMINAL — the hook delegates to the existing canonicalizer, it does not re-implement it
// ---------------------------------------------------------------------------------------

test('TERMINAL: the hook delegates the admission verdict to premvp.command.evolution_canonicalize.v1', () => {
  const seen = [];
  const runGit = fakeGit({ diffFiles: [CYCLE_JSON, CYCLE_REPORT] });
  const runAdmit = (args) => { seen.push(args); return { status: 0, stdout: JSON.stringify({ ok: true, cycles: ['2026-08-29__real'], governor_results: [] }), stderr: '' }; };
  evaluateStopGate({ runGit, runAdmit });
  assert.equal(seen.length, 1, 'exactly one delegated admission call');
  assert.equal(seen[0].base, 'origin/main');
  // the hook file itself must not contain PR / merge / ancestry mechanics
  const src = fs.readFileSync(path.join(REPO_ROOT, '.claude/hooks/evolution-governor-stop-gate.mjs'), 'utf8');
  assert.doesNotMatch(src, /github-pr-create|github-pr-merge|create_pull_request|merge_pull_request|merge-base/);
});

test('TERMINAL: a genuine canonicalizer hard failure fails closed with the causal error', () => {
  const runGit = fakeGit({ diffFiles: [CYCLE_JSON, CYCLE_REPORT] });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitHardFailure() });
  assert.equal(verdict.decision, 'BLOCK');
  assert.equal(verdict.reason, 'CASE_5_CANONICALIZER_HARD_FAILURE');
  assert.match(verdict.message, /bad revision/);
  assert.match(verdict.message, /no alternative persistence path/);
});

test('offline fallback: with no origin/main and no evidence, Stop is allowed', () => {
  const runGit = fakeGit({ hasOriginMain: false, porcelain: '', diffFiles: [] });
  const verdict = evaluateStopGate({ runGit, runAdmit: admitNeverCalled() });
  assert.equal(verdict.decision, 'ALLOW');
});

// ---------------------------------------------------------------------------------------
// registration + wiring
// ---------------------------------------------------------------------------------------

test('the Stop-gate hook is wired into .claude/settings.json alongside the proof-package hook', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude/settings.json'), 'utf8'));
  const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCommands.some((c) => c.includes('validate-proof-package.mjs')), 'proof-package hook preserved');
  assert.ok(stopCommands.some((c) => c.includes('evolution-governor-stop-gate.mjs')), 'stop-gate hook wired');
});

test('the Stop-gate hook is registered in AGENT_REGISTRY.yaml as an automatic HOOK', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'), 'utf8'));
  const entry = registry.entries.find((e) => e.canonical_id === HOOK_ID);
  assert.ok(entry, `${HOOK_ID} is not registered`);
  assert.equal(entry.type, 'HOOK');
  assert.equal(entry.invocation, 'AUTOMATIC');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.implementation_path)));
});

test('collectEvidenceState de-dupes and separates dirty from committed evidence', () => {
  const runGit = fakeGit({ porcelain: ` M ${CYCLE_JSON}\n`, diffFiles: [CYCLE_JSON, CYCLE_REPORT] });
  const state = collectEvidenceState(runGit);
  assert.deepEqual(state.dirty, [CYCLE_JSON]);
  assert.deepEqual(state.committed, [CYCLE_REPORT]); // CYCLE_JSON is dirty, excluded from committed
  assert.equal(state.branch, 'claude/evolution-lineage');
});

assert.equal(typeof CANONICALIZE_COMMAND, 'string');
