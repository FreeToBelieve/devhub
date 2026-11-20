import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createServer } from '@devhub/hub';
import { executionPolicyVersion, executionRequestSchema, inboxStatusSchema, projectInputSchema, taskInbox } from '../packages/contracts/dist/index.js';
import type { ExecutionBinding, ExecutionRequest, GitDeliveryBinding, InboxSource, Project, RunnerRecord } from '../packages/contracts/dist/index.js';
import { githubTaskInbox } from '../packages/git-provider/dist/index.js';
import type { GitApiTransport } from '../packages/git-provider/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { openTaskStore, projectContextDigest, taskSpecDigest } from '../packages/storage/dist/index.js';
import { lockCodexHost } from '../apps/hub/dist/codex-host-lock.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';
import { inspectWorktree } from '../apps/hub/dist/worktree.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';

const version = '6000.3.28f1';
const workspace = sha256('fixture workspace');
const baseHead = 'a'.repeat(40);
const token = 'github_pat_' + '0'.repeat(48);
const signedIn = (store: ReturnType<typeof openTaskStore>) =>
  sha256(store.execution.exchangeBootstrap(sha256(store.execution.createBootstrap().proof)).proof);

function createProject(store: ReturnType<typeof openTaskStore>, root: string, name: string) {
  return store.projects.create({ name, repositoryRoot: join(root, name), unityProjectPath: '.', unityVersion: version,
    repoId: sha256(name), settings: { description: '', gameType: '', documents: [] }, targetPlatform: 'BOTH' });
}

function source(number: number, projectId: string, headSha = '1'.repeat(40)): InboxSource {
  const key = 'task-' + number;
  const scene = 'Assets/Test.unity';
  const text = ['# DevHub AI Task', '', '- Task ID: `' + key + '`', '- Project ID: `' + projectId + '`',
    '- Target Unity: `' + version + '`', '- Test scene: `' + scene + '`', '', '## Objective', 'Synthetic fixture.',
    '', '## Strictly out of scope', 'Production.', '', '## Acceptance plan', 'Use a fixture.',
    '', '## Expected completion report', 'Test summary.', ''].join('\n');
  const blobSha = createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
  return { repositoryId: taskInbox.repositoryId, number, projectId, key, headSha, scene, unityVersion: version,
    title: 'Fixture issue ' + number, blobSha, text };
}

function mockGithub(task: InboxSource, options: { mode?: string; echo?: boolean; forge?: boolean } = {}) {
  const identity = { id: taskInbox.repositoryId, full_name: taskInbox.repository };
  const candidate = { number: task.number, state: 'open', draft: true, title: '[DEVHUB-TASK] ' + task.title,
    user: { login: taskInbox.author, id: taskInbox.authorId },
    head: { ref: 'ai-task/' + task.key, sha: task.headSha, repo: identity },
    base: { ref: 'main', repo: identity } };
  const tree = '2'.repeat(40), devhub = '3'.repeat(40), tasks = '4'.repeat(40);
  const goodData = new Map<string, unknown>([
    ['', { ...identity, private: true, default_branch: 'main' }],
    ['/pulls/' + task.number, candidate],
    ['/git/commits/' + task.headSha, { sha: task.headSha, tree: { sha: tree } }],
    ['/git/trees/' + tree, { truncated: false, tree: [{ path: '.devhub', sha: devhub, mode: '040000', type: 'tree' }] }],
    ['/git/trees/' + devhub, { truncated: false, tree: [{ path: 'tasks', sha: tasks, mode: '040000', type: 'tree' }] }],
    ['/git/trees/' + tasks, { truncated: false, tree: [{ path: task.key + '.md', sha: task.blobSha,
      mode: options.mode ?? '100644', type: 'blob', size: Buffer.byteLength(task.text) }] }],
    ['/git/blobs/' + task.blobSha, { encoding: 'base64', sha: task.blobSha, size: Buffer.byteLength(task.text),
      content: Buffer.from(options.forge ? task.text.replace('Synthetic', 'Different') : task.text).toString('base64') }],
  ]);
  let open = true;
  let listenerCalls = 0;
  const transport: GitApiTransport = async (url, method, headers, body) => {
    expect(url.origin).toBe('https://api.github.com');
    expect(method).toBe('GET');
    expect(body).toBeUndefined();
    expect(headers.authorization === 'Bearer ' + token).toBe(true);
    const path = url.pathname.slice(('/repos/' + taskInbox.repository).length);
    if (options.echo) return { status: 200, headers: {}, data: { unexpected: token } };
    if (path === '/pulls') {
      expect(url.searchParams.get('state')).toBe('open');
      expect(url.searchParams.get('base')).toBe('main');
      listenerCalls++;
      return { status: 200, headers: {}, data: open ? [
        candidate, { ...candidate, user: { ...candidate.user, id: 123 } },
        { ...candidate, head: { ...candidate.head, repo: { id: 123 } } },
        { ...candidate, head: { ...candidate.head, ref: 'ai-task/../.env' } },
        { ...candidate, base: { ...candidate.base, ref: 'release' } },
      ] : [] };
    }
    if (!open && path === '/pulls/' + task.number) return { status: 200, headers: {}, data: { ...candidate, state: 'closed' } };
    if (!goodData.has(path)) throw new Error('Unexpected fixture URL');
    return { status: 200, headers: {}, data: goodData.get(path) };
  };
  return { api: githubTaskInbox(token, transport), calls: () => listenerCalls, close: () => { open = false; } };
}

