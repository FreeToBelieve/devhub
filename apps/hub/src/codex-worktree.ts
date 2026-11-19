import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { codexConfigDigest } from '@devhub/runner';
import type { DeveloperNetworkMode } from '@devhub/contracts';
import { addDetachedWorktree, inspectWorktree } from './worktree.js';

import { snapshotWorkspace } from './workspace-snapshot.js';

export async function inspectCodexWorktree(location: string, networkMode: DeveloperNetworkMode = 'OFF', fresh = false,
  forbiddenText?: string) {
  const identity = await inspectWorktree(location, undefined, true);
  const marker = await lstat(join(identity.root, '.git'));
  if (!identity.linked || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) {
    throw new Error('A DevHub-managed linked Git worktree is required.');
  }
  const snapshot = await snapshotWorkspace(identity.root, { fresh, forbiddenText });
  const after = await inspectWorktree(location, undefined, true);
  if (after.worktreeId !== identity.worktreeId || after.baseHeadSha !== identity.baseHeadSha) {
    throw new Error('Git changed during the Codex worktree inspection.');
  }
  return { ...identity, snapshot, executionProfile: 'PROJECT_DEVELOPER' as const, networkMode,
    workspaceSha256: snapshot.sha256, sdkConfigSha256: codexConfigDigest(identity.root, networkMode) };
}

export async function createCodexWorktree(repository: string, targetDirectory: string) {
  const source = await inspectWorktree(repository);
  await mkdir(resolve(targetDirectory), { recursive: true, mode: 0o700 });
  const parent = await realpath(targetDirectory);
  const relation = relative(source.root, parent);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep))) {
    throw new Error('Choose a Codex worktree directory outside the source checkout.');
  }
  const target = join(parent, randomUUID());
  await addDetachedWorktree(source.root, target, source.baseHeadSha);
  return inspectCodexWorktree(target);
}
