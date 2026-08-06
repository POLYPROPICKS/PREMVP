import fs from 'node:fs';
import path from 'node:path';

export const COMMAND_ID = 'premvp.command.prompt_compile.v2';
export const CORE = ['TASK', 'BUSINESS RESULT', 'EXECUTOR', 'REPOSITORY / AUTHORITY', 'MODE / PERMISSIONS', 'SCOPE', 'COMMANDS', 'ACCEPTANCE', 'EVIDENCE', 'OUTPUT'];
export const OPTIONAL = ['DATABASE', 'REVIEWER', 'RELEASE', 'PRODUCTION OBSERVATION', 'STATE', 'RESUME', 'LIVE MONEY'];
const ORCHESTRATION = /\b(dirty.worktree|git fetch|create pull request|merge pull request|poll.*deploy|CI polling|state refresh|reviewer polling)\b/i;
const GENERIC_STOP = /\b(CONTROL_PLANE_DIRTY_WORKTREE|SAFE_STATE_REFRESH|REQUIRED_CI_PENDING)\b/;

function words(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }
function heading(name, value) { return `## ${name}\n${Array.isArray(value) ? value.map((v) => `- ${v}`).join('\n') : value}`; }

export function compilePrompt(manifest, registry) {
  const errors = [];
  for (const key of CORE) if (!manifest?.[key]) errors.push(`MISSING_MANIFEST_CORE: ${key}`);
  if (manifest?.EXECUTOR === 'default' || manifest?.EXECUTOR === 'fallback') errors.push('DEFAULT_OR_FALLBACK_EXECUTOR');
  const commandIds = manifest?.COMMANDS || [];
  const known = new Set((registry?.entries || []).filter((x) => x.type === 'COMMAND' && x.implementation_path).map((x) => x.canonical_id));
  for (const id of commandIds) if (!known.has(id)) errors.push(`COMMAND_REFERENCE_NOT_EXECUTABLE: ${id}`);
  const prose = JSON.stringify(manifest);
  if (ORCHESTRATION.test(prose)) errors.push('PROMPT_MANUAL_ORCHESTRATION_DUPLICATION');
  if (GENERIC_STOP.test(prose)) errors.push('GENERIC_ORCHESTRATION_STOP_REPEATED');
  const modules = Object.entries(manifest?.MODULES || {}).filter(([, value]) => value).map(([key]) => key);
  for (const key of modules) if (!OPTIONAL.includes(key)) errors.push(`UNKNOWN_MODULE: ${key}`);
  if (manifest?.OUTPUT?.verdict === 'PASS' && manifest?.ACCEPTANCE?.business_result_proven !== true) errors.push('PASS_WITHOUT_BUSINESS_RESULT');
  if (Array.isArray(manifest?.OUTPUT?.next_actions) && manifest.OUTPUT.next_actions.length !== 1) errors.push('MULTIPLE_NEXT_ACTIONS');
  if (errors.length) return { ok: false, errors, command_id: COMMAND_ID };
  const sections = CORE.map((key) => heading(key, manifest[key]));
  for (const key of modules) sections.push(heading(key, manifest.MODULES[key]));
  const prompt = `# Contextual executor prompt\n\n${sections.join('\n\n')}\n\nRegistered commands own their internal orchestration. Recoverable and WAIT outcomes require founder_action: none.`;
  const count = words(prompt);
  const maximum = modules.includes('RELEASE') ? 900 : manifest?.MODE?.includes('inspection') ? 2000 : 1200;
  if (count > maximum && !manifest?.SIZE_JUSTIFICATION) errors.push(`PROMPT_SIZE_EXCEEDED: ${count}/${maximum}`);
  return { ok: errors.length === 0, errors, command_id: COMMAND_ID, prompt, emitted_modules: modules, omitted_modules: OPTIONAL.filter((x) => !modules.includes(x)), word_count: count, registered_commands_referenced: commandIds };
}

export function loadRegistry(root) { return JSON.parse(fs.readFileSync(path.join(root, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'), 'utf8')); }
