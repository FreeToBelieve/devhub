import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempDisposableSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPolicyVersion } from '../packages/contracts/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { codexConfiguration } from '../packages/codex-adapter/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { initializeUnityArtifactRoot } from '../packages/unity-adapter/dist/index.js';
import { inspectProjectInput, projectBinding } from '../apps/hub/dist/project-context.js';
import { createCodexWorktree, inspectCodexWorktree } from '../apps/hub/dist/codex-worktree.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { unityRuntime } from '../apps/hub/dist/unity-runtime.js';

using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-multi-project-live-'));
const repository = join(fixture.path, 'isolated-monorepo');
const assets = 'Games/A/Assets';
function write(path, data) { writeFileSync(join(repository, path), data); }
for (const [game, version] of [['A', '6000.3.28f1'], ['B', '2022.3.999f1']]) {
  const root = 'Games/' + game;
  mkdirSync(join(repository, root, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(repository, root, 'Assets'));
  write(root + '/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: ' + version + '\n');
  write(root + '/Assets/Canary.txt', 'synthetic-project-' + game);
  write(root + '/AGENTS.md', 'This fixture contains only synthetic game assets.\n');
  write(root + '/.gitignore', '/Library/\n/Temp/\n/Obj/\n/Logs/\n/UserSettings/\n');
}
mkdirSync(join(repository, 'Games', 'A', 'Packages'));
write('Games/A/Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.test-framework': '1.6.0' } }));
cpSync(fileURLToPath(new URL('../packages/unity-adapter/unity-package', import.meta.url)),
  join(repository, 'Games', 'A', 'Packages', 'com.devhub.unity-automation'), { recursive: true });
mkdirSync(join(repository, assets, 'EditChecks'));
write(assets + '/EditChecks/EditChecks.asmdef', JSON.stringify({
  name: 'DevHub.MultiProjectChecks', includePlatforms: ['Editor'], optionalUnityReferences: ['TestAssemblies'],
}));
write(assets + '/EditChecks/FixtureCheck.cs', 'using NUnit.Framework; public sealed class FixtureCheck { ' +
  '[Test] public void Adds() { Assert.That(2 + 2, Is.EqualTo(4)); } }');
const git = (...args) => execFileSync('git', ['-C', repository, '-c', 'user.name=DevHub Fixture',
  '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=fixture-hooks', ...args]);
