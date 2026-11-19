import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deliveryBranchName, gitAuthorInput, gitHeadSchema } from '@devhub/contracts';
import { GitProviderError, providerEndpoint } from '@devhub/git-provider';
import type { Endpoint } from '@devhub/git-provider';

const exec = promisify(execFile);
const runtimeEnv = ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR'];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

async function git(root: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}, allowedCodes: readonly number[] = []) {
  const env = Object.fromEntries(runtimeEnv.map((key) => [key, process.env[key]]));
  try {
    const { stdout } = await exec('git', [
      '-C', root, '-c', 'core.hooksPath=' + nullDevice, '-c', 'core.fsmonitor=false', '-c', 'core.trustctime=true',
      '-c', 'core.checkStat=default', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'commit.gpgSign=false', '-c', 'core.logAllRefUpdates=true', ...args,
    ], { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1', ...extra },
      windowsHide: true, timeout: 100_000, maxBuffer: 4 * 1024 ** 2 });
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && allowedCodes.includes(code)) return '';
    throw new GitProviderError('GIT_LOCAL_COMMAND_FAILED');
  }
}

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

export async function localChangeSummary(root: string, head: string) {
  const expected = gitHeadSchema.parse(head);
  const [status, diff] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all']),
    git(root, ['diff', '--no-textconv', '--no-ext-diff', '--no-renames', '--stat', expected, '--', '.']),
  ]);
  return { changes: status.split('\0').filter(Boolean), diff: diff.slice(0, 30_000) };
}

export async function createDeliveryCommit(input: {
  root: string; branch: string; expectedHead: string; author: { name: string; email: string }; title: string;
  verify: () => Promise<void>; saveCommit: (sha: string) => void;
}) {
  const { root, expectedHead } = input;
  const author = gitAuthorInput.parse(input.author);
  const ref = await prepareDeliveryBranch(root, input.branch, expectedHead);
  const scratch = await mkdtemp(join(tmpdir(), 'devhub-index-'));
  try {
    const GIT_INDEX_FILE = join(scratch, 'index');
    const index = { GIT_INDEX_FILE };
    await input.verify();
    await git(root, ['read-tree', expectedHead], index);
    await git(root, ['add', '--all', '--', '.'], index);
    // Re-read source files and prove the staged tree still corresponds to those exact bytes.
    await input.verify();
    const staged = gitHeadSchema.parse((await git(root, ['write-tree'], index)).trim());
    const verification = { GIT_INDEX_FILE: join(scratch, 'verify') };
    await git(root, ['read-tree', expectedHead], verification);
    await git(root, ['add', '--all', '--', '.'], verification);
    if ((await git(root, ['write-tree'], verification)).trim() !== staged) {
      throw new GitProviderError('GIT_WORKTREE_CHANGED');
    }
    await input.verify();
    const existing = (await git(root, ['rev-parse', expectedHead + '^{tree}'])).trim();
    if (existing === staged) throw new GitProviderError('GIT_NO_CHANGES');
    const sha = gitHeadSchema.parse((await git(root, ['commit-tree', staged, '-p', expectedHead, '-m', input.title], {
      ...index, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    })).trim());
    // Journal the object before changing the branch so retries can recover either outcome.
    input.saveCommit(sha);
    await applyDeliveryCommit(root, ref, expectedHead, sha);
    return sha;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function applyDeliveryCommit(root: string, ref: string, previous: string, sha: string) {
  const approvedRef = 'refs/heads/' + deliveryBranchName.parse(ref.replace(/^refs\/heads\//, ''));
  const object = gitHeadSchema.parse(sha);
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
