import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from '@devhub/hub';
import { createLogger } from '@devhub/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionBinding, ExecutionRequest } from '../packages/contracts/dist/index.js';
import { legacyProjectId } from '../packages/contracts/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { claimFromLocalRunner } from '../apps/hub/dist/runner-ipc.js';
import { inspectWorktree } from '../apps/hub/dist/worktree.js';

const port = 4317;
const host = '127.0.0.1:' + port;
const origin = 'http://' + host;
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: fileURLToPath(new URL('../apps/hub/config/readonly.gitconfig', import.meta.url)),
};
const actualPlatform = process.platform === 'darwin' || process.platform === 'win32';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/hub/dist/authorization-cli.js', import.meta.url));
const taskInput = { title: '本地测试任务', description: '模拟线程和测试仓库', targetPlatform: 'BOTH' } as const;

function git(directory: string, ...args: string[]) {
  return execFileSync('git', [
    '-C', directory, '-c', 'user.name=DevHub Test', '-c', 'user.email=local@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { env: gitEnv, encoding: 'utf8', timeout: 10000 });
}

async function fixture() {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'devhub-authorization-'));
  const repository = join(temp.path, '临时 Git 仓库');
  const databasePath = join(temp.path, 'data', 'tasks.sqlite');
  mkdirSync(repository);
  git(repository, 'init', '-b', 'main', '-q');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, 'README.md'), 'original\n');
  writeFileSync(join(repository, '.gitignore'), '*.ignored\n');
  git(repository, 'add', '--', '.gitignore', 'README.md');
  git(repository, 'commit', '-qm', 'Create test repository');
  let now = Date.now();
  const clock = () => now;
  const store = openTaskStore(databasePath, true, clock);
  const device = actualPlatform ? localDevice() : { platform: 'MACOS' as const, deviceId: sha256('test-device') };
  const runner = store.execution.registerRunner({ ...device, label: 'Native IPC test' });
  const tree = await inspectWorktree(repository);
  store.execution.registerWorktree(tree, legacyProjectId);
  const task = store.create(taskInput, legacyProjectId);
  const logs: string[] = [];
  const makeServer = () => createServer({ port, databasePath, managedDataDirectory: true, clock,
    logger: createLogger('info', { write: (message) => logs.push(message) }) });
  const servers = [makeServer()];
  const app = servers[0]!;
  const bootstrap = store.execution.createBootstrap();
  const login = await app.inject({
    method: 'POST', url: '/api/operator/session', headers: { host, origin },
    payload: { bootstrapCredential: bootstrap.proof },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const csrf = login.json().csrfToken as string;
  const headers = { host, origin, cookie, 'x-csrf-token': csrf };
  const binding: ExecutionBinding = {
    taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
    repoId: tree.repoId, worktreeId: tree.worktreeId, baseHeadSha: tree.baseHeadSha,
    codexThreadId: 'thread_fixture', runnerId: runner.id, platform: runner.platform,
    scope: { operation: 'process.run', executable: 'git', action: 'status' }, policyVersion: 1,
  };

  const create = (value: unknown = binding, key: string = randomUUID()) => app.inject({
    method: 'POST', url: '/api/execution-requests', headers: { ...headers, 'idempotency-key': key }, payload: value as object,
  });
  const review = (item: ExecutionRequest, decision: 'approve' | 'deny' | 'revoke', key: string = randomUUID(), server = app) =>
    server.inject({
      method: 'POST', url: '/api/execution-requests/' + item.id + (decision === 'revoke' ? '/revoke' : '/decision'),
      headers: { ...headers, 'idempotency-key': key },
      payload: decision === 'revoke' ? { expectedVersion: item.version } : { expectedVersion: item.version, decision },
    });
  async function createPending() {
    const response = await create();
    expect(response.statusCode, response.body).toBe(201);
    return response.json<ExecutionRequest>();
  }
  async function createApproved() {
    const response = await review(await createPending(), 'approve');
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ExecutionRequest>();
  }

  return {
    app, store, logs, repository, databasePath, task, device, runner, binding, bootstrap, login, headers,
    create, review, createPending, createApproved,
    moveTime(milliseconds: number) { now += milliseconds; },
    openServer() {
      const instance = makeServer();
      servers.push(instance);
      return instance;
    },
    async restart() {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      const instance = makeServer();
      servers.push(instance);
      return instance;
    },
    async close() {
      await Promise.all(servers.map((server) => server.close()));
      store.close();
      temp.remove();
    },
  };
}

function claimFor(item: ExecutionRequest, idempotencyKey: string = randomUUID()) {
  expect(item.grantId).toBeTruthy();
  return { grantId: item.grantId!, expectedVersion: item.version, bindingDigest: item.bindingDigest, idempotencyKey };
}

describe('local execution authorization', () => {
  let context: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { context = await fixture(); }, 60000);
  afterEach(async () => { await context?.close(); }, 60000);

  it('exchanges once, sets protected cookies and keeps plaintext out of SQLite and logs', async () => {
    const { login, bootstrap, app, headers, databasePath, logs } = context;
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).not.toContain('Domain=');
    expect(login.headers['cache-control']).toBe('no-store');
    const again = await app.inject({
      method: 'POST', url: '/api/operator/session', headers: { host, origin },
      payload: { bootstrapCredential: bootstrap.proof },
    });
    expect(again.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/operator/session', headers })).statusCode).toBe(200);
    const sessionProof = headers.cookie.slice(headers.cookie.indexOf('=') + 1);
    for (const proof of [bootstrap.proof, sessionProof, headers['x-csrf-token']]) {
      expect(readFileSync(databasePath).includes(proof)).toBe(false);
      expect(logs.join('')).not.toContain(proof);
    }
    expect(readFileSync(databasePath).includes(sha256(sessionProof))).toBe(true);
  }, 60000);

  it('rejects missing, null, wrong-port Origin and invalid/missing CSRF before writes', async () => {
    const { app, binding, headers } = context;
    const base = { host, cookie: headers.cookie };
    for (const rejected of [
      { ...base, 'x-csrf-token': headers['x-csrf-token'] },
      { ...headers, origin: 'null' },
      { ...headers, origin: 'http://127.0.0.1:4318' },
      { ...headers, origin: origin + '/' },
      { ...base, origin },
      { ...headers, 'x-csrf-token': '0'.repeat(64) },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/api/execution-requests',
        headers: { ...rejected, 'idempotency-key': randomUUID() }, payload: binding,
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(context.store.execution.requests()).toEqual([]);
    const logout = await app.inject({ method: 'DELETE', url: '/api/operator/session', headers });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/operator/session', headers })).statusCode).toBe(401);
  }, 60000);

  it('revokes an approved grant idempotently and prevents further consumption', async () => {
    const approved = await context.createApproved();
    const key = randomUUID();
    expect((await context.review(approved, 'revoke', key)).json().status).toBe('REVOKED');
    expect((await context.review(approved, 'revoke', key)).json().status).toBe('REVOKED');
    await expect(claimFromLocalRunner(context.store.execution, context.runner.id, claimFor(approved), context.device))
      .rejects.toThrow();
    expect(context.store.execution.detail(approved.id).events.map((event) => event.kind)).toEqual(['PENDING', 'APPROVED', 'REVOKED']);
  }, 60000);

  it('expires bootstrap proofs and operator sessions', async () => {
    const next = context.store.execution.createBootstrap();
    context.moveTime(5 * 60_000);
    const expired = await context.app.inject({
      method: 'POST', url: '/api/operator/session', headers: { host, origin }, payload: { bootstrapCredential: next.proof },
    });
    expect(expired.statusCode).toBe(401);
    context.moveTime(8 * 60 * 60_000);
    expect((await context.app.inject({ url: '/api/operator/session', headers: context.headers })).statusCode).toBe(401);
  }, 60000);

  it('replays creation and decisions idempotently, and rejects new input under the same key', async () => {
    const key = randomUUID();
    const initial = (await context.create(context.binding, key)).json<ExecutionRequest>();
    expect((await context.create(context.binding, key)).json().id).toBe(initial.id);
    const conflict = await context.create({ ...context.binding, codexThreadId: 'other_thread' }, key);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
    const decision = randomUUID();
    expect((await context.review(initial, 'deny', decision)).json().status).toBe('DENIED');
    expect((await context.review(initial, 'deny', decision)).json().status).toBe('DENIED');
    expect((await context.review(initial, 'approve', decision)).json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(context.store.execution.detail(initial.id).events.map((event) => event.kind)).toEqual(['PENDING', 'DENIED']);
  }, 60000);

  it('rejects shell strings, path escapes, ignored paths and mismatched approval bindings', async () => {
    for (const scope of [
      { operation: 'process.run', executable: 'git', action: 'status && whoami' },
      { operation: 'process.run', executable: 'git', action: 'status', args: ['--ignored'] },
      { operation: 'workspace.write', paths: ['../outside'] },
      { operation: 'workspace.write', paths: ['.git/config'] },
      { operation: 'workspace.write', paths: ['COM1.txt'] },
    ]) {
      expect((await context.create({ ...context.binding, scope })).statusCode).toBe(400);
    }
    const ignored = await context.create({ ...context.binding, scope: { operation: 'workspace.write', paths: ['test.ignored'] } });
    expect(ignored.statusCode, ignored.body).toBe(409);
    for (const binding of [
      { ...context.binding, taskSpecSha256: '0'.repeat(64) },
      { ...context.binding, policyVersion: 2 },
      { ...context.binding, baseHeadSha: '0'.repeat(40) },
      { ...context.binding, repoId: '0'.repeat(64) },
      { ...context.binding, platform: context.binding.platform === 'WINDOWS' ? 'MACOS' : 'WINDOWS' },
    ]) {
      expect((await context.create(binding)).statusCode).toBe(409);
    }
  }, 60000);

  it('separates HTTP operator credentials, other Runners and other devices from the intended Runner', async () => {
    const { app, store, runner, device, headers } = context;
    const approved = await context.createApproved();
    const claim = claimFor(approved);
    const runnerProof = store.execution.activateRunner(runner.id, device.deviceId, device.platform);
    const crossHttp = await app.inject({ url: '/api/execution-requests', headers: { host, cookie: 'devhub_operator=' + runnerProof } });
    expect(crossHttp.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/runner/grants/' + claim.grantId + '/claim',
      headers, payload: claim })).statusCode).toBe(404);
    const operatorProof = headers.cookie.slice(headers.cookie.indexOf('=') + 1);
    expect(() => store.execution.mutate({ ...claim, kind: 'claim', runnerId: runner.id, deviceId: device.deviceId,
      proofDigest: sha256(operatorProof), workspaceMatches: true })).toThrow('UNAUTHENTICATED');
    const other = store.execution.registerRunner({ ...device, label: 'Other runner' });
    await expect(claimFromLocalRunner(store.execution, other.id, claim, device)).rejects.toThrow('FORBIDDEN');
    await expect(claimFromLocalRunner(store.execution, runner.id, claim, { ...device, deviceId: '0'.repeat(64) })).rejects.toThrow('FORBIDDEN');
    expect(store.execution.getRequest(approved.id)?.status).toBe('APPROVED');
  }, 60000);

  it('keeps the file-backed session, grant, and audit across a Hub restart and consumes only once', async () => {
    const approved = await context.createApproved();
    const reopened = await context.restart();
    const detailUrl = '/api/execution-requests/' + approved.id;
    expect((await reopened.inject({ url: detailUrl, headers: context.headers })).json().request).toEqual(approved);
    const claim = claimFor(approved);
    const { store, runner, device } = context;
    expect((await claimFromLocalRunner(store.execution, runner.id, claim, device)).status).toBe('CLAIMED');
    await expect(claimFromLocalRunner(store.execution, runner.id, claim, device)).rejects.toThrow('ALREADY_CLAIMED');
    const detail = (await reopened.inject({ url: detailUrl, headers: context.headers })).json();
    expect(detail.events.map((event: { kind: string }) => event.kind)).toEqual(['PENDING', 'APPROVED', 'CLAIMED']);
  }, 60000);

  it('serializes concurrent approval and revoke-versus-claim without a duplicate audit event', async () => {
    const pending = await context.createPending();
    const otherServer = context.openServer();
    const results = await Promise.all([context.review(pending, 'approve'), context.review(pending, 'approve', randomUUID(), otherServer)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const approved = results.find((result) => result.statusCode === 200)!.json<ExecutionRequest>();
    const { store, runner, device } = context;
    const competing = await Promise.allSettled([
      context.review(approved, 'revoke'), claimFromLocalRunner(store.execution, runner.id, claimFor(approved), device),
    ]);
    const winner = store.execution.detail(pending.id);
    expect(['CLAIMED', 'REVOKED']).toContain(winner.request.status);
    expect(winner.events.map((event) => event.kind)).toEqual(['PENDING', 'APPROVED', winner.request.status]);
    const successes = Number(competing[0]?.status === 'fulfilled' && competing[0].value.statusCode === 200) +
      Number(competing[1]?.status === 'fulfilled' && competing[1].value.status === 'CLAIMED');
    expect(successes).toBe(1);
  }, 60000);

  it.skipIf(!actualPlatform)('allows one claim from concurrent native CLI processes sharing the SQLite file', async () => {
    const approved = await context.createApproved();
    const { grantId, expectedVersion, bindingDigest } = claimFor(approved);
    const args = [cli, 'runner-claim', context.runner.id, grantId, String(expectedVersion), bindingDigest];
    const options = { env: { ...process.env, DEVHUB_DB_PATH: context.databasePath }, timeout: 30000 };
    const results = await Promise.allSettled([
      exec(process.execPath, [...args, randomUUID()], options),
      exec(process.execPath, [...args, randomUUID()], options),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect(JSON.parse(succeeded[0]!.value.stdout).status).toBe('CLAIMED');
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason.stderr).toContain('ALREADY_CLAIMED');
    expect(context.store.execution.detail(approved.id).events.filter((event) => event.kind === 'CLAIMED')).toHaveLength(1);
  }, 60000);

  it('expires both pending requests and grants, or permanently revokes them on a changed task or HEAD', async () => {
    const pending = await context.createPending();
    const approved = await context.createApproved();
    context.moveTime(2 * 60_000);
    await expect(claimFromLocalRunner(context.store.execution, context.runner.id, claimFor(approved), context.device)).rejects.toThrow();
    expect(context.store.execution.detail(approved.id).request.status).toBe('EXPIRED');
    context.moveTime(8 * 60_000);
    expect(context.store.execution.detail(pending.id).request.status).toBe('EXPIRED');

    const headGrant = await context.createApproved();
    git(context.repository, 'commit', '--allow-empty', '-qm', 'Move HEAD without changing files');
    await expect(claimFromLocalRunner(context.store.execution, context.runner.id, claimFor(headGrant), context.device)).rejects.toThrow('STALE_CONTEXT');
    expect(context.store.execution.detail(headGrant.id).events.at(-1)?.reason).toBe('CONTEXT_CHANGED');
    expect(context.store.execution.getRequest(headGrant.id)?.status).toBe('REVOKED');
    const live = await inspectWorktree(context.repository);
    const created = await context.create({ ...context.binding, baseHeadSha: live.baseHeadSha });
    expect(created.statusCode).toBe(201);
    const taskRequest = (await context.review(created.json<ExecutionRequest>(), 'approve')).json<ExecutionRequest>();
    const revised = await context.app.inject({
      method: 'PUT', url: '/api/tasks/' + context.task.id + '/spec', headers: context.headers,
      payload: { ...taskInput, expectedRevision: 1, description: 'New task text' },
    });
    expect(revised.json().revision).toBe(2);
    expect(context.store.execution.detail(taskRequest.id).events.at(-1)?.reason).toBe('TASK_REVISION_CHANGED');
    await expect(claimFromLocalRunner(context.store.execution, context.runner.id, claimFor(taskRequest), context.device)).rejects.toThrow();
  }, 60000);

  it('invalidates a pending request when a tracked file is changed without moving HEAD', async () => {
    const request = await context.createPending();
    writeFileSync(join(context.repository, 'README.md'), 'uncommitted update\n');
    expect((await context.review(request, 'approve')).json().code).toBe('STALE_CONTEXT');
    expect(context.store.execution.getRequest(request.id)?.status).toBe('REVOKED');
  }, 60000);

  it('fails closed on external Git filters without using the configured command', async () => {
    const request = await context.createPending();
    git(context.repository, 'config', 'filter.unregistered.clean', 'unregistered-executable');
    expect((await context.review(request, 'approve')).json().code).toBe('STALE_CONTEXT');
    expect(context.store.execution.getRequest(request.id)?.status).toBe('REVOKED');
    git(context.repository, 'config', '--unset', 'filter.unregistered.clean');
    git(context.repository, 'config', 'filter.unregistered.smudge', 'unregistered-executable');
    await expect(inspectWorktree(context.repository)).rejects.toThrow('external Git filters');
  }, 60000);
});

it('migrates a Sprint 2.1 database without rewriting the stored task', () => {
  using temp = mkdtempDisposableSync(join(tmpdir(), 'devhub-legacy-'));
  const filename = join(temp.path, 'tasks.sqlite');
  const old = new DatabaseSync(filename);
  const id = randomUUID();
  const createdAt = '2026-11-19T00:00:00.000Z';
  try {
    old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      target_platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`);
    old.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)').run(id, '原任务', '原说明', 'BOTH', 'CREATED', createdAt);
  } finally {
    old.close();
  }
  const store = openTaskStore(filename, true);
  try {
    expect(store.get(id)).toEqual({
      id, title: '原任务', description: '原说明', targetPlatform: 'BOTH', status: 'CREATED', createdAt, revision: 1, projectId: legacyProjectId,
    });
    expect(store.execution.requests()).toEqual([]);
  } finally {
    store.close();
  }
}, 60000);
