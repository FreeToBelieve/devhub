import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface UnityProcessExit { code: number | null; signal: NodeJS.Signals | null; diagnostic?: string }

export function startEditor(executable: string, args: readonly string[], project: string) {
  const child = spawn(executable, args, { cwd: project, shell: false, windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
  const identity = { id: randomUUID(), pid: child.pid ?? null, startedAt: Date.now() };
  let nativeError = '';
  child.stderr.on('data', (chunk: Buffer) => { nativeError = (nativeError + chunk.toString('utf8')).slice(-8192); });
  const exit = new Promise<UnityProcessExit>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      const diagnostic = /^E[A-Z0-9_]{2,24}$/.test(error.code ?? '') ? 'UNITY_SPAWN_' + error.code : 'UNITY_SPAWN_FAILED';
      resolve({ code: null, signal: null, diagnostic });
    });
    child.once('close', (code, signal) => {
      const diagnostic = /library not loaded|dyld/i.test(nativeError) ? 'UNITY_NATIVE_LIBRARY_FAILED' :
        /code signature|library validation/i.test(nativeError) ? 'UNITY_SIGNATURE_INVALID' :
        signal ? 'UNITY_SIGNAL_' + signal : undefined;
      resolve({ code, signal, diagnostic });
    });
  });
  return {
    inspectEditorProcess: () => identity,
    waitForEditorExit: () => exit,
    stopEditor() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); },
  };
}

export const startBatchMode = startEditor;

export async function waitForEditorReady<T>(read: () => Promise<T | null>, exit: Promise<UnityProcessExit>,
  signal: AbortSignal): Promise<T | null> {
  let stopped = false;
  void exit.then(() => { stopped = true; });
  do {
    const value = await read();
    if (value !== null) return value;
    if (stopped || signal.aborted) break;
    await delay(150, undefined, { signal }).catch(() => undefined);
  } while (!signal.aborted);
  return null;
}
