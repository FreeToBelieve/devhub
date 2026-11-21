import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { mcpIssueSchema, mcpMediaLimit, mcpRecordingInputLimit } from '@devhub/mcp-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  unityEvidenceContentType, unityEvidenceFiles, unityEvidenceHeader, unityEvidenceManifestSchema, unityEvidenceRunSchema,
} from '../packages/contracts/dist/index.js';
import { startHttp } from '../apps/mcp-server/dist/transports.js';
import { openTaskStore } from '../packages/storage/dist/index.js';
import { migrate } from '../packages/storage/dist/migrations.js';
import { findFfmpeg, findFfprobe, runReviewCommand } from '../packages/unity-adapter/dist/index.js';
import { createRunDirectory } from '../packages/unity-adapter/dist/artifacts.js';

const entry = fileURLToPath(new URL('../apps/mcp-server/dist/main.js', import.meta.url));
const png = readFileSync(new URL('../project_work/test_case/assets/sprint-2.5-game-view.png', import.meta.url));
const mp4 = readFileSync(new URL('../project_work/test_case/assets/sprint-2.5-game-view.mp4', import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
  const issue = async (projectIds = [A.id], groups = ['projects', 'tasks', 'unity', 'git', 'codex'], hours: number | null = 1) => {
    const result = await app.inject({ method: 'POST', url: '/api/mcp/pairings', headers,
      payload: { label: 'Synthetic acceptance', hours, projectIds, groups } });
    expect(result.statusCode, result.body).toBe(201);
    return mcpIssueSchema.parse(result.json());
  };
  function publish(name: string, mime: 'image/png' | 'image/jpeg' | 'video/mp4', data: Buffer, declaredSize = data.length) {
    const item = { name, kind: mime === 'video/mp4' ? 'editor-recording' : 'editor-screenshot', mime, size: declaredSize,
      sha256: createHash('sha256').update(data).digest('hex'), createdAt: time };
    writeFileSync(join(runDir, name), data, { mode: 0o600 });
    const database = new DatabaseSync(databasePath);
    try {
      const last = database.prepare('SELECT artifacts FROM unity_runs WHERE id=?').get(runId);
      database.prepare('UPDATE unity_runs SET artifacts=? WHERE id=?').run(JSON.stringify([...JSON.parse(String(last?.artifacts)), item]), runId);
    } finally { database.close(); }
    return catalogId(item);
  }
  const internal = (auth: string | undefined, tool: string, input: unknown) => app.inject({
    method: 'POST', url: '/api/mcp/internal/read', headers: { host, ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
    payload: { tool, input },
  });
  return { A, B, task, otherTask, runId, artifactId: catalogId(artifact), videoId: catalogId(video), largeVideoId: catalogId(largeRecording), secret,
    app, port, headers, store, databasePath, unityArtifactRoot, runDir, logs, issue, internal, publish, advance: (ms: number) => { time += ms; },
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
    expect(tools).toHaveLength(33);
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
    expect((await client.listTools()).tools).toHaveLength(33);
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

  it('keeps permanent pairings valid across time and restart until rotated or revoked', async () => {
    const f = await fixture();
    const pairing = await f.issue([f.A.id], ['projects'], null);
    expect(pairing.pairing.expiresAt).toBeNull();
    const endpoint = '/api/mcp/pairings/' + pairing.pairing.id;
    const rotated = await f.app.inject({ method: 'POST', url: endpoint + '/rotate',
      headers: f.headers, payload: { hours: null } });
    const next = mcpIssueSchema.parse(rotated.json());
    expect(next.pairing.expiresAt).toBeNull();
    expect((await f.internal(pairing.credential, 'devhub_list_projects', {})).statusCode).toBe(401);
    f.advance(3_600_000 * 24 * 365 * 10);
    await f.restart();
    expect((await f.internal(next.credential, 'devhub_list_projects', {})).statusCode).toBe(200);
    f.store.mcp.revoke(pairing.pairing.id);
    expect((await f.internal(next.credential, 'devhub_list_projects', {})).statusCode).toBe(401);
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
    expect((await client.listTools()).tools).toHaveLength(33);
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

  it('imports a scoped real-media bundle and reads it as a Unity Run through MCP', async () => {
    const f = await fixture();
    const repository = f.A.repositoryRoot!;
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10_000 });
    git('init', '-q');
    const scene = 'Assets/青溪 (fixture).unity';
    writeFileSync(join(repository, scene), '%YAML 1.1');
    git('add', '--', '.');
    git('-c', 'user.name=DevHub Test', '-c', 'user.email=devhub@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      'commit', '-qm', 'Review fixture');
    const commit = git('rev-parse', 'HEAD').trim();
    const log = Buffer.from('Unity Game View initialized\nprivate_token=synthetic-never-export');
    const report = Buffer.from(JSON.stringify({ result: 'captured', access_token: 'synthetic-never-export' }));
    const metadata = (bytes: Buffer) => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const manifest = unityEvidenceManifestSchema.parse({ version: 1, projectId: f.A.id, commit, scene,
      captureSource: 'LocalFixture.Capture', platform: 'MACOS', editorVersion: '6000.3.28f1',
      capturedAt: Date.now(), width: 960, height: 540, console: { name: 'console.log', ...metadata(log) }, report: metadata(report),
      skills: ['wind', 'guard'].map((id) => ({ id, name: id === 'wind' ? '风式' : '护身', frames: [{ name: '01_before', ...metadata(png) }, { name: '02_hit', ...metadata(png) }], recording: { name: 'clip', ...metadata(mp4) } })),
    });
    const files = [png, png, mp4, png, png, mp4, log, report];
    const payload = (meta = manifest, contents = files) => Buffer.concat([unityEvidenceHeader(meta), ...contents]);
    const endpoint = '/api/unity/evidence/import';
    const upload = (body: Buffer, options: { projectId?: string; auth?: boolean; csrf?: boolean; origin?: string } = {}) =>
      f.app.inject({ method: 'POST', url: endpoint, headers: {
        'content-type': unityEvidenceContentType, 'x-devhub-project-id': options.projectId ?? f.A.id,
        host: f.headers.host, origin: options.origin ?? f.headers.origin,
        ...(options.auth === false ? {} : { cookie: f.headers.cookie }),
        ...(options.csrf === false ? {} : { 'x-csrf-token': f.headers['x-csrf-token'] }),
      }, payload: body });
    expect((await upload(payload(), { auth: false })).statusCode).toBe(401);
    expect((await upload(payload(), { csrf: false })).statusCode).toBe(403);
    expect((await upload(payload(), { origin: 'https://example.invalid' })).statusCode).toBe(403);
    expect((await upload(payload(), { projectId: f.B.id })).json().code).toBe('UNITY_EVIDENCE_PROJECT_MISMATCH');
    expect((await upload(payload({ ...manifest, commit: '0'.repeat(40) }))).json().code).toBe('UNITY_EVIDENCE_REVISION_INVALID');
    expect((await upload(payload({ ...manifest, scene: 'Assets/Missing.unity' }))).json().code).toBe('UNITY_EVIDENCE_REVISION_INVALID');
    const corrupt = Buffer.from(png);
    corrupt[40] = (corrupt[40] ?? 0) ^ 1;
    expect((await upload(payload(manifest, [corrupt, ...files.slice(1)]))).json().code).toBe('UNITY_EVIDENCE_HASH_MISMATCH');
    expect((await upload(payload({ ...manifest, width: 1920 }))).json().code).toBe('UNITY_EVIDENCE_MEDIA_INVALID');
    expect((await upload(Buffer.concat([payload(), Buffer.from('extra')]))).statusCode).toBe(409);
    expect((await upload(payload().subarray(0, -1))).statusCode).toBe(409);
    expect(f.store.unityEvidence.list(f.A.id)).toHaveLength(0);

    const imported = await upload(payload());
    expect(imported.statusCode, imported.body).toBe(201);
    const run = unityEvidenceRunSchema.parse(imported.json());
    expect(run).toMatchObject({ projectId: f.A.id, commit, source: 'EXTERNAL_CAPTURE', width: 960, height: 540 });
    expect(run.artifacts).toHaveLength(unityEvidenceFiles(manifest).length + 1);
    expect(unityEvidenceRunSchema.parse((await upload(payload())).json()).id).toBe(run.id);
    const uris = (projectId: string) => '/api/unity/runs/' + run.id + '/artifact?name=wind__clip.mp4&projectId=' + projectId;
    const playback = await f.app.inject({ method: 'GET', url: uris(f.A.id), headers: { ...f.headers, range: 'bytes=0-31' } });
    expect(playback.statusCode).toBe(206);
    expect(playback.rawPayload.equals(mp4.subarray(0, 32))).toBe(true);
    expect((await f.app.inject({ method: 'GET', url: uris(f.B.id), headers: f.headers })).statusCode).toBe(404);

    const pair = await f.issue([f.A.id, f.B.id], ['unity']);
    const invoke = (tool: string, extra: object = {}, projectId = f.A.id) =>
      f.internal(pair.credential, tool, { projectId, runId: run.id, ...extra });
    const summary = await invoke('devhub_get_unity_run');
    expect(summary.json()).toMatchObject({ data: { id: run.id, source: 'EXTERNAL_CAPTURE', scene } });
    const listing = await f.internal(pair.credential, 'devhub_list_unity_runs', { projectId: f.A.id });
    expect(listing.json().data.items[0].id).toBe(run.id);
    const artifacts = (await invoke('devhub_list_unity_artifacts')).json<{ data: { id: string; skillId?: string; mime: string }[] }>().data;
    const photo = artifacts.find((entry) => entry.skillId === 'wind' && entry.mime === 'image/png')!;
    const clip = artifacts.find((entry) => entry.skillId === 'wind' && entry.mime === 'video/mp4')!;
    const image = await invoke('devhub_get_unity_screenshot', { artifactId: photo.id });
    expect(Buffer.from(image.json().media.data, 'base64').equals(png)).toBe(true);
    expect((await invoke('devhub_get_unity_recording_metadata', { artifactId: clip.id })).json().data.reviewFrames)
      .toMatchObject([{ id: photo.id, skillId: 'wind' }, { skillId: 'wind' }]);
    expect((await invoke('devhub_get_unity_screenshot', { artifactId: photo.id }, f.B.id)).statusCode).toBe(404);
    const diagnostics = await invoke('devhub_get_unity_diagnostics');
    expect(diagnostics.body).toContain('captured');
    expect(diagnostics.body).toContain('[REDACTED]');
    expect(diagnostics.body).not.toContain('synthetic-never-export');
  }, 60_000);

  it('preserves a v7 task through repeated migrations', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, 7);
      const id = randomUUID();
      const { id: projectId } = db.prepare('SELECT id FROM projects').get()!;
      db.prepare(`INSERT INTO tasks (id,title,description,target_platform,status,created_at,revision,project_id)
        VALUES (?,'Existing task','','BOTH','CREATED','2026-01-01',3,?)`).run(id, projectId!);
      migrate(db);
      migrate(db);
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(10);
      expect(db.prepare('SELECT title,revision FROM tasks WHERE id=?').get(id)).toMatchObject({ title: 'Existing task', revision: 3 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});

describe('MCP visual recording review', () => {
  it('returns verified JPEG, rejects incorrect size/MIME/hash and unsafe media', async () => {
    const f = await fixture();
    const pair = await f.issue();
    const scope = { projectId: f.A.id, runId: f.runId };
    const shot = (artifactId: string) => f.internal(pair.credential, 'devhub_get_unity_screenshot', { ...scope, artifactId });
    const forged = f.publish('test__invalid.jpg', 'image/jpeg', png);
    expect((await shot(forged)).statusCode).toBe(422);
    expect((await shot(f.videoId)).statusCode).toBe(404);
    expect((await shot('8'.repeat(64))).statusCode).toBe(404);
    expect((await f.internal(pair.credential, 'devhub_get_unity_screenshot', { ...scope, runId: randomUUID(), artifactId: f.artifactId })).statusCode).toBe(404);
    const encoder = await findFfmpeg();
    if (encoder) {
      const bytes = execFileSync(encoder, ['-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0',
        '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], { input: png, maxBuffer: mcpMediaLimit });
      const id = f.publish('test__jpeg.jpg', 'image/jpeg', bytes);
      const photo = await shot(id);
      expect(photo.statusCode, photo.body.slice(0, 100)).toBe(200);
      expect(photo.json().media.mimeType).toBe('image/jpeg');
      expect(Buffer.from(photo.json().media.data, 'base64').equals(bytes)).toBe(true);
    } else if (process.env.CI) throw new Error('CI must provide FFmpeg.');
    const modified = Buffer.from(png);
    modified[modified.length - 3] = modified[modified.length - 3]! ^ 1;
    writeFileSync(join(f.runDir, 'game-view.png'), modified, { mode: 0o600 });
    expect((await shot(f.artifactId)).statusCode).toBe(409);
    if (process.platform === 'darwin') {
      const id = f.publish('test__symlink.png', 'image/png', png);
      const escape = join(f.A.repositoryRoot!, 'outside.png');
      writeFileSync(escape, png);
      const linked = join(f.runDir, 'test__link.png');
      symlinkSync(escape, linked);
      const linkedId = createHash('sha256').update(JSON.stringify([f.A.id, f.runId, 'test__link.png',
        createHash('sha256').update(png).digest('hex')])).digest('hex');
      const db = new DatabaseSync(f.databasePath);
      try {
        const row = db.prepare('SELECT artifacts FROM unity_runs WHERE id=?').get(f.runId);
        const values = JSON.parse(String(row?.artifacts));
        values.at(-1).name = 'test__link.png';
        db.prepare('UPDATE unity_runs SET artifacts=? WHERE id=?').run(JSON.stringify(values), f.runId);
      } finally { db.close(); }
      expect(id).not.toBe(linkedId);
      expect((await shot(linkedId)).statusCode).toBe(404);
    }
  }, 35_000);

  it('returns SDK images with default, explicit and maximum frame counts, and a separate recording blob', async (context) => {
    const encoder = await findFfmpeg();
    if (!encoder || !await findFfprobe(encoder)) {
      if (process.env.CI) throw new Error('CI must provide FFmpeg and FFprobe.');
      return context.skip();
    }
    const f = await fixture();
    const pair = await f.issue();
    const client = new Client({ name: 'media-test', version: '1' });
    cleanup.push(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'start', 'stdio'],
      env: { DEVHUB_PORT: String(f.port), DEVHUB_MCP_PAIRING: pair.credential, PATH: process.env.PATH ?? '' }, stderr: 'pipe' }));
    const scope = { projectId: f.A.id, runId: f.runId, artifactId: f.videoId };
    const sample = (extra: Record<string, unknown> = {}) => client.callTool({ name: 'devhub_get_unity_recording_review_frames',
      arguments: { ...scope, ...extra } }, undefined, { timeout: 45_000 });
    const result = await sample();
    expect(result.isError, JSON.stringify(result.content).slice(0, 140)).not.toBe(true);
    const images = Array.isArray(result.content) ? result.content.filter(({ type }) => type === 'image') : [];
    expect(images).toHaveLength(8);
    expect(images.every((image) => image.mimeType === 'image/jpeg' &&
      Buffer.from(image.data, 'base64').subarray(0, 3).toString('hex') === 'ffd8ff')).toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { integrity: 'verified', video: {
      width: expect.any(Number), height: expect.any(Number), fps: expect.any(Number), durationSeconds: expect.any(Number),
    }, timeline: expect.arrayContaining([{ frameIndex: 1, requestedSeconds: expect.any(Number), timestampSeconds: expect.any(Number),
      originalResolution: expect.any(Object), imageResolution: expect.any(Object), durationSeconds: expect.any(Number),
      dark: expect.any(Boolean), duplicate: expect.any(Boolean) }]) } });
    const ordered = await sample({ timestamps: [0, 0.2, 0.4] });
    expect(ordered.structuredContent).toMatchObject({ data: { timeline: [
      expect.objectContaining({ requestedSeconds: 0, timestampSeconds: 0 }),
      expect.objectContaining({ requestedSeconds: 0.2, timestampSeconds: expect.any(Number) }),
      expect.objectContaining({ requestedSeconds: 0.4, timestampSeconds: expect.any(Number) }),
    ] } });
    const full = await sample({ sampleCount: 12 });
    expect(Array.isArray(full.content) && full.content.filter(({ type }) => type === 'image')).toHaveLength(12);
    expect((await sample({ sampleCount: 13 })).isError).toBe(true);
    expect((await sample({ timestamps: [899] })).isError).toBe(true);
    const summary = await client.callTool({ name: 'devhub_review_unity_recording', arguments: { ...scope, sampleCount: 2 } });
    expect(summary.structuredContent).toMatchObject({ data: { stageScreenshots: [{ integrity: 'verified' }],
      commit: 'f'.repeat(40), scene: 'Assets/Fixture.unity', unityVersion: '6000.3.28f1' } });
    expect(Array.isArray(summary.content) && summary.content.filter(({ type }) => type === 'image')).toHaveLength(3);
    const recording = await client.callTool({ name: 'devhub_get_unity_recording_resource', arguments: scope });
    expect(Array.isArray(recording.content) && recording.content.map(({ type }) => type)).toEqual(['text', 'resource_link', 'resource']);
    const range = await f.app.inject({ method: 'GET', headers: { ...f.headers, 'x-devhub-project-id': f.A.id, range: 'bytes=0-23' },
      url: '/api/unity/runs/' + f.runId + '/artifact?name=game-view.mp4' });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(mp4.subarray(0, 24))).toBe(true);
    expect(readdirSync(f.unityArtifactRoot).filter(name => name.startsWith('.mcp-media-'))).toEqual([]);
    expect(JSON.stringify(f.logs)).not.toContain(mp4.toString('base64').slice(0, 50));
  }, 90_000);

  it('enforces media scope, global decoder budget and bounded failure cleanup', async (context) => {
    const encoder = await findFfmpeg();
    if (!encoder || !await findFfprobe(encoder)) {
      if (process.env.CI) throw new Error('CI must provide FFmpeg and FFprobe.');
      return context.skip();
    }
    const f = await fixture();
    const [a, b, c] = await Promise.all([f.issue(), f.issue(), f.issue()]);
    const scope = { projectId: f.A.id, runId: f.runId, artifactId: f.videoId };
    const frames = (credential: string, input: Record<string, unknown> = {}) =>
      f.internal(credential, 'devhub_get_unity_recording_review_frames', { ...scope, ...input });
    expect((await frames(a!.credential, { projectId: f.B.id })).statusCode).toBe(403);
    const allowed = await f.issue([f.A.id, f.B.id], ['unity']);
    expect((await frames(allowed.credential, { projectId: f.B.id })).statusCode).toBe(404);
    expect((await frames(a!.credential, { artifactId: f.publish('test__huge.mp4', 'video/mp4', mp4, mcpRecordingInputLimit + 1) })).statusCode)
      .toBe(413);
    const truncated = mp4.subarray(0, 32);
    const invalid = await frames(a!.credential, { artifactId: f.publish('test__corrupt.mp4', 'video/mp4', truncated) });
    expect(invalid.statusCode).toBe(422);
    const outcome = await Promise.all([a!, b!, c!].map((pairing) => frames(pairing.credential)));
    expect(outcome.map((response) => response.statusCode).sort()).toEqual([200, 200, 429]);
    expect(outcome.find((response) => response.statusCode === 429)?.json().code).toBe('MCP_MEDIA_BUSY');
    expect(readdirSync(f.unityArtifactRoot).filter(name => name.startsWith('.mcp-media-'))).toEqual([]);
    vi.stubEnv('DEVHUB_UNITY_FFMPEG', join(f.runDir, 'missing'));
    expect((await frames(a!.credential)).statusCode).toBe(503);
    await expect(runReviewCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],
      undefined, undefined, 150)).rejects.toMatchObject({ code: 'TIMEOUT' });
  }, 90_000);
});
