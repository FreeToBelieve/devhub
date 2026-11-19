import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { codexConfigDigest } from '@devhub/runner';
import { addDetachedWorktree, inspectWorktree } from './worktree.js';

async function workspaceDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  async function visit(directory: string, prefix: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name;
      const lower = entry.name.toLowerCase();
      if (!prefix && lower === '.git') continue;
      if (lower === '.git' || (!prefix && lower === '.codex') || entry.isSymbolicLink()) {
        throw new Error('The Codex worktree contains delegated Git metadata, a project Codex profile or a link.');
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        digest.update(JSON.stringify(['dir', name]) + '\n');
        await visit(path, name + '/');
        continue;
      }
      if (!entry.isFile()) throw new Error('The Codex worktree contains a special file.');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw new Error('The Codex worktree contains a linked file.');
        const fileDigest = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false })) fileDigest.update(chunk);
        const after = await file.stat({ bigint: true });
        if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
          throw new Error('The Codex worktree changed during inspection.');
        }
        digest.update(JSON.stringify(['file', name, before.mode.toString(), fileDigest.digest('hex')]) + '\n');
      } finally {
        await file.close();
      }
    }
  }
  await visit(root, '');
  return digest.digest('hex');
}

export async function inspectCodexWorktree(location: string) {
  const identity = await inspectWorktree(location, undefined, true);
  const marker = await lstat(join(identity.root, '.git'));
  if (!identity.linked || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1) {
    throw new Error('A DevHub-managed linked Git worktree is required.');
  }
  const workspaceSha256 = await workspaceDigest(identity.root);
  const after = await inspectWorktree(location, undefined, true);
  if (after.worktreeId !== identity.worktreeId || after.baseHeadSha !== identity.baseHeadSha) {
    throw new Error('Git changed during the Codex worktree inspection.');
  }
  return { ...identity, workspaceSha256, sdkConfigSha256: codexConfigDigest(identity.root) };
}

export async function createCodexWorktree(repository: string, targetDirectory: string) {
  const source = await inspectWorktree(repository);
  await mkdir(resolve(targetDirectory), { recursive: true, mode: 0o700 });
  const parent = await realpath(targetDirectory);
  const relation = relative(source.root, parent);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + sep))) {
    throw new Error('Choose a Codex worktree directory outside the source checkout.');
  }
  const target = join(parent, randomUUID());
  await addDetachedWorktree(source.root, target, source.baseHeadSha);
  return inspectCodexWorktree(target);
}
