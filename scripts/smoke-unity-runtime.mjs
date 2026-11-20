import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempDisposableSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { executionPolicyVersion, unityVersion } from '../packages/contracts/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { createCodexWorktree, inspectCodexWorktree } from '../apps/hub/dist/codex-worktree.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { unityRuntime } from '../apps/hub/dist/unity-runtime.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';
import { gitDelivery } from '../apps/hub/dist/git-delivery.js';
import { initializeUnityArtifactRoot } from '../packages/unity-adapter/dist/index.js';

using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-runtime-'));
const phase = process.argv[2] ?? 'A';
const fixtureScene = phase === 'D' ? 'Assets/场景.v2/山河（夜） - 試練, A.unity' : 'Assets/Automation.unity';
const root = fixture.path;
const source = join(root, 'source');
mkdirSync(join(source, 'ProjectSettings'), { recursive: true });
mkdirSync(join(source, 'Assets'));
mkdirSync(join(source, 'Packages'));
writeFileSync(join(source, 'Assets', 'RuntimeMarker.cs'), 'public static class RuntimeMarker { }\n');
writeFileSync(join(source, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + unityVersion + '\n');
writeFileSync(join(source, 'Packages', 'manifest.json'), JSON.stringify({
  dependencies: phase === 'A' ? {} : { 'com.unity.test-framework': '1.6.0' },
}));
writeFileSync(join(source, '.gitignore'), '/Library/\n/Temp/\n/Obj/\n/Logs/\n/UserSettings/\n');
cpSync(fileURLToPath(new URL('../packages/unity-adapter/unity-package', import.meta.url)),
  join(source, 'Packages', 'com.devhub.unity-automation'), { recursive: true });
if (phase !== 'A') {
  for (const [folder, name, settings, contents] of [
    ['EditChecks', 'DevHub.Fixture.EditChecks', { includePlatforms: ['Editor'] }, `
      using NUnit.Framework;
      namespace DevHub.Fixture {
        public sealed class EditChecks {
          [Test] public void Passes() { Assert.That(2 + 2, Is.EqualTo(4)); }
          [Test] public void Fails() { Assert.That(2 + 2, Is.EqualTo(7)); }
          [Test] public void Exits() { UnityEditor.EditorApplication.Exit(19); }
        }
      }`],
    ['PlayChecks', 'DevHub.Fixture.PlayChecks', {}, `
      using System.Collections;
      using NUnit.Framework;
      using UnityEngine;
      using UnityEngine.TestTools;
      namespace DevHub.Fixture {
        public sealed class PlayChecks {
          [UnityTest] public IEnumerator Passes() { int frame = Time.frameCount; yield return null; Assert.Greater(Time.frameCount, frame); }
          [UnityTest] public IEnumerator Slow() { yield return new WaitForSecondsRealtime(45); Assert.Pass(); }
        }
      }`],
  ]) {
    mkdirSync(join(source, 'Assets', folder));
    writeFileSync(join(source, 'Assets', folder, folder + '.asmdef'),
      JSON.stringify({ name, optionalUnityReferences: ['TestAssemblies'], ...settings }));
    writeFileSync(join(source, 'Assets', folder, folder + '.cs'), contents);
  }
}
if (['C', 'D', 'E'].includes(phase)) {
  cpSync(fileURLToPath(new URL('./unity-fixture/Assets', import.meta.url)), join(source, 'Assets'), { recursive: true });
}
if (phase === 'D') {
  mkdirSync(join(source, 'Assets', '场景.v2'));
  for (const suffix of ['', '.meta']) renameSync(join(source, 'Assets', 'Automation.unity' + suffix), join(source, fixtureScene + suffix));
}
if (phase === 'E') {
  mkdirSync(join(source, 'Assets', 'Repair'));
  mkdirSync(join(source, 'Assets', 'RepairChecks'));
  writeFileSync(join(source, 'Assets', 'Repair', 'Repair.asmdef'), JSON.stringify({ name: 'DevHub.Fixture.Repair' }));
  writeFileSync(join(source, 'Assets', 'Repair', 'RepairRules.cs'),
    'public static class RepairRules { public static int RemainingHealth(int health, int damage) => health; }\n');
  writeFileSync(join(source, 'Assets', 'RepairChecks', 'RepairChecks.asmdef'), JSON.stringify({
    name: 'DevHub.Fixture.RepairChecks', includePlatforms: ['Editor'], optionalUnityReferences: ['TestAssemblies'],
    references: ['DevHub.Fixture.Repair'],
  }));
  writeFileSync(join(source, 'Assets', 'RepairChecks', 'RepairChecks.cs'), `
    using NUnit.Framework;
    namespace DevHub.Fixture {
      public sealed class RepairChecks {
        [TestCase(8,3,5)] [TestCase(3,8,0)] [TestCase(8,-5,8)]
        public void HealthAfterDamage(int health, int damage, int expected) {
          Assert.That(RepairRules.RemainingHealth(health, damage), Is.EqualTo(expected));
        }
      }
    }`);
}
const git = (...args) => execFileSync('git', ['-C', source, '-c', 'user.name=DevHub Fixture',
  '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=fixture-hooks', ...args], { stdio: 'pipe' });
git('init', '-b', 'main', '-q');
const simulatedUrl = 'https://github.com/fixture-owner/unity-runtime-fixture';
if (phase === 'E') git('remote', 'add', 'origin', simulatedUrl + '.git');
git('add', '.');
git('commit', '-qm', 'Temporary real Unity automation fixture');
const store = openTaskStore(join(root, 'data', 'unity.sqlite'), true);
const artifactRoot = process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS ? resolve(process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS) : join(root, 'artifacts');
const service = unityRuntime(store, artifactRoot);
try {
  await initializeUnityArtifactRoot(artifactRoot, !process.env.DEVHUB_UNITY_SMOKE_ARTIFACTS);
  async function newTree() {
    const tree = await createCodexWorktree(source, join(root, 'worktrees'));
    store.execution.registerWorktree(tree);
    store.codex.manage(tree.worktreeId);
    return tree;
  }
  const tree = await newTree();
  const runner = store.execution.registerRunner({ ...localDevice(), label: 'Unity native smoke test' });
  const task = store.create({ title: 'Isolated Unity automation', description: 'Temporary fixture only', targetPlatform: 'BOTH' });
  const session = sha256(store.execution.exchangeBootstrap(sha256(store.execution.createBootstrap().proof)).proof);
  async function launch(plan, workspace = tree) {
    const request = await service.request({ taskId: task.id, runnerId: runner.id, worktreeId: workspace.worktreeId, plan }, session, randomUUID());
    const approval = store.execution.mutate({ kind: 'approve', requestId: request.id, expectedVersion: request.version,
      sessionDigest: session, idempotencyKey: randomUUID(), workspaceMatches: true });
    return service.start({ grantId: approval.grantId, expectedVersion: approval.version,
      bindingDigest: approval.bindingDigest, idempotencyKey: randomUUID() });
  }
  async function run(plan, workspace = tree) {
    const active = await launch(plan, workspace);
    const outcome = await active.completion;
    console.log(JSON.stringify({ id: outcome.id, plan: outcome.plan.stage, status: outcome.status, code: outcome.diagnostic,
      exitConfirmed: outcome.exitConfirmed, stages: outcome.reports, artifacts: outcome.artifacts }));
    return outcome;
  }
  const doctor = await service.environment(tree.worktreeId);
  assert.equal(doctor.projectVersion, unityVersion);
  assert.ok(doctor.editor);
  console.log(JSON.stringify({ doctor: { version: doctor.version, platform: doctor.platform, build: doctor.buildSupport,
    graphics: doctor.graphics, locked: doctor.projectLocked, license: doctor.license } }));
  if (phase === 'A') {
    for (const stage of ['IMPORT', 'EDITOR']) {
      const result = await run({ stage, timeoutSeconds: 150 });
      assert.equal(result.status, 'COMPLETED', result.diagnostic ?? undefined);
      assert.equal(result.exitConfirmed, true);
      assert.ok(result.pid && result.processIdentity);
    }
    const active = await launch({ stage: 'IMPORT', timeoutSeconds: 120 });
    const deadline = AbortSignal.timeout(15_000);
    while (!store.unity.get(active.run.id)?.pid) await delay(100, undefined, { signal: deadline });
    assert.ok(service.cancel(active.run.id));
    const cancelled = await active.completion;
    console.log(JSON.stringify({ id: cancelled.id, status: cancelled.status, code: cancelled.diagnostic,
      exitConfirmed: cancelled.exitConfirmed, worktreeLocked: store.git.busy(cancelled.worktreeId) }));
    assert.ok(cancelled.status === 'CANCELLED' || cancelled.status === 'INTERRUPTED');
    assert.equal(store.git.busy(cancelled.worktreeId), !cancelled.exitConfirmed);
  } else if (phase === 'B') {
    const imported = await run({ stage: 'IMPORT', timeoutSeconds: 120 });
    assert.equal(imported.status, 'COMPLETED', imported.diagnostic ?? undefined);
    for (const stage of ['EDITMODE', 'PLAYMODE']) {
      const type = stage === 'EDITMODE' ? 'EditChecks' : 'PlayChecks';
      const result = await run({ stage, testFilter: 'DevHub.Fixture.' + type + '.Passes', timeoutSeconds: 100 });
      assert.equal(result.status, 'COMPLETED', result.diagnostic ?? undefined);
      assert.equal(result.reports[0].tests.passed, 1);
    }
    const failed = await run({ stage: 'EDITMODE', testFilter: 'DevHub.Fixture.EditChecks.Fails', timeoutSeconds: 100 });
    assert.equal(failed.status, 'FAILED', failed.diagnostic ?? undefined);
    assert.equal(failed.reports[0].tests.failed, 1);
    const brokenPath = join(tree.root, 'Assets', 'BrokenCompile.cs');
    writeFileSync(brokenPath, 'public static class BrokenCompile { public static int Value => MissingVariable; }\n');
    const broken = await run({ stage: 'IMPORT', timeoutSeconds: 100 });
    assert.equal(broken.diagnostic, 'UNITY_COMPILATION_FAILED');
    assert.ok(broken.reports[0].diagnostics.some((entry) => entry.code === 'CS0103'));
    unlinkSync(brokenPath);
    const processExit = await run({ stage: 'EDITMODE', testFilter: 'DevHub.Fixture.EditChecks.Exits', timeoutSeconds: 100 },
      await newTree());
    assert.equal(processExit.diagnostic, 'UNITY_TEST_REPORT_MISSING');
    const timeout = await run({ stage: 'PLAYMODE', testFilter: 'DevHub.Fixture.PlayChecks.Slow', timeoutSeconds: 5 }, await newTree());
    assert.equal(timeout.diagnostic, 'UNITY_TIMEOUT');
    if (process.platform === 'darwin') assert.equal(timeout.exitConfirmed, false);
  } else if (phase === 'C') {
    const result = await run({ stage: 'PLAYER', scene: 'Assets/Automation.unity', timeoutSeconds: 240 });
    assert.equal(result.status, 'COMPLETED', result.diagnostic ?? undefined);
    assert.ok(result.reports[0].build.sha256);
    assert.equal(result.reports[1].scene.path, 'Assets/Automation.unity');
    assert.ok(result.reports[1].scene.skillTriggered);
  } else if (phase === 'D') {
    const result = await run({ stage: 'GAME_VIEW', scene: fixtureScene, timeoutSeconds: 160,
      capture: { width: 960, height: 540, seconds: 3 } });
    assert.equal(result.status, 'COMPLETED', result.diagnostic ?? undefined);
    assert.ok(result.reports[0].scene.skillTriggered);
    assert.equal(result.reports[0].scene.path, fixtureScene);
    assert.ok(result.artifacts.find((asset) => asset.kind === 'editor-screenshot'));
    assert.ok(result.artifacts.find((asset) => asset.kind === 'editor-recording'));
  } else if (phase === 'E') {
    let profile = process.env.DEVHUB_CODEX_HOME;
    if (!profile && process.platform === 'darwin' && process.env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN === '1') {
      profile = join(root, 'codex-profile');
      mkdirSync(profile, { mode: 0o700 });
      symlinkSync(join(homedir(), '.codex', 'auth.json'), join(profile, 'auth.json'));
    }
    assert.ok(profile, 'A dedicated or explicitly reused Codex login is required.');
    async function codex(request, prompt) {
      const approval = store.execution.mutate({ kind: 'approve', requestId: request.id, expectedVersion: request.version,
        sessionDigest: session, idempotencyKey: randomUUID(), workspaceMatches: true });
      const actual = await executeApprovedTurn(store, { grantId: approval.grantId, expectedVersion: approval.version,
        bindingDigest: approval.bindingDigest, idempotencyKey: randomUUID() }, prompt, profile, AbortSignal.timeout(140_000));
      console.log(JSON.stringify({ codex: actual.devhubRunId, status: actual.status, diagnostic: actual.diagnosticCode,
        threadDigest: actual.providerThreadId && sha256(actual.providerThreadId).slice(0, 12) }));
      assert.equal(actual.status, 'COMPLETED', actual.diagnosticCode ?? undefined);
      return actual;
    }
    const live = await inspectCodexWorktree(tree.root, 'OFF', true);
    const prompt = 'This is an isolated Unity test fixture. Edit only Assets/Repair/RepairRules.cs. Set ' +
      'RemainingHealth(int health, int damage) to return exactly health - damage. This deliberate first pass will exercise ' +
      'failure recovery. Do not clamp values, inspect credentials, run Unity, or modify Git metadata.';
    const initial = store.execution.createRequest({
      taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task), repoId: live.repoId,
      worktreeId: live.worktreeId, baseHeadSha: live.baseHeadSha, codexThreadId: null, runnerId: runner.id, platform: runner.platform,
      policyVersion: executionPolicyVersion, scope: { operation: 'codex.turn', mode: 'start', previousRunId: null,
        promptSha256: sha256(prompt), sdkConfigSha256: live.sdkConfigSha256, workspaceSha256: live.workspaceSha256,
        executionProfile: live.executionProfile, networkMode: 'OFF' },
    }, session, randomUUID(), true);
    const first = await codex(initial, prompt);
    const testPlan = { stage: 'EDITMODE', testFilter: 'DevHub.Fixture.RepairChecks', timeoutSeconds: 120 };
    assert.equal((await run({ stage: 'IMPORT', timeoutSeconds: 120 })).status, 'COMPLETED');
    const failed = await run(testPlan);
    assert.equal(failed.status, 'FAILED');
    assert.ok(failed.reports[0].tests.failed > 0);
    const repair = await service.requestRepair({ runId: failed.id, previousRunId: first.devhubRunId,
      notes: 'Damage must not heal and remaining health cannot fall below zero. Edit only Assets/Repair/RepairRules.cs.' }, session, randomUUID());
    assert.notEqual(repair.request.binding.scope.promptSha256, initial.binding.scope.promptSha256);
    const fixed = await codex(repair.request, repair.prompt);
    assert.equal(fixed.providerThreadId, first.providerThreadId);
    assert.equal((await run({ stage: 'IMPORT', timeoutSeconds: 120 })).status, 'COMPLETED');
    const passed = await run(testPlan);
    assert.equal(passed.reports[0].tests.passed, 3);
    assert.equal((await run({ stage: 'PLAYMODE', testFilter: 'DevHub.Fixture.PlayChecks.Passes', timeoutSeconds: 120 })).status, 'COMPLETED');

    const branch = 'devhub/unity-repair-fixture';
    const refs = new Map([['main', live.baseHeadSha], [branch, live.baseHeadSha]]);
    const metadata = { remoteId: '55', defaultBranch: 'main', canPush: true, repositoryUrl: simulatedUrl, account: 'fixture' };
    let change = { number: 8, title: 'Fixture', description: '', url: simulatedUrl + '/pull/8', sourceBranch: branch, targetBranch: 'main',
      state: 'open', headSha: live.baseHeadSha };
    const values = new Map();
    const delivery = gitDelivery(store, {
      credentials: async () => ({ async set(ref, token) { values.set(ref, token); },
        async get(ref) { return values.get(ref) ?? null; }, async remove(ref) { values.delete(ref); } }),
      provider: () => ({ async validateConnection() { return metadata; }, async getRepository() { return metadata; },
        async getBranch(name) { return refs.has(name) ? { name, sha: refs.get(name), protected: false } : null; },
        async findPullRequest() { return change; },
        async updatePullRequest(number, text) { assert.equal(number, 8); change = { ...change, ...text, headSha: refs.get(branch) }; return change; } }),
      transfer: async ({ operation }) => { assert.equal(operation.kind, 'push'); refs.set(operation.branch, operation.sha); },
    });
    const projectId = randomUUID();
    await delivery.connect({ projectId, provider: 'github', repositoryUrl: simulatedUrl, token: 'synthetic-unity-delivery-fixture' }, 0, session);
    const { operation } = await delivery.preview(projectId, { taskId: task.id, worktreeId: tree.worktreeId, branch,
      title: 'Fix isolated Unity damage rules', description: 'Verified Unity run ' + passed.id,
      author: { name: 'DevHub Fixture', email: 'fixture@example.invalid' } }, session, randomUUID());
    const approved = store.git.approve(operation.id, { expectedVersion: operation.version, digest: operation.digest }, session);
    const delivered = await delivery.execute(operation.id, { expectedVersion: approved.version, digest: approved.digest }, session);
    const commitTree = execFileSync('git', ['-C', tree.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    assert.equal(commitTree, operation.binding.candidateTreeSha);
    assert.equal(delivered.changeNumber, 8);
    console.log(JSON.stringify({ sameThread: true, failed: failed.id, passed: passed.id, candidateTreeSha: commitTree,
      simulatedPullRequest: delivered.changeNumber }));
  } else throw new Error('Unknown smoke phase');
} finally { await service.close(); store.close(); }
