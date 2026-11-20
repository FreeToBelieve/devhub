import type { CodexDiagnostic, DeveloperNetworkMode } from '@devhub/contracts';
import { streamCodexTurn, summarizeCodexEvent } from '@devhub/runner';

export interface WorkerInput {
  worktree: string;
  profile: string;
  prompt: string;
  threadId: string | null;
  networkMode: DeveloperNetworkMode;
  projectDocuments?: readonly string[];
}

const abort = new AbortController();
let launched = false;
process.on('disconnect', () => abort.abort());
process.on('message', (message) => {
  if (message === 'cancel') {
    abort.abort();
    if (!launched && process.connected) {
      process.send?.({ type: 'done', diagnostic: null }, () => process.disconnect?.());
    }
    return;
  }
  if (!launched && message && typeof message === 'object') {
    launched = true;
    void run(message as WorkerInput);
  }
});

async function run(input: WorkerInput) {
  const send = (message: object) => { if (process.connected) process.send?.(message); };
  const timer = setInterval(() => send({ type: 'heartbeat' }), 2000);
  let diagnostic: CodexDiagnostic | null = null;
  let started = false;
  try {
    send({ type: 'heartbeat' });
    const events = await streamCodexTurn({ ...input, signal: abort.signal });
    started = true;
    for await (const event of events) send({ type: 'event', event: summarizeCodexEvent(event) });
  } catch (error) {
    if (!abort.signal.aborted) {
      diagnostic = error instanceof Error && /permission profile|permission.*unsupported|sandbox.*unavailable/i.test(error.message)
        ? 'SDK_PERMISSION_PROFILE_UNAVAILABLE' : started ? 'SDK_STREAM_FAILED' : 'SDK_START_FAILED';
    }
  } finally {
    clearInterval(timer);
    if (process.connected) {
      process.send?.({ type: 'done', diagnostic }, () => process.disconnect?.());
    }
  }
}

process.send?.({ type: 'ready' });
