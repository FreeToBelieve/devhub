import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { Transform } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { McpTunnel } from '@devhub/mcp-contracts';
import { mcpRequestLimit, mcpReviewTimeoutMs } from '@devhub/mcp-contracts';
import { createMcpServer, BridgeError } from './server.js';
import type { HubClient } from './server.js';

export async function startStdio(hub: HubClient, input: Readable, output: Writable, tunnel?: () => Promise<McpTunnel | undefined>) {
  async function checkConnection() {
    await hub.probe('stdio', undefined, await tunnel?.());
  }
  await checkConnection();
  const server = createMcpServer(hub, 'stdio');
  let size = 0;
  // The SDK accepts newline-delimited messages. Bound any unfinished frame before it reaches its buffer.
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      for (const byte of chunk) {
        size = byte === 10 ? 0 : size + 1;
        if (size > mcpRequestLimit) {
          done(new Error('MCP_REQUEST_LIMIT'));
          return;
        }
      }
      done(null, chunk);
    },
  });
  const stop = () => {
    clearInterval(heartbeat);
    input.unpipe(bounded);
    input.pause();
    void server.close();
  };
  const heartbeat = setInterval(() => {
    void checkConnection().catch(stop);
  }, 20_000);
  heartbeat.unref();
  input.once('end', stop);
  input.once('error', stop);
  bounded.once('error', stop);
  await server.connect(new StdioServerTransport(bounded, output));
  input.pipe(bounded);
  return stop;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export async function startHttp(hub: HubClient, credential: string, port: number) {
  await hub.probe('http');
  const token = digest('Bearer ' + credential);
  let active = 0;
  const listener = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, (request, response) => {
    const finish = (code: number) => { response.writeHead(code, { 'Cache-Control': 'no-store' }); response.end(); };
    const authority = listener.address();
    const host = typeof authority === 'object' && authority ? '127.0.0.1:' + authority.port : '';
    const origin = request.headers.origin;
    if (!host || request.headers.host !== host || (origin !== undefined && origin !== 'http://' + host)) return finish(403);
    if (typeof request.headers.authorization !== 'string' || !timingSafeEqual(digest(request.headers.authorization), token)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="DevHub MCP"');
      return finish(401);
    }
    if (active >= 8) return finish(429);
    active++;
    response.once('close', () => { active--; });
    void (async () => {
      // Each HTTP request is stateless and explicitly re-authenticated.
      await hub.probe();
      if (request.url === '/status' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ transport: 'http', protocolVersion: LATEST_PROTOCOL_VERSION }));
        return;
      }
      if (request.url === '/stop' && request.method === 'POST' && origin === undefined) {
        finish(204);
        listener.close();
        return;
      }
      if (request.url !== '/mcp') return finish(404);
      let body: unknown;
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) return finish(415);
        if (Number(request.headers['content-length']) > mcpRequestLimit) return finish(413);
        const chunks: Buffer[] = [];
        let size = 0;
        // Keep the socket available for 413 even when a chunked sender exceeds the limit.
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > mcpRequestLimit) {
            response.setHeader('Connection', 'close');
            return finish(413);
          }
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return finish(400);
      }
      const server = createMcpServer(hub, 'http');
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: mcpRequestLimit });
      response.setHeader('Cache-Control', 'no-store');
      response.once('close', () => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    })().catch((error) => {
      const code = error instanceof BridgeError ? error.code : '';
      if (!response.headersSent) finish(code === 'MCP_RATE_LIMIT' ? 429 :
        ['MCP_UNAUTHENTICATED', 'MCP_PAIRING_INACTIVE'].includes(code) ? 401 : 503);
      else response.end();
    });
  });
  listener.maxConnections = 16;
  listener.setTimeout(mcpReviewTimeoutMs + 2_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  const heartbeat = setInterval(() => { void hub.probe('http').catch(() => listener.close()); }, 20_000);
  heartbeat.unref();
  listener.once('close', () => clearInterval(heartbeat));
  return listener;
}
