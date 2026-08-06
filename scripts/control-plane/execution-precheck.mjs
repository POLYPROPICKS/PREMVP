#!/usr/bin/env node
import fs from 'node:fs';
import { classifyExecutionPrecheck, COMMAND_ID } from './lib/execution-precheck.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(`${COMMAND_ID}\nUsage: --classify|--prepare|--status|--resume --input <json> [--json]`); process.exit(0); }
const mode = ['--classify', '--prepare', '--status', '--resume'].find((x) => args.includes(x));
const idx = args.indexOf('--input');
if (!mode || idx < 0 || !args[idx + 1]) { console.error('execution-precheck requires one mode and --input <json>'); process.exit(1); }
const result = classifyExecutionPrecheck(JSON.parse(fs.readFileSync(args[idx + 1], 'utf8')));
result.mode = mode.slice(2);
console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : `[execution-precheck] ${result.verdict}`);
process.exit(result.verdict === 'BLOCKED' ? 1 : 0);
