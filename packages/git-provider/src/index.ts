import { gitHeadSchema, remoteBranchName } from '@devhub/contracts';
import type { GitBranch, GitChange, GitCheck, GitDiffFile, GitReview } from '@devhub/contracts';
import {
  GitProviderError, gitApiTransport, validateProviderLink, verifyGitWriteAccess,
} from './endpoint.js';
import type { Endpoint, GitApiTransport } from './endpoint.js';
export { GitProviderError, gitHttpsFailure, openGitHttps, providerEndpoint, publicGitAddress, smartGitAuthorization } from './endpoint.js';
export type { Endpoint, GitApiTransport } from './endpoint.js';

export interface RemoteRepository {
  remoteId: string;
  defaultBranch: string;
  repositoryUrl: string;
  canPush: boolean;
}

interface ChangeText { title: string; description: string }
interface OpenChange extends ChangeText { sourceBranch: string; targetBranch: string }

export interface GitProvider {
  validateConnection(): Promise<RemoteRepository & { account: string }>;
  getRepository(): Promise<RemoteRepository>;
  getDefaultBranch(): Promise<string>;
  listBranches(): Promise<GitBranch[]>;
  getBranch(branch: string): Promise<GitBranch | null>;
  findPullRequest(source: string, target: string): Promise<GitChange | null>;
  createPullRequest(change: OpenChange): Promise<GitChange>;
  updatePullRequest(number: number, text: ChangeText): Promise<GitChange>;
  getPullRequest(number: number): Promise<GitChange>;
  getPullRequestDiff(number: number): Promise<GitDiffFile[]>;
  listPullRequestComments(number: number): Promise<GitReview[]>;
  createPullRequestComment(number: number, body: string, key: string): Promise<GitReview>;
  getChecks(change: GitChange): Promise<GitCheck[]>;
  closePullRequest(number: number): Promise<GitChange>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitProviderError('GIT_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitProviderError('GIT_RESPONSE_INVALID');
  return value;
}

function string(value: unknown, maximum = 5000) {
  if (typeof value !== 'string') throw new GitProviderError('GIT_RESPONSE_INVALID');
  return value.slice(0, maximum);
}

function identifier(value: unknown) {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) throw new GitProviderError('GIT_RESPONSE_INVALID');
  return value;
}

