import { join } from 'node:path';
import { GitProviderError } from '@devhub/git-provider';

const service = 'com.shanhe.devhub.git-provider';

export interface GitCredentialManager {
  get(reference: string): Promise<string | null>;
  set(reference: string, token: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

function target(reference: string) {
  if (!/^[a-f0-9-]{36}$/.test(reference)) throw new GitProviderError('GIT_CREDENTIAL_REFERENCE_INVALID');
  return service + '/' + reference;
}

async function macCredentials(): Promise<GitCredentialManager> {
  const { default: koffi } = await import('koffi');
  const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
  const foundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const release = foundation.func('void CFRelease(void *)');
  const add = security.func('int SecKeychainAddGenericPassword(void *, uint32_t, const char *, uint32_t, const char *, uint32_t, const void *, void *)');
  const find = security.func('int SecKeychainFindGenericPassword(void *, uint32_t, const char *, uint32_t, const char *, _Out_ uint32_t *, _Out_ void **, _Out_ void **)');
  const erase = security.func('int SecKeychainItemDelete(void *)');
  const free = security.func('int SecKeychainItemFreeContent(void *, void *)');
  const interaction = security.func('int SecKeychainSetUserInteractionAllowed(uint8_t)');
  const check = (status: number) => { if (status !== 0) throw new GitProviderError('GIT_KEYCHAIN_UNAVAILABLE'); };
  check(interaction(0));

  return {
    async get(reference) {
      const account = target(reference);
      const size = [0];
      const data = [null];
      const status = find(null, service.length, service, account.length, account, size, data, null);
      if (status === -25300) return null;
      check(status);
      try { return Buffer.from(koffi.decode(data[0], 'uint8_t', size[0]!)).toString('utf8'); }
      finally { free(null, data[0]); }
    },
    async set(reference, token) {
      const account = target(reference);
      const blob = Buffer.from(token);
      try { check(add(null, service.length, service, account.length, account, blob.length, blob, null)); }
      finally { blob.fill(0); }
    },
    async remove(reference) {
      const account = target(reference);
      const item = [null];
      const status = find(null, service.length, service, account.length, account, null, null, item);
      if (status === -25300) return;
      check(status);
      try { check(erase(item[0])); }
      finally { release(item[0]); }
    },
  };
}

async function windowsCredentials(): Promise<GitCredentialManager> {
  const { default: koffi } = await import('koffi');
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const advapi = koffi.load(join(system, 'advapi32.dll'));
  const kernel = koffi.load(join(system, 'kernel32.dll'));
  const credential = koffi.struct('DevHubCredential', {
    Flags: 'uint32_t', Type: 'uint32_t', TargetName: 'str16', Comment: 'str16',
    LastWritten: 'uint64_t', CredentialBlobSize: 'uint32_t', CredentialBlob: 'void *',
    Persist: 'uint32_t', AttributeCount: 'uint32_t', Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  });
  const read = advapi.func('int __stdcall CredReadW(const char16_t *, uint32_t, uint32_t, _Out_ void **)');
  const write = advapi.func('int __stdcall CredWriteW(const DevHubCredential *, uint32_t)');
  const erase = advapi.func('int __stdcall CredDeleteW(const char16_t *, uint32_t, uint32_t)');
  const free = advapi.func('void __stdcall CredFree(void *)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError(void)');
  const failure = () => new GitProviderError('GIT_CREDENTIAL_MANAGER_UNAVAILABLE');
  return {
    async get(reference) {
      const pointer = [null];
      if (!read(target(reference), 1, 0, pointer)) {
        if (lastError() === 1168) return null;
        throw failure();
      }
      try {
        const row = koffi.decode(pointer[0], credential);
        return Buffer.from(koffi.decode(row.CredentialBlob, 'uint8_t', row.CredentialBlobSize)).toString('utf8');
      } finally { free(pointer[0]); }
    },
    async set(reference, token) {
      const blob = Buffer.from(token);
      try {
        if (!write({ Flags: 0, Type: 1, TargetName: target(reference), Comment: null, LastWritten: 0,
          CredentialBlobSize: blob.length, CredentialBlob: blob, Persist: 2, AttributeCount: 0,
          Attributes: null, TargetAlias: null, UserName: 'DevHub' }, 0)) throw failure();
      } finally { blob.fill(0); }
    },
    async remove(reference) {
      if (!erase(target(reference), 1, 0) && lastError() !== 1168) throw failure();
    },
  };
}

let manager: Promise<GitCredentialManager> | undefined;
export function gitCredentials() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new GitProviderError('GIT_SYSTEM_CREDENTIALS_UNAVAILABLE');
  }
  manager ??= (process.platform === 'darwin' ? macCredentials() : windowsCredentials()).catch(() => {
    manager = undefined;
    throw new GitProviderError('GIT_SYSTEM_CREDENTIALS_UNAVAILABLE');
  });
  return manager;
}
