import { resolve4, resolve6 } from 'node:dns/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import { BlockList, isIP, isIPv6 } from 'node:net';
import type { Readable } from 'node:stream';
import { isPublicDeveloperAddress, providerProxyEndpoint } from '@devhub/security';
import type { GitConnection } from '@devhub/contracts';

export class GitProviderError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type Endpoint = Pick<GitConnection, 'provider' | 'repositoryUrl' | 'apiBaseUrl'> & { projectPath: string };

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const reservedIpv6 = new BlockList();
// Exclude special-purpose, translation and documentation ranges in the global unicast space.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  reservedIpv6.addSubnet(address, prefix, 'ipv6');
}

function secureUrl(value: string) {
  const url = URL.parse(value);
  if (!url || !/^https:\/\//.test(value) || value !== value.trim() || /[%\\\s]/.test(value) || url.protocol !== 'https:' ||
      url.username || url.password || url.hash || url.search || isIP(url.hostname) ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(url.hostname) ||
      value.split('/').some((part) => part === '.' || part === '..')) {
    throw new GitProviderError('GIT_ENDPOINT_DENIED');
  }
  return url;
}

export function providerEndpoint(provider: GitConnection['provider'], repository: string, apiBase?: string): Endpoint {
  const url = secureUrl(repository);
  const repositoryPath = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  const parts = repositoryPath.slice(1).split('/');
  if (parts.length < 2 || parts.some((part) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(part))) {
    throw new GitProviderError('GIT_REPOSITORY_PATH_DENIED');
  }
  if (provider === 'github') {
    if (url.origin !== 'https://github.com' || parts.length !== 2 ||
        (apiBase !== undefined && apiBase !== 'https://api.github.com')) {
      throw new GitProviderError('GIT_ENDPOINT_DENIED');
    }
    return { provider, repositoryUrl: url.origin + repositoryPath, apiBaseUrl: 'https://api.github.com',
      projectPath: parts.join('/') };
  }
  const api = secureUrl(apiBase ?? url.origin + '/api/v4');
  const apiPath = api.pathname.replace(/\/$/, '');
  if (api.origin !== url.origin || !/^(?:\/[a-zA-Z0-9_-]+)*\/api\/v4$/.test(apiPath)) {
    throw new GitProviderError('GIT_ENDPOINT_DENIED');
  }
  const prefix = apiPath.slice(0, -'/api/v4'.length);
  const projectPath = repositoryPath.slice(prefix.length + 1);
  if (!repositoryPath.startsWith(prefix + '/') || projectPath.split('/').length < 2) {
    throw new GitProviderError('GIT_REPOSITORY_PATH_DENIED');
  }
  return { provider, repositoryUrl: url.origin + repositoryPath, apiBaseUrl: api.origin + apiPath, projectPath };
}

export function publicGitAddress(addresses: readonly string[]) {
  const first = addresses[0];
  if (!first || addresses.some((address) => !isPublicDeveloperAddress(address) &&
      (!isIPv6(address) || address.includes('%') || !globalIpv6.check(address, 'ipv6') || reservedIpv6.check(address, 'ipv6')))) {
    throw new GitProviderError('GIT_ADDRESS_DENIED');
  }
  return first;
}

export function gitHttpsFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (/^(?:ERR_TLS_CERT_|CERT_|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(code)) {
    return 'GIT_TLS_CERTIFICATE_REJECTED';
  }
  if (/^ERR_SSL_|^ERR_TLS_/.test(code)) return 'GIT_TLS_HANDSHAKE_FAILED';
  return 'GIT_NETWORK_UNAVAILABLE';
}

async function resolveGitAddresses(hostname: string) {
  function emptyAnswer(error: NodeJS.ErrnoException) {
    if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
    throw error;
  }
  const [ipv4, ipv6] = await Promise.all([resolve4(hostname).catch(emptyAnswer), resolve6(hostname).catch(emptyAnswer)]);
  return [...ipv4, ...ipv6];
}

