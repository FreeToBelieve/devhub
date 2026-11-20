import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathInside, runByteLimit } from './artifacts.js';
import type { UnityWorkerInput } from './protocol.js';
import { captureArgs } from './protocol.js';

export async function buildInventory(directory: string) {
  const root = await realpath(join(directory, 'build'));
  if (!pathInside(directory, root) || !(await lstat(root)).isDirectory()) throw new Error('UNITY_BUILD_OUTPUT_INVALID');
  const hash = createHash('sha256');
  let size = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const entries = await readdir(stack.pop()!, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(entry.parentPath, entry.name);
      if (await realpath(path) !== path) throw new Error('UNITY_BUILD_OUTPUT_INVALID');
      if (entry.isDirectory()) { stack.push(path); continue; }
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || ++files > 25_000 || (size += info.size) > runByteLimit) throw new Error('UNITY_BUILD_OUTPUT_LIMIT');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) {
          throw new Error('UNITY_BUILD_OUTPUT_INVALID');
        }
        const content = createHash('sha256');
        let bytes = 0;
        for await (const data of file.createReadStream({ autoClose: false })) {
          bytes += data.length;
          if (bytes > info.size) throw new Error('UNITY_BUILD_OUTPUT_INVALID');
          content.update(data);
        }
        if (bytes !== info.size) throw new Error('UNITY_BUILD_OUTPUT_INVALID');
        hash.update(JSON.stringify([relative(root, path).replaceAll('\\', '/'), bytes, content.digest('hex')]));
      } finally { await file.close(); }
    }
  }
  if (!files) throw new Error('UNITY_BUILD_OUTPUT_INVALID');
  return { sha256: hash.digest('hex'), size };
}

export async function playerExecutable(input: UnityWorkerInput) {
  const build = join(input.directory, 'build');
  let executable = join(build, 'DevHubPlayer.exe');
  if (input.platform === 'MACOS') {
    const folder = join(build, 'DevHubPlayer.app', 'Contents', 'MacOS');
    const entries = await readdir(folder, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length !== 1) throw new Error('UNITY_PLAYER_MISSING');
    executable = join(folder, files[0]!.name);
  }
  const actual = await realpath(executable);
  if (actual !== executable || !pathInside(input.directory, actual) || !(await lstat(actual)).isFile()) {
    throw new Error('UNITY_PLAYER_MISSING');
  }
  await access(actual, constants.X_OK);
  return actual;
}

export function playerArgs(input: UnityWorkerInput, log: string) {
  return ['-logFile', log, '-devhubRun', input.id, '-devhubArtifacts', input.directory, '-devhubStage', 'PLAYER',
    '-devhubScene', input.plan.scene!, '-screen-fullscreen', '0', ...captureArgs(input.plan),
    ...(input.plan.capture ? ['-screen-width', String(input.plan.capture.width), '-screen-height', String(input.plan.capture.height)] : [])];
}
