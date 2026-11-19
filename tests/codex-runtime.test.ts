import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@devhub/hub';
import { expect, it } from 'vitest';
import type { ExecutionBinding, RunnerClaimInput } from '../packages/contracts/dist/index.js';
import { codexEnvironment, csrfForSession, defaultToolNetworkPolicy, permitsDestination, providerProxyEndpoint, sha256 } from '../packages/security/dist/index.js';
import { codexConfiguration, codexConfigDigest, isolatedCodexHome, summarizeCodexEvent } from '../packages/codex-adapter/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { claimFromLocalRunner } from '../apps/hub/dist/runner-ipc.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';
import { createCodexWorktree, inspectCodexWorktree } from '../apps/hub/dist/codex-worktree.js';

it('locks the SDK sandbox, filters process and proxy credentials, and applies exact domain policy separately', () => {
  const profile = codexConfiguration('/fixture-path', 'win32');
  expect(profile.thread).toMatchObject({
    sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: false,
    webSearchMode: 'disabled', additionalDirectories: [],
  });
  expect(profile.config.windows).toEqual({ sandbox: 'elevated' });
  expect(profile.config.features).toEqual({ apps: false, plugins: false, remote_plugin: false });
  const source = {
    Path: '/fixture/bin', HOME: '/fixture/home', GITLAB_TOKEN: 'dummy-secret', PRIVATE_TOKEN: 'dummy-other',
    OPENAI_API_KEY: 'dummy-api', HTTPS_PROXY: 'https://example.invalid', CODEX_HOME: '/different',
    NODE_OPTIONS: 'untrusted',
  };
  expect(codexEnvironment(source, '/isolated')).toEqual({ Path: '/fixture/bin', HOME: '/fixture/home', CODEX_HOME: '/isolated' });
  const local = providerProxyEndpoint('http://127.0.0.1:7890');
  expect(codexEnvironment(source, '/isolated', local)).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
  expect(() => providerProxyEndpoint('http://name:pass@127.0.0.1:7890')).toThrow();
  expect(() => providerProxyEndpoint('http://example.invalid:7890')).toThrow();
  expect(codexConfigDigest('/one')).not.toBe(codexConfigDigest('/two'));
  expect(permitsDestination(defaultToolNetworkPolicy, 'https://example.invalid')).toBe(false);
  const allow = { enabled: true, allowedDomains: ['example.invalid'] };
  expect(permitsDestination(allow, 'https://example.invalid/path')).toBe(true);
  expect(permitsDestination(allow, 'https://example.invalid.evil.invalid/')).toBe(false);
  expect(permitsDestination(allow, 'https://example.invalid:80')).toBe(false);
  expect(permitsDestination(allow, 'https://name:pass@example.invalid/')).toBe(false);
});

it('keeps secret-prone text out of SDK event projections', () => {
  expect(summarizeCodexEvent({ type: 'item.completed', item: {
    id: 'item_1', type: 'command_execution', command: 'echo dummy-token', aggregated_output: 'dummy-token',
    status: 'completed', exit_code: 0,
  } })).toEqual({ kind: 'item.completed', itemType: 'command_execution', exitCode: 0 });
  expect(summarizeCodexEvent({ type: 'error', message: 'dummy-token' })).toEqual({ kind: 'error' });
});

