import { deliveryBranchName, gitAuthorInput, gitHeadSchema } from '@devhub/contracts';
import { GitProviderError, providerEndpoint } from '@devhub/git-provider';
import type { Endpoint } from '@devhub/git-provider';

import { git } from './git-process.js';
import { withCandidate } from './candidate.js';

export async function checkLocalGitRemote(root: string, endpoint: Endpoint) {
  const config = await git(root, ['config', '--includes', '--null', '--list']);
  // Prevent a local transport rewrite, custom API credentials, or dispatch of repository-supplied code.
  if (config.split('\0').some((field) => /^(?:include(?:if)?\.|filter\.|url\.|credential\.|http\.|alias\.|core\.(?:sshcommand|gitproxy)\b)/i.test(field))) {
    throw new GitProviderError('GIT_CONFIG_DENIED');
  }
  const remotes = await Promise.all([
    git(root, ['remote', 'get-url', '--all', 'origin']),
    git(root, ['remote', 'get-url', '--all', '--push', 'origin']),
  ]);
  for (const remote of remotes) {
    try {
      if (providerEndpoint(endpoint.provider, remote.trimEnd(), endpoint.apiBaseUrl).repositoryUrl !== endpoint.repositoryUrl) {
        throw new Error();
      }
    } catch { throw new GitProviderError('GIT_REMOTE_CHANGED'); }
  }
}

export async function localGitIdentity(root: string) {
  const [head, ref, bare] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD']),
    git(root, ['symbolic-ref', '-q', 'HEAD'], {}, [1]),
    git(root, ['rev-parse', '--is-bare-repository']),
  ]);
  if (bare.trim() !== 'false') throw new GitProviderError('GIT_WORKTREE_REQUIRED');
  return { head: gitHeadSchema.parse(head.trim()), ref: ref.trim() };
}

export async function verifyCaptureRevision(root: string, commit: string, scenePath: string) {
  const sha = gitHeadSchema.parse(commit);
  const [resolved, scene] = await Promise.all([
    git(root, ['rev-parse', '--verify', sha + '^{commit}']),
    git(root, ['--literal-pathspecs', 'ls-tree', '-rz', sha, '--', scenePath]),
  ]);
  const tab = scene.indexOf('\t');
  return resolved.trim() === sha && /^100(?:644|755) blob [a-f0-9]+$/.test(scene.slice(0, tab)) &&
    scene.slice(tab + 1) === scenePath + '\0';
}

export async function prepareDeliveryBranch(root: string, branch: string, expectedHead: string) {
  const name = deliveryBranchName.parse(branch);
  const target = 'refs/heads/' + name;
  const current = await localGitIdentity(root);
  if (current.head !== expectedHead || (current.ref && current.ref !== target)) {
    throw new GitProviderError('GIT_WORKTREE_CHANGED');
  }
  if (!current.ref) {
    await git(root, ['switch', '-c', name, '--no-guess']);
    const after = await localGitIdentity(root);
    if (after.head !== expectedHead || after.ref !== target) throw new GitProviderError('GIT_WORKTREE_CHANGED');
  }
  return target;
}

export async function createDeliveryCommit(input: {
  root: string; branch: string; expectedHead: string; candidateTreeSha: string;
  author: { name: string; email: string }; title: string; forbiddenText?: string;
  verify: () => Promise<void>; saveCommit: (sha: string) => void;
}) {
  const { root, expectedHead } = input;
  const author = gitAuthorInput.parse(input.author);
  const approvedTree = gitHeadSchema.parse(input.candidateTreeSha);
  await input.verify();
  return withCandidate(root, expectedHead, input.forbiddenText, async (candidate) => {
    if (!candidate.summary.canCommit || candidate.summary.candidateTreeSha !== approvedTree) {
      throw new GitProviderError('GIT_CANDIDATE_TREE_CHANGED');
    }
    await input.verify();
    const ref = await prepareDeliveryBranch(root, input.branch, expectedHead);
    // Copy only the approved, scanned objects into the repository.
    await candidate.importObjects();
    const sha = gitHeadSchema.parse((await git(root, ['commit-tree', approvedTree, '-p', expectedHead, '-m', input.title], {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    })).trim());
    await verifyCommitTree(root, sha, approvedTree);
    await input.verify();
    input.saveCommit(sha);
    await applyDeliveryCommit(root, ref, expectedHead, sha, approvedTree);
    return sha;
  });
}

async function verifyCommitTree(root: string, sha: string, approvedTree: string) {
  if ((await git(root, ['rev-parse', sha + '^{tree}'])).trim() !== gitHeadSchema.parse(approvedTree)) {
    throw new GitProviderError('GIT_CANDIDATE_TREE_CHANGED');
  }
}

export async function applyDeliveryCommit(root: string, ref: string, previous: string, sha: string, approvedTree: string) {
  const approvedRef = 'refs/heads/' + deliveryBranchName.parse(ref.replace(/^refs\/heads\//, ''));
  const object = gitHeadSchema.parse(sha);
  await verifyCommitTree(root, object, approvedTree);
  const current = await localGitIdentity(root);
  if (current.ref !== approvedRef || (current.head !== previous && current.head !== object)) {
    throw new GitProviderError('GIT_WORKTREE_CHANGED');
  }
  const parent = (await git(root, ['rev-parse', object + '^'])).trim();
  if (parent !== previous) throw new GitProviderError('GIT_HEAD_CHANGED');
  if (current.head !== object) await git(root, ['update-ref', approvedRef, object, previous]);
  await git(root, ['read-tree', object]);
}

export async function loopbackGit(root: string, verb: 'fetch' | 'push', url: string, ref: string, proof: string) {
  const headers: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'X-DevHub-Git: ' + proof,
  };
  const args = ['-c', 'protocol.http.allow=always', '-c', 'http.followRedirects=false', '-c', 'http.proxy=',
    '-c', 'credential.helper=', '-c', 'push.followTags=false', '-c', 'fetch.writeCommitGraph=false',
    '-c', 'http.version=HTTP/1.1', verb];
  if (verb === 'push') args.push('--porcelain', '--no-verify', '--no-follow-tags', url, ref);
  else args.push('--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', url, ref);
  return git(root, args, headers);
}
