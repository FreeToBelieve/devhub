import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempDisposableSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { inspect, promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  codexEnvironment, connectPolicy, containsWorkspaceSecret, isWorkspaceSecretPath, startDeveloperConnectProxy,
} from '../packages/security/dist/index.js';
import { codexConfiguration, codexConfigDigest } from '../packages/codex-adapter/dist/index.js';
import { snapshotWorkspace } from '../apps/hub/dist/workspace-snapshot.js';

describe('worktree secrets', () => {
  it('classifies files without blocking normal Unity assets or explicit templates', () => {
    for (const path of ['Assets/.env', '.env.production', '.ssh/project', 'local/credentials.json',
      'Packages/licensing.pem', 'local/service.KEY', 'id_ed25519']) expect(isWorkspaceSecretPath(path)).toBe(true);
    for (const path of ['.env.example', 'Packages/vendor.pem.template', 'Assets/Main.unity', 'Assets/Main.prefab',
      'Assets/Main.shader.meta', 'Packages/manifest.json', 'ProjectSettings/ProjectSettings.asset']) {
      expect(isWorkspaceSecretPath(path)).toBe(false);
    }
    expect(containsWorkspaceSecret('API_TOKEN=example\nPASSWORD=${TEST_VALUE}', true)).toBe(false);
    expect(containsWorkspaceSecret('API_TOKEN=synthetic-value-for-test', true)).toBe(true);
    expect(containsWorkspaceSecret('//registry.npmjs.org/:_authToken=${FIXTURE}', true, true)).toBe(true);
    expect(containsWorkspaceSecret('registry=https://registry.npmjs.org/', true, true)).toBe(false);
  });

  it('fails closed at workspace inspection without returning any secret content', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-secret-test-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', temporary.path, ...args]);
    git('init', '-q');
    mkdirSync(join(temporary.path, 'Assets'));
    writeFileSync(join(temporary.path, 'Assets', 'Fixture.cs'), 'class Fixture {}');
    writeFileSync(join(temporary.path, '.env.example'), 'AUTH_TOKEN=<placeholder>\n');
    const clean = await snapshotWorkspace(temporary.path, { fresh: true });
    expect(clean.fileCount).toBe(2);
    const privateConfig = join(temporary.path, '.npmrc');
    writeFileSync(privateConfig, '//registry.npmjs.org/:_authToken=synthetic-test-value');
    await expect(snapshotWorkspace(temporary.path)).rejects.toThrow(/^WORKSPACE_SECRET_DETECTED$/);
    unlinkSync(privateConfig);
    const second = join(temporary.path, 'Assets', '.env.local');
    writeFileSync(second, 'synthetic-test-value');
    await expect(snapshotWorkspace(temporary.path)).rejects.toThrow(/^WORKSPACE_SECRET_DETECTED$/);
    unlinkSync(second);
    writeFileSync(join(temporary.path, 'renamed.txt'), '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nsynthetic\n');
    await expect(snapshotWorkspace(temporary.path)).rejects.toThrow(/^WORKSPACE_SECRET_DETECTED$/);
  });
});

function proxyResponse(port: number, request: string) {
  return new Promise<{ socket: ReturnType<typeof connect>; response: string }>((accept, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(request));
    let response = '';
    function receive(chunk: Buffer) {
      response += chunk.toString('ascii');
      if (!response.includes('\r\n\r\n')) return;
      socket.off('data', receive);
      accept({ socket, response });
    }
    socket.on('data', receive);
    socket.once('error', reject);
    socket.setTimeout(4000, () => socket.destroy(new Error('CONNECT fixture timeout')));
  });
}

function connectResponse(port: number, authority: string, ...headers: string[]) {
  return proxyResponse(port, ['CONNECT ' + authority + ' HTTP/1.1', 'Host: ' + authority, ...headers, '', ''].join('\r\n'));
}

function proxyAuthorization(proxy: Awaited<ReturnType<typeof startDeveloperConnectProxy>>) {
  const url = new URL(proxy.clientProxyUrl());
  return 'Proxy-Authorization: Basic ' + Buffer.from(url.username + ':' + url.password).toString('base64');
}

