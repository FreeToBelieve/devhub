import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyDeliveryCommit, createDeliveryCommit, gitCredentials, inspectCandidate } from '../packages/git-adapter/dist/index.js';
import { openTaskStore } from '../packages/storage/dist/index.js';
import { createServer } from '../apps/hub/dist/server.js';
import { gitDelivery } from '../apps/hub/dist/git-delivery.js';
import type { GitProvider } from '../packages/git-provider/dist/index.js';
import { gitHttpsFailure } from '../packages/git-provider/dist/index.js';
import { gitFetchDiagnostic } from '../packages/codex-adapter/dist/dependency-client.js';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function setup(root: string) {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'DevHub Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
}

const author = { name: 'DevHub Fixture', email: 'fixture@example.invalid' };
const source = 'devhub/candidate-fixture';
const noOperation = async () => undefined;

describe('approved Git candidate tree', () => {
  it('previews Unity and binary changes from an isolated index and commits the exact approved Tree', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-candidate-test-'));
    const root = fixture.path;
    setup(root);
    mkdirSync(join(root, 'Assets'));
    writeFileSync(join(root, 'Assets', 'World.unity'), '%YAML 1.1\nm_Name: Original\n');
    writeFileSync(join(root, 'Assets', 'Moved.prefab'), '%YAML 1.1\nm_Name: Moved\n');
    writeFileSync(join(root, 'Assets', 'Obsolete.txt'), 'obsolete fixture\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Fixture base');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', '-c', source);
    writeFileSync(join(root, 'Assets', 'World.unity'), '%YAML 1.1\nm_Name: New World\n');
    renameSync(join(root, 'Assets', 'Moved.prefab'), join(root, 'Assets', 'MovedTo.prefab'));
    unlinkSync(join(root, 'Assets', 'Obsolete.txt'));
    writeFileSync(join(root, 'Assets', 'MovedTo.prefab.meta'), 'fileFormatVersion: 2\nguid: synthetictest\n');
    const binary = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    writeFileSync(join(root, 'Assets', 'Icon.png'), binary);
    writeFileSync(join(root, 'Assets', 'Huge.txt'), 'synthetic fixture line\n'.repeat(8000));
    git(root, 'add', '--', 'Assets/World.unity');
    const actualIndexBefore = git(root, 'write-tree');
    const preview = await inspectCandidate(root, base);
    expect(preview.candidateFileSummary).toEqual({ added: 3, modified: 1, deleted: 1, renamed: 1, 'type-changed': 0 });
    expect(git(root, 'write-tree')).toBe(actualIndexBefore);
    const byPath = (path: string) => preview.changedFiles.find((file) => file.path === 'Assets/' + path);
    expect(byPath('World.unity')).toMatchObject({ patch: expect.stringContaining('+m_Name: New World') });
    expect(byPath('MovedTo.prefab')).toMatchObject({ previousPath: 'Assets/Moved.prefab', patch: expect.stringContaining('rename from') });
    expect(byPath('Obsolete.txt')).toMatchObject({ patch: expect.stringContaining('-obsolete fixture') });
    expect(byPath('MovedTo.prefab.meta')).toMatchObject({ patch: expect.stringContaining('+guid: synthetictest') });
    expect(byPath('Icon.png')).toMatchObject({ after: { kind: 'binary', mediaType: 'image/png',
      size: binary.length, sha256: createHash('sha256').update(binary).digest('hex') }, patch: null });
    expect(byPath('Huge.txt')).toMatchObject({ patch: null, warnings: ['GIT_TEXT_PREVIEW_LIMIT'] });

    await expect(createDeliveryCommit({ root, branch: source, expectedHead: base, candidateTreeSha: actualIndexBefore,
      author, title: 'Fixture', verify: noOperation, saveCommit() { throw new Error('Unexpected journal'); },
    })).rejects.toThrow('GIT_CANDIDATE_TREE_CHANGED');
    writeFileSync(join(root, 'Assets', 'World.unity'), 'changed after approval\n');
    await expect(createDeliveryCommit({ root, branch: source, expectedHead: base, candidateTreeSha: preview.candidateTreeSha,
      author, title: 'Fixture', verify: noOperation, saveCommit() { throw new Error('Unexpected journal'); },
    })).rejects.toThrow('GIT_CANDIDATE_TREE_CHANGED');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
    writeFileSync(join(root, 'Assets', 'World.unity'), '%YAML 1.1\nm_Name: New World\n');
    let saved = '';
    const commit = await createDeliveryCommit({ root, branch: source, expectedHead: base, candidateTreeSha: preview.candidateTreeSha,
      author, title: 'Fixture', verify: noOperation, saveCommit(sha) { saved = sha; },
    });
    expect(saved).toBe(commit);
    expect(git(root, 'rev-parse', 'HEAD^{tree}')).toBe(preview.candidateTreeSha);
    await expect(applyDeliveryCommit(root, 'refs/heads/' + source, base, commit, actualIndexBefore))
      .rejects.toThrow('GIT_CANDIDATE_TREE_CHANGED');
  }, 40_000);

  it('does not run external filters, textconv or diff drivers and blocks secrets in staged bytes', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-candidate-drivers-'));
    const root = fixture.path;
    setup(root);
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=untrusted diff=untrusted\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Fixture base');
    const head = git(root, 'rev-parse', 'HEAD');
    for (const key of ['filter.untrusted.clean', 'filter.untrusted.process', 'diff.untrusted.command', 'diff.untrusted.textconv']) {
      git(root, 'config', key, 'echo invoked > driver-invoked.txt');
    }
    git(root, 'config', 'filter.untrusted.required', 'true');
    writeFileSync(join(root, 'content.txt'), 'ordinary candidate\n');
    const preview = await inspectCandidate(root, head);
    expect(preview.changedFiles[0]?.patch).toContain('+ordinary candidate');
    expect(() => readFileSync(join(root, 'driver-invoked.txt'))).toThrow();
    writeFileSync(join(root, 'content.txt'), 'prefix\n' + 'synthetic-candidate-secret');
    await expect(inspectCandidate(root, head, 'synthetic-candidate-secret')).rejects.toThrow('WORKSPACE_SECRET_DETECTED');
    const objects = git(root, 'count-objects', '-v');
    expect(objects).toContain('count: 3');
  }, 20_000);

  it('separates Git LFS pointer metadata from resources and blocks materialized LFS payloads', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-candidate-lfs-'));
    setup(fixture.path);
    writeFileSync(join(fixture.path, '.gitattributes'), '*.res filter=lfs diff=lfs\n');
    git(fixture.path, 'add', '.');
    git(fixture.path, 'commit', '-m', 'Fixture base');
    const base = git(fixture.path, 'rev-parse', 'HEAD');
    const resourceSha = 'f'.repeat(64);
    const asset = join(fixture.path, 'asset.res');
    writeFileSync(asset, 'version https://git-lfs.github.com/spec/v1\noid sha256:' + resourceSha + '\nsize 999999\n');
    const pointer = await inspectCandidate(fixture.path, base);
    expect(pointer.canCommit).toBe(true);
    expect(pointer.changedFiles[0]).toMatchObject({ warnings: ['GIT_LFS_POINTER_ONLY'],
      after: { kind: 'lfs-pointer', lfs: { sha256: resourceSha, size: 999999 } }, patch: null });
    writeFileSync(asset, 'materialized fixture');
    const actual = await inspectCandidate(fixture.path, base);
    expect(actual.canCommit).toBe(false);
    expect(actual.changedFiles[0]?.warnings).toContain('GIT_LFS_POINTER_REQUIRED');
  }, 20_000);

  it('labels a Gitlink as a commit pointer without reading or importing submodule files', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-candidate-submodule-'));
    setup(fixture.path);
    git(fixture.path, 'commit', '--allow-empty', '-m', 'Fixture base');
    const base = git(fixture.path, 'rev-parse', 'HEAD');
    const embedded = join(fixture.path, 'Dependency');
    mkdirSync(embedded);
    setup(embedded);
    writeFileSync(join(embedded, 'hidden.txt'), 'synthetic nested source must stay hidden');
    git(embedded, 'add', '.');
    git(embedded, 'commit', '-m', 'Embedded fixture');
    const subHead = git(embedded, 'rev-parse', 'HEAD');
    const preview = await inspectCandidate(fixture.path, base);
    expect(preview.canCommit).toBe(false);
    expect(preview.changedFiles[0]).toMatchObject({ path: 'Dependency', patch: null, warnings: ['GIT_SUBMODULE_POINTER_ONLY'],
      after: { kind: 'submodule', objectSha: subHead, size: null, sha256: null } });
    expect(JSON.stringify(preview)).not.toContain('synthetic nested source');
  }, 20_000);
});

