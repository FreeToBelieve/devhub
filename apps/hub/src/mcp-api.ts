import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateLocalProof, sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import {
  mcpCallTimeout, mcpCredentialSchema, mcpPairInput, mcpProbeSchema, mcpRequestLimit,
  mcpResponseLimit, mcpToolNames, mcpToolSchema, mcpTools,
} from '@devhub/mcp-contracts';
import type { AuthorizationRoutes } from './authorization-api.js';
import { McpReadError } from './mcp-errors.js';
import type { mcpReads } from './mcp-reads.js';

const readInput = z.strictObject({ tool: mcpToolSchema, input: z.unknown() });
const rateWindow = 60_000;
const callLimit = 120;
const concurrencyLimit = 4;

export function registerMcpApi(app: FastifyInstance, routes: AuthorizationRoutes, tasks: TaskStore,
  read: ReturnType<typeof mcpReads>, clock: () => number, timeout?: number) {
  const { route, session, input, parse } = routes;
  const rate = new Map<string, { start: number; used: number; active: number }>();
  const credential = () => 'dhm_' + generateLocalProof();
  route('GET', '/api/mcp/status', (request) => {
    session(request);
    return { pairings: tasks.mcp.list(), audit: tasks.mcp.recent(), tools: mcpToolNames };
  });
  route('POST', '/api/mcp/pairings', (request, reply) => {
    session(request, true);
    const spec = input(request, mcpPairInput);
    for (const id of spec.projectIds) tasks.projects.require(id, true, true);
    const proof = credential();
    const pairing = tasks.mcp.issue(spec, sha256(proof));
    if (!pairing) return reply.code(429).send({ code: 'MCP_PAIRING_LIMIT', message: '活动配对达到上限。' });
    return reply.code(201).send({ pairing, credential: proof });
  });
  route('POST', '/api/mcp/pairings/:id/rotate', (request, reply) => {
    session(request, true);
    const { hours } = input(request, mcpPairInput.pick({ hours: true }));
    const proof = credential();
    const pairing = tasks.mcp.rotate(parse(z.uuid(), request.params.id), hours, sha256(proof));
    if (!pairing) return reply.code(404).send({ code: 'MCP_PAIRING_INACTIVE', message: '配对已失效。' });
    return { pairing, credential: proof };
  });
  route('DELETE', '/api/mcp/pairings/:id', (request, reply) => {
    session(request, true);
    tasks.mcp.revoke(parse(z.uuid(), request.params.id));
    return reply.code(204).send();
  });

  function authenticate(request: FastifyRequest) {
    const header = request.headers.authorization;
    if (request.headers.origin !== undefined || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new McpReadError('MCP_UNAUTHENTICATED', 401);
    }
    const proof = mcpCredentialSchema.safeParse(header.slice(7));
    const pairing = proof.success ? tasks.mcp.authenticate(sha256(proof.data)) : undefined;
    if (!pairing) throw new McpReadError('MCP_UNAUTHENTICATED', 401);
    if (pairing.revokedAt !== null || (pairing.expiresAt !== null && pairing.expiresAt <= clock())) throw new McpReadError('MCP_PAIRING_INACTIVE', 401);
    return pairing;
  }

  function budget(id: string) {
    const now = clock();
    for (const [key, value] of rate) if (now - value.start >= rateWindow && value.active === 0) rate.delete(key);
    let entry = rate.get(id);
    if (!entry) {
      entry = { start: now, used: 0, active: 0 };
      rate.set(id, entry);
    } else if (now - entry.start >= rateWindow) {
      entry.start = now;
      entry.used = 0;
    }
    if (entry.used >= callLimit || entry.active >= concurrencyLimit) throw new McpReadError('MCP_RATE_LIMIT', 429);
    entry.used++;
    return entry;
  }

  function safeFailure(error: unknown) {
    if (error instanceof McpReadError) return error;
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code === 'GIT_CHANGE_NOT_FOUND') return new McpReadError('MCP_NOT_FOUND', 404);
    if (typeof code === 'string' && /^(?:GIT|PROVIDER)_[A-Z_]+$/.test(code)) return new McpReadError('MCP_GIT_UNAVAILABLE', 502);
    return new McpReadError('MCP_READ_FAILED', 500);
  }

  app.post('/api/mcp/internal/probe', { bodyLimit: mcpRequestLimit }, async (request, reply) => {
    try {
      const pairing = authenticate(request);
      const probe = mcpProbeSchema.safeParse(request.body);
      if (!probe.success) throw new McpReadError('MCP_INVALID_INPUT');
      budget(pairing.id);
      if (probe.data.transport) tasks.mcp.touch(pairing.id, probe.data.transport, probe.data.protocolVersion, probe.data.tunnel);
      return { projectIds: pairing.projectIds, tools: mcpToolNames.filter((name) => pairing.groups.includes(mcpTools[name].group)) };
    } catch (error) {
      const failure = safeFailure(error);
      return reply.code(failure.status).send({ code: failure.code });
    }
  });
  app.post('/api/mcp/internal/read', { bodyLimit: mcpRequestLimit }, async (request, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancellation = new AbortController();
    const interrupted = () => { if (!reply.raw.writableFinished) cancellation.abort(); };
    reply.raw.once('close', interrupted);
    try {
      const pairing = authenticate(request);
      const parsed = readInput.safeParse(request.body);
      if (!parsed.success) throw new McpReadError('MCP_INVALID_INPUT');
      const { tool, input } = parsed.data;
      const scope = z.object({ projectId: z.uuid().optional() }).safeParse(input);
      const projectId = scope.success && scope.data.projectId && pairing.projectIds.includes(scope.data.projectId)
        ? scope.data.projectId : null;
      try {
        const entry = budget(pairing.id);
        entry.active++;
        const work = Promise.resolve().then(() => read(tool, input, pairing, cancellation.signal)).finally(() => { entry.active--; });
        const result = await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const failure = new McpReadError('MCP_TIMEOUT', 504);
            reject(failure);
            cancellation.abort(failure);
          }, timeout ?? mcpCallTimeout(tool));
        })]);
        authenticate(request);
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > mcpResponseLimit) throw new McpReadError('MCP_RESPONSE_LIMIT', 413);
        tasks.mcp.audit(pairing.id, tool, 'OK', projectId);
        return reply.type('application/json').send(body);
      } catch (error) {
        const failure = safeFailure(error);
        tasks.mcp.audit(pairing.id, tool, failure.code, projectId);
        throw failure;
      }
    } catch (error) {
      const failure = safeFailure(error);
      return reply.code(failure.status).send({ code: failure.code });
    } finally { clearTimeout(timer); reply.raw.off('close', interrupted); }
  });
}
