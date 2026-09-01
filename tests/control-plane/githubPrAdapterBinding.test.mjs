import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GitHubPrAdapterBindingError,
  readGitHubPrRegistry,
  resolveGitHubPrAdapter,
} from '../../scripts/control-plane/lib/github-pr-adapter-binding.mjs';
import { resolveCanonicalizationAdapters } from '../../scripts/control-plane/evolution-canonicalize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = readGitHubPrRegistry(REPO_ROOT);

test('cloud PR adapters resolve only to the registered GitHub MCP operations', () => {
  const create = resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_create.v1', executorId: 'claude_code_cloud' });
  const merge = resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_merge.v1', executorId: 'claude_code_cloud' });
  assert.deepEqual(
    { transport: create.transport, operation: create.operation, capability: create.capability },
    { transport: 'github_mcp', operation: 'create_pull_request', capability: 'GITHUB_PR_CREATE' },
  );
  assert.deepEqual(
    { transport: merge.transport, operation: merge.operation, capability: merge.capability },
    { transport: 'github_mcp', operation: 'merge_pull_request', capability: 'GITHUB_PR_MERGE' },
  );
});

test('local PR adapters retain the existing gh command behavior', () => {
  const create = resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_create.v1', executorId: 'local_codex_windows' });
  const merge = resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_merge.v1', executorId: 'local_codex_windows' });
  assert.equal(create.transport, 'local_gh_cli');
  assert.equal(create.script, 'scripts/control-plane/github-pr-create.mjs');
  assert.equal(merge.transport, 'local_gh_cli');
  assert.equal(merge.script, 'scripts/control-plane/github-pr-merge.mjs');
});

test('missing and unsupported adapters fail closed without executor substitution', () => {
  assert.throws(
    () => resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_create.v1', executorId: 'ireland_local' }),
    (error) => error instanceof GitHubPrAdapterBindingError && error.code === 'GITHUB_PR_ADAPTER_UNAVAILABLE',
  );
  const broken = structuredClone(registry);
  broken.entries.find((entry) => entry.canonical_id === 'premvp.command.github_pr_merge.v1').executor_bindings = [];
  assert.throws(
    () => resolveGitHubPrAdapter({ registry: broken, commandId: 'premvp.command.github_pr_merge.v1', executorId: 'claude_code_cloud' }),
    (error) => error instanceof GitHubPrAdapterBindingError && error.code === 'GITHUB_PR_ADAPTER_UNAVAILABLE',
  );
});

test('canonicalization resolves the same executor-native create and merge adapters', () => {
  const cloud = resolveCanonicalizationAdapters('claude_code_cloud');
  const local = resolveCanonicalizationAdapters('local_codex_windows');
  assert.equal(cloud.create.transport, 'github_mcp');
  assert.equal(cloud.merge.transport, 'github_mcp');
  assert.equal(local.create.transport, 'local_gh_cli');
  assert.equal(local.merge.transport, 'local_gh_cli');
});
