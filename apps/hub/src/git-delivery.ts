import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitChange, GitCheck, GitDiffFile, GitReview, GitDeliveryBinding, GitDeliveryInput, GitOperation, GitProjectInput } from '@devhub/contracts';
import {
  applyDeliveryCommit, checkLocalGitRemote, createDeliveryCommit, gitCredentials, gitTransport,
  inspectCandidate, localGitIdentity, prepareDeliveryBranch,
} from '@devhub/git-adapter';
import type { GitCredentialManager } from '@devhub/git-adapter';
import { gitProvider, GitProviderError, providerEndpoint } from '@devhub/git-provider';
import { containsWorkspaceSecret, sha256 } from '@devhub/security';
import { GitStateError, projectContextDigest, taskSpecDigest } from '@devhub/storage';
import type { TaskStore } from '@devhub/storage';
import { createCodexWorktree, inspectCodexWorktree } from './codex-worktree.js';
import { projectWorkspace } from './project-context.js';

type ChangeReads = { change: GitChange; diff: GitDiffFile[]; reviews: GitReview[]; checks: GitCheck[] };

interface Dependencies {
  credentials: () => Promise<GitCredentialManager>;
  provider: typeof gitProvider;
  transfer: typeof gitTransport;
}

const defaults: Dependencies = { credentials: gitCredentials, provider: gitProvider, transfer: gitTransport };

export function safeGitError(error: unknown) {
  if (error instanceof GitStateError || error instanceof GitProviderError) return error.code;
  if (error instanceof Error && (/^WORKSPACE_(?:SECRET|SNAPSHOT)_[A-Z_]+$/.test(error.message) ||
    error.message === 'GIT_SUBMODULE_WORKTREE_UNSUPPORTED')) return error.message;
  return 'GIT_OPERATION_FAILED';
}

