import { resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  deliveryBranchName, executionPolicyVersion, gitChangeInput, gitDeliveryApproval,
  gitDeliveryInput, gitProjectInput, requestKeySchema,
} from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import { GitStateError, taskSpecDigest } from '@devhub/storage';
import type { TaskStore } from '@devhub/storage';
import { inspectCodexWorktree } from './codex-worktree.js';
import { gitDelivery } from './git-delivery.js';
import type { AuthorizationRoutes } from './authorization-api.js';

const project = z.uuid();
const number = z.coerce.number().int().positive();
const connectionInput = gitProjectInput.extend({ expectedVersion: z.int().nonnegative() });
const projectQuery = z.strictObject({ projectId: project });

export function registerGitApi(routes: AuthorizationRoutes, tasks: TaskStore, treeDirectory?: string) {
  const { route, session, parse, input, key } = routes;
  const git = gitDelivery(tasks);
  const projectId = (request: FastifyRequest) => parse(projectQuery, request.query).projectId;
  const changeNumber = (id: string) => parse(number, id);
  route('GET', '/api/git/connections', (request) => {
    session(request);
    return { connections: tasks.git.connections(), tasks: tasks.list(),
      worktrees: tasks.execution.catalog().worktrees.filter((tree) => tasks.codex.manages(tree.worktreeId)),
      runners: tasks.execution.catalog().runners };
  });
  route('PUT', '/api/git/connections', (request) => {
    const actor = session(request, true);
    const { expectedVersion, ...project } = input(request, connectionInput);
    return git.connect(project, expectedVersion, actor.digest);
  });
  route('POST', '/api/git/connections/revoke', async (request, reply) => {
    const { digest } = session(request, true);
    const body = input(request, z.strictObject({ projectId: project, expectedVersion: z.int().positive() }));
    await git.revoke(body.projectId, body.expectedVersion, digest);
    return reply.code(204).send();
  });
  route('GET', '/api/git/branches', async (request) => {
    session(request);
    return { branches: await git.branches(projectId(request)) };
  });
  route('POST', '/api/git/worktrees', (request) => {
    const actor = session(request, true);
    const body = input(request, z.strictObject({ projectId: project,
      repositoryRoot: z.string().min(1).max(2048), branch: deliveryBranchName }));
    if (!treeDirectory) throw new GitStateError('GIT_WORKTREE_ROOT_UNAVAILABLE');
    return git.prepare(body.projectId, resolve(body.repositoryRoot), treeDirectory, body.branch, actor.digest);
  });
  route('GET', '/api/git/operations', (request) => {
    session(request);
    const id = projectId(request);
    return { operations: tasks.git.operations(id), changes: tasks.git.changes(id), audit: tasks.git.events(id) };
  });
  route('POST', '/api/git/operations', (request) => {
    const actor = session(request, true);
    const { projectId: id, operationId, ...binding } = input(request, gitDeliveryInput.extend({ projectId: project, operationId: z.uuid() }));
    return git.preview(id, binding, actor.digest, operationId);
  });
  route('POST', '/api/git/operations/:id/approve', (request) => {
    const actor = session(request, true);
    return tasks.git.approve(parse(project, request.params.id), input(request, gitDeliveryApproval), actor.digest);
  });
  route('POST', '/api/git/operations/:id/execute', (request) => {
    const actor = session(request, true);
    return git.execute(parse(project, request.params.id), input(request, gitDeliveryApproval), actor.digest);
  });
  route('GET', '/api/git/changes/:id', (request) => {
    session(request);
    return git.details(projectId(request), changeNumber(request.params.id));
  });
  route('POST', '/api/git/changes/:id', (request) => {
    const actor = session(request, true);
    const action = input(request, z.discriminatedUnion('action', [
      gitChangeInput.extend({ action: z.literal('update') }), z.strictObject({ action: z.literal('close') }),
      z.strictObject({ action: z.literal('comment'), body: z.string().min(1).max(4500), key: requestKeySchema }),
    ]));
    return git.change(projectId(request), changeNumber(request.params.id), actor.digest, action, key(request));
  });
  route('POST', '/api/git/changes/:id/follow-up', async (request) => {
    const actor = session(request, true);
    const id = projectId(request);
    const change = changeNumber(request.params.id);
    const body = input(request, z.strictObject({
      operationId: z.uuid(), runId: z.uuid(), runnerId: z.uuid(), instructions: z.string().trim().min(1).max(6000),
    }));
    const operation = tasks.git.operation(body.operationId);
    const run = tasks.codex.get(body.runId);
    if (!operation || operation.projectId !== id || operation.changeNumber !== change || operation.phase !== 'DELIVERED' ||
        run?.status !== 'COMPLETED' || !run.providerThreadId || run.worktreeId !== operation.binding.worktreeId) {
      throw new GitStateError('GIT_FOLLOW_UP_UNAVAILABLE');
    }
    const task = tasks.get(operation.binding.taskId);
    const runner = tasks.execution.catalog().runners.find(({ id }) => id === body.runnerId);
    if (!task || !runner || tasks.git.busy(run.worktreeId)) throw new GitStateError('GIT_FOLLOW_UP_UNAVAILABLE');
    const digest = sha256(body.instructions);
    const context = await inspectCodexWorktree(operation.binding.worktreeRoot, 'OFF', true);
    if (context.baseHeadSha !== operation.commitSha || context.worktreeId !== run.worktreeId) throw new GitStateError('GIT_HEAD_CHANGED');
    return tasks.execution.createRequest({
      taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
      repoId: context.repoId, worktreeId: context.worktreeId, baseHeadSha: context.baseHeadSha,
      codexThreadId: run.providerThreadId, runnerId: runner.id, platform: runner.platform,
      policyVersion: executionPolicyVersion,
      scope: { operation: 'codex.turn', mode: 'resume', previousRunId: run.devhubRunId, promptSha256: digest,
        sdkConfigSha256: context.sdkConfigSha256, workspaceSha256: context.workspaceSha256,
        executionProfile: context.executionProfile, networkMode: context.networkMode },
    }, actor.digest, key(request), true);
  });
}
