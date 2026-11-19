import fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createTaskSchema, taskIdSchema } from '@devhub/contracts';
import { createLogger } from '@devhub/logger';
import { inspectEnvironment } from '@devhub/runner';
import { allowsLocalRequest } from '@devhub/security';
import { openTaskStore } from '@devhub/storage';
import { registerAuthorizationApi } from './authorization-api.js';

interface ServerOptions {
  port: number;
  databasePath: string;
  managedDataDirectory?: boolean;
  dashboardDirectory?: string;
  logger?: ReturnType<typeof createLogger>;
  clock?: () => number;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const logger: FastifyBaseLogger = options.logger ?? createLogger('silent');
  const app = fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    bodyLimit: 32 * 1024,
  });
  const clock = options.clock ?? Date.now;
  const tasks = openTaskStore(options.databasePath, options.managedDataDirectory, clock);
  app.addHook('onClose', async () => tasks.close());

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!allowsLocalRequest(request.headers.host, request.headers.origin, options.port)) {
      return reply.code(403).send({ code: 'LOCAL_ORIGIN_REQUIRED', message: '请从 DevHub 的本机地址访问。' });
    }
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/doctor', async () => inspectEnvironment());
  app.get('/api/tasks', async () => ({ tasks: tasks.list() }));

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const id = taskIdSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ code: 'INVALID_TASK_ID', message: '任务 ID 格式无效。' });

    const task = tasks.get(id.data);
    if (!task) return reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '找不到该任务。' });
    return task;
  });

  app.post('/api/tasks', async (request, reply) => {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return reply.code(415).send({ code: 'JSON_REQUIRED', message: '请使用 application/json 提交任务。' });
    }

    const input = createTaskSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        code: 'INVALID_TASK',
        message: '请检查标题、任务说明和目标平台。',
      });
    }

    const task = tasks.create(input.data);
    return reply.code(201).header('Location', `/api/tasks/${task.id}`).send(task);
  });

  registerAuthorizationApi(app, tasks, options.port, clock);

  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        code: 'INVALID_REQUEST',
        message: status === 413 ? '请求内容过长。' : '请求格式无效。',
      });
    }
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    request.log.error({ code, requestId: request.id }, 'Request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Hub 无法完成请求。' });
  });
  app.setNotFoundHandler(async (_request, reply) => (
    reply.code(404).send({ code: 'NOT_FOUND', message: '找不到该地址。' })
  ));

  if (options.dashboardDirectory) {
    app.register(fastifyStatic, { root: options.dashboardDirectory });
  }
  return app;
}
