#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const input = JSON.parse(process.argv[2] || '{}');
if (!input.repository || !input.source_branch || !input.target_branch || !input.title) throw new Error('repository, source_branch, target_branch and title are required');
const existing = execFileSync('gh', ['pr', 'list', '--repo', input.repository, '--head', input.source_branch, '--base', input.target_branch, '--state', 'open', '--json', 'number,url,headRefOid'], { encoding: 'utf8' });
const rows = JSON.parse(existing); if (rows[0]) console.log(JSON.stringify({ reused: true, ...rows[0] }));
else console.log(execFileSync('gh', ['pr', 'create', '--repo', input.repository, '--head', input.source_branch, '--base', input.target_branch, '--title', input.title, '--body', input.body || ''], { encoding: 'utf8' }).trim());
