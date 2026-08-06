import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL = 'docs/ai-context/control-plane';
const STATE_FILES = ['CURRENT_STATE.yaml', 'EVIDENCE_LEDGER.md', 'ARCHITECT_SNAPSHOT.md'];

export function reconcilePlan({ mode, baseline = null }) {
  if (!['plan', 'apply-non-state', 'apply-state', 'verify'].includes(mode)) {
    throw new Error(`RECONCILE_INVALID_MODE: ${mode}`);
  }
  if (mode === 'apply-state' && !/^[0-9a-f]{40}$/i.test(baseline || '')) {
    throw new Error('RECONCILE_BASELINE_REQUIRED: --apply-state requires a full implementation SHA');
  }
  return { command_id: 'premvp.command.control_plane_reconcile.v1', mode, baseline,
    state_files: STATE_FILES.map((f) => `${CONTROL}/${f}`), atomic: true,
    authority: ['live Git/runtime evidence', 'CURRENT_STATE.yaml', 'CAPABILITY_MATRIX.yaml', 'ROUTING_AND_PIPELINES.yaml', 'AGENT_REGISTRY.yaml', 'PROMPT__PROTOCOL.md'] };
}

export function stageAtomically(root, writes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-reconcile-'));
  try {
    for (const [relative, content] of Object.entries(writes)) {
      const candidate = path.join(dir, relative);
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, content, 'utf8');
      JSON.parse(content);
    }
    for (const [relative] of Object.entries(writes)) {
      fs.renameSync(path.join(dir, relative), path.join(root, relative));
    }
    return { ok: true, phase: 'REPLACED_ATOMICALLY' };
  } catch (error) {
    return { ok: false, phase: 'STAGING_VALIDATION', error: error.message };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
