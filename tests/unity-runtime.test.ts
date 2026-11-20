import { legacyProjectId } from '../packages/contracts/dist/index.js';
import { mkdirSync, mkdtempDisposableSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executionScopeSchema, unityPlanSchema } from '../packages/contracts/dist/index.js';
import { artifactMime, directoryBytes, initializeUnityArtifactRoot, inspectUnityEnvironment, parseUnityTests, pngDimensions,
  readArtifact, sanitizeUnityText, unityConfiguration, unityDiagnostics, verifyUnityScene }
  from '../packages/unity-adapter/dist/index.js';
import { startEditor, waitForEditorReady } from '../apps/runner/dist/unity/process.js';
import { createServer } from '../apps/hub/dist/server.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';

describe('Unity Runner controls', () => {
  it('accepts typed scopes and rejects arbitrary commands, traversal, and capture limits', () => {
    expect(unityPlanSchema.safeParse({ stage: 'BUILD', scene: 'Assets/Test.unity', timeoutSeconds: 30 }).success).toBe(true);
    expect(unityPlanSchema.safeParse({ stage: 'BUILD', scene: 'Assets/../Test.unity', timeoutSeconds: 30 }).success).toBe(false);
    expect(unityPlanSchema.safeParse({ stage: 'GAME_VIEW', scene: 'Assets/Test.unity', timeoutSeconds: 30,
      capture: { width: 640, height: 360, seconds: 99 } }).success).toBe(false);
    expect(executionScopeSchema.safeParse({ operation: 'unity.run', plan: { stage: 'EDITOR', executable: 'bash', timeoutSeconds: 20 },
      workspaceSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64) }).success).toBe(false);
  });

  it('reports mismatched projects and denies open lock files', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-doctor-'));
    mkdirSync(join(fixture.path, 'ProjectSettings'));
    mkdirSync(join(fixture.path, 'Temp'));
    writeFileSync(join(fixture.path, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.27f1\n');
    writeFileSync(join(fixture.path, 'Temp', 'UnityLockfile'), '');
    const report = await inspectUnityEnvironment(fixture.path);
    expect(report).toMatchObject({ projectVersion: '6000.3.27f1', projectLocked: true });
    expect(report.diagnostics).toContain('UNITY_EDITOR_MISSING');
    expect(report.diagnostics).toContain('UNITY_PROJECT_LOCKED');
  });

  it('accepts Unicode scene names and verifies the resolved ordinary file within the worktree', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-scenes-'));
    const project = join(fixture.path, 'project');
    const scene = 'Assets/场景.v2/山河（夜） - 試練, A.unity';
    mkdirSync(join(project, 'Assets', '场景.v2'), { recursive: true });
    writeFileSync(join(project, scene), '%YAML 1.1\n');
    expect(unityPlanSchema.parse({ stage: 'BUILD', scene, timeoutSeconds: 30 }).scene).toBe(scene);
    await expect(verifyUnityScene(project, scene)).resolves.toBeUndefined();
    for (const invalid of ['/Assets/山河.unity', 'C:/Assets/山河.unity', 'Assets/../山河.unity', 'Assets/./山河.unity',
      'Assets//山河.unity', 'Assets/Logs./山河.unity', 'Assets/CON.unity', 'Assets/山河:ads.unity', 'Assets/山河\u0085.unity',
      'Assets/山河\\夜.unity', 'Assets/山河.txt']) {
      expect(unityPlanSchema.safeParse({ stage: 'BUILD', scene: invalid, timeoutSeconds: 30 }).success).toBe(false);
    }
    mkdirSync(join(project, 'Assets', '目录.unity'));
    await expect(verifyUnityScene(project, 'Assets/目录.unity')).rejects.toThrow('UNITY_SCENE_MISSING');
    const outside = join(fixture.path, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '山河.unity'), '%YAML 1.1\n');
    symlinkSync(outside, join(project, 'Assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(verifyUnityScene(project, 'Assets/linked/山河.unity')).rejects.toThrow('UNITY_SCENE_MISSING');
  });

  it('tracks child process identity and never considers time alone a ready signal', async () => {
    const fixture = startEditor(process.execPath, ['-e', 'process.exit(2)'], process.cwd());
    const identity = fixture.inspectEditorProcess();
    expect(identity.pid).toBeGreaterThan(0);
    await expect(waitForEditorReady(async () => null, fixture.waitForEditorExit(), AbortSignal.timeout(2000))).resolves.toBeNull();
    await expect(fixture.waitForEditorExit()).resolves.toMatchObject({ code: 2 });
  });

  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('selects the exact project Editor using bundle metadata without launching it', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-dynamic-editor-'));
    const project = join(fixture.path, 'project');
    const editorRoot = join(fixture.path, 'editors');
    const version = '2022.3.654f1';
    const contents = join(editorRoot, version, 'Unity.app', 'Contents');
    const executable = join(contents, 'MacOS', 'Unity');
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
    mkdirSync(join(project, 'Assets'));
    writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
    writeFileSync(join(project, 'Assets', 'Fixture.unity'), '%YAML 1.1\n');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    writeFileSync(executable, '', { mode: 0o700 });
    const stamp = (reported: string) => writeFileSync(join(contents, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>' + reported + '</string></dict></plist>');
    const env = { DEVHUB_UNITY_HUB_ROOT: editorRoot };
    stamp('2022.3.653f1');
    expect(await inspectUnityEnvironment(project, env)).toMatchObject({ editor: null, projectVersion: version,
      diagnostics: expect.arrayContaining(['UNITY_EDITOR_VERSION_UNVERIFIED']) });
    stamp(version);
    const plan = { stage: 'BUILD' as const, scene: 'Assets/Fixture.unity', timeoutSeconds: 30 };
    await expect(unityConfiguration(project, plan, '2022.3.653f1', env)).rejects.toThrow('UNITY_PROJECT_VERSION_CHANGED');
    await expect(unityConfiguration(project, plan, version, env)).rejects.toThrow('UNITY_BUILD_SUPPORT_MISSING');
    mkdirSync(join(contents, 'PlaybackEngines', 'MacStandaloneSupport'), { recursive: true });
    expect(await unityConfiguration(project, plan, version, env)).toMatchObject({ editorVersion: version,
      environment: { projectVersion: version, buildSupport: true, installedVersions: expect.arrayContaining([version]) } });
  }, 15000);

  it('parses compiler diagnostics and bounded, completed NUnit XML without external entities', () => {
    expect(unityDiagnostics('Assets/Fault.cs(4,7): error CS0103: missing value')).toEqual([
      { severity: 'error', file: 'Assets/Fault.cs', line: 4, code: 'CS0103', message: 'missing value' },
    ]);
    const xml = '<test-run total="2" passed="1" failed="1" skipped="0" inconclusive="0">' +
      '<test-case fullname="Failure" result="Failed" /></test-run>';
    expect(parseUnityTests(xml)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, names: ['Failure'] });
    expect(() => parseUnityTests('<!DOCTYPE test-run>' + xml)).toThrow('UNITY_TEST_XML_INVALID');
    expect(() => parseUnityTests(xml.slice(0, -11))).toThrow('UNITY_TEST_XML_INVALID');
  });

  it('uses separate artifact identities for rendered Editor and Player media', () => {
    expect(artifactMime('game-view.png')).toBe('image/png');
    expect(artifactMime('player.mp4')).toBe('video/mp4');
    expect(artifactMime('screen.png')).toBeNull();
    expect(() => pngDimensions(Buffer.alloc(40))).toThrow('UNITY_CAPTURE_INVALID');
  });

  it('reserves the Unity worktree within the Runner grant and keeps the lock after uncertain exit', () => {
    const storage = openTaskStore(':memory:');
    try {
      const proof = storage.execution.createBootstrap().proof;
      const sessionDigest = sha256(storage.execution.exchangeBootstrap(sha256(proof)).proof);
      const runner = storage.execution.registerRunner({ label: 'Fixture', deviceId: 'a'.repeat(64), platform: 'MACOS' });
      const task = storage.create({ title: 'Unity lock', description: '', targetPlatform: 'BOTH' }, legacyProjectId);
      const worktree = storage.execution.registerWorktree({ worktreeId: 'b'.repeat(64), repoId: 'c'.repeat(64), root: '/fixture' }, legacyProjectId);
      storage.codex.manage(worktree.worktreeId);
      const pending = storage.execution.createRequest({ repoId: worktree.repoId, worktreeId: worktree.worktreeId,
        taskId: task.id, runnerId: runner.id,
        platform: runner.platform, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task), policyVersion: 1,
        baseHeadSha: 'd'.repeat(40), codexThreadId: null, scope: { operation: 'unity.run',
          plan: { stage: 'IMPORT', timeoutSeconds: 30 }, configSha256: 'e'.repeat(64), workspaceSha256: 'f'.repeat(64) },
      }, sessionDigest, randomUUID(), true);
      const approval = storage.execution.mutate({ kind: 'approve', requestId: pending.id, expectedVersion: pending.version,
        sessionDigest, idempotencyKey: randomUUID(), workspaceMatches: true });
      const worker = randomUUID();
      const runnerProof = storage.execution.activateRunner(runner.id, runner.deviceId, runner.platform);
      const claim = { kind: 'claim' as const, grantId: approval.grantId!, bindingDigest: approval.bindingDigest,
        expectedVersion: approval.version, idempotencyKey: randomUUID(), proofDigest: sha256(runnerProof), runnerId: runner.id,
        deviceId: runner.deviceId, workspaceMatches: true };
      expect(() => storage.execution.mutate(claim)).toThrow();
      storage.execution.mutate(claim, (request) => { storage.unity.reserveWithinClaim(request, worker); });
      const run = storage.unity.list()[0]!;
      expect(storage.git.busy(worktree.worktreeId)).toBe(true);
      storage.unity.finish(run.id, worker, 'FAILED', false, 'UNITY_TIMEOUT', []);
      expect(storage.unity.get(run.id)).toMatchObject({ status: 'INTERRUPTED', exitConfirmed: false });
      expect(storage.git.busy(worktree.worktreeId)).toBe(true);
      expect(storage.unity.pruneIds()).not.toContain(run.id);
    } finally { storage.close(); }
  });

  it('consumes artifacts by known name only and redacts Unity and provider secrets', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-artifact-'));
    const id = '29a7c836-661a-4c43-b860-96cfef34bb5f';
    const root = join(fixture.path, 'artifacts');
    mkdirSync(root, { mode: 0o700 });
    await initializeUnityArtifactRoot(root, true);
    mkdirSync(join(root, id));
    const path = join(root, id, 'editor.log');
    writeFileSync(path, 'fixture');
    const file = await readArtifact(root, id, 'editor.log');
    try { expect(await file.readFile('utf8')).toBe('fixture'); } finally { await file.close(); }
    await expect(readArtifact(root, id, '../editor.log')).rejects.toThrow('UNITY_ARTIFACT_UNSAFE');
    await expect(directoryBytes(root, 1)).rejects.toThrow('UNITY_ARTIFACT_LIMIT');
    expect(artifactMime('unredacted.raw')).toBeNull();
    const sanitized = sanitizeUnityText('access_token=secret-value\nLicense serial: private-value\nAuthorization: Bearer fixture-id');
    for (const secret of ['secret-value', 'private-value', 'fixture-id']) expect(sanitized).not.toContain(secret);
    if (process.platform !== 'win32') {
      symlinkSync(path, join(root, id, 'player.log'));
      await expect(readArtifact(root, id, 'player.log')).rejects.toThrow('UNITY_ARTIFACT_UNSAFE');
    }
  }, 20000);

  it('requires an operator session, matching origin and CSRF on Unity routes', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-api-'));
    const databasePath = join(fixture.path, 'data', 'hub.sqlite');
    const storage = openTaskStore(databasePath, true);
    const server = createServer({ port: 4317, databasePath, managedDataDirectory: true });
    const host = '127.0.0.1:4317';
    const origin = 'http://' + host;
    const media = `/api/unity/runs/${randomUUID()}/artifact?name=game-view.png`;
    try {
      expect((await server.inject({ url: '/api/unity/runs', headers: { host } })).statusCode).toBe(401);
      expect((await server.inject({ url: media, headers: { host } })).statusCode).toBe(401);
      const login = await server.inject({ method: 'POST', url: '/api/operator/session', headers: { host, origin },
        payload: { bootstrapCredential: storage.execution.createBootstrap().proof } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      expect((await server.inject({ url: '/api/unity/runs', headers: { host, cookie } })).json()).toEqual({ runs: [] });
      expect((await server.inject({ url: media, headers: { host, cookie, origin: 'http://localhost:4317' } })).statusCode).toBe(403);
      expect((await server.inject({ method: 'POST', url: '/api/unity/requests', headers: { host, origin, cookie },
        payload: {} })).statusCode).toBe(403);
    } finally {
      await server.close();
      storage.close();
    }
  });
});
