import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerMcpApi } from './mcp-api.js';
import { mcpReads } from './mcp-reads.js';
import {
  decisionInputSchema, developerNetworkModeSchema, digestSchema, executionBindingSchema, executionPolicyVersion, localProofSchema,
  createTaskSchema, legacyProjectId, requestKeySchema, reviseTaskSchema, taskIdSchema, versionInputSchema,
} from '@devhub/contracts';
import { allowsLocalOrigin, csrfForSession, sha256, verifyCsrf } from '@devhub/security';
import { AuthorizationError, ProjectError, taskSpecDigest } from '@devhub/storage';
import type { TaskStore } from '@devhub/storage';
import type { Project } from '@devhub/contracts';
import { workspaceMatches } from './authorization-context.js';
import { inspectWorktree } from './worktree.js';
import { inspectCodexWorktree } from './codex-worktree.js';
import { GitProviderError } from '@devhub/git-provider';
import { GitStateError } from '@devhub/storage';
import { registerGitApi } from './git-api.js';
import { safeGitError } from './git-delivery.js';
import type { gitDelivery } from './git-delivery.js';
import { registerUnityApi } from './unity-api.js';
import { registerProjectApi } from './project-api.js';
import { projectBinding } from './project-context.js';
import { unityFailure } from './unity-runtime.js';
import type { unityRuntime } from './unity-runtime.js';

const cookieName = 'devhub_operator';
const bootstrapSchema = z.strictObject({ bootstrapCredential: localProofSchema });

class ApiInputError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiInputError(400, 'INVALID_AUTHORIZATION_INPUT');
  return parsed.data;
}

function input<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiInputError(415, 'JSON_REQUIRED');
  return parse(schema, request.body);
}

function errorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiInputError) return reply.code(error.status).send({ code: error.code, message: error.code });
  if (error instanceof AuthorizationError) {
    const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 :
      error.code === 'NOT_FOUND' ? 404 : 409;
    return reply.code(status).send({ code: error.code, message: error.code });
  }
  if (error instanceof ProjectError) return reply.code(error.code === 'PROJECT_NOT_FOUND' || error.code === 'PROJECT_SCOPE_MISMATCH' ? 404 : 409)
    .send({ code: error.code, message: error.code });
  if (error instanceof Error && /^UNITY_[A-Z0-9_]{1,64}$/.test(error.message)) {
    const code = unityFailure(error);
    return reply.code(code === 'UNITY_RUN_NOT_FOUND' ? 404 : 409).send({ code, message: code });
  }
  if (error instanceof GitProviderError || error instanceof GitStateError ||
      (error instanceof Error && (/^WORKSPACE_(?:SECRET|SNAPSHOT)_[A-Z_]+$/.test(error.message) ||
        error.message === 'GIT_SUBMODULE_WORKTREE_UNSUPPORTED'))) {
    const code = safeGitError(error);
    return reply.code(code === 'GIT_OPERATION_NOT_FOUND' ? 404 : 409).send({ code, message: code });
  }
  throw error;
}

export interface AuthorizationRoutes {
  route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, handler: (
    request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply,
  ) => unknown | Promise<unknown>): void;
  session(request: FastifyRequest, requireCsrf?: boolean): { digest: string; expiresAt: number; csrfToken: string };
  parse: typeof parse;
  input: typeof input;
  key(request: FastifyRequest): string;
  project(request: FastifyRequest, resourceId?: string): Project;
}