export function gitProvider(endpoint: Endpoint, token: string, transport: GitApiTransport = gitApiTransport): GitProvider {
  const github = endpoint.provider === 'github';
  const name = endpoint.projectPath.split('/').map(encodeURIComponent).join('/');
  const repo = github ? '/repos/' + name : '/projects/' + encodeURIComponent(endpoint.projectPath);
  const changes = repo + (github ? '/pulls' : '/merge_requests');
  const changePath = (number: number) => changes + '/' + identifier(number);
  const methodForChange = github ? 'PATCH' : 'PUT';

  async function call(path: string, method = 'GET', input?: object, missing = false) {
    const payload = input === undefined ? undefined : JSON.stringify(input);
    const url = new URL(endpoint.apiBaseUrl + path);
    const headers: Record<string, string> = github
      ? { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      : { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
    if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)) });
    const result = () => transport(url, method, headers, payload);
    let response = await result().catch((error: unknown) => {
      if (method === 'GET' && error instanceof GitProviderError && error.code === 'GIT_NETWORK_UNAVAILABLE') return result();
      throw error;
    });
    if (method === 'GET' && [502, 503, 504].includes(response.status)) response = await result();
    if (missing && response.status === 404) return null;
    if (response.status < 200 || response.status > 299) {
      const code = response.status === 401 ? 'GIT_CREDENTIAL_EXPIRED' :
        response.status === 403 ? 'GIT_PERMISSION_DENIED' :
        response.status === 404 ? 'GIT_REMOTE_NOT_FOUND' :
        response.status === 409 || response.status === 422 ? 'GIT_REMOTE_CONFLICT' : 'GIT_REMOTE_FAILED';
      throw new GitProviderError(code);
    }
    if (JSON.stringify(response.data)?.includes(token)) throw new GitProviderError('GIT_RESPONSE_CONTAINS_CREDENTIAL');
    return response.data;
  }

  async function pages(path: string, params = new URLSearchParams()) {
    const entries: unknown[] = [];
    params.set('per_page', '100');
    for (let page = 1; page <= 10; page++) {
      params.set('page', String(page));
      const batch = list(await call(path + '?' + params));
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
    throw new GitProviderError('GIT_PAGINATION_LIMIT');
  }

  let repository: RemoteRepository | undefined;
  async function getRepository() {
    const row = object(await call(repo));
    const address = string(github ? row.html_url : row.web_url, 512);
    if (address.toLowerCase() !== endpoint.repositoryUrl.toLowerCase()) throw new GitProviderError('GIT_REPOSITORY_MOVED');
    const permissions = row.permissions && typeof row.permissions === 'object' ? object(row.permissions) : {};
    const access = Math.max(Number((permissions.project_access as { access_level?: number } | null)?.access_level ?? 0),
      Number((permissions.group_access as { access_level?: number } | null)?.access_level ?? 0));
    repository = { remoteId: String(identifier(row.id)), repositoryUrl: endpoint.repositoryUrl,
      defaultBranch: remoteBranchName.parse(row.default_branch), canPush: github ? permissions.push === true : access >= 30 };
    return repository;
  }

  function branch(value: unknown): GitBranch {
    const row = object(value);
    return { name: remoteBranchName.parse(row.name), sha: gitHeadSchema.parse(object(row.commit).sha ?? object(row.commit).id),
      protected: row.protected === true };
  }

  function change(value: unknown): GitChange {
    const row = object(value);
    const head = github ? object(row.head) : undefined;
    const base = github ? object(row.base) : undefined;
    const state = row.merged === true || row.merged_at || row.state === 'merged' ? 'merged' :
      row.state === 'open' || row.state === 'opened' ? 'open' : 'closed';
    return { number: identifier(github ? row.number : row.iid), title: string(row.title, 160),
      description: string((github ? row.body : row.description) ?? ''), url: validateProviderLink(endpoint, github ? row.html_url : row.web_url),
      sourceBranch: remoteBranchName.parse(github ? head?.ref : row.source_branch),
      targetBranch: remoteBranchName.parse(github ? base?.ref : row.target_branch),
      headSha: gitHeadSchema.parse(github ? head?.sha : row.sha), state };
  }

  function belongs(value: unknown, remoteId: string) {
    const row = object(value);
    if (github) {
      const head = object(row.head).repo;
      const base = object(row.base).repo;
      return !!head && !!base && String(object(head).id) === remoteId && String(object(base).id) === remoteId;
    }
    return String(row.source_project_id) === remoteId && String(row.target_project_id) === remoteId;
  }

  async function findPullRequest(source: string, target: string) {
    const identity = repository ?? await getRepository();
    const params = github
      ? { head: endpoint.projectPath.split('/')[0] + ':' + source, base: target, state: 'all' }
      : { source_branch: source, target_branch: target, scope: 'all' };
    const found = (await pages(changes, new URLSearchParams(Object.entries(params))))
      .filter((row) => belongs(row, identity.remoteId)).map(change)
      .filter((candidate) => candidate.sourceBranch === source && candidate.targetBranch === target);
    const open = found.filter((candidate) => candidate.state === 'open');
    if (open.length > 1) throw new GitProviderError('GIT_CHANGE_AMBIGUOUS');
    return open[0] ?? found[0] ?? null;
  }

  function review(value: unknown): GitReview {
    const row = object(value);
    const user = object(github ? row.user ?? { login: 'deleted' } : row.author);
    const position = row.position ? object(row.position) : undefined;
    const link = row.html_url ?? row.web_url;
    return { id: String(identifier(row.id)), author: string(user.login ?? user.username, 120),
      body: string(row.body), path: typeof row.path === 'string' ? row.path : typeof position?.new_path === 'string' ? position.new_path : null,
      url: link ? validateProviderLink(endpoint, link) : null };
  }

  const commentPath = (number: number) => github ? repo + '/issues/' + identifier(number) + '/comments' : changePath(number) + '/notes';
  const titleBody = (text: ChangeText) => ({ title: text.title, [github ? 'body' : 'description']: text.description });

  return {
    async validateConnection() {
      const user = object(await call('/user'));
      const repository = await getRepository();
      if (repository.canPush && transport === gitApiTransport) await verifyGitWriteAccess(endpoint, token);
      return { ...repository, account: string(github ? user.login : user.username, 120) };
    },
    getRepository,
    async getDefaultBranch() { return (await getRepository()).defaultBranch; },
    async listBranches() { return (await pages(repo + (github ? '/branches' : '/repository/branches'))).map(branch); },
    async getBranch(ref) {
      const identifier = encodeURIComponent(remoteBranchName.parse(ref));
      const row = await call(repo + (github ? '/branches/' : '/repository/branches/') + identifier, 'GET', undefined, true);
      return row ? branch(row) : null;
    },
    findPullRequest,
    async getPullRequest(number) { return change(await call(changePath(number))); },
    async createPullRequest(input) {
      const existing = await findPullRequest(input.sourceBranch, input.targetBranch);
      if (existing?.state === 'open') return existing;
      if (existing) throw new GitProviderError('GIT_CHANGE_CLOSED');
      try {
        return change(await call(changes, 'POST', { ...titleBody(input),
          ...(github ? { head: input.sourceBranch, base: input.targetBranch } :
            { source_branch: input.sourceBranch, target_branch: input.targetBranch }) }));
      } catch (original) {
        const observed = await findPullRequest(input.sourceBranch, input.targetBranch).catch(() => null);
        if (observed?.state === 'open') return observed;
        throw original;
      }
    },
    async updatePullRequest(number, text) {
      const existing = await this.getPullRequest(number);
      if (existing.state !== 'open') throw new GitProviderError('GIT_CHANGE_CLOSED');
      if (existing.title === text.title && existing.description === text.description) return existing;
      return change(await call(changePath(number), methodForChange, titleBody(text)));
    },
    async closePullRequest(number) {
      const existing = await this.getPullRequest(number);
      if (existing.state !== 'open') return existing;
      return change(await call(changePath(number), methodForChange, github ? { state: 'closed' } : { state_event: 'close' }));
    },
    async getPullRequestDiff(number) {
      return (await pages(changePath(number) + (github ? '/files' : '/diffs'))).map((value) => {
        const row = object(value);
        const patch = github ? row.patch : row.diff;
        return { path: string(github ? row.filename : row.new_path, 1000),
          status: github ? string(row.status, 32) : row.new_file ? 'added' : row.deleted_file ? 'removed' : row.renamed_file ? 'renamed' : 'modified',
          patch: typeof patch === 'string' ? patch.slice(0, 30_000) : null };
      });
    },
    async listPullRequestComments(number) {
      if (github) {
        const sources = await Promise.all([pages(commentPath(number)), pages(changePath(number) + '/comments')]);
        return sources.flat().map(review);
      }
      const discussions = await pages(changePath(number) + '/discussions');
      return discussions.flatMap((entry) => list(object(entry).notes)).map(review);
    },
    async createPullRequestComment(number, body, key) {
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new GitProviderError('GIT_INVALID_IDEMPOTENCY_KEY');
      const marked = body + '\n\n<!-- devhub:' + key + ' -->';
      const lookup = async () => (await pages(commentPath(number))).find((note) => object(note).body === marked);
      const previous = await lookup();
      if (previous) return review(previous);
      try { return review(await call(commentPath(number), 'POST', { body: marked })); }
      catch (error) {
        const observed = await lookup().catch(() => undefined);
        if (observed) return review(observed);
        throw error;
      }
    },
    async getChecks(pull) {
      if (github) {
        const commit = repo + '/commits/' + gitHeadSchema.parse(pull.headSha);
        const [checks, status] = await Promise.all([call(commit + '/check-runs?per_page=100'), call(commit + '/status?per_page=100')]);
        return [...list(object(checks).check_runs).map((value) => {
          const row = object(value);
          return { name: string(row.name, 120), status: string(row.status, 40), conclusion: row.conclusion ? string(row.conclusion, 40) : null };
        }), ...list(object(status).statuses).map((value) => {
          const row = object(value);
          const state = string(row.state, 40);
          return { name: string(row.context, 120), status: state, conclusion: state === 'pending' ? null : state };
        })];
      }
      return (await pages(changePath(pull.number) + '/pipelines')).filter((value) => object(value).sha === pull.headSha)
        .map((value) => {
          const row = object(value);
          const state = string(row.status, 40);
          return { name: 'Pipeline #' + identifier(row.id), status: state,
            conclusion: ['success', 'failed', 'canceled', 'skipped'].includes(state) ? state : null };
        });
    },
  };
}