describe('system credential cleanup', () => {
  it.skipIf(process.platform !== 'win32' &&
    (process.platform !== 'darwin' || process.env.DEVHUB_TEST_NATIVE_KEYCHAIN !== '1'))(
    'round-trips and idempotently removes a synthetic native vault item', async () => {
      const manager = await gitCredentials();
      const reference = randomUUID();
      const fixture = 'synthetic-native-vault-fixture';
      try {
        await manager.set(reference, fixture);
        expect(await manager.get(reference) === fixture).toBe(true);
      } finally { await manager.remove(reference); }
      await manager.remove(reference);
      expect(await manager.get(reference)).toBeNull();
    },
  );

  it('retries after vault failures and Hub restart, handles duplicate revoke and missing vault items', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-vault-retry-'));
    const db = join(fixture.path, 'fixture.sqlite');
    let time = 1750000000000;
    let unavailable = false;
    let deleteFails = false;
    const clock = () => time;
    const provider = { async validateConnection() { return {
      remoteId: '42', defaultBranch: 'main', account: 'fixture', canPush: true,
      repositoryUrl: 'https://github.com/fixture-owner/isolated-fixture',
    }; } } as unknown as GitProvider;
    const entries = new Map<string, string>();
    const credential = 'synthetic-never-persist-this-token';
    const deps = {
      credentials: async () => {
        if (unavailable) throw new Error('external error with ' + credential);
        return {
          async get(id: string) { return entries.get(id) ?? null; },
          async set(id: string, token: string) { entries.set(id, token); },
          async remove(id: string) {
            if (deleteFails) throw new Error('external deletion error ' + credential);
            entries.delete(id);
          },
        };
      },
      provider: () => provider,
      transfer: noOperation,
    };
    const projectId = randomUUID();
    const input = { projectId, provider: 'github' as const,
      repositoryUrl: 'https://github.com/fixture-owner/isolated-fixture', token: credential };
    {
      const store = openTaskStore(db, false, clock);
      try {
        const service = gitDelivery(store, deps);
        await service.connect(input, 0, 'fixture');
        const reference = store.git.connection(projectId)?.credentialRef;
        expect(entries.size).toBe(1);
        unavailable = true;
        await service.revoke(projectId, 1, 'fixture');
        await service.revoke(projectId, 1, 'fixture');
        expect(store.git.connection(projectId)).toMatchObject({ credentialRef: null, version: 2 });
        expect(store.git.cleanupStatus(projectId)).toMatchObject([{ attempts: 1, lastErrorCode: 'GIT_VAULT_DELETE_FAILED' }]);
        expect(entries.has(reference!)).toBe(true);
        unavailable = false;
        deleteFails = true;
        time += 1000;
        await service.retryCredentialCleanup();
        expect(store.git.cleanupStatus(projectId)).toMatchObject([{ attempts: 2, lastErrorCode: 'GIT_VAULT_DELETE_FAILED' }]);
      } finally { store.close(); }
    }
    deleteFails = false;
    time += 2000;
    const hub = createServer({ port: 4317, databasePath: db, clock, gitDependencies: deps });
    try {
      await hub.ready();
      expect(entries.size).toBe(0);
    } finally { await hub.close(); }
    const store = openTaskStore(db, false, clock);
    try {
      expect(store.git.cleanupStatus(projectId)).toEqual([]);
      const service = gitDelivery(store, deps);
      await service.connect(input, 2, 'fixture');
      // OS-side manual deletion before revoke behaves the same as a successful delete.
      entries.clear();
      await service.revoke(projectId, 3, 'fixture');
      expect(store.git.cleanupStatus(projectId)).toEqual([]);
      expect(readFileSync(db).includes(credential)).toBe(false);
    } finally { store.close(); }
    const sql = new DatabaseSync(db, { readOnly: true });
    try {
      expect(sql.prepare('SELECT COUNT(*) AS count FROM git_credentials_refs').get()?.count).toBe(0);
    } finally { sql.close(); }
  }, 25_000);
});

