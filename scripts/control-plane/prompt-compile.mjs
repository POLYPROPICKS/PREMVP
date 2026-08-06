#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { compilePrompt, loadRegistry, COMMAND_ID } from './lib/prompt-compile.mjs';
const args = process.argv.slice(2); const i = args.indexOf('--input');
if (args.includes('--help') || i < 0) { console.log(`${COMMAND_ID}\nUsage: --input <compact-manifest.json> [--json]`); process.exit(i < 0 ? 1 : 0); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = compilePrompt(JSON.parse(fs.readFileSync(args[i + 1], 'utf8')), loadRegistry(root));
console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : result.ok ? result.prompt : result.errors.join('\n'));
process.exit(result.ok ? 0 : 1);
