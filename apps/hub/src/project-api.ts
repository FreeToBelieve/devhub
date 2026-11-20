import { z } from 'zod';
import { projectInputSchema, legacyProjectId, digestSchema } from '@devhub/contracts';
import type { TaskStore } from '@devhub/storage';
import { inspectUnityEnvironment } from '@devhub/unity-adapter';
import { createCodexWorktree } from './codex-worktree.js';
import { inspectProjectInput, projectPath, projectWorkspace } from './project-context.js';
import { repositoryRemote } from './worktree.js';
import type { AuthorizationRoutes } from './authorization-api.js';
import { join } from 'node:path';
import { ProjectError } from '@devhub/storage';

export function registerProjectApi(routes: AuthorizationRoutes, tasks: TaskStore, worktreeDirectory: string | undefined) {
  const { route, session, parse, input, project } = routes;
  const id = (params: { id: string }) => parse(z.uuid(), params.id);

  route('GET', '/api/projects', (request) => {
    session(request);
    return { projects: tasks.projects.list().map((item) => {
      const connection = tasks.git.connection(item.id);
      return { ...item, provider: connection?.provider ?? null, repositoryUrl: connection?.repositoryUrl ?? null,
        defaultBranch: connection?.defaultBranch ?? null };
    }) };
  });
  route('POST', '/api/projects', async (request, reply) => {
    session(request, true);
    const verified = await inspectProjectInput(tasks, input(request, projectInputSchema));
    const created = tasks.projects.create(verified);
    const workspace = await projectWorkspace(created, verified.repositoryRoot);
    return reply.code(201).send({ project: created, environment: await inspectUnityEnvironment(workspace),
      remote: await repositoryRemote(verified.repositoryRoot) });
  });
  route('GET', '/api/projects/:id', async (request) => {
    session(request);
    const item = tasks.projects.require(id(request.params));
    project(request, item.id);
    const connection = tasks.git.connection(item.id);
    const workspace = item.repositoryRoot ? await projectWorkspace(item, item.repositoryRoot).catch(() => null) : null;
    const environment = workspace ? await inspectUnityEnvironment(workspace) : null;
    return { project: item, environment, remote: item.repositoryRoot ? await repositoryRemote(item.repositoryRoot).catch(() => null) : null,
      connection: connection ? { provider: connection.provider, repositoryUrl: connection.repositoryUrl,
        defaultBranch: connection.defaultBranch, connected: !!connection.credentialRef } : null,
      tasks: tasks.list(item.id).slice(0, 5), codexRuns: tasks.codex.list(item.id).slice(0, 5),
      unityRuns: tasks.unity.list(item.id).slice(0, 5),
      migrationReport: item.id === legacyProjectId ? tasks.projects.migrationReport() : [] };
  });
  route('PUT', '/api/projects/:id', async (request) => {
    session(request, true);
    const selected = id(request.params);
    project(request, selected);
    const { expectedRevision, ...settings } = input(request, projectInputSchema.extend({ expectedRevision: z.int().positive() }));
    return tasks.projects.update(selected, expectedRevision, await inspectProjectInput(tasks, settings, selected));
  });
  route('POST', '/api/projects/:id/archive', (request) => {
    session(request, true);
    const { expectedRevision } = input(request, z.strictObject({ expectedRevision: z.int().positive() }));
    project(request, id(request.params));
    return tasks.projects.archive(id(request.params), expectedRevision);
  });
  route('POST', '/api/projects/:id/worktrees', async (request, reply) => {
    session(request, true);
    const item = tasks.projects.require(id(request.params), true, true);
    if (project(request, item.id).id !== item.id || !worktreeDirectory || !item.repositoryRoot) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
    const identity = await createCodexWorktree(item.repositoryRoot, join(worktreeDirectory, item.id), item);
    await projectWorkspace(item, identity.root);
    const worktree = tasks.execution.registerWorktree(identity, item.id);
    tasks.codex.manage(worktree.worktreeId);
    return reply.code(201).send(worktree);
  });
  route('GET', '/api/projects/:id/documents/:worktree', async (request) => {
    session(request);
    const parameters = parse(z.strictObject({ id: z.uuid(), worktree: digestSchema }), request.params);
    const item = tasks.projects.require(parameters.id, false, true);
    project(request, item.id);
    const tree = tasks.execution.getWorktree(parameters.worktree, item.id);
    if (!tree || !tasks.codex.manages(tree.worktreeId)) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
    const workspace = await projectWorkspace(item, tree.root);
    await Promise.all(item.settings.documents.map(({ path }) => projectPath(workspace, path, 'file')));
    return { documents: item.settings.documents };
  });
}
