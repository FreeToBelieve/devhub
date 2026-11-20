import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { projectRelativePathSchema, projectUnityPathSchema, unityEditorVersionSchema } from '@devhub/contracts';
import type { Project, ProjectInput } from '@devhub/contracts';
import { checkLocalGitRemote } from '@devhub/git-adapter';
import { providerEndpoint } from '@devhub/git-provider';
import { projectContextDigest, ProjectError } from '@devhub/storage';
import type { TaskStore } from '@devhub/storage';
import { readRegular } from '@devhub/unity-adapter';
import { inspectWorktree } from './worktree.js';

export async function projectPath(root: string, path: string, leaf: 'file' | 'directory') {
  if (!(leaf === 'directory' ? projectUnityPathSchema : projectRelativePathSchema).safeParse(path).success) {
    throw new ProjectError('PROJECT_SCOPE_MISMATCH');
  }
  try {
    const base = await realpath(root);
    const baseEntry = await lstat(root);
    if (!baseEntry.isDirectory() || baseEntry.isSymbolicLink()) throw new Error();
    let current = base;
    const parts = path === '.' ? [] : path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const entry = await lstat(current);
      const file = leaf === 'file' && index === parts.length - 1;
      if (entry.isSymbolicLink() || (file ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) throw new Error();
    }
    const resolved = await realpath(current);
    const relation = relative(base, resolved);
    if (isAbsolute(relation) || relation === '..' || relation.startsWith('..' + sep)) throw new Error();
    return resolved;
  } catch {
    throw new ProjectError('PROJECT_SCOPE_MISMATCH');
  }
}

export async function inspectProjectInput(tasks: TaskStore, input: ProjectInput, existingId?: string) {
  if (!isAbsolute(input.repositoryRoot)) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
  const identity = await inspectWorktree(input.repositoryRoot, undefined, true).catch(() => { throw new ProjectError('PROJECT_SCOPE_MISMATCH'); });
  if (identity.linked) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
  const workspace = await projectPath(identity.root, input.unityProjectPath, 'directory');
  const versionPath = await projectPath(workspace, 'ProjectSettings/ProjectVersion.txt', 'file');
  const contents = await readRegular(versionPath, 16 * 1024).catch(() => { throw new ProjectError('PROJECT_SCOPE_MISMATCH'); });
  const version = unityEditorVersionSchema.safeParse(/^m_EditorVersion:[ \t]*(\S+)[ \t]*\r?$/m.exec(contents.toString('utf8'))?.[1]);
  if (!version.success) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
  await projectPath(workspace, 'Assets', 'directory');
  for (const document of input.settings.documents) await projectPath(workspace, document.path, 'file');
  const connection = existingId ? tasks.git.connection(existingId) : undefined;
  if (connection) await checkLocalGitRemote(identity.root, providerEndpoint(connection.provider, connection.repositoryUrl, connection.apiBaseUrl));
  return { ...input, repositoryRoot: identity.root, repoId: identity.repoId, unityVersion: version.data };
}

export async function projectWorkspace(project: Project, worktreeRoot: string) {
  return project.unityProjectPath ? projectPath(worktreeRoot, project.unityProjectPath, 'directory') : worktreeRoot;
}

export function projectBinding(project: Project) {
  return { projectId: project.id, ...(project.repositoryRoot ? { projectContextSha256: projectContextDigest(project) } : {}) };
}