it('reuses the profile after the SDK initializes its built-in skills', async () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-codex-profile-'));
  const profile = join(temporary.path, 'profile');
  const worktree = join(temporary.path, 'worktree');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(worktree);
  mkdirSync(join(profile, 'skills', '.system'), { recursive: true });
  await expect(isolatedCodexHome(profile, worktree)).resolves.toBe(realpathSync.native(profile));
  await expect(isolatedCodexHome(profile, temporary.path)).rejects.toThrow('separate from the worktree');
  writeFileSync(join(profile, 'config.toml'), '');
  await expect(isolatedCodexHome(profile, worktree)).rejects.toThrow('custom configuration');
  const otherProfile = join(temporary.path, 'custom');
  mkdirSync(otherProfile, { mode: 0o700 });
  mkdirSync(join(otherProfile, 'skills', 'custom'), { recursive: true });
  await expect(isolatedCodexHome(otherProfile, worktree)).rejects.toThrow('custom skills');
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'atomically reserves real linked worktree runs, resumes and cancels through the SDK adapter contract',
  async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-codex-'));
    const repo = join(temporary.path, 'fixture repo');
    const profile = join(temporary.path, 'isolated profile');
    mkdirSync(repo);
    mkdirSync(profile, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', [
      '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=fixture-disabled-hooks', ...args,
    ], { stdio: 'pipe' });
    git('init', '-b', 'main', '-q');
    writeFileSync(join(repo, 'README.md'), 'synthetic fixture\n');
    git('add', '--', 'README.md');
    git('commit', '-qm', 'Fixture');
    const tree = await createCodexWorktree(repo, join(temporary.path, 'runs'));
    expect(tree.linked).toBe(true);
    const database = join(temporary.path, 'data', 'tasks.sqlite');
    const store = openTaskStore(database, true);
    const app = createServer({ port: 4317, databasePath: database, managedDataDirectory: true });
    const thread = 'thread_fixture';
    try {
      store.execution.registerWorktree(tree);
      store.codex.manage(tree.worktreeId);
      const device = localDevice();
      const runner = store.execution.registerRunner({ ...device, label: 'Runtime fixture' });
      const task = store.create({ title: 'Codex fixture', description: 'Synthetic task', targetPlatform: 'BOTH' });
      const bootstrap = store.execution.createBootstrap();
      const session = store.execution.exchangeBootstrap(sha256(bootstrap.proof));
      const sessionDigest = sha256(session.proof);
      const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317',
        cookie: 'devhub_operator=' + session.proof };
      expect((await app.inject({ url: '/api/codex-runs', headers: { host: headers.host } })).statusCode).toBe(401);
      async function approve(prompt: string, previousRunId: string | null): Promise<RunnerClaimInput> {
        const live = await inspectCodexWorktree(tree.root);
        const binding: ExecutionBinding = {
          taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
          repoId: live.repoId, worktreeId: live.worktreeId, baseHeadSha: live.baseHeadSha, runnerId: runner.id,
          platform: device.platform, policyVersion: 1, codexThreadId: previousRunId ? thread : null,
          scope: {
            operation: 'codex.turn', mode: previousRunId ? 'resume' : 'start', previousRunId, promptSha256: sha256(prompt),
            sdkConfigSha256: live.sdkConfigSha256, workspaceSha256: live.workspaceSha256,
          },
        };
        const pending = store.execution.createRequest(binding, sessionDigest, randomUUID(), true);
        const approved = store.execution.mutate({
          kind: 'approve', requestId: pending.id, expectedVersion: pending.version, sessionDigest,
          idempotencyKey: randomUUID(), workspaceMatches: true,
        });
        return { grantId: approved.grantId!, expectedVersion: approved.version,
          bindingDigest: approved.bindingDigest, idempotencyKey: randomUUID() };
      }
      const initial = await approve('first prompt', null);
      const passive = new AbortController();
      await expect(claimFromLocalRunner(store.execution, runner.id, initial, device)).rejects.toThrow('FORBIDDEN');
      await expect(executeApprovedTurn(store, initial, 'changed input', profile, passive.signal)).rejects.toThrow('approved SHA256');
      const first = await executeApprovedTurn(store, initial, 'first prompt', profile, passive.signal, async (input) => {
        expect(input.threadId).toBeNull();
        return (async function* () {
          yield { type: 'thread.started', thread_id: thread } as const;
          yield { type: 'turn.started' } as const;
          writeFileSync(join(tree.root, 'proof.txt'), 'approved worktree write');
          yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0,
            cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } } as const;
        })();
      });
      expect(first).toMatchObject({ status: 'COMPLETED', providerThreadId: thread, providerTurnId: null });
      expect(store.codex.events(first.devhubRunId, 0).map((entry) => entry.event.kind))
        .toEqual(['thread.started', 'turn.started', 'turn.completed']);
      expect(readFileSync(join(tree.root, 'proof.txt'), 'utf8')).toBe('approved worktree write');
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('synthetic fixture\n');
      const stale = await approve('stale proof', first.devhubRunId);
      writeFileSync(join(tree.root, 'proof.txt'), 'changed after approval');
      await expect(executeApprovedTurn(store, stale, 'stale proof', profile, passive.signal)).rejects.toThrow('STALE_CONTEXT');

      const continuation = await approve('second prompt', first.devhubRunId);
      const second = await executeApprovedTurn(store, continuation, 'second prompt', profile, passive.signal, async (input) => {
        expect(input.threadId).toBe(thread);
        return (async function* () {
          yield { type: 'turn.started' } as const;
          const running = store.codex.list().find((run) => run.previousRunId === first.devhubRunId)!;
          const url = '/api/codex-runs/' + running.devhubRunId;
          const live = await app.inject({ url: url + '/events?after=0', headers });
          expect(live.json()).toMatchObject({ run: { status: 'RUNNING' }, events: [{ event: { kind: 'turn.started' } }] });
          expect((await app.inject({ method: 'POST', url: url + '/cancel', headers })).statusCode).toBe(403);
          expect((await app.inject({ method: 'POST', url: url + '/cancel',
            headers: { ...headers, 'x-csrf-token': csrfForSession(session.proof) } })).statusCode).toBe(204);
          await new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('cancelled test')), { once: true });
          });
        })();
      });
      expect(second).toMatchObject({ status: 'CANCELLED', providerThreadId: thread, providerTurnId: null });
      expect(second.devhubRunId).not.toBe(first.devhubRunId);
      expect(second.promptSha256).not.toBe(first.promptSha256);
      expect(second.sdkConfigSha256).toBe(first.sdkConfigSha256);
    } finally {
      await app.close();
      store.close();
    }
    const reopened = openTaskStore(database, true);
    try {
      expect(reopened.codex.list().map((run) => run.status)).toEqual(['CANCELLED', 'COMPLETED']);
    } finally {
      reopened.close();
    }
  }, 90000);
