import { legacyProjectId } from '../packages/contracts/dist/index.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '@devhub/hub';
import { expect, it } from 'vitest';
import type { ExecutionBinding, RunnerClaimInput } from '../packages/contracts/dist/index.js';
import { codexEnvironment, csrfForSession, defaultToolNetworkPolicy, dependencyDestination, isPublicDeveloperAddress,
  permitsDestination, providerProxyEndpoint, sha256 } from '../packages/security/dist/index.js';
import { codexConfiguration, codexConfigDigest, isolatedCodexHome, summarizeCodexEvent } from '../packages/codex-adapter/dist/index.js';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { claimFromLocalRunner } from '../apps/hub/dist/runner-ipc.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';
import { createCodexWorktree, inspectCodexWorktree } from '../apps/hub/dist/codex-worktree.js';
import { snapshotWorkspace } from '../apps/hub/dist/workspace-snapshot.js';
import { superviseCodex } from '../apps/hub/dist/supervise-codex.js';
import { workspaceMatches } from '../apps/hub/dist/authorization-context.js';

it('locks the SDK sandbox, filters process and proxy credentials, and applies exact domain policy separately', () => {
  const profile = codexConfiguration('/fixture-path', 'win32');
  expect(profile.thread).toMatchObject({
    approvalPolicy: 'never',
    webSearchMode: 'disabled', additionalDirectories: [],
  });
  expect(profile.config.windows).toEqual({ sandbox: 'elevated' });
  expect(profile.config.features).toEqual({ apps: false, plugins: false, remote_plugin: false, network_proxy: false });
  expect(profile.config.default_permissions).toBe('PROJECT_DEVELOPER');
  expect(profile.rawConfigOverrides).toContain('permissions.PROJECT_DEVELOPER.network.enabled=false');
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

it('only brokers approved HTTPS destinations and refuses unsafe redirect and IP targets', () => {
  const registry = dependencyDestination('https://registry.npmjs.org/npm');
  expect(dependencyDestination('/npm/-/npm.tgz', registry).hostname).toBe(registry.hostname);
  expect(dependencyDestination('https://codeload.github.com/example/repo', new URL('https://github.com')))
    .toMatchObject({ hostname: 'codeload.github.com' });
  for (const target of ['https://127.0.0.1/test', 'https://0x7f000001/', 'https://[::1]/',
    '//registry.npmjs.org.evil.invalid/pkg', 'https://registry.npmjs.org:8443/pkg',
    'http://registry.npmjs.org/pkg', 'https://user@registry.npmjs.org/pkg', '/pkg?data=test']) {
    expect(() => dependencyDestination(target, registry)).toThrow('DESTINATION_DENIED');
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '172.29.1.2', '192.168.0.2', '169.254.169.254',
    '100.64.0.1', '198.19.0.1', '::ffff:127.0.0.1', '255.255.255.255']) {
    expect(isPublicDeveloperAddress(address)).toBe(false);
  }
  expect(isPublicDeveloperAddress('1.1.1.1')).toBe(true);
  const mode = codexConfiguration('/fixture', process.platform, 'DEVELOPER_ALLOWLIST');
  expect(mode.config.mcp_servers).toHaveProperty('devhub_dependencies');
  expect(mode.config.mcp_servers).toMatchObject({ devhub_dependencies: {
    enabled_tools: ['fetch_dependency'], default_tools_approval_mode: 'approve',
  } });
  expect(mode.rawConfigOverrides).toContain('permissions.PROJECT_DEVELOPER.network.enabled=false');
  expect(codexConfigDigest('/fixture', 'OFF')).not.toBe(codexConfigDigest('/fixture', 'DEVELOPER_ALLOWLIST'));
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
  const auth = join(profile, 'auth.json');
  writeFileSync(auth, '{}\n', { mode: 0o600 });
  await expect(isolatedCodexHome(profile, worktree)).resolves.toBe(realpathSync.native(profile));
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [auth, '/grant', '*S-1-5-32-545:(R)']);
    await expect(isolatedCodexHome(profile, worktree)).rejects.toThrow('CODEX_PROFILE_ACL_UNVERIFIED');
    execFileSync('icacls.exe', [auth, '/remove:g', '*S-1-5-32-545']);
  } else {
    chmodSync(auth, 0o644);
    await expect(isolatedCodexHome(profile, worktree)).rejects.toThrow('CODEX_AUTH_FILE_NOT_PRIVATE');
    chmodSync(auth, 0o600);
  }
  writeFileSync(join(profile, 'config.toml'), '');
  await expect(isolatedCodexHome(profile, worktree)).rejects.toThrow('custom configuration');
  const otherProfile = join(temporary.path, 'custom');
  mkdirSync(otherProfile, { mode: 0o700 });
  mkdirSync(join(otherProfile, 'skills', 'custom'), { recursive: true });
  await expect(isolatedCodexHome(otherProfile, worktree)).rejects.toThrow('custom skills');
}, 30000);

