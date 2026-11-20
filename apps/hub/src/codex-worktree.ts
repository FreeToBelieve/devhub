import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { codexConfigDigest } from '@devhub/runner';
import type { DeveloperNetworkMode, Project } from '@devhub/contracts';
import { addDetachedWorktree, inspectWorktree } from './worktree.js';

import { snapshotWorkspace } from './workspace-snapshot.js';
import { projectPath, projectWorkspace } from './project-context.js';

export async function inspectCodexWorktree(location: string, networkMode: DeveloperNetworkMode = 'OFF', fresh = false,
  forbiddenText?: string, project?: Project) {
  const identity = await inspectWorktree(location, undefined, true);
  const marker = await lstat(join(identity.root, '.git'));
  if (!identity.linked || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) {
    throw new Error('A DevHub-managed linked Git worktree is required.');
  }
  if (project?.repoId && project.repoId !== identity.repoId) throw new Error('PROJECT_SCOPE_MISMATCH');
  const projectRoot = project ? await projectWorkspace(project, identity.root) : identity.root;
  const projectDocuments = project?.repositoryRoot ? project.settings.documents.map(({ path }) => path) : undefined;
  for (const path of projectDocuments ?? []) await projectPath(projectRoot, path, 'file');
  const snapshot = await snapshotWorkspace(forbiddenText ? identity.root : projectRoot, { fresh, forbiddenText });
  const after = await inspectWorktree(location, undefined, true);
  if (after.worktreeId !== identity.worktreeId || after.baseHeadSha !== identity.baseHeadSha) {
    throw new Error('Git changed during the Codex worktree inspection.');
  }
  return { ...identity, projectRoot, projectDocuments, snapshot, executionProfile: 'PROJECT_DEVELOPER' as const, networkMode,
    workspaceSha256: snapshot.sha256, sdkConfigSha256: codexConfigDigest(projectRoot, networkMode, projectDocuments) };
}

export async function createCodexWorktree(repository: string, targetDirectory: string, project?: Project) {
  const source = await inspectWorktree(repository);
  await mkdir(resolve(targetDirectory), { recursive: true, mode: 0o700 });
  const parent = await realpath(targetDirectory);
  const relation = relative(source.root, parent);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep))) {
    throw new Error('Choose a Codex worktree directory outside the source checkout.');
  }
  const target = join(parent, randomUUID());
  await addDetachedWorktree(source.root, target, source.baseHeadSha);
  return inspectCodexWorktree(target, 'OFF', false, undefined, project);
}
