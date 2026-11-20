import { Agent, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

// An explicit direct agent keeps the pairing off every environment-configured proxy.
const direct = new Agent({ keepAlive: true, maxSockets: 8 });

export class ResponseLimitError extends Error {}
export function loopback(port: number, path: string, options: {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; limit: number; signal: AbortSignal;
}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port, path, agent: direct, method: options.method ?? 'GET', signal: options.signal,
      headers: { ...options.headers, ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body) } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.limit) {
          response.destroy(new ResponseLimitError());
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers }));
    });
    call.on('error', reject);
    call.end(options.body);
  });
}
