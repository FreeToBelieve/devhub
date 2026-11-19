import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deliveryBranchName, gitHeadSchema, remoteBranchName } from '@devhub/contracts';
import { GitProviderError, openGitHttps, smartGitAuthorization } from '@devhub/git-provider';
import type { Endpoint } from '@devhub/git-provider';
import { loopbackGit } from './local.js';

const maximumBytes = 128 * 1024 ** 2;

interface ChangeCommand {
  ref: string;
  oldSha: string;
  newSha: string;
}

export function authorizedReceivePack(command: Buffer, approved: ChangeCommand) {
  const lengthText = command.subarray(0, 4).toString('ascii');
  if (!/^[a-f0-9]{4}$/.test(lengthText)) return false;
  const size = Number.parseInt(lengthText, 16);
  if (size < 5 || size + 4 > command.length || command.subarray(size, size + 4).toString('ascii') !== '0000') return false;
  const line = command.subarray(4, size).toString('latin1').split('\0');
  if (line.length !== 2 || /(?:^| )push-options(?: |$)/.test(line[1] ?? '')) return false;
  return line[0] === approved.oldSha + ' ' + approved.newSha + ' ' + approved.ref;
}

async function checkedBody(inbound: IncomingMessage, command?: ChangeCommand) {
  const iterator = inbound.iterator({ destroyOnReturn: false });
  let first = Buffer.alloc(0);
  if (command) {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) throw new GitProviderError('GIT_PUSH_COMMAND_DENIED');
      first = Buffer.concat([first, value as Buffer]);
      const length = first.subarray(0, 4).toString('ascii');
      if (first.length < 4) continue;
      if (!/^[a-f0-9]{4}$/.test(length) || Number.parseInt(length, 16) > 4096) {
        throw new GitProviderError('GIT_PUSH_COMMAND_DENIED');
      }
      if (first.length >= Number.parseInt(length, 16) + 4) break;
    }
    if (!authorizedReceivePack(first, command)) throw new GitProviderError('GIT_PUSH_COMMAND_DENIED');
  }
  return Readable.from((async function* () {
    let size = first.length;
    if (size) yield first;
    for await (const chunk of iterator) {
      const data = chunk as Buffer;
      size += data.length;
      if (size > maximumBytes) throw new GitProviderError('GIT_TRANSFER_LIMIT');
      yield data;
    }
  })());
}

export async function gitTransport(input: {
  root: string; endpoint: Endpoint; token: string;
  operation: { kind: 'fetch'; branch: string } | { kind: 'push'; branch: string; sha: string; remoteSha: string | null };
}, connect = openGitHttps) {
  const { root, endpoint, operation, token } = input;
  const protocol = operation.kind === 'push' ? 'git-receive-pack' : 'git-upload-pack';
  const branch = operation.kind === 'push' ? deliveryBranchName.parse(operation.branch) : remoteBranchName.parse(operation.branch);
  const command = operation.kind === 'push' ? {
    ref: 'refs/heads/' + branch, oldSha: operation.remoteSha ?? '0'.repeat(operation.sha.length),
    newSha: gitHeadSchema.parse(operation.sha),
  } : undefined;
  const credential = Buffer.from(randomBytes(32).toString('base64url'));
  const auth = smartGitAuthorization(endpoint.provider, token);
  const signal = AbortSignal.timeout(100_000);
  const controller = new AbortController();
  const connectionSignal = AbortSignal.any([signal, controller.signal]);
  let posted = false;
  let upstreamError: string | undefined;
  const server = createServer({ headersTimeout: 5000, requestTimeout: 100_000, maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      const proofs = request.headersDistinct['x-devhub-git'];
      const proof = proofs?.length === 1 ? Buffer.from(proofs[0]!) : undefined;
      if (!proof || proof.length !== credential.length || !timingSafeEqual(proof, credential)) {
        response.writeHead(403, { Connection: 'close' }).end();
        return;
      }
      const discovery = request.method === 'GET' && request.url === '/git/info/refs?service=' + protocol;
      const post = request.method === 'POST' && request.url === '/git/' + protocol;
      if (!discovery && !post) { response.writeHead(405, { Connection: 'close' }).end(); return; }
      const expectedType = 'application/x-' + protocol + '-request';
      const length = request.headers['content-length'];
      if (post && (request.headers['content-type'] !== expectedType || (length && Number(length) > maximumBytes) ||
          (operation.kind === 'push' && posted))) {
        response.writeHead(403, { Connection: 'close' }).end();
        return;
      }
      const headers: Record<string, string> = { Authorization: auth };
      if (post) headers['Content-Type'] = expectedType;
      if (post && length) headers['Content-Length'] = length;
      if (request.headers['git-protocol'] === 'version=2') headers['Git-Protocol'] = 'version=2';
      const body = post ? await checkedBody(request, command) : undefined;
      if (post && command) {
        if (posted) throw new GitProviderError('GIT_PUSH_COMMAND_DENIED');
        posted = true;
      }
      const upstreamUrl = new URL(endpoint.repositoryUrl + '.git' + request.url!.slice(4));
      const upstream = await connect(upstreamUrl, discovery ? 'GET' : 'POST', headers, body, connectionSignal);
      const status = upstream.statusCode ?? 502;
      if (status !== 200) {
        upstream.destroy();
        upstreamError = status === 401 ? 'GIT_CREDENTIAL_EXPIRED' : status === 403 ? 'GIT_PERMISSION_DENIED' : 'GIT_REMOTE_FAILED';
        response.writeHead(502, { Connection: 'close' }).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-' + protocol + (discovery ? '-advertisement' : '-result'),
        'Cache-Control': 'no-store' });
      let received = 0;
      await pipeline(upstream, async function* (source) {
        for await (const chunk of source) {
          received += Buffer.byteLength(chunk);
          if (received > maximumBytes) throw new GitProviderError('GIT_TRANSFER_LIMIT');
          yield chunk;
        }
      }, response, { signal: connectionSignal });
    })().catch((error: unknown) => {
      upstreamError = error instanceof GitProviderError ? error.code : 'GIT_TRANSFER_FAILED';
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { Connection: 'close' }).end();
    });
  });
  server.maxConnections = 4;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new GitProviderError('GIT_TRANSPORT_UNAVAILABLE');
    const ref = command ? command.newSha + ':' + command.ref : 'refs/heads/' + branch;
    try { await loopbackGit(root, operation.kind, 'http://127.0.0.1:' + bound.port + '/git', ref, credential.toString()); }
    catch { throw new GitProviderError(upstreamError ?? 'GIT_TRANSFER_FAILED'); }
  } finally {
    credential.fill(0);
    controller.abort();
    server.close();
    server.closeAllConnections();
  }
}