describe('dependency CONNECT proxy', () => {
  it('challenges missing, invalid and ambiguous credentials before DNS or upstream', async () => {
    let resolutions = 0;
    const proxy = await startDeveloperConnectProxy(async () => { resolutions++; return ['1.1.1.1']; });
    try {
      const valid = proxyAuthorization(proxy);
      const incorrect = 'Proxy-Authorization: Basic ' + Buffer.from('devhub:' + 'x'.repeat(43)).toString('base64');
      for (const headers of [[], [incorrect], [valid, incorrect], [valid.replace('Proxy-Authorization', 'Authorization')]]) {
        const { socket, response } = await connectResponse(proxy.port, 'registry.npmjs.org:443', ...headers);
        socket.destroy();
        expect(response).toMatch(/^HTTP\/1\.1 407/);
        expect(response).toContain('Proxy-Authenticate: Basic');
        expect(response.includes(valid.split(' ').at(-1)!)).toBe(false);
      }
      expect(resolutions).toBe(0);
      expect(proxy.stats()).toMatchObject({ authDenied: 4, attempts: 0, accepted: 0, uploaded: 0, downloaded: 0 });
    } finally { await proxy.close(); }
  });

  it('rejects a separate local process that knows the port but has no credentials', async () => {
    let resolutions = 0;
    const proxy = await startDeveloperConnectProxy(async () => { resolutions++; return ['1.1.1.1']; });
    try {
      const local = await promisify(execFile)(process.execPath, ['-e', `
        const { connect } = require('node:net');
        const socket = connect({ host: '127.0.0.1', port: Number(process.argv[1]) }, () => {
          socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\n\\r\\n');
        });
        let response = '';
        socket.on('data', (part) => { response += part; });
        socket.on('end', () => process.stdout.write(response.slice(0, response.indexOf('\\r\\n'))));
      `, String(proxy.port)], { env: { SystemRoot: process.env.SystemRoot }, timeout: 5000 });
      expect(local.stdout).toBe('HTTP/1.1 407 Proxy Authentication Required');
      expect(resolutions).toBe(0);
      expect(proxy.stats()).toMatchObject({ authDenied: 1, accepted: 0 });
    } finally { await proxy.close(); }
  });

  it('rejects ordinary HTTP with and without CONNECT credentials', async () => {
    let resolutions = 0;
    const proxy = await startDeveloperConnectProxy(async () => { resolutions++; return ['1.1.1.1']; });
    try {
      for (const headers of [[], [proxyAuthorization(proxy)]]) {
        const { socket, response } = await proxyResponse(proxy.port, [
          'GET http://registry.npmjs.org/is-number HTTP/1.1', 'Host: registry.npmjs.org',
          ...headers, '', '',
        ].join('\r\n'));
        socket.destroy();
        expect(response).toMatch(/^HTTP\/1\.1 405/);
      }
      expect(resolutions).toBe(0);
      expect(proxy.stats()).toMatchObject({ attempts: 0, accepted: 0 });
    } finally { await proxy.close(); }
  });

  it('revokes credentials on close and rejects their replay against a replacement proxy', async () => {
    const previous = await startDeveloperConnectProxy(async () => ['1.1.1.1']);
    const oldHeader = proxyAuthorization(previous);
    try {
      const live = await connectResponse(previous.port, 'registry.npmjs.org:443', oldHeader);
      expect(live.response).toMatch(/^HTTP\/1\.1 200/);
      live.socket.destroy();
    } finally { await previous.close(); }
    expect(() => previous.clientProxyUrl()).toThrow(/^PROXY_CLOSED$/);
    await expect(connectResponse(previous.port, 'registry.npmjs.org:443', oldHeader))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' });

    const replacement = await startDeveloperConnectProxy(async () => ['1.1.1.1']);
    try {
      expect(proxyAuthorization(replacement) === oldHeader).toBe(false);
      const stale = await connectResponse(replacement.port, 'registry.npmjs.org:443', oldHeader);
      stale.socket.destroy();
      expect(stale.response).toMatch(/^HTTP\/1\.1 407/);
      const current = await connectResponse(replacement.port, 'registry.npmjs.org:443', proxyAuthorization(replacement));
      current.socket.destroy();
      expect(current.response).toMatch(/^HTTP\/1\.1 200/);
    } finally { await replacement.close(); }
  });

  it('keeps the 256-bit credential outside policy, diagnostics and the Codex environment', async () => {
    const before = process.env.HTTPS_PROXY;
    const proxy = await startDeveloperConnectProxy();
    try {
      const url = proxy.clientProxyUrl();
      const secret = new URL(url).password;
      const header = proxyAuthorization(proxy).split(' ').at(-1)!;
      expect(Buffer.from(secret, 'base64url').length).toBe(32);
      const sdk = codexEnvironment({ ...process.env, HTTPS_PROXY: url }, '/profile');
      const diagnostics = inspect({ proxy, stats: proxy.stats(), connectPolicy, sdk });
      expect(diagnostics.includes(secret) || diagnostics.includes(header)).toBe(false);
      expect(process.env.HTTPS_PROXY === before).toBe(true);
    } finally { await proxy.close(); }
  });

  it('authenticates and validates the next CONNECT after a cross-origin redirect', async () => {
    const queried: string[] = [];
    const proxy = await startDeveloperConnectProxy(async (host) => { queried.push(host); return ['1.1.1.1']; });
    try {
      const auth = proxyAuthorization(proxy);
      for (const [host, headers, status] of [
        ['download.packages.unity.com', [auth], 200],
        ['cdn.packages.unity.com', [], 407],
        ['cdn.packages.unity.com', [auth], 200],
        ['example.invalid', [auth], 403],
      ] as const) {
        const { socket, response } = await connectResponse(proxy.port, host + ':443', ...headers);
        socket.destroy();
        expect(response.startsWith('HTTP/1.1 ' + status)).toBe(true);
      }
      expect(queried).toEqual(['download.packages.unity.com', 'cdn.packages.unity.com']);
      expect(proxy.stats()).toMatchObject({ authDenied: 1, authorityDenied: 1, accepted: 0 });
    } finally { await proxy.close(); }
  });

  it('validates each destination and refuses an approved hostname with mixed private DNS answers', async () => {
    const queried: string[] = [];
    const proxy = await startDeveloperConnectProxy(async (host) => {
      queried.push(host);
      return ['1.1.1.1', '127.0.0.1'];
    });
    try {
      for (const target of ['127.0.0.1:443', 'registry.npmjs.org:8443', 'registry.npmjs.org.evil.invalid:443',
        'registry.npmjs.org:443']) {
        const { socket, response } = await connectResponse(proxy.port, target, proxyAuthorization(proxy));
        expect(response).toMatch(/^HTTP\/1\.1 403/);
        socket.destroy();
      }
      expect(queried).toEqual(['registry.npmjs.org']);
      expect(proxy.stats()).toMatchObject({ attempts: 4, denied: 4, accepted: 0 });
    } finally { await proxy.close(); }
  });

  it('requires the actual TLS server name to match the CONNECT authority before opening upstream', async () => {
    const proxy = await startDeveloperConnectProxy(async () => ['1.1.1.1']);
    try {
      const { socket, response } = await connectResponse(proxy.port, 'registry.npmjs.org:443', proxyAuthorization(proxy));
      expect(response).toMatch(/^HTTP\/1\.1 200/);
      const tls = tlsConnect({ socket, servername: 'example.invalid', ALPNProtocols: ['http/1.1'] });
      await new Promise<void>((accept, reject) => {
        tls.once('secureConnect', () => reject(new Error('Mismatched TLS unexpectedly connected')));
        tls.once('error', () => accept());
        tls.once('close', () => accept());
      });
      expect(proxy.stats()).toMatchObject({ attempts: 1, denied: 1, accepted: 0 });
    } finally { await proxy.close(); }
  });

  it('counts pending TLS handshakes against the connection limit', async () => {
    const proxy = await startDeveloperConnectProxy(async () => ['1.1.1.1']);
    const pending: ReturnType<typeof connect>[] = [];
    try {
      for (let i = 0; i < connectPolicy.concurrency; i++) {
        const client = await connectResponse(proxy.port, 'registry.npmjs.org:443', proxyAuthorization(proxy));
        pending.push(client.socket);
        expect(client.response).toMatch(/^HTTP\/1\.1 200/);
      }
      const [excess, unauthorized] = await Promise.all([
        connectResponse(proxy.port, 'registry.npmjs.org:443', proxyAuthorization(proxy)),
        connectResponse(proxy.port, 'registry.npmjs.org:443'),
      ]);
      pending.push(excess.socket, unauthorized.socket);
      expect(excess.response).toMatch(/^HTTP\/1\.1 403/);
      expect(unauthorized.response).toMatch(/^HTTP\/1\.1 407/);
      expect(proxy.stats()).toMatchObject({ accepted: 0, denied: 1, authDenied: 1 });
    } finally {
      for (const socket of pending) socket.destroy();
      await proxy.close();
    }
  });

  it('binds network implementation and limits to a fresh policy digest and fails closed on Windows', () => {
    const profile = codexConfiguration('/fixture', 'darwin', 'DEVELOPER_CONNECT');
    expect(profile.transparentPolicy?.proxy).toMatchObject({ port: 443, bind: '127.0.0.1', concurrency: 6 });
    expect(profile.rawConfigOverrides).toContain('permissions.PROJECT_DEVELOPER.network.enabled=false');
    expect(() => codexConfiguration('/fixture', 'win32', 'DEVELOPER_CONNECT')).toThrow('PROXY_OS_CONTAINMENT_UNAVAILABLE');
    if (process.platform === 'darwin') {
      expect(codexConfigDigest('/fixture', 'OFF')).not.toEqual(codexConfigDigest('/fixture', 'DEVELOPER_CONNECT'));
      expect(codexConfigDigest('/fixture', 'DEVELOPER_ALLOWLIST')).not.toEqual(codexConfigDigest('/fixture', 'DEVELOPER_CONNECT'));
    }
  });
});
