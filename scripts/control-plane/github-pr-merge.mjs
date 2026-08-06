#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const input = JSON.parse(process.argv[2] || '{}');
if (!input.repository || !input.number) throw new Error('repository and number are required');
console.log(execFileSync('gh', ['pr', 'merge', String(input.number), '--repo', input.repository, '--merge', '--delete-branch=false'], { encoding: 'utf8' }).trim());
