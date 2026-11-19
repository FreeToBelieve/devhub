import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { containsWorkspaceSecret, isSensitiveConfig, isWorkspaceSecretPath } from '@devhub/security';
import { generatedRoots } from './worktree.js';

const unityCaches = ['Library', 'Temp', 'Obj', 'obj', 'Logs'];
const limits = { entries: 125_000, bytes: 24 * 1024 ** 3, milliseconds: 35_000, depth: 64 };
const recent = new Map<string, Map<string, { identity: string; digest: string }>>();

function identity(stats: BigIntStats) {
  return [stats.dev, stats.ino, stats.mode, stats.nlink, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

export async function snapshotWorkspace(root: string, options: { fresh?: boolean; budget?: typeof limits; forbiddenText?: string } = {}) {
  const budget = options.budget ?? limits;
  const started = performance.now();
  const deadline = started + budget.milliseconds;
  const digest = createHash('sha256');
  const previous = options.fresh || options.forbiddenText ? undefined : recent.get(root);
  const next = new Map<string, { identity: string; digest: string }>();
  const unity = await lstat(join(root, 'ProjectSettings', 'ProjectVersion.txt')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  const omitted = await generatedRoots(root, unity?.isFile() ? [...unityCaches, 'node_modules'] : ['node_modules']);
  let entries = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let cachedFiles = 0;
  function withinBudget() {
    if (entries > budget.entries || totalBytes > budget.bytes || performance.now() > deadline) {
      throw new Error('WORKSPACE_SNAPSHOT_LIMIT');
    }
  }

  async function visit(directory: string, prefix: string, depth: number) {
    if (depth > budget.depth) throw new Error('WORKSPACE_SNAPSHOT_LIMIT');
    withinBudget();
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error('WORKSPACE_SNAPSHOT_UNSAFE_ENTRY');
    const children = await readdir(directory, { withFileTypes: true });
    entries += children.length;
    withinBudget();
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of children) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix + entry.name;
      if (isWorkspaceSecretPath(name) || (options.forbiddenText && name.includes(options.forbiddenText))) {
        throw new Error('WORKSPACE_SECRET_DETECTED');
      }
      const lower = entry.name.toLowerCase();
      if (lower === '.git' || (!prefix && lower === '.codex') || entry.isSymbolicLink()) {
        throw new Error('WORKSPACE_SNAPSHOT_UNSAFE_ENTRY');
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!prefix && omitted.has(entry.name)) continue;
        digest.update(JSON.stringify(['dir', name]) + '\n');
        await visit(path, name + '/', depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error('WORKSPACE_SNAPSHOT_UNSAFE_ENTRY');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || identity(before) !== identity(await lstat(path, { bigint: true }))) {
          throw new Error('WORKSPACE_SNAPSHOT_UNSAFE_ENTRY');
        }
        fileCount++;
        totalBytes += Number(before.size);
        withinBudget();
        const key = identity(before);
        const cached = previous?.get(name);
        let contentSha: string;
        if (cached?.identity === key && before.ino !== 0n && before.ctimeNs !== 0n) {
          contentSha = cached.digest;
          cachedFiles++;
        } else {
          const contents = createHash('sha256');
          const inspectConfig = isSensitiveConfig(name);
          if (inspectConfig && before.size > 256_000n) throw new Error('WORKSPACE_SECRET_SCAN_LIMIT');
          let scan = '';
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            withinBudget();
            contents.update(chunk);
            scan += chunk.toString('utf8');
            if (containsWorkspaceSecret(scan) || (options.forbiddenText && scan.includes(options.forbiddenText))) {
              throw new Error('WORKSPACE_SECRET_DETECTED');
            }
            if (!inspectConfig) scan = scan.slice(-Math.max(256, options.forbiddenText?.length ?? 0));
          }
          if (inspectConfig && containsWorkspaceSecret(scan, true, lower === '.npmrc')) {
            throw new Error('WORKSPACE_SECRET_DETECTED');
          }
          contentSha = contents.digest('hex');
        }
        if (key !== identity(await file.stat({ bigint: true })) || key !== identity(await lstat(path, { bigint: true }))) {
          throw new Error('WORKSPACE_SNAPSHOT_CHANGED');
        }
        next.set(name, { identity: key, digest: contentSha });
        digest.update(JSON.stringify(['file', name, before.mode.toString(), contentSha]) + '\n');
      } finally {
        await file.close();
      }
    }
    if (identity(before) !== identity(await lstat(directory, { bigint: true }))) {
      throw new Error('WORKSPACE_SNAPSHOT_CHANGED');
    }
  }
  digest.update('devhub-workspace-snapshot-v3\n');
  await visit(root, '', 0);
  withinBudget();
  recent.delete(root);
  recent.set(root, next);
  if (recent.size > 4) recent.delete(recent.keys().next().value!);
  return { sha256: digest.digest('hex'), fileCount, totalBytes, cachedFiles, elapsedMs: Math.ceil(performance.now() - started) };
}
