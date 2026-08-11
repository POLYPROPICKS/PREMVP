#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function validateCommandBindings(repoRoot = root) {
 const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'), 'utf8'));
 const errors = [];
 for (const entry of registry.entries.filter((x) => ['COMMAND', 'SKILL'].includes(x.type) && x.status === 'PROVEN_PRESENT')) {
   if (!entry.implementation_path) errors.push(`COMMAND_REFERENCE_NOT_EXECUTABLE: ${entry.canonical_id}`);
   else if (!fs.existsSync(path.join(repoRoot, entry.implementation_path))) errors.push(`COMMAND_REFERENCE_NOT_EXECUTABLE: ${entry.canonical_id} -> ${entry.implementation_path}`);
 }
 return { ok: errors.length === 0, errors };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const r = validateCommandBindings(); console.log(r.ok ? 'command bindings: PASS' : r.errors.join('\n')); process.exit(r.ok ? 0 : 1); }
