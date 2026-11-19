import { randomUUID } from 'node:crypto';
import type { CodexDiagnostic, CodexEvent, CodexRun, RunnerClaimInput } from '@devhub/contracts';
import { codexEventSchema } from '@devhub/contracts';
import { isolatedCodexHome, streamCodexTurn, summarizeCodexEvent } from '@devhub/runner';
import { sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import { claimFromLocalRunner } from './runner-ipc.js';
import { superviseCodex } from './supervise-codex.js';

export async function executeApprovedTurn(
  store: TaskStore,
  claim: RunnerClaimInput,
  prompt: string,
  profile: string,
  signal: AbortSignal,
  stream?: typeof streamCodexTurn,
): Promise<CodexRun> {
  const approval = store.execution.getByGrant(claim.grantId);
  const binding = approval?.binding;
  if (!binding || binding.scope.operation !== 'codex.turn' ||
      !binding.scope.executionProfile || !binding.scope.networkMode || !store.codex.manages(binding.worktreeId)) {
    throw new Error('A managed worktree and Project Developer approval are required.');
  }
  if (!prompt.trim() || sha256(prompt) !== binding.scope.promptSha256) {
    throw new Error('The prompt does not match the approved SHA256.');
  }
  const worktree = store.execution.getWorktree(binding.worktreeId);
  if (!worktree) throw new Error('The approved worktree was not found.');
  const home = await isolatedCodexHome(profile, worktree.root);
  signal.throwIfAborted();

  const workerId = randomUUID();
  let reservedId: string | undefined;
  try {
    await claimFromLocalRunner(store.execution, binding.runnerId, claim, undefined, (request) => {
      signal.throwIfAborted();
      reservedId = store.codex.reserveWithinClaim(request, workerId).devhubRunId;
    });
  } catch (error) {
    if (reservedId && store.codex.get(reservedId)) {
      store.codex.finish(reservedId, workerId, signal.aborted ? 'CANCELLED' : 'FAILED', true, 'WORKER_FAILED');
    }
    throw error;
  }
  if (!reservedId) throw new Error('The Codex run was not reserved.');
  const id = reservedId;

  const cancel = new AbortController();
  const runSignal = AbortSignal.any([signal, cancel.signal]);
  let lastHeartbeat = performance.now();
  function poll() {
    try {
      if (store.codex.shouldCancel(id) || performance.now() - lastHeartbeat > 15_000) cancel.abort();
    } catch {
      cancel.abort();
    }
  }
  let completed = false;
  let failed = false;
  const callbacks = {
    event(event: CodexEvent) {
      store.codex.append(id, event);
      if (event.kind === 'turn.completed') completed = true;
      if (event.kind === 'turn.failed') failed = true;
    },
    heartbeat() {
      lastHeartbeat = performance.now();
      if (!store.codex.heartbeat(id, workerId)) cancel.abort();
    },
  };
  const timer = setInterval(poll, 250);
  const input = { worktree: worktree.root, profile: home, prompt, threadId: binding.codexThreadId,
    networkMode: binding.scope.networkMode };
  let exitConfirmed = true;
  let diagnostic: CodexDiagnostic | null = null;
  try {
    poll();
    if (!runSignal.aborted && stream) {
      for await (const event of await stream({ ...input, signal: runSignal })) {
        callbacks.event(codexEventSchema.parse(summarizeCodexEvent(event)));
      }
    } else if (!runSignal.aborted) {
      exitConfirmed = false;
      const result = await superviseCodex(input, runSignal, callbacks);
      exitConfirmed = result.exitConfirmed;
      diagnostic = result.diagnostic;
    }
  } catch {
    if (!runSignal.aborted) diagnostic = 'WORKER_FAILED';
  } finally {
    clearInterval(timer);
  }

  if (completed && !failed && !diagnostic && store.codex.get(id)?.providerThreadId) {
    return store.codex.finish(id, workerId, 'COMPLETED', exitConfirmed, null);
  }
  if (runSignal.aborted) return store.codex.finish(id, workerId, 'CANCELLED', exitConfirmed, diagnostic);
  return store.codex.finish(id, workerId, 'FAILED', exitConfirmed,
    diagnostic ?? (failed ? 'SDK_TURN_FAILED' : 'SDK_NO_TERMINAL_EVENT'));
}