export function gitDelivery(tasks: TaskStore, dependencies: Dependencies = defaults) {
  const store = tasks.git;
  const fail = (code: string): never => { throw new GitStateError(code); };
  let draining: Promise<void> | undefined;

  function retryCredentialCleanup() {
    draining ??= (async () => {
      const owner = randomUUID();
      for (let count = 0; count < 32; count++) {
        const job = store.claimCleanup(owner);
        if (!job) break;
        try {
          await (await dependencies.credentials()).remove(job.reference);
        } catch {
          store.finishCleanup(job.reference, owner, 'GIT_VAULT_DELETE_FAILED');
          continue;
        }
        store.finishCleanup(job.reference, owner, null);
      }
    })().finally(() => { draining = undefined; });
    return draining;
  }

  async function credential(projectId: string) {
    const connection = store.connection(projectId);
    if (!connection?.credentialRef) throw new GitStateError('GIT_CONNECTION_REQUIRED');
    const vault = await dependencies.credentials();
    const token = await vault.get(connection.credentialRef);
    if (!token) throw new GitStateError('GIT_CREDENTIAL_MISSING');
    const endpoint = providerEndpoint(connection.provider, connection.repositoryUrl, connection.apiBaseUrl);
    const provider = dependencies.provider(endpoint, token);
    const repository = await provider.getRepository();
    if (repository.remoteId !== connection.remoteId || repository.defaultBranch !== connection.defaultBranch) {
      fail('GIT_REMOTE_CHANGED');
    }
    return { connection, token, endpoint, provider, repository };
  }

  function checkConnection(projectId: string, version: number) {
    if (store.connection(projectId)?.version !== version) fail('GIT_CONNECTION_CHANGED');
  }

  async function inspect(projectId: string, binding: Pick<GitDeliveryInput, 'worktreeId' | 'taskId' | 'branch'>, token: string) {
    const project = tasks.projects.require(projectId, true);
    const worktree = tasks.execution.getWorktree(binding.worktreeId, projectId);
    const task = tasks.get(binding.taskId, projectId);
    if (!worktree || !tasks.codex.manages(worktree.worktreeId) || !task) throw new GitStateError('GIT_WORKTREE_REQUIRED');
    const live = await inspectCodexWorktree(worktree.root, 'OFF', true, token, project);
    const git = await localGitIdentity(live.root);
    if (live.repoId !== worktree.repoId || live.worktreeId !== worktree.worktreeId || live.baseHeadSha !== git.head ||
        (git.ref && git.ref !== 'refs/heads/' + binding.branch)) fail('GIT_WORKTREE_CHANGED');
    return { ...live, ...git, task, project };
  }

  function checkText(text: string, token: string) {
    if (text.includes(token) || containsWorkspaceSecret(text)) fail('WORKSPACE_SECRET_DETECTED');
  }

  async function connect(input: GitProjectInput, expectedVersion: number, actor: string) {
    const project = tasks.projects.require(input.projectId, true);
    const endpoint = providerEndpoint(input.provider, input.repositoryUrl, input.apiBaseUrl);
    if (project.repositoryRoot) await checkLocalGitRemote(project.repositoryRoot, endpoint);
    const remote = await dependencies.provider(endpoint, input.token).validateConnection();
    if (!remote.canPush) fail('GIT_PERMISSION_DENIED');
    const vault = await dependencies.credentials();
    const reference = randomUUID();
    store.reserveCredential(input.projectId, reference);
    try {
      await vault.set(reference, input.token);
      store.connect({ projectId: input.projectId, provider: endpoint.provider,
        repositoryUrl: endpoint.repositoryUrl, apiBaseUrl: endpoint.apiBaseUrl, remoteId: remote.remoteId,
        account: remote.account, defaultBranch: remote.defaultBranch, credentialRef: reference }, expectedVersion, actor);
    } catch (error) {
      store.queueCleanup(reference);
      await retryCredentialCleanup();
      throw error;
    }
    await retryCredentialCleanup();
    return store.connections().find((connection) => connection.projectId === input.projectId)!;
  }

  async function prepare(projectId: string, repositoryRoot: string, targetDirectory: string, branch: string, actor: string) {
    const project = tasks.projects.require(projectId, true, true);
    if (await realpath(repositoryRoot) !== project.repositoryRoot) fail('GIT_PROJECT_SCOPE_MISMATCH');
    const context = await credential(projectId);
    const base = await context.provider.getBranch(context.connection.defaultBranch);
    if (!base || branch === base.name || await context.provider.getBranch(branch)) fail('GIT_BRANCH_PROTECTED');
    await checkLocalGitRemote(repositoryRoot, context.endpoint);
    const current = await localGitIdentity(repositoryRoot);
    if (current.head !== base?.sha) fail('GIT_HEAD_CHANGED');
    checkConnection(projectId, context.connection.version);
    const worktree = await createCodexWorktree(repositoryRoot, join(targetDirectory, projectId), project);
    await projectWorkspace(project, worktree.root);
    if (worktree.baseHeadSha !== current.head) fail('GIT_HEAD_CHANGED');
    await prepareDeliveryBranch(worktree.root, branch, current.head);
    const registered = tasks.execution.registerWorktree(worktree, projectId);
    tasks.codex.manage(worktree.worktreeId);
    store.audit(projectId, null, actor, 'WORKTREE_CREATED');
    return registered;
  }

  async function preview(projectId: string, input: GitDeliveryInput, actor: string, operationId: string) {
    if (!tasks.get(input.taskId, projectId) || !tasks.execution.getWorktree(input.worktreeId, projectId)) fail('GIT_PROJECT_SCOPE_MISMATCH');
    if (store.busy(input.worktreeId)) fail('GIT_WORKTREE_BUSY');
    const context = await credential(projectId);
    checkText([input.title, input.description, input.author.name, input.author.email].join('\n'), context.token);
    const worktree = await inspect(projectId, input, context.token);
    await checkLocalGitRemote(worktree.root, context.endpoint);
    if (!context.repository.canPush || input.branch === context.connection.defaultBranch) fail('GIT_BRANCH_PROTECTED');
    const target = await context.provider.getBranch(input.branch);
    if (target?.protected) fail('GIT_BRANCH_PROTECTED');
    const base = target ?? await context.provider.getBranch(context.connection.defaultBranch);
    if (base?.sha !== worktree.head) fail('GIT_HEAD_CHANGED');
    const existing = await context.provider.findPullRequest(input.branch, context.connection.defaultBranch);
    if (existing && existing.state !== 'open') fail('GIT_CHANGE_CLOSED');
    const candidate = { ...await inspectCandidate(worktree.root, worktree.head, context.token),
      workspaceSha256: worktree.workspaceSha256 };
    const subdirectory = worktree.project.unityProjectPath;
    if (subdirectory && subdirectory !== '.' && candidate.changedFiles.some(({ path, previousPath }) =>
      !path.startsWith(subdirectory + '/') || (previousPath && !previousPath.startsWith(subdirectory + '/')))) {
      fail('GIT_PROJECT_SCOPE_MISMATCH');
    }
    const summary = { changes: candidate.changedFiles.map(({ path }) => path), diff: '', candidate };
    const live = await inspect(projectId, input, context.token);
    if (live.head !== worktree.head || live.workspaceSha256 !== worktree.workspaceSha256 ||
        live.task.revision !== worktree.task.revision) fail('GIT_WORKTREE_CHANGED');
    checkConnection(projectId, context.connection.version);
    const binding: GitDeliveryBinding = {
      ...input, projectId, connectionVersion: context.connection.version, targetBranch: context.connection.defaultBranch,
      worktreeRoot: worktree.root, repoId: worktree.repoId, head: worktree.head, workspaceSha256: worktree.workspaceSha256,
      taskRevision: worktree.task.revision, taskSpecSha256: taskSpecDigest(worktree.task), remoteHead: target?.sha ?? null,
      candidateTreeSha: candidate.candidateTreeSha, candidateDiffDigest: candidate.candidateDiffDigest,
      ...(worktree.project.repositoryRoot ? { projectContextSha256: projectContextDigest(worktree.project) } : {}),
    };
    return { operation: store.preview(binding, summary, sha256(JSON.stringify({ binding, summary })), actor, operationId), ...summary };
  }

  async function apply(operation: GitOperation, actor: string, owner: string) {
    const { id, projectId, binding } = operation;
    const candidateTreeSha = binding.candidateTreeSha;
    if (!candidateTreeSha || !operation.summary.candidate?.canCommit) throw new GitStateError('GIT_CANDIDATE_REVIEW_REQUIRED');
    let phase = operation.phase;
    const context = await credential(projectId);
    checkConnection(projectId, binding.connectionVersion);
    if (!context.repository.canPush || binding.branch === context.connection.defaultBranch ||
        binding.targetBranch !== context.connection.defaultBranch) fail('GIT_BRANCH_PROTECTED');
    async function verify(expected: readonly string[]) {
      checkConnection(projectId, binding.connectionVersion);
      const live = await inspect(projectId, binding, context.token);
      if (live.root !== binding.worktreeRoot || live.repoId !== binding.repoId ||
          live.workspaceSha256 !== binding.workspaceSha256 || !expected.includes(live.head) ||
          live.task.revision !== binding.taskRevision || taskSpecDigest(live.task) !== binding.taskSpecSha256) {
        fail('GIT_WORKTREE_CHANGED');
      }
      await checkLocalGitRemote(live.root, context.endpoint);
    }
    await verify(operation.commitSha ? [binding.head, operation.commitSha] : [binding.head]);
    const existing = await context.provider.findPullRequest(binding.branch, binding.targetBranch);
    if (existing && existing.state !== 'open') fail('GIT_CHANGE_CLOSED');
    const target = await context.provider.getBranch(binding.branch);
    if (target?.protected || (target?.sha ?? null) !== binding.remoteHead && target?.sha !== operation.commitSha) {
      fail('GIT_REMOTE_CHANGED');
    }

    let commit = operation.commitSha;
    if (!commit) {
      if (!binding.remoteHead && (await context.provider.getBranch(binding.targetBranch))?.sha !== binding.head) {
        fail('GIT_REMOTE_CHANGED');
      }
      commit = await createDeliveryCommit({
        root: binding.worktreeRoot, branch: binding.branch, expectedHead: binding.head, author: binding.author,
        title: binding.title, candidateTreeSha, forbiddenText: context.token, verify: () => verify([binding.head]), saveCommit(sha) {
          store.advance(id, owner, 'COMMITTED', actor, { commitSha: sha });
        },
      });
      phase = 'COMMITTED';
    } else {
      await applyDeliveryCommit(binding.worktreeRoot, 'refs/heads/' + binding.branch, binding.head, commit, candidateTreeSha);
    }
    await verify([commit]);
    const alreadyPushed = target?.sha === commit;
    if (!alreadyPushed) {
      if (phase === 'PUSHED') fail('GIT_REMOTE_CHANGED');
      await dependencies.transfer({ root: binding.worktreeRoot, endpoint: context.endpoint, token: context.token,
        operation: { kind: 'push', branch: binding.branch, sha: commit, remoteSha: binding.remoteHead } });
    }
    const observed = await context.provider.getBranch(binding.branch);
    if (!observed || observed.sha !== commit || observed.protected) fail('GIT_PUSH_UNCONFIRMED');
    if (phase !== 'PUSHED') store.advance(id, owner, 'PUSHED', actor);
    checkConnection(projectId, binding.connectionVersion);
    const text = { title: binding.title, description: binding.description };
    let change = existing && store.changes(projectId).some(({ number }) => number === existing.number)
      ? await mutateChange(projectId, existing.number, id, sha256(JSON.stringify(text)),
        () => context.provider.updatePullRequest(existing.number, text))
      : existing ? await context.provider.updatePullRequest(existing.number, text)
        : await context.provider.createPullRequest({ ...text, sourceBranch: binding.branch, targetBranch: binding.targetBranch });
    if (change.headSha !== commit) change = await context.provider.getPullRequest(change.number);
    if (change.state !== 'open' || change.headSha !== commit) fail('GIT_CHANGE_UNCONFIRMED');
    store.recordChange(projectId, change);
    return store.advance(id, owner, 'DELIVERED', actor, { changeNumber: change.number });
  }

  function knownChange(projectId: string, number: number) {
    if (!store.changes(projectId).some((change) => change.number === number)) fail('GIT_CHANGE_NOT_FOUND');
  }

  async function mutateChange<T>(projectId: string, number: number, key: string, digest: string, run: () => Promise<T>) {
    const claimedAt = store.claimMutation(projectId, number, key, digest);
    try { return await run(); }
    finally { store.releaseMutation(projectId, number, key, claimedAt); }
  }

  return {
    connect,
    prepare,
    preview,
    retryCredentialCleanup,
    async revoke(projectId: string, version: number, actor: string) {
      store.revoke(projectId, version, actor);
      await retryCredentialCleanup();
    },
    async branches(projectId: string) {
      return (await credential(projectId)).provider.listBranches();
    },
    async execute(id: string, approval: { expectedVersion: number; digest: string }, actor: string) {
      const owner = randomUUID();
      const operation = store.claim(id, approval, actor, owner);
      if (operation.phase === 'DELIVERED') return operation;
      let errorCode: string | null = null;
      try { return await apply(operation, actor, owner); }
      catch (error) {
        errorCode = safeGitError(error);
        throw error;
      } finally { store.release(id, owner, actor, errorCode); }
    },
    async inspectChange<Part extends keyof ChangeReads>(projectId: string, number: number, part: Part): Promise<ChangeReads[Part]> {
      knownChange(projectId, number);
      const { provider, connection, token } = await credential(projectId);
      const reads: { [Key in keyof ChangeReads]: () => Promise<ChangeReads[Key]> } = {
        change: () => provider.getPullRequest(number),
        diff: () => provider.getPullRequestDiff(number),
        reviews: () => provider.listPullRequestComments(number),
        checks: async () => provider.getChecks(await provider.getPullRequest(number)),
      };
      const result = await reads[part]();
      checkConnection(projectId, connection.version);
      // Provider-controlled fields cannot reflect the active credential back to a Bridge client.
      return JSON.parse(JSON.stringify(result, (_key, value: unknown) =>
        typeof value === 'string' ? value.replaceAll(token, '[REDACTED]') : value)) as ChangeReads[Part];
    },
    async details(projectId: string, number: number) {
      knownChange(projectId, number);
      const { provider } = await credential(projectId);
      const change = await provider.getPullRequest(number);
      const [diff, reviews, checks] = await Promise.all([
        provider.getPullRequestDiff(number), provider.listPullRequestComments(number), provider.getChecks(change),
      ]);
      store.recordChange(projectId, change, reviews);
      return { change, diff, reviews, checks };
    },
    async change(projectId: string, number: number, actor: string,
      input: { action: 'update'; title: string; description: string } | { action: 'close' } | { action: 'comment'; body: string; key: string },
      requestKey: string = randomUUID()) {
      knownChange(projectId, number);
      const { provider, token, connection } = await credential(projectId);
      return mutateChange(projectId, number, input.action === 'comment' ? input.key : requestKey, sha256(JSON.stringify(input)), async () => {
        checkConnection(projectId, connection.version);
        if (input.action === 'comment') {
          checkText(input.body, token);
          const note = await provider.createPullRequestComment(number, input.body, input.key);
          store.audit(projectId, null, actor, 'COMMENT_CONFIRMED');
          return note;
        }
        let outcome: GitChange;
        if (input.action === 'update') {
          checkText(input.title + '\n' + input.description, token);
          outcome = await provider.updatePullRequest(number, input);
        } else outcome = await provider.closePullRequest(number);
        store.recordChange(projectId, outcome);
        store.audit(projectId, null, actor, input.action === 'close' ? 'CHANGE_CLOSED' : 'CHANGE_UPDATED');
        return outcome;
      });
    },
  };
}
