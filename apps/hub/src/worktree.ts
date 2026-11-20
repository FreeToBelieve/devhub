import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gitHeadSchema } from '@devhub/contracts';
import type { ExecutionScope, WorktreeRecord } from '@devhub/contracts';
import { sha256 } from '@devhub/security';

const exec = promisify(execFile);
const isolatedConfig = fileURLToPath(new URL('../config/readonly.gitconfig', import.meta.url));

async function git(root: string, args: string[], ignoreExitOne = false): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  try {
    const result = await exec('git', [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.trustctime=true',
      '-c', 'core.checkStat=default', '-c', 'core.untrackedCache=false',
      '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-C', root, ...args,
    ], {
      env: {
        ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: isolatedConfig, GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      },
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (ignoreExitOne && (error as { code?: string | number }).code === 1) return '';
    throw new Error('The registered Git worktree could not be inspected.');
  }
}

async function directoryIdentity(path: string): Promise<string> {
  const metadata = await stat(path, { bigint: true });
  if (!metadata.isDirectory()) throw new Error('An ordinary Git directory is required.');
  return JSON.stringify([path, metadata.dev.toString(), metadata.ino.toString()]);
}

async function verifyTargets(root: string, scope: ExecutionScope | undefined) {
  if (scope?.operation !== 'workspace.write') return;
  if (await git(root, ['check-ignore', '--no-index', '--', ...scope.paths], true)) {
    throw new Error('Ignored paths are outside the execution policy.');
  }
  for (const path of scope.paths) {
    let target = root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!entry) break;
      const permitted = index < parts.length - 1 ? entry.isDirectory() : entry.isFile() && entry.nlink === 1;
      if (entry.isSymbolicLink() || !permitted) throw new Error('A requested workspace path is outside the file policy.');
    }
  }
}

export async function inspectWorktree(path: string, scope?: ExecutionScope, allowDirty = false): Promise<WorktreeRecord & {
  baseHeadSha: string; linked: boolean;
}> {
  const root = await realpath(resolve(path));
  const layout = (await git(root, [
    'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--verify', 'HEAD',
  ])).trimEnd().split(/\r?\n/);
  const [top, gitDirectory, commonDirectory, head] = layout;
  if (layout.length !== 4 || !top || !gitDirectory || !commonDirectory || await realpath(top) !== root) {
    throw new Error('Register the Git worktree root.');
  }
  const baseHeadSha = gitHeadSchema.parse(head);
  const config = await git(root, ['config', '--null', '--list']);
  if (config.split('\0').some((value) => /^filter\..*\.(?:clean|smudge|process)\n[^\0]/i.test(value))) {
    throw new Error('Worktrees with external Git filters are outside the execution policy.');
  }
  const index = await git(root, ['ls-files', '-v', '--stage', '-z']);
  if (index.split('\0').some((entry) => /^H 160000 /.test(entry))) {
    throw new Error('GIT_SUBMODULE_WORKTREE_UNSUPPORTED');
  }
  if (index.split('\0').some((entry) => entry && !/^H (?:100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))) {
    throw new Error('Git submodules, sparse or hidden index entries are outside the execution policy.');
  }
  if (!allowDirty && await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])) {
    throw new Error('Commit or otherwise resolve Git worktree changes before requesting authorization.');
  }
  await verifyTargets(root, scope);
  if ((await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() !== baseHeadSha) {
    throw new Error('Git HEAD changed while checking the worktree.');
  }

  const common = await realpath(commonDirectory);
  const individual = await realpath(gitDirectory);
  const repoId = sha256(await directoryIdentity(common));
  const worktreeId = sha256(JSON.stringify([
    repoId, await directoryIdentity(root), await directoryIdentity(individual),
  ]));
  return { repoId, worktreeId, root, baseHeadSha, linked: common !== individual };
}

export async function addDetachedWorktree(repository: string, destination: string, head: string) {
  await git(repository, ['-c', 'core.hooksPath=' + isolatedConfig, 'worktree', 'add', '--detach', '--', destination, head]);
}

export async function repositoryRemote(root: string): Promise<string | null> {
  const remote = (await git(root, ['config', '--local', '--get', 'remote.origin.url'], true)).trim();
  try {
    const uri = new URL(remote);
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash ? uri.href : null;
  } catch { return null; }
}

export async function generatedRoots(root: string, names: readonly string[]) {
  const paths = await git(root, ['ls-files', '-z', '--', ...names.map((name) => ':(icase,literal)' + name)]);
  const occupied = new Set(paths.split('\0').map((path) => path.split('/')[0]?.toLowerCase()));
  const patterns = names.map((name) => name + '/');
  const ignored = await git(root, ['check-ignore', '--no-index', '--', ...patterns], true);
  return new Set(ignored.split(/\r?\n/).map((path) => path.slice(0, -1))
    .filter((name) => names.includes(name) && !occupied.has(name.toLowerCase())));
}
