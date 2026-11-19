import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import type { Socket } from 'node:net';
import { Transform } from 'node:stream';
import { developerDomains, isPublicDeveloperAddress } from './developer-network.js';

export const connectPolicy = Object.freeze({
  version: 2, bind: '127.0.0.1', port: 443, protocol: 'CONNECT-TLS-SNI',
  authentication: 'per-instance Basic with a 256-bit secret',
  http2: 'single-origin Git client with redirects disabled',
  domains: developerDomains, concurrency: 6, attempts: 80,
  uploadBytes: 8 * 1024 ** 2, downloadBytes: 128 * 1024 ** 2, connectMs: 7000, idleMs: 20_000, tunnelMs: 90_000,
});

const proxyUser = 'devhub';
const authenticate = 'HTTP/1.1 407 Proxy Authentication Required\r\n' +
  'Proxy-Authenticate: Basic realm="DevHub dependency proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

function tunnelHost(authority: string) {
  const match = /^([a-z0-9.-]+):443$/i.exec(authority);
  const hostname = match?.[1]?.toLowerCase();
  return hostname && connectPolicy.domains.includes(hostname) ? hostname : undefined;
}

// undefined means more bytes are needed. null means the TLS preface is disallowed.
function clientHelloName(input: Buffer, allowHttp2: boolean): string | null | undefined {
  const fragments: Buffer[] = [];
  let payloadBytes = 0;
  let cursor = 0;
  while (cursor + 5 <= input.length) {
    const size = input.readUInt16BE(cursor + 3);
    if (input[cursor] !== 22 || input[cursor + 1] !== 3 || size === 0 || size > 16_384) return null;
    if (cursor + 5 + size > input.length) return undefined;
    fragments.push(input.subarray(cursor + 5, cursor + 5 + size));
    payloadBytes += size;
    cursor += 5 + size;
    if (payloadBytes < 4) continue;
    const hello = Buffer.concat(fragments, payloadBytes);
    if (hello[0] !== 1) return null;
    const length = hello.readUIntBE(1, 3) + 4;
    if (length > 32_768) return null;
    if (hello.length >= length) {
      try {
        let position = 38;
        position += 1 + hello.readUInt8(position); // session ID
        position += 2 + hello.readUInt16BE(position); // cipher suites
        position += 1 + hello.readUInt8(position); // compression methods
        const end = position + 2 + hello.readUInt16BE(position);
        if (end !== length) return null;
        position += 2;
        let name: string | null = null;
        while (position + 4 <= end) {
          const type = hello.readUInt16BE(position);
          const size = hello.readUInt16BE(position + 2);
          position += 4;
          if (position + size > end || type === 0xfe0d) return null;
          const item = hello.subarray(position, position + size);
          position += size;
          if (type === 0) {
            if (name !== null || item.length < 6 || item.readUInt16BE(0) !== item.length - 2 ||
                item[2] !== 0 || item.readUInt16BE(3) !== item.length - 5) return null;
            name = item.subarray(5).toString('ascii').toLowerCase();
            if (!/^[a-z0-9.-]+$/.test(name)) return null;
          } else if (type === 16) {
            if (item.length < 3 || item.readUInt16BE(0) !== item.length - 2) return null;
            let at = 2;
            while (at < item.length) {
              const size = item[at++]!;
              if (!size || at + size > item.length) return null;
              const protocol = item.subarray(at, at + size).toString('ascii');
              if (protocol !== 'http/1.1' && protocol !== 'http/1.0' && !(allowHttp2 && protocol === 'h2')) return null;
              at += size;
            }
          }
        }
        return position === end ? name : null;
      } catch {
        return null;
      }
    }
  }
  return undefined;
}

