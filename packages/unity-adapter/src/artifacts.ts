import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { UnityArtifact } from '@devhub/contracts';
import { windowsAclCommand } from '@devhub/security';

export const runByteLimit = 2 * 1024 ** 3;
export const storageByteLimit = 10 * 1024 ** 3;
export const artifactRetentionMs = 7 * 24 * 60 * 60 * 1000;
const maximumEntries = 25_000;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);
const windows = process.platform === 'win32';

const kinds = {
  'editor.log': ['log', 'text/plain'], 'player.log': ['log', 'text/plain'],
  'import-report.json': ['report', 'application/json'], 'compilation-report.json': ['report', 'application/json'],
  'editmode-results.xml': ['test', 'application/xml'], 'playmode-results.xml': ['test', 'application/xml'],
  'build-report.json': ['report', 'application/json'], 'run-summary.json': ['report', 'application/json'],
  'game-view.png': ['editor-screenshot', 'image/png'], 'player.png': ['player-screenshot', 'image/png'],
  'player.mp4': ['recording', 'video/mp4'],
  'game-view.mp4': ['editor-recording', 'video/mp4'],
  'console.log': ['log', 'text/plain'], 'console.json': ['log', 'application/json'], 'evidence-report.json': ['report', 'application/json'],
  'evidence-manifest.json': ['report', 'application/json'], 'visual-audit.txt': ['report', 'text/plain'],
} as const;

function artifactKind(name: string): readonly [UnityArtifact['kind'], UnityArtifact['mime']] | null {
  if (Object.hasOwn(kinds, name)) return kinds[name as keyof typeof kinds];
  if (/^[a-z][a-z0-9-]{0,39}__[a-zA-Z0-9_-]{1,48}\.png$/.test(name)) return ['editor-screenshot', 'image/png'];
  if (/^(?:game-view|[a-z][a-z0-9-]{0,39}__[a-zA-Z0-9_-]{1,48})\.jpe?g$/.test(name)) return ['editor-screenshot', 'image/jpeg'];
  if (/^player\.jpe?g$/.test(name)) return ['player-screenshot', 'image/jpeg'];
  if (/^[a-z][a-z0-9-]{0,39}__[a-zA-Z0-9_-]{1,48}\.mp4$/.test(name)) return ['editor-recording', 'video/mp4'];
  return null;
}
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
  if (windows) {
    // Realpath may expand a local DOS short name. Verify the supplied ancestry directly so
    // aliases for ordinary directories work without allowing junctions or symlinks.
    let directory = resolve(root);
    if (!/^[a-z]:\\/i.test(directory)) throw new Error('UNITY_ARTIFACT_UNSAFE');
    for (;;) {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('UNITY_ARTIFACT_UNSAFE');
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if ((await lstat(root)).isSymbolicLink()) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const actual = await realpath(root);
  const info = await ordinaryDirectory(actual);
  if (!windows && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error('UNITY_ARTIFACT_UNSAFE');
  }
  return actual;
}

async function assertWindowsAcl(root: string, child?: string, managed = false) {
  if (!windows) return;
  try {
    const script = await readFile(new URL('../windows/artifact-permissions.ps1', import.meta.url), 'utf8');
    const { executable, args, env } = windowsAclCommand(script, {
      DEVHUB_UNITY_ACL_ROOT: root, DEVHUB_UNITY_ACL_CHILD: child ?? '', DEVHUB_UNITY_ACL_MANAGED: managed ? '1' : '0',
    });
    await exec(executable, args, { env, timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error('UNITY_ARTIFACT_ACL_UNSAFE');
  }
}

export async function initializeUnityArtifactRoot(root: string, managed: boolean) {
  if (!windows) return;
  try {
    if (managed) {
      const parent = dirname(root);
      await mkdir(parent, { recursive: true });
      await privateRoot(parent);
      await mkdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    }
    await assertWindowsAcl(await privateRoot(root), undefined, managed);
  } catch (error) {
    if (error instanceof Error && error.message === 'UNITY_ARTIFACT_UNSAFE') throw error;
    throw new Error('UNITY_ARTIFACT_ACL_UNSAFE');
  }
}

export async function createRunDirectory(root: string, id: string, project: string) {
  if (!isAbsolute(root) || !runIdPattern.test(id)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  if (!windows) await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await privateRoot(root);
  const workspace = await realpath(project);
  if (workspace === actual || pathInside(workspace, actual) || pathInside(actual, workspace)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  await assertWindowsAcl(actual);
  const directory = join(actual, id);
  await mkdir(directory, { mode: 0o700 });
  await ordinaryDirectory(directory);
  await assertWindowsAcl(actual, directory);
  return directory;
}

export async function readArtifact(root: string, id: string, name: string) {
  if (!runIdPattern.test(id) || !artifactKind(name)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  return openArtifact(await privateRunDirectory(root, id), name);
}

export async function withArtifactScratch<T>(root: string, use: (directory: string) => Promise<T>) {
  const actual = await privateRoot(root);
  const directory = await mkdtemp(join(actual, '.mcp-media-'));
  try {
    await ordinaryDirectory(directory);
    await assertWindowsAcl(actual, directory);
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function privateRunDirectory(root: string, id: string) {
  if (!runIdPattern.test(id)) throw new Error('UNITY_ARTIFACT_UNSAFE');
  const actual = await privateRoot(root);
  const directory = join(actual, id);
  await ordinaryDirectory(directory);
  await assertWindowsAcl(actual, directory);
  return directory;
}

async function openArtifact(dir: string, name: string) {
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

export async function catalogArtifacts(directory: string, names: readonly string[] = Object.keys(kinds)): Promise<UnityArtifact[]> {
  const verified = await privateRunDirectory(dirname(directory), relative(dirname(directory), directory));
  const result: UnityArtifact[] = [];
  for (const name of names) {
    const type = artifactKind(name);
    if (!type) throw new Error('UNITY_ARTIFACT_UNSAFE');
    const [kind, mime] = type;
    const info = await lstat(join(verified, name)).catch(() => undefined);
    if (!info) continue;
    const file = await openArtifact(verified, name);
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
  await assertWindowsAcl(actual);
  const allowed = new Set(candidates);
  for (const entry of await readdir(actual, { withFileTypes: true })) {
    if (!runIdPattern.test(entry.name) || !allowed.has(entry.name) || !entry.isDirectory()) continue;
    const folder = join(actual, entry.name);
    const info = await ordinaryDirectory(folder);
    if (info.mtimeMs < now - artifactRetentionMs) {
      await assertWindowsAcl(actual, folder);
      await rm(folder, { recursive: true, force: true });
    }
  }
}

export function artifactMime(name: string) {
  return artifactKind(name)?.[1] ?? null;
}
