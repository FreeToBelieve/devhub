import { hostname, userInfo } from 'node:os';
import type { ExecutionBinding, RunnerRecord } from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import { inspectWorktree } from './worktree.js';
import { inspectCodexWorktree } from './codex-worktree.js';

export function localDevice(): Pick<RunnerRecord, 'deviceId' | 'platform'> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('A Windows or macOS Runner is required.');
  return {
    deviceId: sha256(JSON.stringify([process.platform, hostname(), userInfo().username, userInfo().homedir])),
    platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
  };
}

export async function workspaceMatches(execution: TaskStore['execution'], binding: ExecutionBinding, fresh = false): Promise<boolean> {
  const worktree = execution.getWorktree(binding.worktreeId);
  if (!worktree || worktree.repoId !== binding.repoId) return false;
  try {
    if (binding.scope.operation === 'codex.turn') {
      if (!binding.scope.executionProfile || !binding.scope.networkMode) return false;
      const live = await inspectCodexWorktree(worktree.root, binding.scope.networkMode, fresh);
      return live.repoId === binding.repoId && live.worktreeId === binding.worktreeId && live.baseHeadSha === binding.baseHeadSha &&
        live.workspaceSha256 === binding.scope.workspaceSha256 && live.sdkConfigSha256 === binding.scope.sdkConfigSha256;
    }
    const live = await inspectWorktree(worktree.root, binding.scope);
    return live.repoId === binding.repoId && live.worktreeId === binding.worktreeId && live.baseHeadSha === binding.baseHeadSha;
  } catch {
    return false;
  }
}