describe('safe TLS and dependency Fetch diagnostics', () => {
  it('classifies certificate rejection, TLS errors and IPv6 routing without using raw messages', () => {
    expect(gitHttpsFailure({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'synthetic-secret' })).toBe('GIT_TLS_CERTIFICATE_REJECTED');
    expect(gitHttpsFailure({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).toBe('GIT_TLS_HANDSHAKE_FAILED');
    expect(gitHttpsFailure({ code: 'EHOSTUNREACH' })).toBe('GIT_NETWORK_UNAVAILABLE');
  });

  it('reports fixed categories for untrusted Git stderr', () => {
    expect(gitFetchDiagnostic('fatal: Failed to connect to a synthetic address')).toBe('GIT_FETCH_CONNECTION');
    expect(gitFetchDiagnostic('curl 92 HTTP/2 stream 3 was not closed cleanly: synthetic-secret')).toBe('GIT_FETCH_HTTP2');
    expect(gitFetchDiagnostic('curl 60 SSL certificate problem: synthetic-secret')).toBe('GIT_FETCH_TLS_CERTIFICATE');
    expect(gitFetchDiagnostic('Received HTTP code 407 from proxy after CONNECT')).toBe('GIT_FETCH_PROXY_AUTH');
    expect(gitFetchDiagnostic('synthetic-secret', true)).toBe('GIT_FETCH_TIMEOUT');
  });
});