export function registerAuthorizationApi(app: FastifyInstance, tasks: TaskStore, port: number, clock: () => number,
  git: ReturnType<typeof gitDelivery>, unity: ReturnType<typeof unityRuntime>, codexWorktreeRoot?: string, mcpTimeout?: number) {
  const execution = tasks.execution;
  const route = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, handler: (
    request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply,
  ) => unknown | Promise<unknown>) => {
    app.route<{ Params: { id: string } }>({ method, url, async handler(request, reply) {
      try {
        if (method !== 'GET' && !allowsLocalOrigin(request.headers.origin, port)) {
          throw new ApiInputError(403, 'EXACT_ORIGIN_REQUIRED');
        }
        return await handler(request, reply);
      } catch (error) {
        return errorResponse(reply, error);
      }
    } });
  };

  function session(request: FastifyRequest, requireCsrf = false) {
    const cookies = request.headers.cookie?.split(';').map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(cookieName + '=')) ?? [];
    const proof = cookies.length === 1 ? cookies[0]?.slice(cookieName.length + 1) : undefined;
    const parsed = localProofSchema.safeParse(proof);
    if (!parsed.success) throw new AuthorizationError('UNAUTHENTICATED');
    const digest = sha256(parsed.data);
    const expiresAt = execution.sessionExpiry(digest);
    const csrf = request.headers['x-csrf-token'];
    if (requireCsrf && !verifyCsrf(parsed.data, typeof csrf === 'string' ? csrf : undefined)) {
      throw new ApiInputError(403, 'CSRF_REQUIRED');
    }
    return { digest, expiresAt, csrfToken: csrfForSession(parsed.data) };
  }

  const key = (request: FastifyRequest) => parse(requestKeySchema, request.headers['idempotency-key']);
  function project(request: FastifyRequest, resourceId?: string) {
    const header = request.headers['x-devhub-project-id'];
    const query = (request.query as { projectId?: unknown } | undefined)?.projectId;
    if (header !== undefined && query !== undefined && header !== query) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
    const selected = parse(z.uuid(), header ?? query ?? resourceId ?? legacyProjectId);
    if (resourceId && selected !== resourceId) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
    return tasks.projects.require(selected);
  }
  const setCookie = (reply: FastifyReply, proof: string, maxAge: number) =>
    reply.header('Set-Cookie', `${cookieName}=${proof}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);

  route('POST', '/api/operator/session', (request, reply) => {
    const { bootstrapCredential } = input(request, bootstrapSchema);
    const { proof, expiresAt } = execution.exchangeBootstrap(sha256(bootstrapCredential));
    setCookie(reply, proof, Math.max(0, Math.ceil((expiresAt - clock()) / 1000)));
    return { csrfToken: csrfForSession(proof), expiresAt };
  });
  route('GET', '/api/operator/session', (request) => {
    const { csrfToken, expiresAt } = session(request);
    return { csrfToken, expiresAt };
  });
  route('DELETE', '/api/operator/session', (request, reply) => {
    execution.closeSession(session(request, true).digest);
    return setCookie(reply, '', 0).code(204).send();
  });

  route('GET', '/api/tasks', (request) => {
    session(request);
    return { tasks: tasks.list(project(request).id) };
  });
  route('GET', '/api/tasks/:id', (request) => {
    session(request);
    const task = tasks.get(parse(taskIdSchema, request.params.id), project(request).id);
    if (!task) throw new AuthorizationError('NOT_FOUND');
    return task;
  });
  route('POST', '/api/tasks', (request, reply) => {
    session(request, true);
    const { projectId, ...spec } = input(request, createTaskSchema.extend({ projectId: z.uuid() }));
    const selected = project(request, projectId);
    tasks.projects.require(selected.id, true, true);
    const task = tasks.create(spec, selected.id);
    return reply.code(201).header('Location', '/api/tasks/' + task.id + '?projectId=' + task.projectId).send(task);
  });
  route('PUT', '/api/tasks/:id/spec', (request) => {
    session(request, true);
    const id = parse(taskIdSchema, request.params.id);
    const { expectedRevision, ...spec } = input(request, reviseTaskSchema);
    const selected = project(request).id;
    const task = tasks.revise(id, expectedRevision, spec, selected);
    if (!task) throw new AuthorizationError(tasks.get(id, selected) ? 'VERSION_CONFLICT' : 'NOT_FOUND');
    return task;
  });
  route('GET', '/api/authorization/catalog', (request) => {
    session(request);
    const selected = project(request).id;
    const catalog = execution.catalog(selected);
    return {
      ...catalog, policyVersion: executionPolicyVersion,
      worktrees: catalog.worktrees.map((tree) => ({ ...tree, codexManaged: tasks.codex.manages(tree.worktreeId) })),
      tasks: tasks.list(selected).map((task) => ({ ...task, taskSpecSha256: taskSpecDigest(task) })),
    };
  });
  route('GET', '/api/authorization/worktrees/:id', async (request) => {
    session(request);
    const selected = project(request);
    const worktree = execution.getWorktree(parse(digestSchema, request.params.id), selected.id);
    if (!worktree) throw new AuthorizationError('NOT_FOUND');
    const { network } = parse(z.object({ network: developerNetworkModeSchema.default('OFF') }), request.query);
    const inspection = tasks.codex.manages(worktree.worktreeId)
      ? inspectCodexWorktree(worktree.root, network, false, undefined, selected)
      : inspectWorktree(worktree.root);
    const live = await inspection.catch((error: unknown) => {
      if (error instanceof Error && ['WORKSPACE_SECRET_DETECTED', 'WORKSPACE_SECRET_SCAN_LIMIT',
        'PROXY_OS_CONTAINMENT_UNAVAILABLE'].includes(error.message)) throw new ApiInputError(409, error.message);
      throw new AuthorizationError('STALE_CONTEXT');
    });
    if (live.repoId !== worktree.repoId || live.worktreeId !== worktree.worktreeId) throw new AuthorizationError('STALE_CONTEXT');
    return live;
  });
  route('GET', '/api/execution-requests', (request) => {
    session(request);
    return { requests: execution.requests(project(request).id) };
  });
  route('GET', '/api/execution-requests/:id', (request) => {
    session(request);
    const id = parse(taskIdSchema, request.params.id);
    if (execution.getRequest(id)?.projectId !== project(request).id) throw new AuthorizationError('NOT_FOUND');
    return execution.detail(id);
  });
  route('POST', '/api/execution-requests', async (request, reply) => {
    const actor = session(request, true);
    const idempotencyKey = key(request);
    const submitted = input(request, executionBindingSchema);
    const selected = project(request, submitted.projectId);
    if (!tasks.get(submitted.taskId, selected.id) || !execution.getWorktree(submitted.worktreeId, selected.id)) {
      throw new AuthorizationError('NOT_FOUND');
    }
    if (selected.repositoryRoot && submitted.scope.operation !== 'codex.turn') throw new AuthorizationError('FORBIDDEN');
    const binding = { ...submitted, ...(selected.repositoryRoot ? projectBinding(selected) : {}) };
    if (binding.scope.operation === 'workspace.write') binding.scope.paths = [...new Set(binding.scope.paths)].sort();
    if (binding.scope.operation === 'codex.turn' &&
        (!tasks.codex.manages(binding.worktreeId) || !binding.scope.executionProfile || !binding.scope.networkMode)) {
      throw new AuthorizationError('FORBIDDEN');
    }
    if (binding.scope.operation === 'unity.run') throw new AuthorizationError('FORBIDDEN');
    const matches = await workspaceMatches(execution, binding);
    return reply.code(201).send(execution.createRequest(binding, actor.digest, idempotencyKey, matches));
  });
  route('POST', '/api/execution-requests/:id/decision', async (request) => {
    const actor = session(request, true);
    const requestId = parse(taskIdSchema, request.params.id);
    const idempotencyKey = key(request);
    const { decision, expectedVersion } = input(request, decisionInputSchema);
    const pending = execution.getRequest(requestId);
    if (pending?.projectId !== project(request).id) throw new AuthorizationError('NOT_FOUND');
    const matches = decision === 'approve' && pending ? await workspaceMatches(execution, pending.binding) : false;
    return execution.mutate({
      kind: decision, requestId, expectedVersion, sessionDigest: actor.digest, idempotencyKey, workspaceMatches: matches,
    });
  });
  route('POST', '/api/execution-requests/:id/revoke', (request) => {
    const actor = session(request, true);
    const requestId = parse(taskIdSchema, request.params.id);
    if (execution.getRequest(requestId)?.projectId !== project(request).id) throw new AuthorizationError('NOT_FOUND');
    const { expectedVersion } = input(request, versionInputSchema);
    return execution.mutate({
      kind: 'revoke', requestId, expectedVersion, sessionDigest: actor.digest, idempotencyKey: key(request), workspaceMatches: false,
    });
  });
  route('GET', '/api/codex-runs', (request) => {
    session(request);
    return { runs: tasks.codex.list(project(request).id) };
  });
  route('GET', '/api/codex-runs/:id/events', (request) => {
    session(request);
    const id = parse(taskIdSchema, request.params.id);
    const query = parse(z.object({ after: z.coerce.number().int().nonnegative().default(0) }), request.query);
    const run = tasks.codex.get(id, project(request).id);
    if (!run) throw new AuthorizationError('NOT_FOUND');
    return { run, events: tasks.codex.events(id, query.after) };
  });
  route('POST', '/api/codex-runs/:id/cancel', (request, reply) => {
    session(request, true);
    const id = parse(taskIdSchema, request.params.id);
    if (!tasks.codex.get(id, project(request).id)) throw new AuthorizationError('NOT_FOUND');
    if (!tasks.codex.requestCancel(id)) throw new AuthorizationError('STATE_CONFLICT');
    return reply.code(204).send();
  });
  const routes = { route, session, parse, input, key, project };
  registerMcpApi(app, routes, tasks, mcpReads(tasks, git, unity), clock, mcpTimeout);
  registerProjectApi(routes, tasks, codexWorktreeRoot);
  registerGitApi(routes, tasks, git, codexWorktreeRoot);
  registerUnityApi(routes, tasks, unity);
}
