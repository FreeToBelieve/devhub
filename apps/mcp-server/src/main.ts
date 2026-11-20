import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpTunnel } from '@devhub/mcp-contracts';
import { mcpCredentialSchema, mcpToolNames, mcpWriteToolsEnabled } from '@devhub/mcp-contracts';
import { loopback } from './loopback.js';
import { createHubClient, BridgeError } from './server.js';
import { startHttp, startStdio } from './transports.js';

const [command = 'status', transport = 'http', ...unexpected] = process.argv.slice(2);
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
const proof = mcpCredentialSchema.safeParse(process.env.DEVHUB_MCP_PAIRING);
delete process.env.DEVHUB_MCP_PAIRING;
// Consume only the in-memory pairing from the launching process. The child has no use for the Tunnel key.
delete process.env.CONTROL_PLANE_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_ADMIN_KEY;

function port(value: string | undefined, fallback: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new BridgeError('MCP_INVALID_PORT');
  return parsed;
}

function tunnelVersion() {
  const keys = ['path', 'systemroot', 'windir'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toLowerCase())));
  return new Promise<string | null>((resolve) => {
    execFile('tunnel-client', ['--version'], { timeout: 1500, maxBuffer: 4096, env, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.match(/\bv?\d+\.\d+\.\d+\b/)?.[0] ?? 'installed');
    });
  });
}

async function tunnelStatus(): Promise<McpTunnel | undefined> {
  const id = process.env.CONTROL_PLANE_TUNNEL_ID;
  const health = process.env.DEVHUB_MCP_TUNNEL_HEALTH_PORT;
  if (!id || !/^tunnel_[a-z0-9]{16,80}$/.test(id) || !health) return undefined;
  const result = await loopback(port(health, 4320), '/readyz', {
    limit: 4096, signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  return { id, status: result === null ? 'UNREACHABLE' : result.status === 200 ? 'READY' : 'NOT_READY' };
}

async function stdioDoctor(hubPort: number, credential: string) {
  const client = new Client({ name: 'DevHub Doctor', version: '0.1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(import.meta.url), 'start', 'stdio'], stderr: 'ignore',
      env: { DEVHUB_PORT: String(hubPort), DEVHUB_MCP_PAIRING: credential },
    }), { timeout: 2500 });
    const { tools } = await client.listTools({}, { timeout: 2500 });
    return { state: 'READY', toolCount: tools.length };
  } catch { return { state: 'UNAVAILABLE' }; }
  finally { await client.close(); }
}

async function main() {
  if (unexpected.length || !['http', 'stdio'].includes(transport)) throw new BridgeError('MCP_INVALID_COMMAND');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  delete process.env.DEVHUB_MCP_PAIRING;
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_ADMIN_KEY;
  const hubPort = port(process.env.DEVHUB_PORT, 4317);
  const mcpPort = port(process.env.DEVHUB_MCP_PORT, 4318);
  const origin = `http://127.0.0.1:${mcpPort}`;
  switch (command) {
    case 'tools':
      console.log(JSON.stringify({ tools: mcpToolNames, writeTools: mcpWriteToolsEnabled }, null, 2));
      return;
    case 'pairing':
    case 'revoke':
      console.log(`http://127.0.0.1:${hubPort}/#mcp`);
      return;
    case 'doctor':
    case 'status': {
      const health = await loopback(hubPort, '/api/health', { limit: 4096, signal: AbortSignal.timeout(1000) })
        .then((response) => response.status === 200).catch(() => false);
      const capabilities = proof.success ? await createHubClient(hubPort, proof.data, 1500).probe().catch(() => null) : null;
      const http = proof.success ? await loopback(mcpPort, '/status', {
        limit: 4096, signal: AbortSignal.timeout(1500), headers: { Authorization: 'Bearer ' + proof.data },
      }).then((response) => response.status === 200 ? JSON.parse(response.body) as unknown : null).catch(() => null) : null;
      const stdio = transport === 'stdio' && command === 'doctor' && capabilities && proof.success
        ? await stdioDoctor(hubPort, proof.data) : { state: 'UNVERIFIED' };
      const [clientVersion, tunnel] = await Promise.all([tunnelVersion(), tunnelStatus()]);
      console.log(JSON.stringify({ hub: health ? 'READY' : 'UNAVAILABLE', pairing: capabilities ? 'ACTIVE' : 'UNVERIFIED',
        http, stdio, tunnelClient: clientVersion, tunnel: tunnel ?? null,
        toolCount: capabilities?.tools.length ?? null, projectIds: capabilities?.projectIds ?? [] }, null, 2));
      if (command === 'doctor' && (!health || (proof.success && !capabilities) || stdio.state === 'UNAVAILABLE')) process.exitCode = 1;
      return;
    }
    case 'start': {
      if (!proof.success) throw new BridgeError('MCP_PAIRING_REQUIRED');
      const hub = createHubClient(hubPort, proof.data);
      if (transport === 'stdio') {
        const stop = await startStdio(hub, process.stdin, process.stdout, tunnelStatus);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } else {
        const listener = await startHttp(hub, proof.data, mcpPort);
        const stop = () => listener.close();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.error(origin + '/mcp');
      }
      return;
    }
    case 'stop': {
      if (transport === 'stdio') {
        console.error('Stop the owning stdio client or press Ctrl+C in its terminal.');
        process.exitCode = 2;
        return;
      }
      if (!proof.success) throw new BridgeError('MCP_PAIRING_REQUIRED');
      const response = await loopback(mcpPort, '/stop', { method: 'POST', limit: 4096,
        headers: { Authorization: 'Bearer ' + proof.data }, signal: AbortSignal.timeout(1500) });
      if (response.status !== 204) throw new BridgeError('MCP_STOP_FAILED');
      return;
    }
    default:
      throw new BridgeError('MCP_INVALID_COMMAND');
  }
}

try { await main(); }
catch (error) {
  console.error(error instanceof BridgeError ? error.code : 'MCP_UNAVAILABLE');
  process.exitCode = 1;
}
