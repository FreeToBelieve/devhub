import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from '@devhub/hub';
import { openTaskStore, projectContextDigest, taskSpecDigest } from '../packages/storage/dist/index.js';
import { executionPolicyVersion } from '../packages/contracts/dist/index.js';
import type { ExecutionBinding, Project, Task, WorktreeRecord } from '../packages/contracts/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { createRunDirectory, initializeUnityArtifactRoot, catalogArtifacts } from '../packages/unity-adapter/dist/index.js';
import type { GitProvider } from '../packages/git-provider/dist/index.js';

const host = '127.0.0.1:4317';
const origin = 'http://' + host;
const head = 'a'.repeat(40);
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=fixture-hooks', ...args], { stdio: 'pipe' });
}

it('isolates three projects through registry, actual Git worktrees, requests, Thread, media and Provider APIs', async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-three-projects-'));
  const shared = join(fixture.path, 'shared-repo');
  const independent = join(fixture.path, 'independent');
  const githubUrl = 'https://github.com/example/fixture';
  const gitlabUrl = 'https://gitlab.com/example/fixture';
  for (const [root, entries, remote] of [
    [shared, [['Games/A', '6000.3.28f1'], ['Games/B', '2022.3.62f1']], githubUrl],
    [independent, [['.', '6000.3.28f1']], gitlabUrl],
  ] as const) {
    mkdirSync(root);
    for (const [path, version] of entries) {
      mkdirSync(join(root, path, 'ProjectSettings'), { recursive: true });
      mkdirSync(join(root, path, 'Assets'));
      writeFileSync(join(root, path, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + version + '\n');
      writeFileSync(join(root, path, 'Assets', 'Game.cs'), '// Fixture only');
      writeFileSync(join(root, path, 'AGENTS.md'), 'Only use this project: ' + path);
    }
    git(root, 'init', '-b', 'main', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Fixture');
    git(root, 'remote', 'add', 'origin', remote + '.git');
  }
  const databasePath = join(fixture.path, 'data', 'tasks.sqlite');
  const artifacts = join(fixture.path, 'data', 'unity-runs');
  const store = openTaskStore(databasePath, true);
  const vault = new Map<string, string>();
  const credentialUses: string[] = [];
  const makeHub = () => createServer({ port: 4317, databasePath, managedDataDirectory: true,
    codexWorktreeRoot: join(fixture.path, 'trees'),
    gitDependencies: {
      credentials: async () => ({
        async get(ref) { return vault.get(ref) ?? null; }, async set(ref, value) { vault.set(ref, value); },
        async remove(ref) { vault.delete(ref); },
      }),
      provider: (endpoint, token) => {
        credentialUses.push(token);
        const response = { remoteId: endpoint.repositoryUrl, repositoryUrl: endpoint.repositoryUrl,
          defaultBranch: 'main', canPush: true, account: 'fixture' };
        return {
          async validateConnection() { return response; },
          async getRepository() { return response; },
          async listBranches() { return [{ name: 'main', sha: head, protected: false }]; },
        } as unknown as GitProvider;
      },
      transfer: async () => { throw new Error('No real Git transport permitted in fixture'); },
    },
  });
  let hub = makeHub();
  async function login() {
    const receipt = await hub.inject({ method: 'POST', url: '/api/operator/session', headers: { host, origin },
      payload: { bootstrapCredential: store.execution.createBootstrap().proof } });
    expect(receipt.statusCode).toBe(200);
    return { host, origin, cookie: String(receipt.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': receipt.json().csrfToken as string };
  }
  try {
    const credentials = await login();
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, projectId?: string, payload?: object) =>
      hub.inject({ method, url, payload, headers: { ...credentials,
        ...(projectId ? { 'x-devhub-project-id': projectId } : {}), 'idempotency-key': randomUUID() } });
    const actor = sha256(store.execution.exchangeBootstrap(sha256(store.execution.createBootstrap().proof)).proof);
    const runner = store.execution.registerRunner({ platform: 'MACOS', deviceId: 'c'.repeat(64), label: 'Fixture Runner' });
    const projects: Project[] = [];
    const tasks: Task[] = [];
    const trees: WorktreeRecord[] = [];
    for (const [index, root, path, remote] of [[0, shared, 'Games/A', githubUrl], [1, shared, 'Games/B', githubUrl],
      [2, independent, '.', gitlabUrl]] as const) {
      const register = await call('POST', '/api/projects', undefined, {
        name: 'Game ' + index, repositoryRoot: root, unityProjectPath: path, targetPlatform: 'BOTH',
        settings: { documents: [{ kind: 'AGENTS', path: 'AGENTS.md' }] },
      });
      expect(register.statusCode, register.body).toBe(201);
      const project = register.json().project as Project;
      projects.push(project);
      const created = await call('POST', '/api/tasks', project.id, { title: 'Task ' + index, description: '', targetPlatform: 'BOTH', projectId: project.id });
      expect(created.statusCode, created.body).toBe(201);
      tasks.push(created.json());
      const tree = await call('POST', '/api/projects/' + project.id + '/worktrees', project.id, {});
      expect(tree.statusCode, tree.body).toBe(201);
      trees.push(tree.json());
      const connection = await call('PUT', '/api/git/connections', project.id, {
        projectId: project.id, provider: index === 2 ? 'gitlab' : 'github', repositoryUrl: remote, token: 'synthetic-vault-' + index,
        expectedVersion: 0,
      });
      expect(connection.statusCode, connection.body).toBe(200);
    }
    const [a, b, c] = projects as [Project, Project, Project];
    expect(projects.map(({ unityVersion }) => unityVersion)).toEqual(['6000.3.28f1', '2022.3.62f1', '6000.3.28f1']);
    expect(a.repoId).toBe(b.repoId);
    expect(c.repoId).not.toBe(a.repoId);
    expect(new Set(trees.map(({ worktreeId }) => worktreeId)).size).toBe(3);
    expect(new Set(projects.map(({ id }) => store.git.connection(id)?.credentialRef)).size).toBe(3);
    expect((await call('GET', '/api/tasks', b.id)).json().tasks).toEqual([tasks[1]]);
    expect((await call('GET', '/api/tasks/' + tasks[1]!.id, a.id)).statusCode).toBe(404);
    expect((await call('GET', '/api/authorization/worktrees/' + trees[1]!.worktreeId, a.id)).statusCode).toBe(404);
    expect((await call('GET', '/api/projects/' + a.id + '/documents/' + trees[1]!.worktreeId, a.id)).statusCode).toBe(404);
    const before = credentialUses.length;
    expect((await call('GET', '/api/git/branches?projectId=' + b.id, a.id)).statusCode).toBe(404);
    expect(credentialUses).toHaveLength(before);
    expect((await call('GET', '/api/git/branches', b.id)).statusCode).toBe(200);
    expect(credentialUses.at(-1)).toBe('synthetic-vault-1');
    expect((await call('POST', '/api/git/operations', a.id, { projectId: a.id, operationId: randomUUID(), taskId: tasks[1]!.id,
      worktreeId: trees[1]!.worktreeId, branch: 'devhub/fixture', title: 'Fixture', description: '',
      author: { name: 'Fixture', email: 'fixture@example.invalid' } })).statusCode).toBe(409);

    function binding(index: number, scope: ExecutionBinding['scope'], thread: string | null = null): ExecutionBinding {
      const project = projects[index]!;
      const task = tasks[index]!;
      const tree = trees[index]!;
      return { projectId: project.id, projectContextSha256: projectContextDigest(project), policyVersion: executionPolicyVersion,
        taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task), runnerId: runner.id, platform: runner.platform,
        worktreeId: tree.worktreeId, repoId: tree.repoId, baseHeadSha: head, codexThreadId: thread, scope };
    }
    function reserve(index: number, scope: ExecutionBinding['scope']) {
      const pending = store.execution.createRequest(binding(index, scope), actor, randomUUID(), true);
      const approval = store.execution.mutate({ kind: 'approve', requestId: pending.id,
        expectedVersion: pending.version, sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
      const owner = randomUUID();
      const proof = store.execution.activateRunner(runner.id, runner.deviceId, runner.platform);
      let id = '';
      store.execution.mutate({ kind: 'claim', grantId: approval.grantId!, bindingDigest: approval.bindingDigest,
        expectedVersion: approval.version, idempotencyKey: randomUUID(), proofDigest: sha256(proof),
        runnerId: runner.id, deviceId: runner.deviceId, workspaceMatches: true }, (request) => {
        id = scope.operation === 'codex.turn' ? store.codex.reserveWithinClaim(request, owner).devhubRunId :
          store.unity.reserveWithinClaim(request, owner).id;
      });
      return { id, owner };
    }
    const codexScope = { operation: 'codex.turn', mode: 'start', previousRunId: null,
      workspaceSha256: 'e'.repeat(64), sdkConfigSha256: 'e'.repeat(64), promptSha256: 'e'.repeat(64),
      executionProfile: 'PROJECT_DEVELOPER', networkMode: 'OFF' } as const;
    const codexRuns = projects.map((_, index) => {
      const run = reserve(index, codexScope);
      store.codex.append(run.id, { kind: 'thread.started', threadId: 'thread_fixture_' + index });
      store.codex.finish(run.id, run.owner, 'COMPLETED', true, null);
      return run.id;
    });
    expect((await call('GET', '/api/codex-runs/' + codexRuns[1] + '/events', a.id)).statusCode).toBe(404);
    expect(() => store.execution.createRequest(binding(0, { ...codexScope, mode: 'resume',
      previousRunId: codexRuns[1]! }, 'thread_fixture_1'), actor, randomUUID(), true)).toThrow('STALE_CONTEXT');

    const unity = reserve(1, { operation: 'unity.run', plan: { stage: 'IMPORT', timeoutSeconds: 30 }, editorVersion: '2022.3.62f1',
      workspaceSha256: 'e'.repeat(64), configSha256: 'e'.repeat(64) });
    await initializeUnityArtifactRoot(artifacts, true);
    const directory = await createRunDirectory(artifacts, unity.id, trees[1]!.root);
    writeFileSync(join(directory, 'game-view.png'), 'fixture-png');
    writeFileSync(join(directory, 'game-view.mp4'), 'fixture-mp4');
    store.unity.finish(unity.id, unity.owner, 'COMPLETED', true, null, await catalogArtifacts(directory));
    expect((await call('GET', '/api/unity/runs', a.id)).json()).toEqual({ runs: [] });
    expect((await call('GET', '/api/unity/runs', b.id)).json().runs).toHaveLength(1);
    for (const name of ['game-view.png', 'game-view.mp4']) {
      const url = '/api/unity/runs/' + unity.id + '/artifact?name=' + name;
      expect((await call('GET', url, a.id)).statusCode).toBe(404);
      expect((await call('GET', url, b.id)).statusCode).toBe(200);
    }

    const escape = join(shared, 'InvalidLink');
    symlinkSync(independent, escape, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await call('POST', '/api/projects', undefined, { name: 'Bad', repositoryRoot: shared,
      unityProjectPath: 'InvalidLink', targetPlatform: 'BOTH' })).statusCode).toBe(404);
    const old = store.execution.createRequest(binding(2, codexScope), actor, randomUUID(), true);
    const approved = store.execution.mutate({ kind: 'approve', requestId: old.id, expectedVersion: old.version,
      sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
    writeFileSync(join(independent, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.4.1f1\n');
    const updated = await call('PUT', '/api/projects/' + c.id, c.id, { expectedRevision: c.revision,
      name: c.name, repositoryRoot: independent, unityProjectPath: '.', targetPlatform: 'BOTH', settings: c.settings });
    expect(updated.statusCode, updated.body).toBe(200);
    const proof = store.execution.activateRunner(runner.id, runner.deviceId, runner.platform);
    expect(() => store.execution.mutate({ kind: 'claim', grantId: approved.grantId!, idempotencyKey: randomUUID(),
      expectedVersion: approved.version, bindingDigest: approved.bindingDigest, proofDigest: sha256(proof),
      runnerId: runner.id, deviceId: runner.deviceId, workspaceMatches: true }, () => {
      throw new Error('Stale grant cannot reach the reservation callback.');
    })).toThrow('STALE_CONTEXT');
    expect((await call('POST', '/api/projects/' + c.id + '/archive', c.id,
      { expectedRevision: updated.json().revision })).statusCode).toBe(200);
    expect((await call('POST', '/api/tasks', c.id, { projectId: c.id, title: 'Blocked', description: '', targetPlatform: 'BOTH' })).statusCode).toBe(409);
    expect(() => store.execution.createRequest(binding(2, codexScope), actor, randomUUID(), true)).toThrow('STALE_CONTEXT');

    await hub.close();
    hub = makeHub();
    expect((await call('GET', '/api/projects')).json().projects).toHaveLength(4); // Three registered and one historical.
    expect((await call('GET', '/api/tasks', c.id)).json().tasks).toEqual([tasks[2]]);
    expect((await call('GET', '/api/codex-runs', b.id)).json().runs[0].devhubRunId).toBe(codexRuns[1]);
  } finally { await hub.close(); store.close(); }
}, 90000);
