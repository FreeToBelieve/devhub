import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { codexDiagnosticSchema, codexEventSchema } from '@devhub/contracts';
import type { CodexDiagnostic, CodexEvent } from '@devhub/contracts';
import { codexEnvironment, providerProxyEndpoint } from '@devhub/security';
import type { WorkerInput } from './codex-worker.js';
import { ownWindowsWorker, WindowsJobError } from './windows-job.js';

const executable = fileURLToPath(new URL('./codex-worker.js', import.meta.url));

type Outcome = { exitConfirmed: boolean; diagnostic: CodexDiagnostic | null; jobStage?: string };
type Callbacks = { event: (event: CodexEvent) => void; heartbeat: () => void };

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
  let job: Awaited<ReturnType<typeof ownWindowsWorker>> | undefined;
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
    const workerReady = await Promise.race([ready, delay(10_000, false, { ref: false })]);
    let jobStage: string | undefined;
    if (pid && workerReady && process.platform === 'win32') {
      try { job = await ownWindowsWorker(pid); }
      catch (error) { jobStage = error instanceof WindowsJobError ? error.stage : 'NATIVE_JOB_BINDING_FAILED'; }
    }
    if (!pid || !workerReady || (!mac && !job) || child.exitCode !== null) {
      if (child.connected) child.disconnect();
      child.kill();
      const exited = await Promise.race([closed, delay(5000, null)]);
      const cleaned = await job?.cleanUp();
      return { exitConfirmed: !!exited && (!job || cleaned === true),
        diagnostic: jobStage ? 'WORKER_JOB_UNAVAILABLE' : 'WORKER_READY_TIMEOUT', jobStage };
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
    if (job) await job.cleanUp();
    clearTimeout(cancelTimer);
    clearTimeout(boundedExit);
    signal.removeEventListener('abort', cancel);
  }
}
