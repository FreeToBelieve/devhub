import { z } from 'zod';
import { inboxSessionSchema, inboxTokenSchema } from '@devhub/contracts';
import { InboxStateError } from '@devhub/storage';
import type { TaskStore } from '@devhub/storage';
import type { AuthorizationRoutes } from './authorization-api.js';
import type { taskInboxRuntime } from './task-inbox.js';

export function registerTaskInboxApi(routes: AuthorizationRoutes, inbox: ReturnType<typeof taskInboxRuntime>, tasks: TaskStore) {
  const { route, input, session, parse, key } = routes;
  route('GET', '/api/task-inbox', (request) => {
    session(request);
    const { projectId, status, taskId } = parse(z.strictObject({
      projectId: z.uuid().optional(), status: inboxSessionSchema.shape.status.optional(), taskId: z.uuid().optional(),
    }), request.query);
    return { ...inbox.status(), sessions: tasks.inbox.sessions(projectId, status, taskId) };
  });
  route('PUT', '/api/task-inbox/credential', async (request, reply) => {
    session(request, true);
    await inbox.configure(input(request, z.strictObject({ token: inboxTokenSchema })).token);
    return reply.code(204).send();
  });
  route('PUT', '/api/task-inbox/listener', (request, reply) => {
    session(request, true);
    inbox.enable(input(request, z.strictObject({ enabled: z.boolean() })).enabled);
    return reply.code(204).send();
  });
  route('POST', '/api/task-inbox/scan', async (request) => {
    session(request, true);
    await inbox.scanNow();
    return inbox.status().listener;
  });
  route('POST', '/api/task-inbox/host', (request) => {
    session(request, true);
    return inbox.connect(input(request, z.strictObject({ runnerId: z.uuid() })).runnerId);
  });
  route('DELETE', '/api/task-inbox/host', async (request, reply) => {
    session(request, true);
    await inbox.disconnect();
    return reply.code(204).send();
  });
  route('GET', '/api/task-inbox/sessions/:id/messages', (request) => {
    session(request);
    const id = parse(z.uuid(), request.params.id);
    if (!tasks.inbox.session(id)) throw new InboxStateError('INBOX_SESSION_NOT_FOUND');
    return { messages: tasks.inbox.messages(id) };
  });
  route('POST', '/api/task-inbox/messages/:id/prepare', (request) => {
    const actor = session(request, true);
    return inbox.prepare(parse(z.uuid(), request.params.id), actor.digest, key(request));
  });
  route('POST', '/api/task-inbox/messages/:id/start', (request, reply) => {
    session(request, true);
    inbox.resumeApproved(parse(z.uuid(), request.params.id));
    return reply.code(202).send();
  });
  route('POST', '/api/task-inbox/messages/:id/retry', (request, reply) => {
    session(request, true);
    inbox.retry(parse(z.uuid(), request.params.id));
    return reply.code(204).send();
  });
}