it('omits only untracked, explicitly ignored generated roots and rehashes every source on claim', async () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-snapshot-'));
  const root = temporary.path;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q');
  for (const directory of ['Assets', 'Library', 'Temp', 'ProjectSettings', 'node_modules']) mkdirSync(join(root, directory));
  writeFileSync(join(root, '.gitignore'), '/Library/\n/Temp/\n/node_modules/\n*.meta\n');
  writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.28f1\n');
  writeFileSync(join(root, 'Assets', 'real.meta'), 'original');
  writeFileSync(join(root, 'Library', 'generated'), 'cache one');
  writeFileSync(join(root, 'Temp', 'tracked'), 'project data');
  git('add', '-f', '--', 'Temp/tracked');
  const first = await snapshotWorkspace(root);
  writeFileSync(join(root, 'Library', 'generated'), 'changed unrelated cache');
  const second = await snapshotWorkspace(root);
  expect(second.sha256).toBe(first.sha256);
  expect(second.cachedFiles).toBeGreaterThan(0);
  const fresh = await snapshotWorkspace(root, { fresh: true });
  expect(fresh.sha256).toBe(second.sha256);
  expect(fresh.cachedFiles).toBe(0);
  writeFileSync(join(root, 'Assets', 'real.meta'), 'resource');
  const changed = await snapshotWorkspace(root, { fresh: true });
  expect(changed.sha256).not.toBe(fresh.sha256);
  writeFileSync(join(root, 'Temp', 'tracked'), 'changed source');
  expect((await snapshotWorkspace(root)).sha256).not.toBe(changed.sha256);
  await expect(snapshotWorkspace(root, { budget: { bytes: 8, entries: 100, depth: 10, milliseconds: 5000 } }))
    .rejects.toThrow('WORKSPACE_SNAPSHOT_LIMIT');
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'acknowledges an actual Worker process exit through the platform supervisor',
  async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-worker-'));
    const profile = join(temporary.path, 'profile');
    const tree = join(temporary.path, 'fixture');
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(tree);
    const cancel = new AbortController();
    let heartbeats = 0;
    const result = await superviseCodex({ worktree: tree, profile, prompt: 'Synthetic', threadId: null, networkMode: 'OFF' },
      AbortSignal.any([cancel.signal, AbortSignal.timeout(18_000)]), {
        event() {}, heartbeat() { heartbeats++; cancel.abort(); },
      });
    expect(heartbeats, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.exitConfirmed, JSON.stringify(result)).toBe(true);
  }, 32000);

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
    let now = Date.now();
    const store = openTaskStore(database, true, () => now);
    const app = createServer({ port: 4317, databasePath: database, managedDataDirectory: true });
    const thread = 'thread_fixture';
    try {
      store.execution.registerWorktree(tree, legacyProjectId);
      store.codex.manage(tree.worktreeId);
      const device = localDevice();
      const runner = store.execution.registerRunner({ ...device, label: 'Runtime fixture' });
      const task = store.create({ title: 'Codex fixture', description: 'Synthetic task', targetPlatform: 'BOTH' }, legacyProjectId);
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
            executionProfile: live.executionProfile, networkMode: live.networkMode,
          },
        };
        const pending = store.execution.createRequest(binding, sessionDigest, randomUUID(), true);
        if (binding.scope.operation === 'codex.turn' && binding.scope.networkMode === 'OFF') {
          expect(await workspaceMatches(store.execution,
            { ...binding, scope: { ...binding.scope, networkMode: 'DEVELOPER_ALLOWLIST' } })).toBe(false);
        }
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
      const third = await approve('interrupted prompt', first.devhubRunId);
      const workerId = randomUUID();
      let interruptedId = '';
      await claimFromLocalRunner(store.execution, runner.id, third, device, (request) => {
        interruptedId = store.codex.reserveWithinClaim(request, workerId).devhubRunId;
      });
      expect(store.codex.heartbeat(interruptedId, randomUUID())).toBe(false);
      expect(store.codex.heartbeat(interruptedId, workerId)).toBe(true);
      now += 16_000;
      expect(store.codex.list().find((run) => run.devhubRunId === interruptedId)).toMatchObject({
        status: 'INTERRUPTED', exitConfirmedAt: null, diagnosticCode: 'WORKER_HEARTBEAT_EXPIRED',
      });
      const competing = await approve('locked worktree', first.devhubRunId);
      await expect(claimFromLocalRunner(store.execution, runner.id, competing, device, (request) => {
        store.codex.reserveWithinClaim(request, randomUUID());
      })).rejects.toThrow('CODEX_WORKTREE_BUSY');
      expect(store.codex.finish(interruptedId, workerId, 'CANCELLED', false, null).status).toBe('INTERRUPTED');
      expect(store.codex.finish(interruptedId, workerId, 'CANCELLED', true, null).exitConfirmedAt).toBe(now);
    } finally {
      await app.close();
      store.close();
    }
    const reopened = openTaskStore(database, true);
    try {
      expect(reopened.codex.list().map((run) => run.status)).toEqual(['CANCELLED', 'CANCELLED', 'COMPLETED']);
    } finally {
      reopened.close();
    }
  }, 90000);
