import { randomUUID } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { legacyProjectId } from '../packages/contracts/dist/index.js';
import type { ExecutionBinding, GitDeliveryBinding, GitOperation } from '../packages/contracts/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';

type Kind = 'codex' | 'unity' | 'git';
type ClaimResult = { ok: true; id: string } | { ok: false; error: string };

function makeFixture(filename: string, worktreeRoot: string) {
  const store = openTaskStore(filename, true);
  const task = store.create({ title: 'Worktree lease fixture', description: '', targetPlatform: 'BOTH' }, legacyProjectId);
  const actor = sha256(store.execution.exchangeBootstrap(sha256(store.execution.createBootstrap().proof)).proof);
  const runner = store.execution.registerRunner({ label: 'Fixture Runner', deviceId: 'a'.repeat(64), platform: 'MACOS' });
  const worktree = store.execution.registerWorktree({
    worktreeId: 'b'.repeat(64), repoId: 'c'.repeat(64), root: worktreeRoot,
  }, legacyProjectId);
  store.codex.manage(worktree.worktreeId);
  const context = { taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
    repoId: worktree.repoId, worktreeId: worktree.worktreeId };
  const head = 'd'.repeat(40);
  const scopeFor = {
    codex: { operation: 'codex.turn', mode: 'start', previousRunId: null, promptSha256: 'e'.repeat(64),
      sdkConfigSha256: 'f'.repeat(64), workspaceSha256: '1'.repeat(64), executionProfile: 'PROJECT_DEVELOPER', networkMode: 'OFF' },
    unity: { operation: 'unity.run', plan: { stage: 'IMPORT', timeoutSeconds: 30 },
      configSha256: 'f'.repeat(64), workspaceSha256: '1'.repeat(64) },
  } as const satisfies Record<'codex' | 'unity', ExecutionBinding['scope']>;

  function prepare(kind: Kind) {
    const owner = randomUUID();
    if (kind !== 'git') {
      const pending = store.execution.createRequest({ ...context, baseHeadSha: head, codexThreadId: null,
        runnerId: runner.id, platform: runner.platform, policyVersion: 1, scope: scopeFor[kind] }, actor, randomUUID(), true);
      const approval = store.execution.mutate({ kind: 'approve', requestId: pending.id, expectedVersion: pending.version,
        sessionDigest: actor, idempotencyKey: randomUUID(), workspaceMatches: true });
      const proof = store.execution.activateRunner(runner.id, runner.deviceId, runner.platform);
      return { kind, id: approval.id, owner, actor, input: { kind: 'claim' as const, grantId: approval.grantId!,
        bindingDigest: approval.bindingDigest, expectedVersion: approval.version, idempotencyKey: randomUUID(),
        proofDigest: sha256(proof), runnerId: runner.id, deviceId: runner.deviceId, workspaceMatches: true } };
    }
    const projectId = legacyProjectId;
    const credentialRef = randomUUID();
    store.git.reserveCredential(projectId, credentialRef);
    store.git.connect({ projectId, provider: 'github', credentialRef, repositoryUrl: 'https://github.com/test/fixture',
      remoteId: 'fixture', defaultBranch: 'main', apiBaseUrl: 'https://api.github.com', account: 'fixture' }, 0, actor);
    const binding: GitDeliveryBinding = { ...context, projectId, head, remoteHead: head, branch: 'devhub/fixture',
      connectionVersion: 1, targetBranch: 'main', worktreeRoot, workspaceSha256: '1'.repeat(64),
      candidateTreeSha: 'a'.repeat(40), candidateDiffDigest: '2'.repeat(64), title: 'Fixture', description: '',
      author: { name: 'DevHub Fixture', email: 'fixture@example.invalid' } };
    const summary: GitOperation['summary'] = { changes: [], diff: '', candidate: {
      canCommit: true, candidateTreeSha: binding.candidateTreeSha!, candidateDiffDigest: binding.candidateDiffDigest!,
      workspaceSha256: binding.workspaceSha256, baseHeadSha: head, changedFiles: [],
      candidateFileSummary: { added: 0, modified: 0, deleted: 0, renamed: 0, 'type-changed': 0 },
    } };
    const preview = store.git.preview(binding, summary, '3'.repeat(64), actor, randomUUID());
    const approved = store.git.approve(preview.id, { expectedVersion: preview.version, digest: preview.digest }, actor);
    return { kind, id: approved.id, owner, actor, input: { expectedVersion: approved.version, digest: approved.digest } };
  }
  return { store, prepare, worktree };
}

type Attempt = ReturnType<ReturnType<typeof makeFixture>['prepare']>;

