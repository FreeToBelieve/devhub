import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import { permitsDestination } from './network-policy.js';

export const developerDomains = Object.freeze([
  'packages.unity.com', 'download.packages.unity.com', 'upm-cdn.unity.com', 'upm-cdn-china.unitychina.cn',
  'registry.npmjs.org', 'github.com', 'codeload.github.com',
]);

const nonPublic = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(base, prefix);

export function isPublicDeveloperAddress(address: string) {
  return isIPv4(address) && !nonPublic.check(address);
}

export class DeveloperNetworkError extends Error {
  constructor(readonly code: 'DESTINATION_DENIED' | 'ADDRESS_DENIED' | 'REDIRECT_DENIED' |
    'UPSTREAM_ERROR' | 'DOWNLOAD_LIMIT') { super(code); }
}

export function dependencyDestination(raw: string, base?: URL) {
  if (raw.length > 2048) throw new DeveloperNetworkError('DESTINATION_DENIED');
  const url = URL.parse(raw, base);
  if (!url || url.hash || url.search || !permitsDestination({ enabled: true, allowedDomains: developerDomains }, url.href)) {
    throw new DeveloperNetworkError('DESTINATION_DENIED');
  }
  return url;
}

async function connect(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const signalError = () => new DeveloperNetworkError('UPSTREAM_ERROR');
  return new Promise((resolve, reject) => {
    function abort() { reject(signalError()); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void lookup(url.hostname, { all: true, family: 4 }).then((answers) => {
      signal.throwIfAborted();
      const address = answers[0]?.address;
      if (!address || answers.some((answer) => !isPublicDeveloperAddress(answer.address))) {
        throw new DeveloperNetworkError('ADDRESS_DENIED');
      }
      const agent = new Agent({ keepAlive: false });
      const outbound = request({
        hostname: address, servername: url.hostname, port: 443, method: 'GET', path: url.pathname,
        agent, signal, rejectUnauthorized: true, maxHeaderSize: 16_384,
        headers: { Host: url.hostname, Accept: '*/*', 'User-Agent': 'ShanHe-DevHub-Dependency-Proxy' },
      }, (response) => {
        response.once('close', () => agent.destroy());
        resolve(response);
      });
      outbound.once('error', () => { agent.destroy(); reject(signalError()); });
      outbound.end();
    }).catch((error: unknown) => reject(error instanceof DeveloperNetworkError ? error : signalError()))
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function openDependency(raw: string, signal = AbortSignal.timeout(45_000)) {
  let url = dependencyDestination(raw);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await connect(url, signal);
    if (response.statusCode === 200) return response;
    response.destroy();
    if (!response.statusCode || ![301, 302, 303, 307, 308].includes(response.statusCode) || !response.headers.location) {
      throw new DeveloperNetworkError('UPSTREAM_ERROR');
    }
    if (redirects === 4) throw new DeveloperNetworkError('REDIRECT_DENIED');
    try {
      url = dependencyDestination(response.headers.location, url);
    } catch {
      throw new DeveloperNetworkError('REDIRECT_DENIED');
    }
  }
  throw new DeveloperNetworkError('REDIRECT_DENIED');
}
