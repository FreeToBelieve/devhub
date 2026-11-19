import { z } from 'zod';
import { digestSchema, runnerClaimInputSchema, unityPlanSchema } from '@devhub/contracts';
import type { TaskStore } from '@devhub/storage';
import { readArtifact } from '@devhub/unity-adapter';
import type { AuthorizationRoutes } from './authorization-api.js';
import { UnityStateError } from './unity-runtime.js';
import type { unityRuntime } from './unity-runtime.js';

const requestSchema = z.strictObject({ taskId: z.uuid(), runnerId: z.uuid(), worktreeId: digestSchema, plan: unityPlanSchema });
export function registerUnityApi(routes: AuthorizationRoutes, tasks: TaskStore, unity: ReturnType<typeof unityRuntime>) {
  const { route, session, input, parse, key } = routes;
  route('GET', '/api/unity/environment', (request) => {
    session(request);
    const { worktreeId } = parse(z.strictObject({ worktreeId: digestSchema.optional() }), request.query);
    return unity.environment(worktreeId);
  });
  route('GET', '/api/unity/runs', (request) => {
    session(request);
    return { runs: tasks.unity.list() };
  });
  route('POST', '/api/unity/requests', (request) => {
    const actor = session(request, true);
    return unity.request(input(request, requestSchema), actor.digest, key(request));
  });
  route('POST', '/api/unity/runs', async (request, reply) => {
    session(request, true);
    const { run, completion } = await unity.start(input(request, runnerClaimInputSchema));
    void completion.catch(() => request.log.error({ code: 'UNITY_RUNTIME_STATE_UNAVAILABLE' }, 'Unity runtime failed to finalize'));
    return reply.code(202).send(run);
  });
  route('POST', '/api/unity/runs/:id/cancel', (request, reply) => {
    session(request, true);
    if (!unity.cancel(parse(z.uuid(), request.params.id))) throw new UnityStateError('UNITY_RUN_NOT_FOUND');
    return reply.code(204).send();
  });
  route('POST', '/api/unity/runs/:id/repair', (request) => {
    const actor = session(request, true);
    const payload = input(request, z.strictObject({ previousRunId: z.uuid(), notes: z.string().max(1500).optional() }));
    return unity.requestRepair({ ...payload, runId: parse(z.uuid(), request.params.id) }, actor.digest, key(request));
  });
  route('GET', '/api/unity/runs/:id/artifact', async (request, reply) => {
    session(request);
    const run = tasks.unity.get(parse(z.uuid(), request.params.id));
    const { name } = parse(z.strictObject({ name: z.string().max(100) }), request.query);
    const artifact = run?.artifacts.find((item) => item.name === name);
    if (!run || !artifact || !run.exitConfirmed) throw new UnityStateError('UNITY_RUN_NOT_FOUND');
    const file = await readArtifact(unity.artifacts, run.id, name).catch(() => undefined);
    if (!file) throw new UnityStateError('UNITY_RUN_NOT_FOUND');
    if (artifact.mime !== 'image/png' && artifact.mime !== 'video/mp4') {
      reply.header('Content-Disposition', `attachment; filename="${artifact.name}"`);
    }
    if (artifact.mime === 'video/mp4') {
      reply.header('Accept-Ranges', 'bytes');
      const range = typeof request.headers.range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range) : null;
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), artifact.size - 1) : artifact.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
          await file.close();
          return reply.code(416).header('Content-Range', 'bytes */' + artifact.size).send();
        }
        return reply.code(206).type(artifact.mime).header('Content-Length', end - start + 1)
          .header('Content-Range', `bytes ${start}-${end}/${artifact.size}`).send(file.createReadStream({ start, end }));
      }
    }
    return reply.type(artifact.mime).header('Content-Length', artifact.size).send(file.createReadStream());
  });
}
