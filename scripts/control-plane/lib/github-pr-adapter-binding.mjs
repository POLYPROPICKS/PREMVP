/**
 * Executor-specific binding resolver for the portable GitHub PR commands.
 *
 * This module deliberately resolves only registered bindings. It does not fall back from a
 * cloud executor to the local gh CLI (or vice versa), so a missing adapter remains a
 * fail-closed lifecycle error rather than an implicit host dependency.
 */
import fs from 'node:fs';
import path from 'node:path';

export const GITHUB_PR_COMMAND_IDS = Object.freeze([
  'premvp.command.github_pr_create.v1',
  'premvp.command.github_pr_merge.v1',
]);

export class GitHubPrAdapterBindingError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export function readGitHubPrRegistry(repoRoot) {
  return JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'),
    'utf8',
  ));
}

/** Resolve one command through the selected executor's explicit registry binding. */
export function resolveGitHubPrAdapter({ registry, commandId, executorId }) {
  if (!GITHUB_PR_COMMAND_IDS.includes(commandId)) {
    throw new GitHubPrAdapterBindingError('GITHUB_PR_COMMAND_UNREGISTERED', String(commandId));
  }
  if (!executorId) {
    throw new GitHubPrAdapterBindingError('GITHUB_PR_EXECUTOR_REQUIRED', commandId);
  }
  const command = registry?.entries?.find((entry) => entry.canonical_id === commandId);
  if (!command) throw new GitHubPrAdapterBindingError('GITHUB_PR_COMMAND_UNREGISTERED', commandId);
  const adapter = command.executor_bindings?.find((binding) => binding.executor_id === executorId);
  if (!adapter) {
    throw new GitHubPrAdapterBindingError('GITHUB_PR_ADAPTER_UNAVAILABLE', `${commandId} has no binding for ${executorId}`);
  }
  if (!adapter.transport || !adapter.operation || !adapter.capability) {
    throw new GitHubPrAdapterBindingError('GITHUB_PR_ADAPTER_INVALID', `${commandId} binding for ${executorId}`);
  }
  return Object.freeze({ command_id: commandId, executor_id: executorId, ...adapter });
}