function startClaim(filename: string, gate: SharedArrayBuffer, attempt: Attempt) {
  const thread = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    async function run() {
      const { openTaskStore } = await import(workerData.storage);
      const store = openTaskStore(workerData.filename, true);
      try {
        const { kind, id, owner, actor, input } = workerData.attempt;
        const gate = new Int32Array(workerData.gate);
        parentPort.postMessage('ready');
        if (Atomics.wait(gate, 0, 0, 15000) === 'timed-out') throw new Error('Start barrier timed out');
        let claimed = id;
        if (kind === 'git') store.git.claim(id, input, actor, owner);
        else store.execution.mutate(input, (request) => {
          claimed = kind === 'codex' ? store.codex.reserveWithinClaim(request, owner).devhubRunId :
            store.unity.reserveWithinClaim(request, owner).id;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
        });
        parentPort.postMessage({ ok: true, id: claimed });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error.message });
      } finally { store.close(); }
    }
    void run();
  `, { eval: true, workerData: { filename, gate, attempt,
    storage: new URL('../packages/storage/dist/index.js', import.meta.url).href } });
  const ready = new Promise<void>((resolve, reject) => {
    thread.once('message', (message) => { if (message === 'ready') resolve(); else reject(new Error('Worker did not open SQLite')); });
    thread.once('error', reject);
  });
  const done = new Promise<ClaimResult>((resolve, reject) => {
    thread.on('message', (message) => { if (message !== 'ready') resolve(message as ClaimResult); });
    thread.once('error', reject);
    thread.once('exit', (code) => { if (code !== 0) reject(new Error('Worker exited during claim')); });
  });
  void done.catch(() => undefined);
  return { thread, ready, done };
}

function claimInProcess(store: ReturnType<typeof openTaskStore>, attempt: Attempt) {
  if (attempt.kind === 'git') return store.git.claim(attempt.id, attempt.input, attempt.actor, attempt.owner).id;
  let id: string | undefined;
  store.execution.mutate(attempt.input, (request) => {
    id = attempt.kind === 'codex' ? store.codex.reserveWithinClaim(request, attempt.owner).devhubRunId :
      store.unity.reserveWithinClaim(request, attempt.owner).id;
  });
  return id!;
}

describe('SQLite Worktree lease contention', () => {
  const combinations: [Kind, Kind][] = [
    ['codex', 'unity'], ['unity', 'unity'], ['codex', 'codex'], ['git', 'unity'], ['git', 'codex'],
  ];
  it.each(combinations)('%s competes with %s on independent SQLite connections', async (first, second) => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-lock-race-'));
    const filename = join(fixture.path, 'data', 'devhub.sqlite');
    const { store, prepare, worktree } = makeFixture(filename, join(fixture.path, 'worktree'));
    const gate = new SharedArrayBuffer(4);
    const attempts = [prepare(first), prepare(second)];
    const threads: ReturnType<typeof startClaim>[] = [];
    try {
      for (const attempt of attempts) {
        const worker = startClaim(filename, gate, attempt);
        threads.push(worker);
        await worker.ready;
      }
      const lock = new Int32Array(gate);
      Atomics.store(lock, 0, 1);
      Atomics.notify(lock, 0);
      const results = await Promise.all(threads.map((thread) => thread.done));
      expect(results.filter((entry) => entry.ok)).toHaveLength(1);
      const rejected = results.findIndex((entry) => !entry.ok);
      const loser = attempts[rejected]!;
      expect(results[rejected]).toEqual({ ok: false, error: loser.kind.toUpperCase() + '_WORKTREE_BUSY' });
      expect(store.git.busy(worktree.worktreeId)).toBe(true);
      if (loser.kind !== 'git') {
        expect(store.execution.getRequest(loser.id)?.status).toBe('APPROVED');
        expect(store.execution.detail(loser.id).events.filter(({ kind }) => kind === 'CLAIMED')).toHaveLength(0);
      } else {
        expect(store.git.operation(loser.id)?.phase).toBe('APPROVED');
      }
      const winner = attempts[1 - rejected]!;
      const won = results[1 - rejected]!;
      if (!won.ok) throw new Error('Expected one SQLite lease owner.');
      if (winner.kind === 'codex') store.codex.finish(won.id, winner.owner, 'COMPLETED', true, null);
      else if (winner.kind === 'unity') store.unity.finish(won.id, winner.owner, 'COMPLETED', true, null, []);
      else store.git.release(won.id, winner.owner, winner.actor, null);
      expect(claimInProcess(store, loser)).toBeTruthy();
    } finally {
      await Promise.all(threads.map(({ thread }) => thread.terminate()));
      store.close();
    }
  }, 60000);

  it.each(['codex', 'unity'] as const)('continues to exclude all claimants when %s is INTERRUPTED', (kind) => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-lock-interrupted-'));
    const { store, prepare } = makeFixture(join(fixture.path, 'data', 'devhub.sqlite'), join(fixture.path, 'worktree'));
    try {
      const winner = prepare(kind);
      const run = claimInProcess(store, winner);
      if (kind === 'codex') store.codex.finish(run, winner.owner, 'FAILED', false, null);
      else store.unity.finish(run, winner.owner, 'FAILED', false, null, []);
      for (const other of ['codex', 'unity', 'git'] as const) {
        const request = prepare(other);
        expect(() => claimInProcess(store, request)).toThrow(other.toUpperCase() + '_WORKTREE_BUSY');
      }
    } finally { store.close(); }
  }, 60000);
});
