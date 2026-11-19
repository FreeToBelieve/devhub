import { randomUUID } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@devhub/hub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const port = 4317;
const host = `127.0.0.1:${port}`;
const headers = { host };
const input = { title: ' 青溪地图 ', description: " O'Brien 的双端说明 ", targetPlatform: 'BOTH' };

describe('Hub API', () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    app = createServer({ port, databasePath: ':memory:' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns health, an empty list and environment checks', async () => {
    const health = await app.inject({ url: '/api/health', headers });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['cache-control']).toBe('no-store');

    const list = await app.inject({ url: '/api/tasks', headers });
    expect(list.json()).toEqual({ tasks: [] });

    const doctor = await app.inject({ url: '/api/doctor', headers });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().checks.map((check: { id: string }) => check.id))
      .toEqual(['platform', 'node', 'pnpm', 'git', 'codex', 'unity', 'unityProject']);
  }, 12000);

  it('accepts same-origin JSON, trims task fields and returns its location', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { host, origin: `http://${host}` },
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task).toMatchObject({
      title: '青溪地图', description: "O'Brien 的双端说明", targetPlatform: 'BOTH', status: 'CREATED',
    });
    expect(response.headers.location).toBe(`/api/tasks/${task.id}`);

    const detail = await app.inject({ url: `/api/tasks/${task.id}`, headers });
    expect(detail.json()).toEqual(task);
  });

  it.each([
    { ...input, title: '   ' },
    { ...input, targetPlatform: 'LINUX' },
    { ...input, description: 'x'.repeat(4001) },
    { ...input, status: 'RUNNING' },
  ])('rejects invalid task data without creating a record', async (payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_TASK');
    const list = await app.inject({ url: '/api/tasks', headers });
    expect(list.json().tasks).toEqual([]);
  });

  it('rejects invalid and unknown task IDs', async () => {
    const invalid = await app.inject({ url: '/api/tasks/not-a-uuid', headers });
    const unknown = await app.inject({ url: `/api/tasks/${randomUUID()}`, headers });
    expect(invalid.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(404);
  });

  it('rejects foreign hosts and origins before a task can be written', async () => {
    const rebound = await app.inject({
      method: 'POST', url: '/api/tasks', headers: { host: 'outside.example:4317' }, payload: input,
    });
    const crossOrigin = await app.inject({
      method: 'POST', url: '/api/tasks', headers: { host, origin: 'http://127.0.0.1:5173' }, payload: input,
    });
    expect(rebound.statusCode).toBe(403);
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect((await app.inject({ url: '/api/tasks', headers })).json()).toEqual({ tasks: [] });
  });

  it('requires JSON and limits request size', async () => {
    const text = await app.inject({
      method: 'POST', url: '/api/tasks', headers: { host, 'content-type': 'text/plain' }, payload: JSON.stringify(input),
    });
    const oversized = await app.inject({
      method: 'POST', url: '/api/tasks', headers, payload: { ...input, description: 'x'.repeat(33 * 1024) },
    });
    expect(text.statusCode).toBe(415);
    expect(oversized.statusCode).toBe(413);
  });
});

it('persists task fields in a SQLite file and opens it again after Hub shutdown', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
  const databasePath = join(directory.path, '本机 数据', 'tasks.sqlite');
  const first = createServer({ port, databasePath, managedDataDirectory: true });
  const recorded = await (async () => {
    try {
      const response = await first.inject({ method: 'POST', url: '/api/tasks', headers, payload: input });
      expect(response.statusCode).toBe(201);
      return response.json();
    } finally {
      await first.close();
    }
  })();

  const second = createServer({ port, databasePath, managedDataDirectory: true });
  try {
    const list = await second.inject({ url: '/api/tasks', headers });
    expect(list.json()).toEqual({ tasks: [recorded] });
  } finally {
    await second.close();
  }
}, 35000);
