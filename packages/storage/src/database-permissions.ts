import { spawnSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { windowsAclCommand } from '@devhub/security';

const sidecars = ['-journal', '-wal', '-shm'];

class DatabasePermissionError extends Error {
  readonly code = 'DEVHUB_DB_PERMISSIONS';

  constructor(cause: unknown) {
    super('Could not secure SQLite database files.', { cause });
  }
}

function checkRegularFile(filename: string): boolean {
  const entry = lstatSync(filename, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error('SQLite files must be ordinary files without extra links.');
  }
  return true;
}

function protectPosixFile(filename: string, create: boolean) {
  if (!checkRegularFile(filename) && !create) return;
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0);
  let fd: number;
  try {
    fd = openSync(filename, flags, 0o600);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.()) {
      throw new Error('SQLite files must be owned by the current user and have no extra links.');
    }
    if ((entry.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function protectPosix(directory: string, managed: boolean, filename: string, related: string[]) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const entry = fstatSync(fd);
    if (entry.uid !== process.getuid?.()) throw new Error('The database directory must be owned by the current user.');
    if (managed) {
      if ((entry.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
    } else if ((entry.mode & 0o022) !== 0) {
      throw new Error('An external database directory must be writable only by its owner.');
    }
  } finally {
    closeSync(fd);
  }
  protectPosixFile(filename, true);
  for (const path of related) protectPosixFile(path, false);
}

function protectWindows(filename: string, managed: boolean, related: string[]) {
  const script = readFileSync(new URL('../windows/database-permissions.ps1', import.meta.url), 'utf8');
  const { executable, args, env } = windowsAclCommand(script, { DEVHUB_SQLITE_FILE: filename, DEVHUB_SQLITE_MANAGED_DIR: managed ? '1' : '0' });
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr.trim() || 'Could not apply Windows database ACL.');
  for (const path of [filename, ...related]) checkRegularFile(path);
}

export function protectDatabaseFiles(path: string, managedDataDirectory: boolean) {
  const filename = resolve(path);
  const directory = dirname(filename);
  const related = sidecars.map((suffix) => filename + suffix);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error('The SQLite directory must be an ordinary directory.');
    for (const path of [filename, ...related]) checkRegularFile(path);
    if (process.platform === 'win32') protectWindows(filename, managedDataDirectory, related);
    else protectPosix(directory, managedDataDirectory, filename, related);
  } catch (error) {
    throw new DatabasePermissionError(error);
  }
}
