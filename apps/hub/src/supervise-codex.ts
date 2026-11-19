import { fork, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { codexDiagnosticSchema, codexEventSchema } from '@devhub/contracts';
import type { CodexDiagnostic, CodexEvent } from '@devhub/contracts';
import { codexEnvironment, providerProxyEndpoint } from '@devhub/security';
import type { WorkerInput } from './codex-worker.js';

const executable = fileURLToPath(new URL('./codex-worker.js', import.meta.url));
const jobScript = fileURLToPath(new URL('../windows/worker-job.ps1', import.meta.url));

type Outcome = { exitConfirmed: boolean; diagnostic: CodexDiagnostic | null; jobStage?: string };
type Callbacks = { event: (event: CodexEvent) => void; heartbeat: () => void };

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
  );
}

function windowsJob(pid: number, profile: string, env: NodeJS.ProcessEnv) {
  const powershell = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const directory = mkdtempSync(join(profile, 'devhub-job-'));
  const evidence = join(directory, 'evidence');
  const controller = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', jobScript,
    String(pid), String(process.pid), directory], {
    env, windowsHide: true, stdio: 'ignore',
  });
  const closed = exited(controller);
  controller.on('error', () => undefined);
  const status = () => readFile(evidence, 'utf8').then((value) => value.trim(), () => '');
  let cleanup: Promise<boolean> | undefined;
  return {
    async assign() {
      const deadline = performance.now() + 12_000;
      while (performance.now() < deadline && controller.exitCode === null && controller.signalCode === null) {
        if (await status() === 'READY') return true;
        await delay(50);
      }
      return false;
    },
    async stage() {
      const marker = await status();
      if (/^(?:STARTING|COMPILED|WAITING_JOB|READY|CLEAN|CONTAINMENT_FAILED|(?:OPEN_PARENT|COMPILE_JOB|CREATE_JOB|SET_JOB_LIMITS|OPEN_WORKER|ASSIGN_WORKER)_\d{1,10})$/.test(marker)) {
        return marker;
      }
      return controller.exitCode === null ? 'NO_READY_MARKER' : 'CONTROLLER_EXIT_' + controller.exitCode;
    },
    cleanUp() {
      cleanup ??= (async () => {
        writeFileSync(join(directory, 'stop'), '');
        const exit = await Promise.race([closed, delay(7000, null)]);
        if (!exit) controller.kill();
        const clean = await status() === 'CLEAN';
        if (exit) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        return clean && exit?.code === 0;
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
    // On Windows the Job helper owns containment. Avoid libuv's implicit second job.
    detached: mac || process.platform === 'win32', execArgv: [], env });
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', () => { if (!child.pid) resolve({ code: null }); });
  });
  const pid = child.pid;
  const job = process.platform === 'win32' && pid ? windowsJob(pid, input.profile, env) : undefined;
  let seenDone = false;
  let markDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { markDone = resolve; });
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
        markDone();
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
      const jobStage = await job?.stage();
      if (child.connected) child.disconnect();
      child.kill();
      await Promise.race([closed, delay(5000, null)]);
      const cleaned = await job?.cleanUp();
      // The launch message was never sent, so no SDK command could have started.
      return { exitConfirmed: !job || cleaned === true,
        diagnostic: workerReady && !assigned && job ? 'WORKER_JOB_UNAVAILABLE' : 'WORKER_READY_TIMEOUT', jobStage };
    }
    callbacks.heartbeat();
    const launch = !signal.aborted;
    if (!launch) cancel();
    else child.send(input, (error) => { if (error) { errored = true; cancel(); } });
    const exit = await Promise.race([closed, exitOverdue]);
    if (launch && !seenDone) await Promise.race([done, delay(500)]);
    const agreed = (!launch || seenDone) && !errored && activeHostTools === 0;
    const exitConfirmed = job ? await job.cleanUp() && agreed :
      !!exit && agreed && groupGone(pid);
    if (child.connected) child.disconnect();
    return { exitConfirmed, diagnostic: errored || (launch && (!seenDone || exit?.code !== 0)) ? 'WORKER_FAILED' : diagnostic };
  } finally {
    clearTimeout(cancelTimer);
    clearTimeout(boundedExit);
    signal.removeEventListener('abort', cancel);
  }
}
