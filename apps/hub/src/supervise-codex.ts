import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { codexDiagnosticSchema, codexEventSchema } from '@devhub/contracts';
import type { CodexDiagnostic, CodexEvent } from '@devhub/contracts';
import { codexEnvironment, providerProxyEndpoint } from '@devhub/security';
import type { WorkerInput } from './codex-worker.js';

const executable = fileURLToPath(new URL('./codex-worker.js', import.meta.url));
const jobScript = fileURLToPath(new URL('../windows/worker-job.ps1', import.meta.url));

type Outcome = { exitConfirmed: boolean; diagnostic: CodexDiagnostic | null };
type Callbacks = { event: (event: CodexEvent) => void; heartbeat: () => void };

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
  );
}

function windowsJob(pid: number, env: NodeJS.ProcessEnv) {
  const powershell = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const process = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', jobScript, String(pid)], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = exited(process);
  process.on('error', () => undefined);
  process.stdin.on('error', () => undefined);
  let ready = false;
  let clean = false;
  const lines = createInterface({ input: process.stdout });
  let cleanup: Promise<boolean> | undefined;
  const assigned = new Promise<boolean>((resolve) => {
    lines.on('line', (line) => {
      if (line === 'READY') { ready = true; resolve(true); }
      if (line === 'CLEAN') clean = true;
    });
    void closed.then(() => resolve(false));
  });
  return {
    async assign() { return Promise.race([assigned, delay(10_000, false, { ref: false })]); },
    cleanUp() {
      cleanup ??= (async () => {
        process.stdin.end('\n');
        const exit = await Promise.race([closed, delay(7000, null, { ref: false })]);
        if (!exit) process.kill();
        return ready && clean && exit?.code === 0;
      })();
      return cleanup;
    },
  };
}

function groupGone(pid: number) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function superviseCodex(input: WorkerInput, signal: AbortSignal, callbacks: Callbacks): Promise<Outcome> {
  const mac = process.platform === 'darwin';
  const env: NodeJS.ProcessEnv = codexEnvironment(process.env, input.profile);
  if (mac && process.env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN === '1') env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN = '1';
  const providerProxy = providerProxyEndpoint(process.env.DEVHUB_CODEX_PROVIDER_PROXY);
  if (providerProxy) env.DEVHUB_CODEX_PROVIDER_PROXY = providerProxy;
  const child = fork(executable, [], { silent: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    detached: mac, execArgv: [], env });
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', () => { if (!child.pid) resolve({ code: null }); });
  });
  const pid = child.pid;
  const job = process.platform === 'win32' && pid ? windowsJob(pid, env) : undefined;
  let seenDone = false;
  let diagnostic: CodexDiagnostic | null = null;
  let errored = false;
  let activeHostTools = 0;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let boundedExit: ReturnType<typeof setTimeout> | undefined;
  let expireExit: () => void = () => undefined;
  const exitOverdue = new Promise<null>((resolve) => { expireExit = () => resolve(null); });
  let markReady: (value: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => { markReady = resolve; });
  void closed.then(() => markReady(false));
  function cancel() {
    if (child.connected) child.send('cancel', () => undefined);
    cancelTimer ??= setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (mac && pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* ownership proof is checked below */ }
      } else if (job) void job.cleanUp();
      else child.kill();
    }, 3500);
    cancelTimer.unref();
    boundedExit ??= setTimeout(expireExit, 11_000);
  }
  child.on('message', (message: { type?: unknown; event?: unknown; diagnostic?: unknown }) => {
    try {
      if (message?.type === 'ready') markReady(true);
      if (message?.type === 'heartbeat') callbacks.heartbeat();
      if (message?.type === 'event') {
        const event = codexEventSchema.parse(message.event);
        if (event.itemType === 'command_execution' || event.itemType === 'mcp_tool_call') {
          if (event.kind === 'item.started') activeHostTools++;
          if (event.kind === 'item.completed') activeHostTools = Math.max(0, activeHostTools - 1);
        }
        callbacks.event(event);
      }
      if (message?.type === 'done') {
        seenDone = true;
        diagnostic = codexDiagnosticSchema.nullable().parse(message.diagnostic);
      }
    } catch {
      errored = true;
      cancel();
    }
  });
  child.on('error', () => { errored = true; });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const readyOnTime = Promise.race([ready, delay(10_000, false, { ref: false })]);
    const [workerReady, assigned] = await Promise.all([readyOnTime, job?.assign() ?? mac]);
    if (!pid || !workerReady || !assigned || child.exitCode !== null) {
      if (child.connected) child.disconnect();
      child.kill();
      await Promise.race([closed, delay(5000, null)]);
      const cleaned = await job?.cleanUp();
      // The launch message was never sent, so no SDK command could have started.
      return { exitConfirmed: !job || cleaned === true, diagnostic: 'WORKER_FAILED' };
    }
    callbacks.heartbeat();
    if (signal.aborted) cancel();
    else child.send(input, (error) => { if (error) { errored = true; cancel(); } });
    const exit = await Promise.race([closed, exitOverdue]);
    const exitConfirmed = job ? await job.cleanUp() && seenDone && !errored && activeHostTools === 0 :
      seenDone && exit?.code === 0 && !errored && activeHostTools === 0 && groupGone(pid);
    if (child.connected) child.disconnect();
    return { exitConfirmed, diagnostic: errored || !seenDone || exit?.code !== 0 ? 'WORKER_FAILED' : diagnostic };
  } finally {
    clearTimeout(cancelTimer);
    clearTimeout(boundedExit);
    signal.removeEventListener('abort', cancel);
  }
}