export async function openGitHttps(
  url: URL, method: string, headers: Record<string, string>, body?: string | Readable,
  signal = AbortSignal.timeout(25_000),
  resolveAddresses = resolveGitAddresses,
): Promise<IncomingMessage> {
  let proxy: string | null;
  let proxyResolvesHost = false;
  try {
    proxy = providerProxyEndpoint(process.env.DEVHUB_GIT_HTTPS_PROXY);
    const configuredOrigin = process.env.DEVHUB_GIT_PROXY_DNS_ORIGIN;
    if (configuredOrigin) {
      const origin = secureUrl(configuredOrigin);
      if (!proxy || origin.pathname !== '/') throw new GitProviderError('GIT_EGRESS_PROXY_DENIED');
      proxyResolvesHost = url.origin === origin.origin;
    }
  } catch { throw new GitProviderError('GIT_EGRESS_PROXY_DENIED'); }
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const failure = () => new GitProviderError('GIT_NETWORK_UNAVAILABLE');
    const abort = () => reject(failure());
    signal.addEventListener('abort', abort, { once: true });
    const destination = proxyResolvesHost ? Promise.resolve(url.hostname) : resolveAddresses(url.hostname).then(publicGitAddress);
    void destination.then((hostname) => {
      signal.throwIfAborted();
      const agent = new Agent({ keepAlive: false, ...(proxy ? { proxyEnv: { HTTPS_PROXY: proxy } } : {}) });
      const upstream = request({
        hostname, servername: url.hostname, port: url.port || 443, method, path: url.pathname + url.search,
        headers: { ...headers, Host: url.host, 'User-Agent': 'ShanHe-DevHub/0.1' },
        agent, signal, rejectUnauthorized: true, maxHeaderSize: 16384,
      }, (result) => {
        result.once('close', () => agent.destroy());
        if ((result.statusCode ?? 0) >= 300 && (result.statusCode ?? 0) < 400) {
          result.destroy();
          reject(new GitProviderError('GIT_REDIRECT_DENIED'));
        } else accept(result);
      });
      upstream.once('error', (error) => { agent.destroy(); reject(new GitProviderError(gitHttpsFailure(error))); });
      if (typeof body === 'string') upstream.end(body);
      else if (body) {
        body.once('error', () => upstream.destroy());
        body.pipe(upstream);
      } else upstream.end();
    }).catch((error: unknown) => reject(error instanceof GitProviderError ? error : failure()))
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function validateProviderLink(endpoint: Endpoint, raw: unknown) {
  const url = typeof raw === 'string' ? URL.parse(raw) : null;
  const repository = new URL(endpoint.repositoryUrl);
  if (!url || url.username || url.password || url.origin !== repository.origin ||
      !url.pathname.toLowerCase().startsWith(repository.pathname.toLowerCase() + '/')) {
    throw new GitProviderError('GIT_RESPONSE_INVALID');
  }
  return url.href;
}

export async function boundedGitResponse(message: IncomingMessage, maxBytes = 8 * 1024 ** 2) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of message) {
    const buffer = Buffer.from(part);
    size += buffer.length;
    if (size > maxBytes) { message.destroy(); throw new GitProviderError('GIT_RESPONSE_LIMIT'); }
    parts.push(buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

export interface GitApiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  data: unknown;
}

export type GitApiTransport = (url: URL, method: string, headers: Record<string, string>, body?: string) => Promise<GitApiResponse>;

export const gitApiTransport: GitApiTransport = async (url, method, headers, body) => {
  try {
    const response = await openGitHttps(url, method, headers, body);
    const status = response.statusCode ?? 502;
    if (status >= 400) {
      response.destroy();
      return { status, headers: response.headers, data: null };
    }
    const raw = await boundedGitResponse(response);
    return { status, headers: response.headers, data: raw ? JSON.parse(raw) as unknown : null };
  } catch (error) {
    throw error instanceof GitProviderError ? error : new GitProviderError('GIT_NETWORK_UNAVAILABLE');
  }
};

export function smartGitAuthorization(provider: Endpoint['provider'], token: string) {
  const username = provider === 'github' ? 'x-access-token' : 'oauth2';
  return 'Basic ' + Buffer.from(username + ':' + token).toString('base64');
}

export async function verifyGitWriteAccess(endpoint: Endpoint, token: string) {
  const url = new URL(endpoint.repositoryUrl + '.git/info/refs?service=git-receive-pack');
  const response = await openGitHttps(url, 'GET', { Authorization: smartGitAuthorization(endpoint.provider, token) });
  try {
    if (response.statusCode === 401) throw new GitProviderError('GIT_CREDENTIAL_EXPIRED');
    if (response.statusCode !== 200 ||
        response.headers['content-type']?.split(';', 1)[0] !== 'application/x-git-receive-pack-advertisement') {
      throw new GitProviderError('GIT_PERMISSION_DENIED');
    }
  } finally { response.destroy(); }
}
