import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitChange } from '../packages/contracts/dist/index.js';
import {
  authorizedReceivePack, gitTransport, localGitIdentity,
} from '../packages/git-adapter/dist/index.js';
import {
  gitProvider, GitProviderError, openGitHttps, providerEndpoint, publicGitAddress,
} from '../packages/git-provider/dist/index.js';
import type { GitProvider } from '../packages/git-provider/dist/index.js';
import { openTaskStore } from '../packages/storage/dist/index.js';
import { gitDelivery } from '../apps/hub/dist/git-delivery.js';
import { createServer as createHub } from '../apps/hub/dist/server.js';

const endpoint = providerEndpoint('github', 'https://github.com/fixture-owner/isolated-fixture');
const owner = 'operator-fixture';
const secret = 'synthetic-provider-credential-fixture';
const sha = 'a'.repeat(40);
const branchName = 'devhub/test-delivery';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const init = (root: string) => {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture User');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
};

function fakeProvider(branches: Map<string, string>, desired?: { failCreateOnce?: boolean }): GitProvider {
  let change: GitChange | null = null;
  const repo = { remoteId: '42', defaultBranch: 'main', repositoryUrl: endpoint.repositoryUrl, canPush: true };
  return {
    async getRepository() { return repo; },
    async validateConnection() { return { ...repo, account: 'fixture-user' }; },
    async getDefaultBranch() { return 'main'; },
    async listBranches() { return [...branches].map(([name, sha]) => ({ name, sha, protected: false })); },
    async getBranch(name) {
      const value = branches.get(name);
      return value ? { name, sha: value, protected: false } : null;
    },
    async findPullRequest() { return change; },
    async createPullRequest(input) {
      change ??= {
        ...input, number: 5, url: endpoint.repositoryUrl + '/pull/5',
        state: 'open', headSha: branches.get(input.sourceBranch)!,
      };
      if (desired?.failCreateOnce) {
        desired.failCreateOnce = false;
        throw new GitProviderError('GIT_NETWORK_UNAVAILABLE');
      }
      return change;
    },
    async updatePullRequest(number, text) {
      return change = { ...change!, ...text, number, headSha: branches.get(change!.sourceBranch)! };
    },
    async getPullRequest() { return change!; },
    async getPullRequestDiff() { return []; },
    async listPullRequestComments() { return []; },
    async createPullRequestComment(_number, body) { return { id: '1', author: 'fixture', body, path: null, url: null }; },
    async getChecks() { return []; },
    async closePullRequest() { return change = { ...change!, state: 'closed' }; },
  };
}

