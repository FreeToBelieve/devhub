import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runnerIpcMessageSchema } from '@devhub/contracts';
import type { ExecutionRequest, RunnerClaimInput, RunnerIpcMessage, RunnerRecord } from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import { localDevice, workspaceMatches } from './authorization-context.js';

const workerPath = fileURLToPath(new URL('../../runner/dist/claim-worker.js', import.meta.url));

function requestOverPipe(
  request: RunnerIpcMessage,
  authorize: (message: RunnerIpcMessage, connected: () => boolean) => Promise<ExecutionRequest>,
): Promise<ExecutionRequest> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { SystemRoot: process.env.SystemRoot },
      execArgv: [],
      windowsHide: true,
    });
    let receipt: ExecutionRequest | undefined;
    let finished = false;
    const fail = (error: unknown = new Error('The local Runner IPC handshake failed.')) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(), 45_000);
    child.once('error', () => fail());
    child.once('exit', (code) => {
      if (code !== 0 || !receipt) return fail();
      finished = true;
      clearTimeout(timer);
      resolve(receipt);
    });
    child.once('message', async (message) => {
      const parsed = runnerIpcMessageSchema.safeParse(message);
      if (!parsed.success) return fail();
      try {
        receipt = await authorize(parsed.data, () => child.connected && !finished);
        child.send({ kind: 'receipt', requestId: receipt.id, status: receipt.status, bindingDigest: receipt.bindingDigest },
          (error) => { if (error) fail(); });
      } catch (error) {
        fail(error);
      }
    });
    child.send(request, (error) => { if (error) fail(); });
  });
}

export async function claimFromLocalRunner(
  execution: TaskStore['execution'],
  runnerId: string,
  claim: RunnerClaimInput,
  device: Pick<RunnerRecord, 'deviceId' | 'platform'> = localDevice(),
) {
  const runnerProof = execution.activateRunner(runnerId, device.deviceId, device.platform);
  return requestOverPipe({ kind: 'claim', runnerId, runnerProof, claim }, async (message, connected) => {
    const request = execution.getByGrant(message.claim.grantId);
    const matches = request ? await workspaceMatches(execution, request.binding) : false;
    if (!connected()) throw new Error('The local Runner IPC connection closed before authorization.');
    return execution.mutate({
      ...message.claim, kind: 'claim', proofDigest: sha256(message.runnerProof), runnerId: message.runnerId,
      deviceId: device.deviceId, workspaceMatches: matches,
    });
  });
}