describe('GitHub Task Inbox', () => {
  it('validates author, same repo, refs and exact SHA and reads only the verified blob', async () => {
    const entry = source(1, randomUUID());
    const { api } = mockGithub(entry);
    await api.verify();
    const candidates = await api.open();
    expect(candidates).toHaveLength(1);
    expect(await api.current(1)).toEqual(candidates[0]);
    expect(await api.read(candidates[0]!)).toEqual(entry);
    for (const options of [{ mode: '120000' }, { forge: true }]) {
      const { api: unsafe } = mockGithub(entry, options);
      await expect(unsafe.read(candidates[0]!)).rejects.toThrow('INBOX_TASK_FORMAT');
    }
    await expect(mockGithub(entry, { echo: true }).api.verify()).rejects.toThrow('INBOX_UNSAFE_CONTENT');
  });

  it('requires session, Origin and CSRF, scans once, queues offline and invalidates closed PRs', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-api-'));
    const databasePath = join(dir.path, 'data', 'tasks.sqlite');
    const store = openTaskStore(databasePath, true);
    const project = createProject(store, dir.path, 'Game');
    const fixture = mockGithub(source(1, project.id));
    const vault = new Map<string, string>();
    const app = createServer({ databasePath, managedDataDirectory: true, port: 4317, inboxDependencies: {
      credentials: async () => ({
        async set(ref, value) { vault.set(ref, value); },
        async get(ref) { return vault.get(ref) ?? null; },
        async remove(ref) { vault.delete(ref); },
      }),
      github: (value) => { expect(value === token).toBe(true); return fixture.api; },
      execute: async () => { throw new Error('Unexpected execution'); },
    } });
    const local = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
    try {
      expect((await app.inject({ method: 'GET', url: '/api/task-inbox', headers: local })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/operator/session', headers: local,
        payload: { bootstrapCredential: store.execution.createBootstrap().proof } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const headers = { ...local, cookie, 'x-csrf-token': login.json().csrfToken as string };
      const save = (authorization: Record<string, string>) => app.inject({ method: 'PUT',
        url: '/api/task-inbox/credential', headers: authorization, payload: { token } });
      expect((await save({ ...headers, origin: 'http://127.0.0.1:4318' })).statusCode).toBe(403);
      expect((await save({ ...local, cookie })).statusCode).toBe(403);
      expect((await save(headers)).statusCode).toBe(204);
      expect([...vault.values()]).toEqual([token]);
      expect(JSON.stringify(store.inbox.settings()).includes(token)).toBe(false);
      expect((await app.inject({ method: 'PUT', url: '/api/task-inbox/listener', headers, payload: { enabled: true } })).statusCode).toBe(204);
      const scan = () => app.inject({ method: 'POST', url: '/api/task-inbox/scan', headers });
      expect((await scan()).statusCode).toBe(200);
      const result = await app.inject({ method: 'GET', url: '/api/task-inbox', headers });
      expect(result.body.includes(token)).toBe(false);
      const status = inboxStatusSchema.parse(result.json());
      expect(status.sessions).toHaveLength(1);
      const session = status.sessions[0]!;
      expect(store.inbox.messages(session.id)).toHaveLength(1);
      expect(status.messageCounts.PENDING).toBe(1);
      expect(store.codex.list(project.id)).toEqual([]);
      expect(store.execution.requests(project.id)).toEqual([]);
      fixture.close();
      expect((await scan()).statusCode).toBe(200);
      expect(store.inbox.session(session.id)?.status).toBe('CLOSED');
      expect(store.inbox.messages(session.id)[0]?.status).toBe('STALE');
      expect(fixture.calls()).toBeGreaterThanOrEqual(2);
    } finally { await app.close(); store.close(); }
  });
});

type Store = ReturnType<typeof openTaskStore>;
type Attempt =
  | { kind: 'git'; id: string; approval: { expectedVersion: number; digest: string }; actor: string; owner: string }
  | { kind: 'codex' | 'unity'; input: Parameters<Store['execution']['mutate']>[0]; owner: string; host?: string }
  | { kind: 'host'; owner: string; runner: RunnerRecord }
  | { kind: 'thread'; id: string; threadId: string };

async function race(filename: string, attempts: Attempt[]) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const threads = attempts.map((attempt) => {
    const thread = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      async function run() {
        const { openTaskStore } = await import(workerData.module);
        const store = openTaskStore(workerData.filename, true);
        try {
          const a = workerData.attempt;
          parentPort.postMessage('ready');
          if (Atomics.wait(workerData.gate, 0, 0, 15000) === 'timed-out') throw new Error('Barrier timeout');
          let id;
          if (a.kind === 'host') id = store.inbox.acquire(a.owner, a.runner).id;
          else if (a.kind === 'git') id = store.git.claim(a.id, a.approval, a.actor, a.owner).id;
          else if (a.kind === 'thread') {
            store.codex.append(a.id, {kind:'thread.started',threadId:a.threadId});
            id = a.id;
          } else store.execution.mutate(a.input, (req) => {
            id = a.kind === 'codex' ? store.codex.reserveWithinClaim(req, a.owner, a.host).devhubRunId :
              store.unity.reserveWithinClaim(req, a.owner).id;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          });
          parentPort.postMessage({ id });
        } catch (error) { parentPort.postMessage({ error: error.message }); }
        finally { store.close(); }
      }
      void run();
    `, { eval: true, workerData: { filename, gate, attempt,
      module: new URL('../packages/storage/dist/index.js', import.meta.url).href } });
    const ready = new Promise<void>((resolve, reject) => {
      thread.once('message', (value) => value === 'ready' ? resolve() : reject(new Error('SQLite fixture unavailable')));
      thread.once('error', reject);
    });
    const done = new Promise<{ id?: string; error?: string }>((resolve, reject) => {
      thread.on('message', (value) => { if (value !== 'ready') resolve(value); });
      thread.once('error', reject);
      thread.once('exit', (code) => { if (code !== 0) reject(new Error('Claim worker exited')); });
    });
    void done.catch(() => undefined);
    return { thread, ready, done };
  });
  try {
    await Promise.all(threads.map(({ ready }) => ready));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    return await Promise.all(threads.map(({ done }) => done));
  } finally { await Promise.all(threads.map(({ thread }) => thread.terminate())); }
}

function makeFixture(store: Store, root: string) {
  const actor = signedIn(store);
  const runner = store.execution.registerRunner({ label: 'Fixture', ...localDevice() });
  const owner = sha256('test lease');
  const host = store.inbox.acquire(owner, runner);
  function add(number: number, project: Project) {
    const payload = source(number, project.id);
    expect(store.inbox.accept(payload)).toBe(true);
    expect(store.inbox.accept(payload)).toBe(false);
    store.inbox.deliver(owner);
    const taskId = String(store.inbox.current(number)?.taskId);
    const session = store.inbox.sessions(project.id, undefined, taskId)[0]!;
    const worktree = store.execution.registerWorktree({ worktreeId: sha256('tree-' + number),
      repoId: project.repoId!, root: join(root, 'tree-' + number) }, project.id);
    store.codex.manage(worktree.worktreeId);
    store.inbox.bindWorktree(owner, session.id, worktree.worktreeId);
    return { sessionId: session.id, payload, project, worktree };
  }
  function context(item: ReturnType<typeof add>) {
    const session = store.inbox.session(item.sessionId)!;
    const task = store.get(session.taskId, item.project.id)!;
    return { projectId: item.project.id, projectContextSha256: projectContextDigest(item.project),
      taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
      repoId: item.worktree.repoId, worktreeId: item.worktree.worktreeId };
  }
  function prepare(item: ReturnType<typeof add>, kind: 'codex' | 'unity', linked = true) {
    const session = store.inbox.session(item.sessionId)!;
    const message = store.inbox.messages(session.id)[0]!;
    const thread = kind === 'codex' ? session.providerThreadId : null;
    const scope: ExecutionBinding['scope'] = kind === 'codex' ? {
      operation: 'codex.turn', mode: thread ? 'resume' : 'start', previousRunId: thread ? session.lastRunId : null,
      executionProfile: 'PROJECT_DEVELOPER', networkMode: 'OFF', sdkConfigSha256: workspace,
      workspaceSha256: workspace, promptSha256: sha256(message.source.text),
    } : { operation: 'unity.run', plan: { stage: 'IMPORT', timeoutSeconds: 30 },
      workspaceSha256: workspace, configSha256: workspace, editorVersion: version };
    return store.execution.createRequest({ ...context(item), scope, baseHeadSha: baseHead,
      codexThreadId: thread, runnerId: runner.id, platform: runner.platform, policyVersion: executionPolicyVersion },
    actor, randomUUID(), true, kind === 'codex' && linked ? (request) => store.inbox.linkRequest(owner, message.id, request) : undefined);
  }
  function approve(request: ExecutionRequest, kind: 'codex' | 'unity'): Extract<Attempt, { input: unknown }> {
    const approved = store.execution.mutate({ kind: 'approve', requestId: request.id, expectedVersion: request.version,
      sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
    return { kind, owner: randomUUID(), host: owner, input: claimInput(approved) };
  }
  function claimInput(approved: ExecutionRequest) {
    return { kind: 'claim' as const, grantId: approved.grantId!, bindingDigest: approved.bindingDigest,
      expectedVersion: approved.version, idempotencyKey: randomUUID(), runnerId: runner.id, deviceId: runner.deviceId,
      proofDigest: sha256(store.execution.activateRunner(runner.id, runner.deviceId, runner.platform)), workspaceMatches: true };
  }
  function git(item: ReturnType<typeof add>, connect: boolean): Extract<Attempt, { kind: 'git' }> {
    const projectId = item.project.id;
    if (connect) {
      const credentialRef = randomUUID();
      store.git.reserveCredential(projectId, credentialRef);
      store.git.connect({ projectId, provider: 'github', credentialRef, repositoryUrl: 'https://github.com/example/fixture',
        remoteId: 'fixture', defaultBranch: 'main', apiBaseUrl: 'https://api.github.com', account: 'fixture' }, 0, actor);
    }
    const binding: GitDeliveryBinding = { ...context(item), head: baseHead, remoteHead: baseHead, branch: 'devhub/' + item.payload.key,
      connectionVersion: 1, targetBranch: 'main', worktreeRoot: item.worktree.root, workspaceSha256: workspace,
      candidateTreeSha: 'c'.repeat(40), candidateDiffDigest: sha256('diff'), title: 'Fixture', description: '',
      author: { name: 'Fixture', email: 'fixture@example.invalid' } };
    const preview = store.git.preview(binding, { changes: [], diff: '', candidate: {
      canCommit: true, candidateTreeSha: binding.candidateTreeSha!, candidateDiffDigest: binding.candidateDiffDigest!,
      workspaceSha256: workspace, baseHeadSha: baseHead, changedFiles: [],
      candidateFileSummary: { added: 0, modified: 0, deleted: 0, renamed: 0, 'type-changed': 0 },
    } }, sha256(item.sessionId), actor, randomUUID());
    const approved = store.git.approve(preview.id, { expectedVersion: preview.version, digest: preview.digest }, actor);
    return { kind: 'git', id: approved.id, actor, owner: randomUUID(),
      approval: { expectedVersion: approved.version, digest: approved.digest } };
  }
  return { runner, owner, host, add, prepare, approve, claimInput, git, actor };
}

describe('one Host and concurrent task sessions', () => {
  it('claims three sessions in one project and a fourth in another through separate SQLite writers', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-parallel-'));
    const filename = join(dir.path, 'data', 'tasks.sqlite');
    const store = openTaskStore(filename, true);
    try {
      const a = createProject(store, dir.path, 'A');
      const b = createProject(store, dir.path, 'B');
      const f = makeFixture(store, dir.path);
      const items = [f.add(1, a), f.add(2, a), f.add(3, a), f.add(4, b)];
      const attempts = items.map((item) => f.approve(f.prepare(item, 'codex'), 'codex'));
      const runs = await race(filename, attempts);
      expect(runs.map(({ error }) => error)).toEqual([undefined, undefined, undefined, undefined]);
      expect(store.inbox.sessions(a.id, 'RUNNING')).toHaveLength(3);
      expect(store.inbox.sessions(b.id, 'RUNNING')).toHaveLength(1);
      expect(store.inbox.sessions().map(({ hostId }) => hostId)).toEqual(Array(4).fill(f.host.id));
      const collisions = await race(filename, [0, 3].map((index) =>
        ({ kind: 'thread', id: runs[index]!.id!, threadId: 'synthetic-thread' })));
      expect(collisions.filter(({ id }) => !!id)).toHaveLength(1);
      expect(collisions.filter(({ error }) => !!error)).toHaveLength(1);
      for (const [index, { id }] of runs.entries()) {
        const failed = index === 1;
        store.codex.finish(id!, attempts[index]!.owner, failed ? 'FAILED' : 'COMPLETED', true, failed ? 'WORKER_FAILED' : null);
      }
      store.inbox.deliver(f.owner);
      expect(store.inbox.sessions(a.id, 'FAILED')).toHaveLength(1);
      expect(store.inbox.sessions(a.id, 'COMPLETED')).toHaveLength(2);
      store.projects.archive(b.id, b.revision);
      expect(store.inbox.sessions(b.id, 'CLOSED')).toHaveLength(1);
      expect(store.inbox.sessions(a.id, 'COMPLETED')).toHaveLength(2);
      expect(store.inbox.session(items[3]!.sessionId)?.status).toBe('CLOSED');
    } finally { store.close(); }
  }, 60000);

  it('excludes a duplicate grant for one Thread and keeps the same Session through revisions and restarts', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-restart-'));
    const filename = join(dir.path, 'data', 'tasks.sqlite');
    let now = Date.now();
    let store = openTaskStore(filename, true, () => now);
    try {
      const a = createProject(store, dir.path, 'A');
      const b = createProject(store, dir.path, 'B');
      const f = makeFixture(store, dir.path);
      const item = f.add(1, a);
      const other = f.add(2, b);
      expect(() => store.inbox.accept(source(3, randomUUID()))).toThrow('INBOX_PROJECT_INVALID');
      expect(() => store.inbox.bindWorktree(f.owner, item.sessionId, other.worktree.worktreeId)).toThrow('INBOX_WORKTREE_MISMATCH');
      const unlinked = f.approve(f.prepare(item, 'codex', false), 'codex');
      expect(() => store.execution.mutate(unlinked.input, (r) => store.codex.reserveWithinClaim(r, unlinked.owner, f.owner)))
        .toThrow('INBOX_APPROVAL_MISMATCH');
      const older = f.prepare(item, 'codex');
      const firstRevision = { ...item.payload, headSha: '2'.repeat(40) };
      expect(store.inbox.accept(firstRevision)).toBe(true);
      expect(store.execution.getRequest(older.id)?.status).toBe('REVOKED');
      store.inbox.deliver(f.owner);
      const first = f.approve(f.prepare(item, 'codex'), 'codex');
      expect(() => store.execution.mutate(first.input, (r) => store.codex.reserveWithinClaim(r, first.owner, 'different lease')))
        .toThrow('INBOX_APPROVAL_MISMATCH');
      let runId = '';
      store.execution.mutate(first.input, (r) => { runId = store.codex.reserveWithinClaim(r, first.owner, f.owner).devhubRunId; });
      store.codex.append(runId, { kind: 'thread.started', threadId: 'synthetic-revision-thread' });
      const revisionWhileRunning = { ...item.payload, headSha: '3'.repeat(40) };
      expect(store.inbox.accept(revisionWhileRunning)).toBe(true);
      store.inbox.deliver(f.owner);
      expect(store.inbox.messages(item.sessionId)[0]?.status).toBe('PENDING');
      store.codex.finish(runId, first.owner, 'COMPLETED', true, null);
      store.inbox.deliver(f.owner);
      const resumed = f.prepare(item, 'codex');
      expect(resumed.binding.codexThreadId).toBe('synthetic-revision-thread');
      expect(resumed.binding.scope).toMatchObject({ mode: 'resume', previousRunId: runId });
      const attempt = f.approve(resumed, 'codex');
      const replay = { ...attempt, input: f.claimInput(store.execution.getRequest(resumed.id)!) };
      const results = await race(filename, [attempt, replay]);
      expect(results.filter(({ id }) => !!id)).toHaveLength(1);
      expect(results.filter(({ error }) => error === 'ALREADY_CLAIMED')).toHaveLength(1);
      const set = results.findIndex(({ id }) => !!id);
      const active = results[set]!.id!;
      const worker = [attempt, replay][set]!.owner;
      const afterDisconnect = { ...item.payload, headSha: '4'.repeat(40) };
      store.inbox.disconnect(f.owner, true);
      expect(store.inbox.accept(afterDisconnect)).toBe(true);
      expect(store.inbox.messages(item.sessionId)[0]?.status).toBe('PENDING');
      const heartbeatAt = store.codex.get(active)?.heartbeatAt;
      if (heartbeatAt == null) throw new Error('The claiming worker did not persist a heartbeat.');
      store.close();
      now = heartbeatAt + 16_000;
      store = openTaskStore(filename, true, () => now);
      const owner = sha256('restart owner');
      const host = store.inbox.acquire(owner, f.runner);
      expect(host.id).toBe(f.host.id);
      expect(host.installationId).toBe(f.host.installationId);
      expect(store.inbox.sessions()).toHaveLength(2);
      expect(store.inbox.session(item.sessionId)).toMatchObject({ status: 'INTERRUPTED', currentRunId: active,
        providerThreadId: 'synthetic-revision-thread', worktreeId: item.worktree.worktreeId });
      expect(store.git.busy(item.worktree.worktreeId)).toBe(true);
      store.inbox.deliver(owner);
      expect(store.inbox.messages(item.sessionId)[0]?.status).toBe('PENDING');
      store.codex.finish(active, worker, 'FAILED', true, 'WORKER_FAILED');
      store.inbox.deliver(owner);
      expect(store.inbox.messages(item.sessionId)[0]?.status).toBe('DELIVERED');
      expect(store.inbox.session(item.sessionId)?.lastRunId).toBe(active);
      expect(store.git.busy(item.worktree.worktreeId)).toBe(false);
    } finally { store.close(); }
  }, 60000);

  it('rejects a second Host through real SQLite contention, permits only one active native lock', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-host-'));
    const filename = join(dir.path, 'data', 'tasks.sqlite');
    const store = openTaskStore(filename, true);
    try {
      const runner = store.execution.registerRunner({ ...localDevice(), label: 'Fixture' });
      const results = await race(filename, ['first', 'second'].map((name) => ({ kind: 'host', owner: sha256(name), runner })));
      expect(results.filter(({ id }) => !!id)).toHaveLength(1);
      expect(results.filter(({ error }) => error === 'INBOX_SECOND_HOST')).toHaveLength(1);

      const unlock = lockCodexHost(filename);
      try {
        const lockModule = new URL('../apps/hub/dist/codex-host-lock.js', import.meta.url).href;
        const { spawnSync } = await import('node:child_process');
        const contender = spawnSync(process.execPath, ['--input-type=module', '-e',
          "const {lockCodexHost} = await import(process.argv[1]); try { lockCodexHost(process.argv[2])(); } catch (e) { process.stdout.write(e.message) }",
          lockModule, filename], { encoding: 'utf8', timeout: 10_000 });
        expect(contender.status).toBe(0);
        expect(contender.stdout).toBe('INBOX_SECOND_HOST');
      } finally { unlock(); }
      lockCodexHost(filename)();
    } finally { store.close(); }
  }, 60000);

  it('permits Unity and Git Delivery on different worktrees without a Host or project execution lock', async () => {
    using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-unity-git-'));
    const filename = join(dir.path, 'data', 'tasks.sqlite');
    const store = openTaskStore(filename, true);
    try {
      const a = createProject(store, dir.path, 'A');
      const b = createProject(store, dir.path, 'B');
      const f = makeFixture(store, dir.path);
      const unity = [f.add(1, a), f.add(2, b)].map((item) => f.approve(f.prepare(item, 'unity'), 'unity'));
      const git = [f.git(f.add(3, a), true), f.git(f.add(4, a), false)];
      store.inbox.disconnect(f.owner);
      const results = await race(filename, [...unity, ...git]);
      expect(results.map(({ error }) => error)).toEqual([undefined, undefined, undefined, undefined]);
      expect(store.unity.get(results[0]!.id!, a.id)?.status).toBe('RUNNING');
      expect(store.unity.get(results[1]!.id!, b.id)?.status).toBe('RUNNING');
    } finally { store.close(); }
  }, 60000);
});

it('dispatches the same approved source through Hub, Runner IPC, an actual worktree and the SDK stream contract', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'devhub-inbox-turn-'));
  const databasePath = join(dir.path, 'data', 'tasks.sqlite');
  const store = openTaskStore(databasePath, true);
  const project = createProject(store, dir.path, 'Game');
  const { api } = mockGithub(source(1, project.id));
  const repo = project.repositoryRoot!;
  const profile = join(dir.path, 'profile');
  mkdirSync(repo);
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(repo, 'ProjectSettings'));
  writeFileSync(join(repo, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=fixture-hooks', ...args]);
  git('init', '-b', 'main', '-q');
  git('add', '.');
  git('commit', '-qm', 'Synthetic Unity project');
  const actual = await inspectWorktree(repo);
  const registered = store.projects.update(project.id, project.revision, {
    ...projectInputSchema.parse({ name: project.name, repositoryRoot: repo, unityProjectPath: '.', targetPlatform: 'BOTH' }),
    repoId: actual.repoId, unityVersion: version,
  });
  const runner = store.execution.registerRunner({ ...localDevice(), label: 'Inbox fixture' });
  let launches = 0;
  const vault = new Map<string, string>();
  const app = createServer({ port: 4317, databasePath, managedDataDirectory: true, codexHome: profile,
    codexWorktreeRoot: join(dir.path, 'worktrees'), inboxDependencies: {
      credentials: async () => ({
        async set(ref, value) { vault.set(ref, value); },
        async get(ref) { return vault.get(ref) ?? null; },
        async remove(ref) { vault.delete(ref); },
      }),
      github: () => api,
      execute: (tasks, claim, prompt, home, signal, _stream, owner) => executeApprovedTurn(tasks, claim, prompt, home, signal,
        async (input) => {
          launches++;
          expect(input.networkMode).toBe('OFF');
          expect(prompt.includes(token)).toBe(false);
          expect(input.worktree).not.toBe(repo);
          if (launches === 1) {
            expect(prompt).toContain(source(1, registered.id).headSha);
            expect(input.threadId).toBeNull();
          } else {
            expect(prompt).toContain('Unity run');
            expect(input.threadId).toBe('synthetic-inbox-thread');
          }
          return (async function* () {
            yield { type: 'thread.started', thread_id: 'synthetic-inbox-thread' } as const;
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
              cache_write_input_tokens: 0, reasoning_output_tokens: 0 } } as const;
          })();
        }, owner),
    } });
  const local = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
  try {
    const login = await app.inject({ method: 'POST', url: '/api/operator/session', headers: local,
      payload: { bootstrapCredential: store.execution.createBootstrap().proof } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const headers = { ...local, cookie, 'x-csrf-token': login.json().csrfToken as string, 'x-devhub-project-id': registered.id };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { ...headers, 'idempotency-key': randomUUID() } });
    expect((await call('PUT', '/api/task-inbox/credential', { token })).statusCode).toBe(204);
    expect((await call('POST', '/api/task-inbox/host', { runnerId: runner.id })).statusCode).toBe(200);
    expect((await call('PUT', '/api/task-inbox/listener', { enabled: true })).statusCode).toBe(204);
    expect((await call('POST', '/api/task-inbox/scan')).statusCode).toBe(200);
    const session = store.inbox.sessions(registered.id)[0]!;
    const item = store.inbox.messages(session.id)[0]!;
    const prepare = await call('POST', '/api/task-inbox/messages/' + item.id + '/prepare');
    expect(prepare.statusCode, prepare.body).toBe(200);
    const pending = executionRequestSchema.parse(prepare.json());
    expect(pending.status).toBe('PENDING');
    expect(pending.binding.baseHeadSha).toBe(actual.baseHeadSha);
    expect(pending.binding.baseHeadSha).not.toBe(item.headSha);
    expect(launches).toBe(0);
    const approve = (request: ExecutionRequest) => call('POST', '/api/execution-requests/' + request.id + '/decision',
      { decision: 'approve', expectedVersion: request.version });
    expect((await approve(pending)).statusCode).toBe(200);
    await expect.poll(() => store.inbox.session(session.id)?.status, { timeout: 5000 }).toBe('COMPLETED');
    const latest = store.inbox.session(session.id)!;
    const codex = store.codex.get(latest.lastRunId!, registered.id)!;
    expect(codex).toMatchObject({ status: 'COMPLETED', providerThreadId: 'synthetic-inbox-thread', providerTurnId: null });
    expect(launches).toBe(1);
    expect((await call('POST', '/api/task-inbox/messages/' + item.id + '/start')).statusCode).toBe(409);

    const actor = signedIn(store);
    const { scope: _scope, ...binding } = pending.binding;
    const unityPending = store.execution.createRequest({ ...binding, codexThreadId: null, scope: {
      operation: 'unity.run', plan: { stage: 'IMPORT', timeoutSeconds: 30 }, configSha256: workspace,
      workspaceSha256: workspace, editorVersion: version,
    } }, actor, randomUUID(), true);
    const unityGrant = store.execution.mutate({ kind: 'approve', requestId: unityPending.id, expectedVersion: unityPending.version,
      sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
    let unityId = '';
    const unityWorker = randomUUID();
    store.execution.mutate({ kind: 'claim', grantId: unityGrant.grantId!, expectedVersion: unityGrant.version,
      bindingDigest: unityGrant.bindingDigest, idempotencyKey: randomUUID(), runnerId: runner.id, deviceId: runner.deviceId,
      proofDigest: sha256(store.execution.activateRunner(runner.id, runner.deviceId, runner.platform)), workspaceMatches: true },
    (request) => { unityId = store.unity.reserveWithinClaim(request, unityWorker).id; });
    store.unity.finish(unityId, unityWorker, 'FAILED', true, 'UNITY_IMPORT_FAILED', []);
    const repair = await call('POST', '/api/unity/runs/' + unityId + '/repair', { previousRunId: codex.devhubRunId });
    expect(repair.statusCode, repair.body).toBe(200);
    const repairRequest = executionRequestSchema.parse(repair.json().request);
    expect(repairRequest.binding.codexThreadId).toBe(codex.providerThreadId);
    expect((await approve(repairRequest)).statusCode).toBe(200);
    await expect.poll(() => store.inbox.session(session.id)?.lastRunId, { timeout: 5000 }).not.toBe(codex.devhubRunId);
    expect(store.codex.list(registered.id)).toHaveLength(2);
    expect(launches).toBe(2);
  } finally { await app.close(); store.close(); }
}, 30000);