export async function startDeveloperConnectProxy(
  resolve: (hostname: string) => Promise<readonly string[]> =
    async (hostname) => (await lookup(hostname, { all: true, family: 4 })).map((answer) => answer.address),
  singleGitOrigin = false,
) {
  const secret = randomBytes(32);
  const expected = Buffer.from(Buffer.from(proxyUser + ':' + secret.toString('base64url')).toString('base64'), 'ascii');
  let closing: Promise<void> | undefined;

  function authenticated(headers: readonly string[] | undefined) {
    const encoded = headers?.length === 1 ? /^Basic +([A-Za-z0-9+/=]+)$/i.exec(headers[0] ?? '')?.[1] : undefined;
    return !closing && encoded !== undefined && encoded.length === expected.length &&
      timingSafeEqual(Buffer.from(encoded, 'ascii'), expected);
  }

  function invalidate() {
    secret.fill(0);
    expected.fill(0);
  }

  let inFlight = 0;
  const stats = { attempts: 0, accepted: 0, denied: 0, authDenied: 0, authorityDenied: 0, addressDenied: 0, tlsDenied: 0,
    upstreamConnectErrors: 0, upstreamConnectTimeouts: 0, uploaded: 0, downloaded: 0 };
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 4096, headersTimeout: 5000 }, (_request, response) => {
    response.writeHead(405, { Connection: 'close' }).end();
  });
  server.maxConnections = 24;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(connectPolicy.connectMs, () => socket.destroy());
    socket.on('error', () => undefined);
  });
  server.on('connect', (request, stream, head) => {
    const client = stream as Socket;
    if (!authenticated(request.headersDistinct['proxy-authorization'])) {
      stats.authDenied++;
      client.end(authenticate);
      return;
    }
    const hostname = tunnelHost(request.url ?? '');
    const reportedHost = request.headers.host?.toLowerCase();
    if (++stats.attempts > connectPolicy.attempts || !hostname || (singleGitOrigin && hostname !== 'github.com') ||
        inFlight >= connectPolicy.concurrency ||
        (reportedHost !== undefined && reportedHost !== hostname && reportedHost !== hostname + ':443')) {
      stats.denied++;
      stats.authorityDenied++;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    inFlight++;
    let upstream: Socket | undefined;
    const deadline = setTimeout(() => client.destroy(), connectPolicy.tunnelMs);
    client.once('close', () => {
      clearTimeout(deadline);
      inFlight--;
      upstream?.destroy();
    });
    client.pause();
    void resolve(hostname).then((addresses) => {
      if (client.destroyed) return;
      const address = addresses[0];
      if (!address || addresses.some((value) => !isPublicDeveloperAddress(value))) {
        stats.denied++;
        stats.addressDenied++;
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let preface = head;
      let readingPreface = true;
      function handshake(chunk?: Buffer) {
        if (chunk) preface = Buffer.concat([preface, chunk]);
        const name = preface.length > 36_864 ? null : clientHelloName(preface, singleGitOrigin);
        if (name === undefined) return;
        readingPreface = false;
        client.off('data', handshake);
        if (name !== hostname) {
          stats.denied++;
          stats.tlsDenied++;
          client.destroy();
          return;
        }
        client.pause();
        upstream = createConnection({ host: address!, port: 443, family: 4 });
        let connected = false;
        upstream.setTimeout(connectPolicy.connectMs, () => {
          if (!connected) stats.upstreamConnectTimeouts++;
          upstream?.destroy();
        });
        upstream.on('error', () => {
          if (!connected) stats.upstreamConnectErrors++;
          client.destroy();
        });
        upstream.once('close', () => { if (!upstream?.readableEnded) client.destroy(); });
        upstream.once('connect', () => {
          if (client.destroyed || !upstream) return;
          connected = true;
          stats.accepted++;
          client.setTimeout(connectPolicy.idleMs);
          upstream.setTimeout(connectPolicy.idleMs);
          const quota = (key: 'uploaded' | 'downloaded', maximum: number) => new Transform({
            transform(chunk: Buffer, _encoding, next) {
              stats[key] += chunk.length;
              if (stats[key] > maximum) {
                client.destroy();
                upstream?.destroy();
                next();
              } else next(null, chunk);
            },
          });
          stats.uploaded += preface.length;
          if (stats.uploaded > connectPolicy.uploadBytes) { client.destroy(); return; }
          upstream.write(preface);
          preface = Buffer.alloc(0);
          client.pipe(quota('uploaded', connectPolicy.uploadBytes)).pipe(upstream);
          upstream.pipe(quota('downloaded', connectPolicy.downloadBytes)).pipe(client);
        });
      }
      client.on('data', handshake);
      handshake();
      if (readingPreface) client.resume();
    }).catch(() => {
      if (client.destroyed) return;
      stats.denied++;
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, connectPolicy.bind, () => { server.off('error', reject); accept(); });
    });
  } catch {
    invalidate();
    throw new Error('PROXY_LISTENER_UNAVAILABLE');
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROXY_LISTENER_UNAVAILABLE');
  // Seatbelt's local endpoint rule covers IPv6 localhost too. Reserve it without serving tunnels.
  const ipv6 = createSocketServer((socket) => socket.destroy());
  try {
    await new Promise<void>((accept, reject) => {
      ipv6.once('error', reject);
      ipv6.listen({ port: address.port, host: '::1', ipv6Only: true }, () => {
        ipv6.off('error', reject);
        accept();
      });
    });
  } catch (error) {
    if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      invalidate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept) => server.close(() => accept()));
      throw new Error('PROXY_LISTENER_UNAVAILABLE');
    }
  }
  return {
    port: address.port,
    clientProxyUrl() {
      if (closing) throw new Error('PROXY_CLOSED');
      return 'http://' + proxyUser + ':' + secret.toString('base64url') + '@' + connectPolicy.bind + ':' + address.port;
    },
    stats: () => ({ ...stats }),
    close() {
      closing ??= (async () => {
        invalidate();
        const stopped = new Promise<void>((accept) => server.close(() => accept()));
        for (const socket of sockets) socket.destroy();
        if (ipv6.listening) await new Promise<void>((accept) => ipv6.close(() => accept()));
        await stopped;
      })();
      return closing;
    },
  };
}
