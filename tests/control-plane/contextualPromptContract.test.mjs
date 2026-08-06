import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compilePrompt } from '../../scripts/control-plane/lib/prompt-compile.mjs';
import { validateCommandBindings } from '../../scripts/control-plane/validate-command-bindings.mjs';
const root = path.resolve(import.meta.dirname, '..', '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml')));
const base = { TASK: 'Trace Final Identity load.', 'BUSINESS RESULT': 'Exact source boundary proven.', EXECUTOR: 'local_codex_windows', 'REPOSITORY / AUTHORITY': 'POLYPROPICKS/PREMVP at live origin/main', 'MODE / PERMISSIONS': 'inspection only', SCOPE: 'canonical source trace only', COMMANDS: ['premvp.command.execution_precheck.v1'], ACCEPTANCE: { business_result_proven: false }, EVIDENCE: 'Git ancestry and targeted tests', OUTPUT: { verdict: 'DIAGNOSIS_COMPLETE', next_actions: ['Select one next task'] }, MODULES: { STATE: 'Use canonical current state.' } };
test('registered commands have executable bindings', () => assert.deepEqual(validateCommandBindings(root).errors, []));
test('inspection emits only applicable modules and no empty heading', () => { const r = compilePrompt(base, registry); assert.equal(r.ok, true, r.errors); assert.deepEqual(r.emitted_modules, ['STATE']); assert.ok(!r.prompt.includes('## RELEASE')); });
test('rejects unregistered commands, manual orchestration, and PASS without value proof', () => {
 assert.match(compilePrompt({ ...base, COMMANDS: ['nope'] }, registry).errors.join('\n'), /COMMAND_REFERENCE_NOT_EXECUTABLE/);
 assert.match(compilePrompt({ ...base, SCOPE: 'git fetch and poll deployment' }, registry).errors.join('\n'), /PROMPT_MANUAL_ORCHESTRATION_DUPLICATION/);
 assert.match(compilePrompt({ ...base, OUTPUT: { verdict: 'PASS', next_actions: ['one'] } }, registry).errors.join('\n'), /PASS_WITHOUT_BUSINESS_RESULT/);
});
