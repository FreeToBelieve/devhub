import type { CodexRun, RunnerClaimInput } from '@devhub/contracts';
import { isolatedCodexHome, streamCodexTurn, summarizeCodexEvent } from '@devhub/runner';
import { sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import { claimFromLocalRunner } from './runner-ipc.js';

export async function executeApprovedTurn(
  store: TaskStore,
  claim: RunnerClaimInput,
  prompt: string,
  profile: string,
  signal: AbortSignal,
  stream: typeof streamCodexTurn = streamCodexTurn,
): Promise<CodexRun> {
  const approval = store.execution.getByGrant(claim.grantId);
  const binding = approval?.binding;
  if (!binding || binding.scope.operation !== 'codex.turn' || !store.codex.manages(binding.worktreeId)) {
    throw new Error('A managed worktree and Codex approval are required.');
  }
  if (!prompt.trim() || sha256(prompt) !== binding.scope.promptSha256) {
    throw new Error('The prompt does not match the approved SHA256.');
  }
  const worktree = store.execution.getWorktree(binding.worktreeId);
  if (!worktree) throw new Error('The approved worktree was not found.');
  const home = await isolatedCodexHome(profile, worktree.root);
  signal.throwIfAborted();

  let reservedId: string | undefined;
  try {
    await claimFromLocalRunner(store.execution, binding.runnerId, claim, undefined, (request) => {
      signal.throwIfAborted();
      reservedId = store.codex.reserveWithinClaim(request).devhubRunId;
    });
  } catch (error) {
    if (reservedId) store.codex.finish(reservedId, signal.aborted ? 'CANCELLED' : 'FAILED');
    throw error;
  }
  if (!reservedId) throw new Error('The Codex run was not reserved.');
  const id = reservedId;

  const cancel = new AbortController();
  const runSignal = AbortSignal.any([signal, cancel.signal]);
  const poll = () => {
    try {
      if (store.codex.shouldCancel(id)) cancel.abort();
    } catch {
      cancel.abort();
    }
  };
  const timer = setInterval(poll, 250);
  let completed = false;
  try {
    poll();
    runSignal.throwIfAborted();
    const events = await stream({ worktree: worktree.root, profile: home, prompt, threadId: binding.codexThreadId, signal: runSignal });
    for await (const event of events) {
      store.codex.append(id, summarizeCodexEvent(event));
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') completed = false;
    }
    if (completed && store.codex.get(id)?.providerThreadId) return store.codex.finish(id, 'COMPLETED');
    return store.codex.finish(id, runSignal.aborted ? 'CANCELLED' : 'FAILED');
  } catch {
    return store.codex.finish(id, runSignal.aborted ? 'CANCELLED' : 'FAILED');
  } finally {
    clearInterval(timer);
  }
}
