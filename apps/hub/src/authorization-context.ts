import { hostname, userInfo } from 'node:os';
import type { ExecutionBinding, RunnerRecord } from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import { unityConfiguration } from '@devhub/unity-adapter';
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
  const project = execution.getProject(worktree.projectId ?? '');
  try {
    if (binding.scope.operation === 'codex.turn') {
      if (!binding.scope.executionProfile || !binding.scope.networkMode) return false;
      const live = await inspectCodexWorktree(worktree.root, binding.scope.networkMode, fresh, undefined, project);
      return live.repoId === binding.repoId && live.worktreeId === binding.worktreeId && live.baseHeadSha === binding.baseHeadSha &&
        live.workspaceSha256 === binding.scope.workspaceSha256 && live.sdkConfigSha256 === binding.scope.sdkConfigSha256;
    }
    if (binding.scope.operation === 'unity.run') {
      const live = await inspectCodexWorktree(worktree.root, 'OFF', fresh, undefined, project);
      const configuration = await unityConfiguration(live.projectRoot, binding.scope.plan, project?.unityVersion);
      return configuration.environment.platform === binding.platform && live.repoId === binding.repoId &&
        live.worktreeId === binding.worktreeId && live.baseHeadSha === binding.baseHeadSha &&
        live.workspaceSha256 === binding.scope.workspaceSha256 && configuration.configSha256 === binding.scope.configSha256 &&
        (!binding.scope.editorVersion || configuration.editorVersion === binding.scope.editorVersion);
    }
    const live = await inspectWorktree(worktree.root, binding.scope);
    return live.repoId === binding.repoId && live.worktreeId === binding.worktreeId && live.baseHeadSha === binding.baseHeadSha;
  } catch {
    return false;
  }
}
