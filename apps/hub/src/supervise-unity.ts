import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { unityReportSchema, unityStageSchema } from '@devhub/contracts';
import type { UnityReport, UnityStage } from '@devhub/contracts';
import type { UnityWorkerInput } from '@devhub/unity-adapter';
import { ownWindowsWorker } from './windows-job.js';
import { watchUnityProcessTree } from './unity-process-tree.js';

const runner = fileURLToPath(new URL('../../runner/dist/unity/worker.js', import.meta.url));
const allowedEnv = ['HOME','USER','LOGNAME','PATH','TMPDIR','TEMP','TMP','SystemRoot','SystemDrive','WINDIR',
  'PROGRAMFILES','ProgramW6432','PROGRAMDATA','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL','DISPLAY'];

function groupGone(pid: number) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function superviseUnity(input: UnityWorkerInput, signal: AbortSignal, callbacks: {
  heartbeat(): void;
  process(phase: UnityStage, pid: number, identity: string): void;
  report(report: UnityReport): void;
}) {
  const mac = process.platform === 'darwin';
  const child = fork(runner, [], {
    env: Object.fromEntries(allowedEnv.map((key) => [key, process.env[key]])),
    detached: mac || process.platform === 'win32', execArgv: [],
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let readyResolve: (flag: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => { readyResolve = resolve; });
  const closed = new Promise<boolean>((resolve) => {
    child.once('error', () => { readyResolve(false); if (!child.pid) resolve(false); });
    child.once('exit', () => { readyResolve(false); resolve(true); });
  });
  const pid = child.pid;
  const tree = mac && pid ? watchUnityProcessTree(pid) : undefined;
  let job: Awaited<ReturnType<typeof ownWindowsWorker>> | undefined;
  let launched = false;
  let result: { normalExit: boolean; code: string | null } | undefined;
  let errored = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let overdue: () => void = () => undefined;
  const boundedCancel = new Promise<false>((resolve) => { overdue = () => resolve(false); });
  const cancel = () => {
    if (child.connected) child.send('cancel', () => undefined);
    killTimer ??= setTimeout(() => {
      if (job) void job.cleanUp();
      else if (mac && pid) {
        tree?.stop();
        try { process.kill(-pid, 'SIGKILL'); } catch { /* checked after exit */ }
      }
      else child.kill();
    }, 3200);
    timeoutTimer ??= setTimeout(overdue, 9000);
  };
  child.on('message', (message: { type?: unknown; report?: unknown; code?: unknown; normalExit?: unknown;
    phase?: unknown; pid?: unknown; id?: unknown; startedAt?: unknown }) => {
    try {
      if (message.type === 'ready') readyResolve(true);
      if (message.type === 'heartbeat') callbacks.heartbeat();
      if (message.type === 'process' && typeof message.pid === 'number' && Number.isSafeInteger(message.pid) && message.pid > 0 &&
          typeof message.id === 'string' && /^[a-f0-9-]{36}$/.test(message.id) && typeof message.startedAt === 'number') {
        callbacks.process(unityStageSchema.parse(message.phase), message.pid, message.id + '/' + message.startedAt);
      }
      if (message.type === 'report') callbacks.report(unityReportSchema.parse(message.report));
      if (message.type === 'done') {
        result = { normalExit: message.normalExit === true, code: message.code === null ? null :
          typeof message.code === 'string' && /^UNITY_[A-Z0-9_]{1,64}$/.test(message.code) ? message.code : 'UNITY_WORKER_FAILED' };
      }
    } catch {
      errored = true;
      cancel();
    }
  });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const workerReady = await Promise.race([ready, delay(10_000, false, { ref: false }), boundedCancel]);
    if (pid && workerReady && process.platform === 'win32') {
      try { job = await ownWindowsWorker(pid); } catch { /* refuse launch below */ }
    }
    if (!pid || !workerReady || (!mac && !job) || child.exitCode !== null || signal.aborted) {
      if (child.connected) child.disconnect();
      child.kill();
      const exited = await Promise.race([closed, delay(4000, false, { ref: false })]);
      const confirmed = !pid || exited && (!job || await job.cleanUp());
      return { exitConfirmed: confirmed, code: workerReady && !mac && !job ? 'UNITY_JOB_UNAVAILABLE' : 'UNITY_WORKER_NOT_STARTED' };
    }
    callbacks.heartbeat();
    launched = true;
    child.send(input, (error) => { if (error) { errored = true; cancel(); } });
    const exited = await Promise.race([closed, boundedCancel]);
    if (exited && !result) await delay(100, undefined, { ref: false });
    if (mac && !result?.normalExit) tree?.stop();
    if (mac && exited && result?.normalExit) {
      // Unity's out-of-group licensing and package helpers can finish after the Editor exits.
      const deadline = performance.now() + 8000;
      while ((!groupGone(pid) || !tree?.confirmedGone()) && performance.now() < deadline) {
        await delay(250, undefined, { ref: false });
      }
    }
    const exitConfirmed = job ? await job.cleanUp() :
      !!exited && !errored && result?.normalExit === true && groupGone(pid) && tree?.confirmedGone() === true;
    return { exitConfirmed, code: result?.code ?? (result && !errored ? null : 'UNITY_WORKER_FAILED') };
  } finally {
    clearTimeout(killTimer);
    clearTimeout(timeoutTimer);
    if (job) await job.cleanUp();
    tree?.close();
    if (child.connected) child.disconnect();
    if (!launched) child.kill();
    signal.removeEventListener('abort', cancel);
  }
}
