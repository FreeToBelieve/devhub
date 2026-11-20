import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import koffi from 'koffi';
import { sha256 } from '@devhub/security';
import { InboxStateError } from '@devhub/storage';

export function lockCodexHost(databasePath: string) {
  if (databasePath === ':memory:') return () => undefined;
  const path = realpathSync(databasePath);
  if (process.platform === 'darwin') {
    const system = koffi.load('/usr/lib/libSystem.B.dylib');
    const flock = system.func('int flock(int, int)');
    const file = openSync(path + '.codex-host.lock', constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const info = fstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
        throw new InboxStateError('INBOX_HOST_LOCK_UNSAFE');
      }
      if (flock(file, 2 | 4) !== 0) throw new InboxStateError('INBOX_SECOND_HOST');
      return () => closeSync(file);
    } catch (error) { closeSync(file); throw error; }
  }
  if (process.platform === 'win32') {
    const kernel = koffi.load((process.env.SystemRoot ?? 'C:\\Windows') + '\\System32\\kernel32.dll');
    const mutex = kernel.func('void * __stdcall CreateMutexW(void *, int, const char16_t *)');
    const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)');
    const release = kernel.func('int __stdcall ReleaseMutex(void *)');
    const close = kernel.func('int __stdcall CloseHandle(void *)');
    const handle = mutex(null, 0, 'Global\\ShanHeDevHubCodex_' + sha256(path.toLowerCase()));
    if (!handle) throw new InboxStateError('INBOX_HOST_LOCK_UNAVAILABLE');
    const code = wait(handle, 0);
    if (code !== 0 && code !== 128) {
      close(handle);
      throw new InboxStateError('INBOX_SECOND_HOST');
    }
    return () => { release(handle); close(handle); };
  }
  throw new InboxStateError('INBOX_HOST_LOCK_UNAVAILABLE');
}
