#!/usr/bin/env node
/**
 * premvp.command.mission_compile.v1
 *
 * Usage:
 *   node scripts/control-plane/mission-compile.mjs --input <mission.json> [--phase START_GATE|TERMINAL] [--json]
 *
 * Exit codes: 0 — mission compiles; 1 — one or more semantic violations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMission, loadRegistry, COMMAND_ID } from './lib/mission-compile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--input');
  if (args.includes('--help') || i < 0) {
    process.stdout.write(`${COMMAND_ID}\nUsage: --input <mission.json> [--phase START_GATE|TERMINAL] [--json]\n`);
    process.exit(i < 0 ? 1 : 0);
  }
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO_ROOT;
  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : 'START_GATE';

  const mission = JSON.parse(fs.readFileSync(path.resolve(args[i + 1]), 'utf8'));
  const result = compileMission(mission, { root, registry: loadRegistry(root) }, { phase });

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(result.prompt + '\n');
  } else {
    process.stderr.write(`[control-plane] mission: FAIL (${result.errors.length} violation(s))\n`);
    for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
