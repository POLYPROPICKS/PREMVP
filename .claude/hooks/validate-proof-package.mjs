#!/usr/bin/env node
/**
 * validate-proof-package.mjs
 * Claude Code Stop hook — validates that patch-type responses include
 * a complete proof package per CLAUDE.md §7.
 *
 * Exit codes:
 *   0  — validation passed or response is not a patch (no action)
 *   2  — patch response detected but proof package is incomplete
 *
 * Usage (Claude Code Stop hook):
 *   node .claude/hooks/validate-proof-package.mjs <transcript_path>
 */

import fs from 'node:fs';
import path from 'node:path';

const transcriptPath = process.argv[2] || process.env.CLAUDE_TRANSCRIPT_PATH || '';

if (!transcriptPath) {
  // No transcript available — skip silently
  process.exit(0);
}

// --- Read and parse transcript ---
let lines;
try {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  lines = raw.split('\n').filter(l => l.trim());
} catch {
  // Cannot read transcript — skip silently
  process.exit(0);
}

// --- Find last assistant message ---
let lastAssistantText = '';
for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (!entry || typeof entry !== 'object') continue;

  const role = entry.role ?? entry.type ?? '';
  if (role !== 'assistant') continue;

  // Extract text content (handles both string and array content)
  let text = '';
  if (typeof entry.content === 'string') {
    text = entry.content;
  } else if (Array.isArray(entry.content)) {
    text = entry.content
      .filter(c => c?.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
  } else if (entry.message && typeof entry.message.content === 'string') {
    text = entry.message.content;
  } else if (entry.message && Array.isArray(entry.message.content)) {
    text = entry.message.content
      .filter(c => c?.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
  }

  if (text) lastAssistantText = text;
}

if (!lastAssistantText) {
  process.exit(0);
}

const msg = lastAssistantText;

// --- Classify: is this a patch-type response? ---
// Patch signals: response contains code change indicators
const PATCH_SIGNALS = [
  /files\s+changed\s*:/i,
  /old\s+snippet\s*:/i,
  /new\s+snippet\s*:/i,
  /git\s+diff\s+--stat/i,
  /gate\s*1\s*(verdict|:)/i,
  /\bpatch\b.*\bapplied\b/i,
];

// Skip signals: inspect-only, docs, architecture, non-patch tasks
const SKIP_SIGNALS = [
  /task\s+classification\s*:.*inspect.only/i,
  /task\s+classification\s*:.*docs/i,
  /task\s+classification\s*:.*architecture/i,
  /execution\s+mode\s*:.*inspect/i,
  /inspect.only/i,
  /no\s+files?\s+(changed|modified)/i,
  /\bno\s+patch\b/i,
  /\bread.only\b/i,
];

// Check skip first
const shouldSkip = SKIP_SIGNALS.some(re => re.test(msg));
if (shouldSkip) {
  process.exit(0);
}

// Check patch signals
const isPatch = PATCH_SIGNALS.some(re => re.test(msg));
if (!isPatch) {
  process.exit(0);
}

// --- Validate required proof-package fields ---
const REQUIRED_FIELDS = [
  {
    name: 'git status',
    patterns: [/git\s+status/i, /git status --short/i],
  },
  {
    name: 'git diff --stat',
    patterns: [/git\s+diff\s+--stat/i, /git diff --stat/i],
  },
  {
    name: 'npm run build (or explicit N/A)',
    patterns: [/npm\s+run\s+build/i, /npm run build\s*:\s*(PASS|FAIL|N\/A)/i, /build\s*:\s*(PASS|FAIL|N\/A|not run)/i],
  },
  {
    name: 'OLD SNIPPET',
    patterns: [/old\s+snippet/i, /OLD SNIPPET/],
  },
  {
    name: 'NEW SNIPPET',
    patterns: [/new\s+snippet/i, /NEW SNIPPET/],
  },
  {
    name: 'Gate 1 verdict',
    patterns: [/gate\s*1\s*(verdict|:|\s)/i, /GATE\s*1/],
  },
];

const missing = REQUIRED_FIELDS.filter(
  field => !field.patterns.some(re => re.test(msg))
);

if (missing.length === 0) {
  process.exit(0);
}

// --- Report missing fields ---
const fieldList = missing.map(f => `  - ${f.name}`).join('\n');
process.stderr.write(
  `\n[proof-package-hook] INCOMPLETE PROOF PACKAGE detected.\n` +
  `Missing required fields (${missing.length}/${REQUIRED_FIELDS.length}):\n` +
  `${fieldList}\n\n` +
  `Required per CLAUDE.md §7:\n` +
  `  - git status --short\n` +
  `  - git diff --stat\n` +
  `  - npm run build (or explicit "npm run build: N/A — <reason>")\n` +
  `  - Old snippet\n` +
  `  - New snippet\n` +
  `  - Gate 1 verdict\n\n` +
  `This response appears to be a patch but is missing proof-package fields.\n` +
  `The agent must provide a complete §7 proof package before claiming done.\n\n`
);
process.exit(2);
