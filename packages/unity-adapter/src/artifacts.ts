import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { UnityArtifact } from '@devhub/contracts';

export const runByteLimit = 2 * 1024 ** 3;
export const storageByteLimit = 10 * 1024 ** 3;
export const artifactRetentionMs = 7 * 24 * 60 * 60 * 1000;
const maximumEntries = 25_000;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kinds = {
  'editor.log': ['log', 'text/plain'], 'player.log': ['log', 'text/plain'],
  'import-report.json': ['report', 'application/json'], 'compilation-report.json': ['report', 'application/json'],
  'editmode-results.xml': ['test', 'application/xml'], 'playmode-results.xml': ['test', 'application/xml'],
  'build-report.json': ['report', 'application/json'], 'run-summary.json': ['report', 'application/json'],
  'game-view.png': ['editor-screenshot', 'image/png'], 'player.png': ['player-screenshot', 'image/png'],
  'player.mp4': ['recording', 'video/mp4'],
  'game-view.mp4': ['editor-recording', 'video/mp4'],
} as const;

export function pathInside(root: string, candidate: string) {
  const value = relative(root, candidate);
  return value !== '' && !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep);
}

async function ordinaryDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('UNITY_ARTIFACT_UNSAFE');
  return info;
}

async function privateRoot(root: string) {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const actual = await realpath(root);
  const info = await ordinaryDirectory(actual);
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error('UNITY_ARTIFACT_UNSAFE');
  }
  return actual;
}

export async function createRunDirectory(root: string, id: string, project: string) {
  if (!isAbsolute(root) || !runIdPattern.test(id)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await privateRoot(root);
  const workspace = await realpath(project);
  if (workspace === actual || pathInside(workspace, actual) || pathInside(actual, workspace)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const directory = join(actual, id);
  await mkdir(directory, { mode: 0o700 });
  await ordinaryDirectory(directory);
  return directory;
}

export async function readArtifact(root: string, id: string, name: string) {
  if (!runIdPattern.test(id) || !Object.hasOwn(kinds, name)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const actual = await privateRoot(root);
  const dir = join(actual, id);
  await ordinaryDirectory(dir);
  const path = join(dir, name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.ino !== before.ino || info.dev !== before.dev ||
        info.size > BigInt(runByteLimit)) throw new Error('UNITY_ARTIFACT_UNSAFE');
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function catalogArtifacts(directory: string): Promise<UnityArtifact[]> {
  const result: UnityArtifact[] = [];
  for (const [name, [kind, mime]] of Object.entries(kinds)) {
    const info = await lstat(join(directory, name)).catch(() => undefined);
    if (!info) continue;
    const root = join(directory, '..');
    const id = relative(root, directory);
    const file = await readArtifact(root, id, name);
    try {
      const hash = createHash('sha256');
      for await (const data of file.createReadStream({ autoClose: false })) hash.update(data);
      result.push({ name, kind, mime, size: info.size, sha256: hash.digest('hex'), createdAt: Math.trunc(info.mtimeMs) });
    } finally { await file.close(); }
  }
  return result;
}

export async function directoryBytes(directory: string, limit: number, allowLinks = false) {
  let size = 0;
  let count = 0;
  const stack = [directory];
  while (stack.length) {
    for (const entry of await readdir(stack.pop()!, { withFileTypes: true })) {
      const pathname = join(entry.parentPath, entry.name);
      const info = await lstat(pathname);
      if (++count > maximumEntries) throw new Error('UNITY_ARTIFACT_LIMIT');
      if (info.isSymbolicLink() && allowLinks) continue;
      if (info.isDirectory()) { stack.push(pathname); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error('UNITY_ARTIFACT_UNSAFE');
      size += info.size;
      if (size > limit) throw new Error('UNITY_ARTIFACT_LIMIT');
    }
  }
  return size;
}

export async function sweepArtifacts(root: string, candidates: readonly string[], now = Date.now()) {
  const actual = await privateRoot(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!actual) return;
  const allowed = new Set(candidates);
  for (const entry of await readdir(actual, { withFileTypes: true })) {
    if (!runIdPattern.test(entry.name) || !allowed.has(entry.name) || !entry.isDirectory()) continue;
    const folder = join(actual, entry.name);
    const info = await ordinaryDirectory(folder);
    if (info.mtimeMs < now - artifactRetentionMs) await rm(folder, { recursive: true, force: true });
  }
}

export function artifactMime(name: string) {
  return Object.hasOwn(kinds, name) ? kinds[name as keyof typeof kinds][1] : null;
}
