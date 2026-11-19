import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTaskStore, taskSpecDigest } from '../packages/storage/dist/index.js';
import { sha256 } from '../packages/security/dist/index.js';
import { localDevice } from '../apps/hub/dist/authorization-context.js';
import { createCodexWorktree, inspectCodexWorktree } from '../apps/hub/dist/codex-worktree.js';
import { executeApprovedTurn } from '../apps/hub/dist/codex-runtime.js';

const profile = process.env.DEVHUB_CODEX_HOME;
if (!profile) throw new Error('Set DEVHUB_CODEX_HOME to a private, logged-in Codex profile before the live smoke.');

const temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-codex-live-'));
let store;
const command = process.platform === 'win32'
  ? `Get-Content seed.txt; if ($env:GITLAB_TOKEN) { exit 9 }; Write-Output 'command-proof'`
  : `cat seed.txt && test -z "\${GITLAB_TOKEN:-}" && printf '%s\\n' command-proof`;
try {
  const source = join(temporary.path, 'temporary repository');
  mkdirSync(source);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (...args) => execFileSync('git', [
    '-C', source, '-c', 'user.name=DevHub Live Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=disabled-fixture-hooks', ...args,
  ], { env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: fileURLToPath(new URL('../apps/hub/config/readonly.gitconfig', import.meta.url)) },
  stdio: 'pipe' });
  git('init', '-b', 'main', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(source, 'seed.txt'), 'devhub-fixture-seed\n');
  git('add', '--', 'seed.txt');
  git('commit', '-qm', 'Live test fixture');
  const tree = await createCodexWorktree(source, join(temporary.path, 'runs'));
  const gitMarker = readFileSync(join(tree.root, '.git'), 'utf8');
  store = openTaskStore(join(temporary.path, 'data', 'runtime.sqlite'), true);
  store.execution.registerWorktree(tree);
  store.codex.manage(tree.worktreeId);
  const device = localDevice();
  const runner = store.execution.registerRunner({ ...device, label: 'Live SDK fixture' });
  const task = store.create({ title: 'Codex SDK live acceptance', description: 'Temporary fixture only', targetPlatform: 'BOTH' });
  const bootstrap = store.execution.createBootstrap();
  const sessionDigest = sha256(store.execution.exchangeBootstrap(sha256(bootstrap.proof)).proof);
  process.env.GITLAB_TOKEN = 'devhub-synthetic-non-credential';

  async function run(prompt, previous, abort = undefined) {
    const live = await inspectCodexWorktree(tree.root);
    const pending = store.execution.createRequest({
      taskId: task.id, taskRevision: task.revision, taskSpecSha256: taskSpecDigest(task),
      repoId: live.repoId, worktreeId: live.worktreeId, baseHeadSha: live.baseHeadSha,
      runnerId: runner.id, platform: runner.platform, policyVersion: 1,
      codexThreadId: previous?.providerThreadId ?? null,
      scope: {
        operation: 'codex.turn', mode: previous ? 'resume' : 'start', previousRunId: previous?.devhubRunId ?? null,
        sdkConfigSha256: live.sdkConfigSha256, workspaceSha256: live.workspaceSha256, promptSha256: sha256(prompt),
        executionProfile: live.executionProfile, networkMode: live.networkMode,
      },
    }, sessionDigest, randomUUID(), true);
    const grant = store.execution.mutate({
      kind: 'approve', requestId: pending.id, expectedVersion: pending.version,
      sessionDigest, idempotencyKey: randomUUID(), workspaceMatches: true,
    });
    const timer = abort && setInterval(() => {
      const active = store.codex.list().find((entry) => entry.requestId === pending.id && entry.status === 'RUNNING');
      if (active && store.codex.events(active.devhubRunId, 0).some((entry) => entry.event.kind === 'turn.started')) {
        abort.abort();
      }
    }, 50);
    try {
      const timeout = AbortSignal.timeout(180_000);
      const result = await executeApprovedTurn(store, {
        grantId: grant.grantId, expectedVersion: grant.version, bindingDigest: grant.bindingDigest, idempotencyKey: randomUUID(),
      }, prompt, profile, abort ? AbortSignal.any([abort.signal, timeout]) : timeout);
      const events = store.codex.events(result.devhubRunId, 0).map((entry) => entry.event);
      assert.equal(result.providerTurnId, null);
      console.log(JSON.stringify({
        devhubRunId: result.devhubRunId, status: result.status, providerTurnId: result.providerTurnId,
        threadDigest: result.providerThreadId && sha256(result.providerThreadId).slice(0, 16),
        promptSha256: result.promptSha256, sdkConfigSha256: result.sdkConfigSha256,
        events: events.map((event) => [event.kind, event.itemType ?? null, event.exitCode ?? null]),
      }));
      return { result, events };
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  const first = await run(
    'This is a disposable local acceptance worktree. Run this harmless shell command exactly once: ' + command +
    '. Read seed.txt and create runtime-proof.txt containing the seed value on its own line. Do not alter Git metadata. Finish once done.',
    null,
  );
  assert.equal(first.result.status, 'COMPLETED');
  assert.ok(first.result.providerThreadId);
  assert.ok(first.events.some((event) => event.itemType === 'command_execution' && event.exitCode === 0));
  assert.equal(readFileSync(join(tree.root, 'runtime-proof.txt'), 'utf8').trim(), 'devhub-fixture-seed');
  assert.equal(existsSync(join(source, 'runtime-proof.txt')), false);
  const cancelled = await run(
    'In this disposable worktree, wait twenty seconds using the native shell and then create late-marker.txt. Do not touch other files.',
    first.result, new AbortController(),
  );
  assert.equal(cancelled.result.status, 'CANCELLED');
  assert.ok(cancelled.events.some((event) => event.kind === 'turn.started'));
  assert.equal(existsSync(join(tree.root, 'late-marker.txt')), false);
  const resumed = await run(
    'Read runtime-proof.txt from the earlier turn in this disposable worktree. Append exactly one new line containing devhub-resumed. Finish immediately.',
    first.result,
  );
  assert.equal(resumed.result.status, 'COMPLETED');
  assert.equal(resumed.result.providerThreadId, first.result.providerThreadId);
  assert.notEqual(resumed.result.devhubRunId, first.result.devhubRunId);
  assert.equal(resumed.result.sdkConfigSha256, first.result.sdkConfigSha256);
  assert.deepEqual(readFileSync(join(tree.root, 'runtime-proof.txt'), 'utf8').trim().split(/\r?\n/),
    ['devhub-fixture-seed', 'devhub-resumed']);
  assert.equal(readFileSync(join(tree.root, '.git'), 'utf8'), gitMarker);
  assert.equal(existsSync(join(tree.root, 'late-marker.txt')), false);
  console.log('PASS live SDK file read/write, command, events, cancellation, Thread resume and Git worktree isolation.');
} finally {
  store?.close();
  temporary.remove();
}