describe('Git provider boundaries', () => {
  it('uses a pinned IP for local egress CONNECT without putting credentials in its headers', async () => {
    const proxy = createServer();
    const observed: { address?: string; credentialsPresent?: boolean } = {};
    proxy.on('connect', (incoming, socket) => {
      observed.address = incoming.url;
      observed.credentialsPresent = JSON.stringify(incoming.headers).includes(secret);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((ready) => proxy.listen(0, '127.0.0.1', ready));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('test listener failed');
    vi.stubEnv('DEVHUB_GIT_HTTPS_PROXY', 'http://127.0.0.1:' + address.port);
    try {
      for (const [ip, target] of [['1.1.1.1', '1.1.1.1:9998'], ['2606:4700:4700::1111', '[2606:4700:4700::1111]:9998']] as const) {
        await expect(openGitHttps(new URL('https://gitlab.example.com:9998/test'), 'GET',
          { Authorization: 'Bearer ' + secret }, undefined, undefined, async () => [ip])).rejects.toThrow('GIT_NETWORK_UNAVAILABLE');
        expect(observed).toEqual({ address: target, credentialsPresent: false });
      }
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });

  it('pins the custom GitLab host and rejects non-HTTPS, embedded credentials, IPs and alternate API origins', () => {
    expect(providerEndpoint('gitlab', 'https://gitlab.example.com:9998/base/team/project.git',
      'https://gitlab.example.com:9998/base/api/v4')).toMatchObject({
      projectPath: 'team/project', apiBaseUrl: 'https://gitlab.example.com:9998/base/api/v4',
    });
    for (const target of ['http://gitlab.example.com/team/project', 'https://alice:secret@gitlab.example.com/team/project',
      'https://127.0.0.1/team/project', 'https://gitlab.example.com/team/../project', 'https://gitlab.example.com/team/%2e%2e']) {
      expect(() => providerEndpoint('gitlab', target)).toThrow('GIT_ENDPOINT_DENIED');
    }
    expect(() => providerEndpoint('gitlab', 'https://gitlab.example.com:9998/team/project',
      'https://gitlab.example.com/api/v4')).toThrow('GIT_ENDPOINT_DENIED');
    expect(() => publicGitAddress(['1.1.1.1', '192.168.1.2'])).toThrow('GIT_ADDRESS_DENIED');
    expect(publicGitAddress(['1.1.1.1', '8.8.8.8'])).toBe('1.1.1.1');
    expect(publicGitAddress(['2606:4700:4700::1111'])).toBe('2606:4700:4700::1111');
    for (const address of ['::1', 'fc00::1', 'fe80::1%en0', '::ffff:127.0.0.1', '2001:db8::1', '2002::1', '3fff::1']) {
      expect(() => publicGitAddress(['1.1.1.1', address])).toThrow('GIT_ADDRESS_DENIED');
    }
  });

  it('uses GitLab encoded paths and validates a reflected credential before returning data', async () => {
    const endpoint = providerEndpoint('gitlab', 'https://gitlab.example.com:9998/group/project');
    const requests: string[] = [];
    const provider = gitProvider(endpoint, secret, async (url, method, headers) => {
      requests.push(method + ' ' + url.href);
      expect(headers['PRIVATE-TOKEN'] === secret).toBe(true);
      const data = url.pathname.endsWith('/user') ? { username: 'fixture' } : {
        id: 42, web_url: endpoint.repositoryUrl, default_branch: 'main', permissions: { project_access: { access_level: 30 } },
      };
      return { status: 200, headers: {}, data };
    });
    await expect(provider.validateConnection()).resolves.toMatchObject({ account: 'fixture', remoteId: '42', canPush: true });
    expect(requests).toContain('GET https://gitlab.example.com:9998/api/v4/projects/group%2Fproject');
    const reflected = gitProvider(endpoint, secret, async () => ({ status: 200, headers: {}, data: { username: secret } }));
    await expect(reflected.validateConnection()).rejects.toThrow(/^GIT_RESPONSE_CONTAINS_CREDENTIAL$/);
  });

  it('uses the same GitLab MR for updates and reads diffs, discussions and pipelines', async () => {
    const endpoint = providerEndpoint('gitlab', 'https://gitlab.example.com:9998/group/project');
    let mr: { title: string; state: string; description: string } | undefined;
    const change = () => ({ ...mr, iid: 7, web_url: endpoint.repositoryUrl + '/-/merge_requests/7',
      source_branch: branchName, target_branch: 'main', sha, source_project_id: 42, target_project_id: 42 });
    let posts = 0;
    const provider = gitProvider(endpoint, secret, async (url, method, _headers, body) => {
      const suffix = url.pathname.split('/').at(-1);
      let data: unknown;
      if (suffix === 'group%2Fproject') data = {
        id: 42, web_url: endpoint.repositoryUrl, default_branch: 'main', permissions: { project_access: { access_level: 30 } },
      };
      if (suffix === 'merge_requests') {
        if (method === 'POST') {
          posts++;
          const fields = JSON.parse(body!) as { title: string; description: string };
          mr = { ...fields, state: 'opened' };
          data = change();
        } else data = mr ? [change()] : [];
      }
      if (suffix === '7') {
        if (method === 'PUT') {
          const fields = JSON.parse(body!) as { title?: string; description?: string; state_event?: string };
          mr = { ...mr!, ...fields, state: fields.state_event === 'close' ? 'closed' : 'opened' };
        }
        data = change();
      }
      if (suffix === 'diffs') data = [{ new_path: 'Assets/Test.cs', diff: '+ source' }];
      if (suffix === 'discussions') data = [{ notes: [{ id: 1, author: { username: 'fixture' }, body: 'review' }] }];
      if (suffix === 'pipelines') data = [{ id: 9, sha, status: 'success' }];
      return { status: data === undefined ? 404 : 200, headers: {}, data };
    });
    const input = { sourceBranch: branchName, targetBranch: 'main', title: 'Fixture', description: 'Synthetic' };
    const remote = await provider.createPullRequest(input);
    expect((await provider.createPullRequest(input)).number).toBe(remote.number);
    expect(posts).toBe(1);
    expect((await provider.updatePullRequest(remote.number, { ...input, title: 'Updated' })).title).toBe('Updated');
    expect((await provider.getPullRequestDiff(remote.number))[0]?.path).toBe('Assets/Test.cs');
    expect((await provider.listPullRequestComments(remote.number))[0]?.body).toBe('review');
    expect((await provider.getChecks(remote))[0]?.conclusion).toBe('success');
    expect((await provider.closePullRequest(remote.number)).state).toBe('closed');
    await expect(provider.createPullRequest(input)).rejects.toThrow('GIT_CHANGE_CLOSED');
  });

  it('requires an exact single approved push command', () => {
    const command = { oldSha: '0'.repeat(40), newSha: sha, ref: 'refs/heads/' + branchName };
    const packet = (ref: string, suffix = '0000') => {
      const body = command.oldSha + ' ' + sha + ' ' + ref + '\0 report-status';
      return Buffer.from((body.length + 4).toString(16).padStart(4, '0') + body + suffix);
    };
    expect(authorizedReceivePack(packet(command.ref), command)).toBe(true);
    expect(authorizedReceivePack(packet('refs/heads/main'), command)).toBe(false);
    expect(authorizedReceivePack(packet(command.ref, '0019'), command)).toBe(false);
  });
});

describe('Git delivery', () => {
  it('checks authenticated HTTP route writes with the existing Origin and CSRF policy', async () => {
    const app = createHub({ port: 4317, databasePath: ':memory:' });
    try {
      const bad = await app.inject({ method: 'PUT', url: '/api/git/connections', payload: {},
        headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4318' } });
      expect(bad.statusCode).toBe(403);
      const unauthorized = await app.inject({ url: '/api/git/connections', headers: { host: '127.0.0.1:4317' } });
      expect(unauthorized.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('binds approval, remote, repo and revision, persists the commit, and recovers an ambiguous PR write', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-fixture-delivery-'));
    const repository = join(fixture.path, 'source');
    mkdirSync(repository);
    init(repository);
    const file = join(repository, 'fixture.txt');
    writeFileSync(file, 'base');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'base');
    git(repository, 'remote', 'add', 'origin', endpoint.repositoryUrl + '.git');
    const branches = new Map([['main', git(repository, 'rev-parse', 'HEAD')]]);
    const vault = new Map<string, string>();
    const db = join(fixture.path, 'data', 'fixture.sqlite');
    const store = openTaskStore(db, true);
    const storage = { async get(id: string) { return vault.get(id) ?? null; }, async set(id: string, token: string) { vault.set(id, token); },
      async remove(id: string) { vault.delete(id); } };
    const provider = fakeProvider(branches, { failCreateOnce: true });
    let pushes = 0;
    const service = gitDelivery(store, { credentials: async () => storage, provider: () => provider, transfer: async ({ operation }) => {
      if (operation.kind !== 'push') throw new Error('test expected push');
      pushes++;
      branches.set(operation.branch, operation.sha);
    } });
    try {
      const projectId = randomUUID();
      const connection = { projectId, provider: 'github' as const, repositoryUrl: endpoint.repositoryUrl, token: secret };
      await service.connect(connection, 0, owner);
      const tree = await service.prepare(projectId, repository, join(fixture.path, 'trees'), branchName, owner);
      const task = store.create({ title: 'fixture', description: '', targetPlatform: 'BOTH' });
      const input = {
        taskId: task.id, worktreeId: tree.worktreeId, branch: branchName, title: 'Isolated delivery',
        description: 'Fixture', author: { name: 'Fixture', email: 'fixture@example.invalid' },
      };
      writeFileSync(join(tree.root, 'fixture.txt'), secret);
      await expect(service.preview(projectId, input, owner, randomUUID())).rejects.toThrow(/^WORKSPACE_SECRET_DETECTED$/);
      writeFileSync(join(tree.root, 'fixture.txt'), 'changed');
      const stale = (await service.preview(projectId, input, owner, randomUUID())).operation;
      const staleApproval = store.git.approve(stale.id, { expectedVersion: stale.version, digest: stale.digest }, owner);
      store.revise(task.id, task.revision, { title: 'revised fixture', description: '', targetPlatform: 'BOTH' });
      await expect(service.execute(stale.id, { expectedVersion: staleApproval.version, digest: stale.digest }, owner))
        .rejects.toThrow('GIT_WORKTREE_CHANGED');
      expect(pushes).toBe(0);
      const { operation } = await service.preview(projectId, input, owner, randomUUID());
      const approve = (version: number) => ({ expectedVersion: version, digest: operation.digest });
      await expect(service.execute(operation.id, approve(1), owner)).rejects.toThrow('GIT_APPROVAL_REQUIRED');
      store.git.approve(operation.id, approve(1), owner);
      await expect(service.execute(operation.id, approve(2), 'other')).rejects.toThrow('GIT_APPROVAL_REQUIRED');
      git(tree.root, 'remote', 'set-url', 'origin', 'https://github.com/fixture-owner/another-fixture');
      await expect(service.execute(operation.id, approve(2), owner)).rejects.toThrow('GIT_REMOTE_CHANGED');
      git(tree.root, 'remote', 'set-url', 'origin', endpoint.repositoryUrl + '.git');
      store.git.approve(operation.id, approve(2), owner);
      await expect(service.execute(operation.id, approve(3), owner)).rejects.toThrow('GIT_NETWORK_UNAVAILABLE');
      const interrupted = store.git.operation(operation.id)!;
      expect(interrupted.phase).toBe('PUSHED');
      expect(pushes).toBe(1);
      expect((await localGitIdentity(tree.root)).head).toBe(interrupted.commitSha);
      store.git.approve(operation.id, approve(3), owner);
      expect(await service.execute(operation.id, approve(4), owner)).toMatchObject({ phase: 'DELIVERED', changeNumber: 5 });
      expect(await service.execute(operation.id, approve(4), owner)).toMatchObject({ phase: 'DELIVERED', changeNumber: 5 });
      expect(pushes).toBe(1);
      expect(git(repository, 'rev-parse', 'HEAD')).toBe(branches.get('main'));
      expect(readFileSync(db).includes(secret)).toBe(false);
      expect(JSON.stringify(store.git.events(projectId)).includes(secret)).toBe(false);
      expect(store.git.connections()[0]).not.toHaveProperty('credentialRef');
      await service.revoke(projectId, 1, owner);
      expect(vault.size).toBe(0);
    } finally { store.close(); }
  }, 35_000);

  it('pushes and fetches independently through a synthetic Git smart HTTP fixture', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-fixture-transport-'));
    init(fixture.path);
    const remote = join(fixture.path, 'fixture.git');
    git(fixture.path, 'init', '--bare', remote);
    git(remote, 'config', 'http.receivepack', 'true');
    writeFileSync(join(fixture.path, 'component.txt'), 'safe fixture');
    git(fixture.path, 'add', 'component.txt');
    git(fixture.path, 'commit', '-m', 'Fixture transport');
    const head = git(fixture.path, 'rev-parse', 'HEAD');

    const fixtureServer = createServer((incoming, response) => {
      void (async () => {
        const url = new URL(incoming.url!, 'http://test.invalid');
        const data: Buffer[] = [];
        for await (const chunk of incoming) data.push(Buffer.from(chunk));
        const body = Buffer.concat(data);
        const result = execFileSync('git', ['http-backend'], {
          env: { ...process.env, GIT_PROJECT_ROOT: fixture.path, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'fixture',
            PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: incoming.method,
            CONTENT_TYPE: incoming.headers['content-type'], CONTENT_LENGTH: String(body.length),
            HTTP_GIT_PROTOCOL: typeof incoming.headers['git-protocol'] === 'string' ? incoming.headers['git-protocol'] : undefined },
          input: body, stdio: ['pipe', 'pipe', 'pipe'],
        });
        const end = result.indexOf('\r\n\r\n');
        if (end === -1) throw new Error('CGI fixture returned invalid headers');
        const headers = Object.fromEntries(result.subarray(0, end).toString('ascii').split('\r\n')
          .map((line) => [line.split(':')[0]!, line.slice(line.indexOf(':') + 1).trim()]));
        response.writeHead(Number(headers.Status?.slice(0, 3) ?? 200), headers).end(result.subarray(end + 4));
      })().catch(() => { response.writeHead(500).end(); });
    });
    await new Promise<void>((ready) => fixtureServer.listen(0, '127.0.0.1', ready));
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('test listener failed');
    const connect: Parameters<typeof gitTransport>[1] = (url, method, headers, body, signal) => new Promise((resolve, reject) => {
      expect(headers.Authorization?.startsWith('Basic ')).toBe(true);
      expect(url.origin).toBe('https://github.com');
      const path = '/fixture.git' + url.pathname.slice(url.pathname.lastIndexOf('.git') + 4) + url.search;
      const outbound = request({ hostname: '127.0.0.1', port: address.port, method, path, headers, signal }, resolve);
      outbound.on('error', reject);
      if (typeof body === 'string') outbound.end(body);
      else if (body) body.pipe(outbound);
      else outbound.end();
    });
    try {
      await gitTransport({ root: fixture.path, endpoint, token: secret,
        operation: { kind: 'push', branch: branchName, sha: head, remoteSha: null } }, connect);
      expect(git(remote, 'rev-parse', 'refs/heads/' + branchName)).toBe(head);
      await gitTransport({ root: fixture.path, endpoint, token: secret, operation: { kind: 'fetch', branch: branchName } }, connect);
      expect(git(fixture.path, 'rev-parse', 'FETCH_HEAD')).toBe(head);
    } finally {
      fixtureServer.closeAllConnections();
      await new Promise<void>((done) => fixtureServer.close(() => done()));
    }
  }, 30_000);
});