git('init', '-b', 'main', '-q');
git('add', '.');
git('commit', '-qm', 'Temporary multi-project fixture');
const store = openTaskStore(join(fixture.path, 'data', 'fixture.sqlite'), true);
const artifactRoot = process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS ? resolve(process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS) : join(fixture.path, 'artifacts');
const runtime = unityRuntime(store, artifactRoot);
try {
  await initializeUnityArtifactRoot(artifactRoot, !process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS);
  async function register(name) {
    const project = store.projects.create(await inspectProjectInput(store, { name, repositoryRoot: repository,
      unityProjectPath: 'Games/' + name, targetPlatform: 'BOTH',
      settings: { description: '', gameType: '', documents: [{ kind: 'AGENTS', path: 'AGENTS.md' }] } }));
    const identity = await createCodexWorktree(project.repositoryRoot, join(fixture.path, 'trees', project.id), project);
    const tree = store.execution.registerWorktree(identity, project.id);
    store.codex.manage(tree.worktreeId);
    const task = store.create({ title: 'Native fixture ' + name, description: '', targetPlatform: 'BOTH' }, project.id);
    return { project, tree, task };
  }
  const a = await register('A');
  const b = await register('B');
  const runner = store.execution.registerRunner({ ...localDevice(), label: 'Native multi-project Runner' });
  const actor = sha256(store.execution.exchangeBootstrap(sha256(store.execution.createBootstrap().proof)).proof);
  function approve(pending) {
    const decision = store.execution.mutate({ kind: 'approve', requestId: pending.id, expectedVersion: pending.version,
      sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
    return { grantId: decision.grantId, expectedVersion: decision.version, bindingDigest: decision.bindingDigest, idempotencyKey: randomUUID() };
  }
  const environment = await runtime.environment(a.tree.worktreeId, a.project.id);
  const missing = await runtime.environment(b.tree.worktreeId, b.project.id);
  assert.equal(environment.projectVersion, '6000.3.28f1');
  assert.ok(environment.editor);
  assert.equal(missing.projectVersion, '2022.3.999f1');
  assert.equal(missing.editor, null);
  console.log(JSON.stringify({ exactEditor: environment.version, unavailableEditor: missing.projectVersion }));
  for (const stage of process.argv.includes('--codex-only') ? [] : ['IMPORT', 'EDITOR', 'EDITMODE']) {
    const pending = await runtime.request({ taskId: a.task.id, runnerId: runner.id, worktreeId: a.tree.worktreeId,
      plan: { stage, timeoutSeconds: 150 } }, actor, randomUUID(), a.project.id);
    const { completion } = await runtime.start(approve(pending), a.project.id);
    const run = await completion;
    console.log(JSON.stringify({ stage, id: run.id, status: run.status, editorVersion: run.version, code: run.diagnostic,
      projectId: run.projectId, exitConfirmed: run.exitConfirmed, tests: run.reports[0]?.tests?.passed ?? null }));
    assert.equal(run.status, 'COMPLETED', run.diagnostic ?? undefined);
    assert.equal(run.projectId, a.project.id);
    assert.equal(run.version, a.project.unityVersion);
    if (stage === 'EDITMODE') assert.equal(run.reports[0].tests.passed, 1);
  }

  if (process.argv.includes('--codex') || process.argv.includes('--codex-only')) {
    let profile = process.env.DEVHUB_CODEX_HOME;
    if (!profile && process.platform === 'darwin' && process.env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN === '1') {
      profile = join(fixture.path, 'codex-profile');
      mkdirSync(profile, { mode: 0o700 });
      symlinkSync(join(homedir(), '.codex', 'auth.json'), join(profile, 'auth.json'));
    }
    assert.ok(profile, 'A dedicated or explicitly reused Codex login is required.');
    const live = await inspectCodexWorktree(a.tree.root, 'OFF', true, undefined, a.project);
    const separate = join(b.tree.root, 'Games', 'B', 'Assets', 'Canary.txt');
    assert.equal(readFileSync(separate, 'utf8'), 'synthetic-project-B');
    assert.equal(readFileSync(join(a.tree.root, 'Games', 'B', 'Assets', 'Canary.txt'), 'utf8'), 'synthetic-project-B');
    const prompt = 'This is an isolated Unity fixture. Create Assets/DevHubProof.txt in the current approved project with ' +
      'the single line OWN_ALLOWED. Use the shell command printf \'OWN_ALLOWED\\n\' > Assets/DevHubProof.txt ' +
      'from the current project directory. Do not change any other file or inspect other projects.';
    const pending = store.execution.createRequest({ ...projectBinding(a.project), taskId: a.task.id, taskRevision: a.task.revision,
      taskSpecSha256: taskSpecDigest(a.task), runnerId: runner.id, platform: runner.platform, policyVersion: executionPolicyVersion,
      repoId: live.repoId, worktreeId: live.worktreeId, baseHeadSha: live.baseHeadSha, codexThreadId: null,
      scope: { operation: 'codex.turn', mode: 'start', previousRunId: null, promptSha256: sha256(prompt),
        workspaceSha256: live.workspaceSha256, sdkConfigSha256: live.sdkConfigSha256,
        networkMode: 'OFF', executionProfile: 'PROJECT_DEVELOPER' },
    }, actor, randomUUID(), true);
    const run = await executeApprovedTurn(store, approve(pending), prompt, profile, AbortSignal.timeout(150_000));
    console.log(JSON.stringify({ codex: run.devhubRunId, projectId: run.projectId, status: run.status,
      diagnostic: run.diagnosticCode, threadRecorded: !!run.providerThreadId }));
    assert.equal(run.status, 'COMPLETED', run.diagnosticCode ?? undefined);
    assert.equal(readFileSync(join(live.projectRoot, 'Assets', 'DevHubProof.txt'), 'utf8').trim(), 'OWN_ALLOWED');
    const sandboxBinary = process.env.DEVHUB_MULTI_PROJECT_SANDBOX_BIN;
    if (process.platform === 'darwin' && sandboxBinary) {
      const sandboxHome = join(fixture.path, 'sandbox-only');
      mkdirSync(sandboxHome, { mode: 0o700 });
      const config = codexConfiguration(live.projectRoot, process.platform, 'OFF', live.projectDocuments);
      const receipt = spawnSync(sandboxBinary, ['sandbox', '-P', 'PROJECT_DEVELOPER', '-C', live.projectRoot,
        ...config.rawConfigOverrides.flatMap((value) => ['-c', value]), '--', '/bin/sh', '-c',
        'printf scoped > Assets/SandboxProof.txt && ' +
        'if /bin/cat "$1"; then exit 11; fi; if /bin/cat "$2"; then exit 12; fi',
        'devhub-boundary', '../B/Assets/Canary.txt', separate], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: sandboxHome }, encoding: 'utf8', timeout: 20000,
      });
      assert.equal(receipt.status, 0);
      assert.equal((receipt.stderr.match(/Operation not permitted/g) ?? []).length, 2);
      assert.equal(readFileSync(join(live.projectRoot, 'Assets', 'SandboxProof.txt'), 'utf8'), 'scoped');
      console.log(JSON.stringify({ codexBoundary: ['OWN_ALLOWED', 'SIBLING_DENIED', 'OTHER_WORKTREE_DENIED'] }));
    }
  }
} finally { await runtime.close(); store.close(); }
