import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempDisposableSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { connectPolicy, containsWorkspaceSecret, isWorkspaceSecretPath, startDeveloperConnectProxy } from '../packages/security/dist/index.js';
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

function connectResponse(port: number, authority: string) {
  return new Promise<{ socket: ReturnType<typeof connect>; response: string }>((accept, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () =>
      socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n'));
    socket.once('data', (chunk) => accept({ socket, response: chunk.toString('ascii') }));
    socket.once('error', reject);
    socket.setTimeout(4000, () => socket.destroy(new Error('CONNECT fixture timeout')));
  });
}

describe('dependency CONNECT proxy', () => {
  it('validates each destination and refuses an approved hostname with mixed private DNS answers', async () => {
    const queried: string[] = [];
    const proxy = await startDeveloperConnectProxy(async (host) => {
      queried.push(host);
      return ['1.1.1.1', '127.0.0.1'];
    });
    try {
      for (const target of ['127.0.0.1:443', 'registry.npmjs.org:8443', 'registry.npmjs.org.evil.invalid:443',
        'registry.npmjs.org:443']) {
        const { socket, response } = await connectResponse(proxy.port, target);
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
      const { socket, response } = await connectResponse(proxy.port, 'registry.npmjs.org:443');
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
        const client = await connectResponse(proxy.port, 'registry.npmjs.org:443');
        pending.push(client.socket);
        expect(client.response).toMatch(/^HTTP\/1\.1 200/);
      }
      const excess = await connectResponse(proxy.port, 'registry.npmjs.org:443');
      pending.push(excess.socket);
      expect(excess.response).toMatch(/^HTTP\/1\.1 403/);
      expect(proxy.stats()).toMatchObject({ accepted: 0, denied: 1 });
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
