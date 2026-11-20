import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '@devhub/hub';
import { createLogger } from '@devhub/logger';
import { createHubClient } from '@devhub/mcp-server';
import { mcpIssueSchema, mcpMediaLimit } from '@devhub/mcp-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttp } from '../apps/mcp-server/dist/transports.js';
import { openTaskStore } from '../packages/storage/dist/index.js';
import { migrate } from '../packages/storage/dist/migrations.js';
import { createRunDirectory } from '../packages/unity-adapter/dist/artifacts.js';

const entry = fileURLToPath(new URL('../apps/mcp-server/dist/main.js', import.meta.url));
const png = readFileSync(new URL('../project_work/test_case/assets/sprint-2.5-game-view.png', import.meta.url));
const mp4 = readFileSync(new URL('../project_work/test_case/assets/sprint-2.5-game-view.mp4', import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function fixture(mcpTimeout?: number) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'devhub-mcp-'));
  cleanup.push(() => temp.remove());
  const databasePath = join(temp.path, 'data', 'devhub.sqlite');
  const unityArtifactRoot = join(temp.path, 'data', 'unity-runs');
  const logs: string[] = [];
  let time = Date.now();
  const clock = () => time;
  let delayCredential = false;
  let releaseCredential: (() => void) | undefined;
  const credentialWait = new Promise<void>((resolve) => { releaseCredential = resolve; });
  cleanup.push(() => releaseCredential?.());
  const gitDependencies = {
    credentials: async () => ({
      async get() { if (delayCredential) await credentialWait; return null; },
      async set() {}, async remove() {},
    }),
    provider: () => { throw new Error('remote network must remain unused'); },
    transfer: async () => { throw new Error('Git transfer must remain unused'); },
  };
  const store = openTaskStore(databasePath, true, clock);
  cleanup.push(() => store.close());
  const repo = (name: string) => {
    const root = join(temp.path, name);
    mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
    mkdirSync(join(root, 'Assets'), { recursive: true });
    writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.28f1\n');
    writeFileSync(join(root, 'design.md'), 'Registered level notes\n');
    writeFileSync(join(root, 'other.md'), 'Unregistered content\n');
    return root;
  };
  const secret = 'dhm_' + randomBytes(32).toString('base64url');
  const project = (name: string) => store.projects.create({ name, repositoryRoot: repo(name),
    repoId: createHash('sha256').update(name).digest('hex'), unityProjectPath: '.', unityVersion: '6000.3.28f1',
    targetPlatform: 'BOTH', settings: { description: 'A development fixture.', gameType: '', documents: [{ kind: 'ART', path: 'design.md' }] } });
  const A = project('A');
  const B = project('B');
  const task = store.create({ title: 'Review spell effect', description: 'Bearer ' + secret, targetPlatform: 'BOTH' }, A.id);
  store.revise(task.id, 1, { title: task.title, description: task.description, targetPlatform: 'BOTH' }, A.id);
  const otherTask = store.create({ title: 'Unshared task', description: '', targetPlatform: 'BOTH' }, B.id);
  const runId = randomUUID();
  const runDir = join(unityArtifactRoot, runId);
  const digest = createHash('sha256').update(png).digest('hex');
  const artifact = { name: 'game-view.png', kind: 'editor-screenshot', mime: 'image/png', size: png.length, sha256: digest, createdAt: time };
  const video = { name: 'game-view.mp4', kind: 'editor-recording', mime: 'video/mp4', size: mp4.length,
    sha256: createHash('sha256').update(mp4).digest('hex'), createdAt: time };
  const largeRecording = { name: 'player.mp4', kind: 'recording', mime: 'video/mp4', size: mcpMediaLimit + 1, sha256: '2'.repeat(64), createdAt: time };
  const catalogId = (entry: { name: string; sha256: string }) =>
    createHash('sha256').update(JSON.stringify([A.id, runId, entry.name, entry.sha256])).digest('hex');
  const runnerId = store.execution.registerRunner({ label: 'MCP fixture', platform: 'MACOS', deviceId: 'a'.repeat(64) }).id;
  const worktreeId = 'b'.repeat(64);
  const requestId = randomUUID();
  const change = { number: 1, title: 'Review', description: '', url: 'https://github.com/fixture/fixture/pull/1', sourceBranch: 'devhub/fixture',
    targetBranch: 'main', headSha: 'a'.repeat(40), state: 'open' } as const;
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare('INSERT INTO authorization_worktrees (worktree_id,repo_id,root,project_id) VALUES (?,?,?,?)')
      .run(worktreeId, A.repoId, A.repositoryRoot, A.id);
    db.prepare('INSERT INTO codex_worktrees VALUES (?)').run(worktreeId);
    db.prepare(`INSERT INTO execution_requests (id,task_id,runner_id,worktree_id,binding_json,binding_digest,status,version,created_at,expires_at,project_id)
      VALUES (?,?,?,?,'{}',?,'CLAIMED',1,?,?,?)`).run(requestId, task.id, runnerId, worktreeId, 'c'.repeat(64), time, time + 5000, A.id);
    db.prepare(`INSERT INTO unity_runs (id,request_id,task_id,runner_id,worktree_id,base_head_sha,platform,plan,status,worker_id,
      started_at,heartbeat_at,exit_confirmed,reports,artifacts,project_id,editor_version)
      VALUES (?,?,?,?,?,?,'MACOS','{"stage":"GAME_VIEW","scene":"Assets/Fixture.unity","timeoutSeconds":15,"capture":{"width":960,"height":540,"seconds":2}}','COMPLETED','fixture',?,?,1,'[]',?,?,'6000.3.28f1')`)
      .run(runId, requestId, task.id, runnerId, worktreeId, 'f'.repeat(40), time, time, JSON.stringify([artifact, video, largeRecording]), A.id);
    const provider = randomUUID();
    const ref = randomUUID();
    db.prepare("INSERT INTO git_providers VALUES (?,'github','https://api.github.com')").run(provider);
    db.prepare('INSERT INTO git_credentials_refs VALUES (?,?,1)').run(ref, A.id);
    db.prepare("INSERT INTO project_provider_connections VALUES (?,?,?,?,?,'main','fixture',1)")
      .run(A.id, provider, ref, 'https://github.com/fixture/fixture', 'fixture');
    store.git.recordChange(A.id, change);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }

  const port = await freePort();
  const host = '127.0.0.1:' + port;
  const origin = 'http://' + host;
  let app = createServer({ port, databasePath, managedDataDirectory: true, unityArtifactRoot,
    managedUnityArtifactDirectory: true, clock, gitDependencies, mcpTimeout,
    logger: createLogger('info', { write: (line) => logs.push(line) }) });
  cleanup.push(() => app.close());
  await app.listen({ port, host: '127.0.0.1' });
  await createRunDirectory(unityArtifactRoot, runId, A.repositoryRoot!);
  writeFileSync(join(runDir, artifact.name), png, { mode: 0o600 });
  writeFileSync(join(runDir, video.name), mp4, { mode: 0o600 });
  const login = await app.inject({ method: 'POST', url: '/api/operator/session', headers: { host, origin },
    payload: { bootstrapCredential: store.execution.createBootstrap().proof } });
  expect(login.statusCode).toBe(200);
  const headers = { host, origin, cookie: String(login.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken };
  const issue = async (projectIds = [A.id], groups = ['projects', 'tasks', 'unity', 'git', 'codex']) => {
    const result = await app.inject({ method: 'POST', url: '/api/mcp/pairings', headers,
      payload: { label: 'Synthetic acceptance', hours: 1, projectIds, groups } });
    expect(result.statusCode, result.body).toBe(201);
    return mcpIssueSchema.parse(result.json());
  };
  const internal = (auth: string | undefined, tool: string, input: unknown) => app.inject({
    method: 'POST', url: '/api/mcp/internal/read', headers: { host, ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
    payload: { tool, input },
  });
  return { A, B, task, otherTask, runId, artifactId: catalogId(artifact), videoId: catalogId(video), largeVideoId: catalogId(largeRecording), secret,
    app, port, headers, store, databasePath, logs, issue, internal, advance: (ms: number) => { time += ms; },
    delayCredentials: () => { delayCredential = true; }, releaseCredentials: () => releaseCredential?.(),
    async restart() {
      await app.close();
      app = createServer({ port, databasePath, managedDataDirectory: true, clock });
      await app.listen({ port, host: '127.0.0.1' });
    } };
}

describe('MCP Bridge', () => {
  it('uses SDK stdio initialization and returns an authenticated PNG, resources and prompts', async () => {
    const f = await fixture();
    const pair = await f.issue();
    const client = new Client({ name: 'devhub-test', version: '1' });
    const connect = async () => client.connect(new StdioClientTransport({ command: process.execPath,
      args: [entry, 'start', 'stdio'], env: { DEVHUB_PORT: String(f.port), DEVHUB_MCP_PAIRING: pair.credential }, stderr: 'pipe' }));
    cleanup.push(() => client.close());
    await connect();
    expect(client.getServerVersion()?.name).toBe('ShanHe DevHub');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(31);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
    const projects = await client.callTool({ name: 'devhub_list_projects', arguments: {} });
    expect(projects.structuredContent).toMatchObject({ data: { items: [{ id: f.A.id }] } });
    expect(JSON.stringify(projects)).not.toContain(f.B.id);
    const history = await client.callTool({ name: 'devhub_get_task_history', arguments: { projectId: f.A.id, taskId: f.task.id } });
    expect(history.structuredContent).toMatchObject({ data: { revisions: { items: [{ revision: 2 }] }, requests: { items: [{ status: 'CLAIMED' }] } } });
    expect((await client.listPrompts()).prompts).toHaveLength(7);
    expect((await client.getPrompt({ name: 'devhub_gameplay_review', arguments: { projectId: f.A.id, runId: f.runId } })).messages).toHaveLength(1);
    expect((await client.listResources()).resources[0]?.uri).toBe('devhub://projects');
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(10);
    const screenshot = await client.callTool({ name: 'devhub_get_unity_screenshot',
      arguments: { projectId: f.A.id, runId: f.runId, artifactId: f.artifactId } });
    const content = Array.isArray(screenshot.content) ? screenshot.content[0] : null;
    if (content?.type !== 'image') throw new Error('Expected PNG content: ' + JSON.stringify(screenshot.content));
    expect(content.mimeType).toBe('image/png');
    expect(Buffer.from(content.data, 'base64').equals(png)).toBe(true);
    const uri = `devhub://projects/${f.A.id}/unity-runs/${f.runId}/artifacts`;
    const image = await client.readResource({ uri: uri + '/' + f.artifactId + '/image' });
    expect(image.contents[0]).toMatchObject({ mimeType: 'image/png', blob: png.toString('base64') });
    const recording = await client.readResource({ uri: uri + '/' + f.videoId + '/recording' });
    expect(recording.contents[0]).toMatchObject({ mimeType: 'video/mp4', blob: mp4.toString('base64') });
    const large = await client.readResource({ uri: uri + '/' + f.largeVideoId + '/recording' });
    expect(JSON.stringify(large)).toContain('reviewFrames');
    expect(large.contents[0]).not.toHaveProperty('blob');
    const log = JSON.stringify(f.logs);
    const events = JSON.stringify(f.store.mcp.recent());
    expect(log + events).not.toContain(pair.credential);
    expect(log + events).not.toContain(f.secret);
    await client.close();
    await f.restart();
    await connect();
    expect((await client.listTools()).tools).toHaveLength(31);
    expect(await client.ping()).toEqual({});
    f.store.mcp.revoke(pair.pairing.id);
    await expect(client.ping()).rejects.toThrow('MCP_PAIRING_INACTIVE');
    await expect(client.listTools()).rejects.toThrow('MCP_PAIRING_INACTIVE');
  }, 25_000);

  it('rejects missing, expired and rotated credentials, cross-project objects and unregistered documents', async () => {
    const f = await fixture();
    const pair = await f.issue();
    const call = (tool: string, input: unknown) => f.internal(pair.credential, tool, input);
    expect((await f.internal(undefined, 'devhub_list_projects', {})).statusCode).toBe(401);
    expect((await call('devhub_get_task', { projectId: f.B.id, taskId: f.otherTask.id })).statusCode).toBe(403);
    expect((await call('devhub_get_task', { projectId: f.A.id, taskId: f.otherTask.id })).statusCode).toBe(404);
    const both = await f.issue([f.A.id, f.B.id], ['unity']);
    const denied = await f.internal(both.credential, 'devhub_get_unity_screenshot',
      { projectId: f.B.id, runId: f.runId, artifactId: f.artifactId });
    expect(denied.statusCode).toBe(404);
    expect((await f.internal(both.credential, 'devhub_list_projects', {})).statusCode).toBe(403);
    expect((await call('devhub_get_task', { projectId: f.A.id, taskId: 'bad input' })).statusCode).toBe(400);
    expect((await call('devhub_read_project_document', { projectId: f.A.id, path: '../other.md' })).statusCode).toBe(400);
    expect((await call('devhub_read_project_document', { projectId: f.A.id, documentId: 'f'.repeat(64) })).statusCode).toBe(404);
    const docs = await call('devhub_list_project_documents', { projectId: f.A.id });
    const doc = docs.json<{ data: { id: string }[] }>().data[0]!;
    const contents = await call('devhub_read_project_document', { projectId: f.A.id, documentId: doc.id });
    expect(contents.body).toContain('Registered level notes');
    expect(contents.body).not.toContain(f.A.repositoryRoot);
    const task = await call('devhub_get_task', { projectId: f.A.id, taskId: f.task.id });
    expect(task.body).toContain('[REDACTED]');
    expect(task.body).not.toContain(f.secret);
    const rotationPath = '/api/mcp/pairings/' + pair.pairing.id;
    const missingCsrf = await f.app.inject({ method: 'POST', url: rotationPath + '/rotate',
      headers: { ...f.headers, 'x-csrf-token': '' }, payload: { hours: 1 } });
    expect(missingCsrf.statusCode).toBe(403);
    const rotated = await f.app.inject({ method: 'POST', url: rotationPath + '/rotate', headers: f.headers, payload: { hours: 1 } });
    const next = mcpIssueSchema.parse(rotated.json());
    expect((await call('devhub_list_projects', {})).statusCode).toBe(401);
    expect((await f.internal(next.credential, 'devhub_list_projects', {})).statusCode).toBe(200);
    await f.app.inject({ method: 'DELETE', url: rotationPath, headers: f.headers });
    expect((await f.internal(next.credential, 'devhub_list_projects', {})).statusCode).toBe(401);
    f.advance(3_600_000);
    expect((await f.internal(both.credential, 'devhub_list_unity_runs', { projectId: f.A.id })).statusCode).toBe(401);
  }, 25_000);

  it('checks HTTP loopback Host, Origin and bearer; enforces message and concurrency budgets', async () => {
    const f = await fixture(200);
    const pair = await f.issue();
    const hub = createHubClient(f.port, pair.credential);
    const listener = await startHttp(hub, pair.credential, 0);
    cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing MCP socket');
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const auth = { Authorization: 'Bearer ' + pair.credential };
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, Origin: 'https://example.invalid' } })).status).toBe(403);
    const evilHost = await import('node:http').then(({ request }) => new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...auth, Host: 'example.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    }));
    expect(evilHost).toBe(403);
    const client = new Client({ name: 'devhub-http', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: auth } }));
    expect((await client.listTools()).tools).toHaveLength(31);
    const oversized = await fetch(url, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ text: 'a'.repeat(32_000) }),
    });
    expect(oversized.status).toBe(413);
    f.delayCredentials();
    const calls = await Promise.all(Array.from({ length: 6 }, () => f.internal(pair.credential, 'devhub_get_pull_request',
      { number: 1, projectId: f.A.id })));
    expect(calls.map(({ statusCode }) => statusCode).sort()).toEqual([429, 429, 504, 504, 504, 504]);
    f.releaseCredentials();
  }, 25_000);

  it('preserves a v7 task through repeated v8 migration', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, 7);
      const id = randomUUID();
      const { id: projectId } = db.prepare('SELECT id FROM projects').get()!;
      db.prepare(`INSERT INTO tasks (id,title,description,target_platform,status,created_at,revision,project_id)
        VALUES (?,'Existing task','','BOTH','CREATED','2026-01-01',3,?)`).run(id, projectId!);
      migrate(db);
      migrate(db);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
      expect(db.prepare('SELECT title,revision FROM tasks WHERE id=?').get(id)).toMatchObject({ title: 'Existing task', revision: 3 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});
