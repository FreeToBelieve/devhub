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

export async function inspectWorktree(path: string, scope?: ExecutionScope): Promise<WorktreeRecord & { baseHeadSha: string }> {
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
  if (config.split('\0').some((value) => /^filter\..*\.(?:clean|process)\n[^\0]/i.test(value))) {
    throw new Error('Worktrees with external Git filters are outside the execution policy.');
  }
  const index = await git(root, ['ls-files', '-v', '--stage', '-z']);
  if (index.split('\0').some((entry) => entry && !/^H (?:100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))) {
    throw new Error('Git submodules, sparse or hidden index entries are outside the execution policy.');
  }
  if (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])) {
    throw new Error('Commit or otherwise resolve Git worktree changes before requesting authorization.');
  }
  await verifyTargets(root, scope);
  if ((await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() !== baseHeadSha) {
    throw new Error('Git HEAD changed while checking the worktree.');
  }

  const repoId = sha256(await directoryIdentity(await realpath(commonDirectory)));
  const worktreeId = sha256(JSON.stringify([
    repoId, await directoryIdentity(root), await directoryIdentity(await realpath(gitDirectory)),
  ]));
  return { repoId, worktreeId, root, baseHeadSha };
}
