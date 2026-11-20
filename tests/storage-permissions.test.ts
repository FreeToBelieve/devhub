import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempDisposableSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from '@devhub/hub';
import { windowsAclCommand } from '../packages/security/dist/index.js';
import { createRunDirectory, readArtifact } from '../packages/unity-adapter/dist/index.js';
import { describe, expect, it } from 'vitest';

const port = 4317;
const mode = (filename: string) => statSync(filename).mode & 0o7777;

describe.skipIf(process.platform === 'win32')('SQLite POSIX permissions', () => {
  it('tightens a managed directory, an existing database and an existing sidecar', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    const directory = join(temporary.path, '本机 数据');
    const databasePath = join(directory, 'tasks.sqlite');
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    for (const filename of [databasePath, databasePath + '-shm']) {
      writeFileSync(filename, '');
      chmodSync(filename, 0o644);
    }

    const hub = createServer({ port, databasePath, managedDataDirectory: true });
    try {
      expect(mode(directory)).toBe(0o700);
      expect(mode(databasePath)).toBe(0o600);
      expect(mode(databasePath + '-shm')).toBe(0o600);
    } finally {
      await hub.close();
    }
  });

  it('preserves an existing external directory mode and restricts its database', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    chmodSync(temporary.path, 0o751);
    const databasePath = join(temporary.path, 'tasks.sqlite');
    const hub = createServer({ port, databasePath });
    try {
      expect(mode(temporary.path)).toBe(0o751);
      expect(mode(databasePath)).toBe(0o600);
    } finally {
      await hub.close();
    }
  });

  it('rejects a shared writable directory and leaves it unchanged', () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    chmodSync(temporary.path, 0o775);
    const databasePath = join(temporary.path, 'tasks.sqlite');
    expect(() => createServer({ port, databasePath })).toThrow('Could not secure SQLite database files');
    expect(mode(temporary.path)).toBe(0o775);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('rejects linked database files and a linked managed directory without touching their targets', () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    const target = join(temporary.path, 'other.txt');
    const linked = join(temporary.path, 'linked.sqlite');
    const hardlink = join(temporary.path, 'hardlink.sqlite');
    const directory = join(temporary.path, 'other-folder');
    const linkedDirectory = join(temporary.path, 'linked-folder');
    writeFileSync(target, 'other local file');
    chmodSync(target, 0o644);
    symlinkSync(target, linked);
    linkSync(target, hardlink);
    mkdirSync(directory);
    chmodSync(directory, 0o751);
    symlinkSync(directory, linkedDirectory, 'dir');

    expect(() => createServer({ port, databasePath: linked })).toThrow('Could not secure SQLite database files');
    expect(() => createServer({ port, databasePath: hardlink })).toThrow('Could not secure SQLite database files');
    expect(() => createServer({ port, databasePath: join(linkedDirectory, 'tasks.sqlite'), managedDataDirectory: true }))
      .toThrow('Could not secure SQLite database files');
    expect(mode(target)).toBe(0o644);
    expect(mode(directory)).toBe(0o751);
  });
});

interface WindowsAclSnapshot {
  sddl: string;
  protected: boolean;
  currentSid: string;
  allowedSids: string[];
}

function windowsAcl(path: string, extraSid = ''): WindowsAclSnapshot {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
$ErrorActionPreference = 'Stop'
$entry = $env:DEVHUB_TEST_ACL
$cid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$access = [System.Security.AccessControl.AccessControlSections]::Access
$fileSystem = if ([IO.Directory]::Exists($entry)) { [IO.Directory] } else { [IO.File] }
$acl = $fileSystem::GetAccessControl($entry, $access)
if ($env:DEVHUB_TEST_EXTRA_SID) {
    $descriptor = 'D:P(A;OICI;FA;;;{0})(A;OICI;GR;;;{1})' -f $cid, $env:DEVHUB_TEST_EXTRA_SID
    $acl.SetSecurityDescriptorSddlForm($descriptor, $access)
    $fileSystem::SetAccessControl($entry, $acl)
    $acl = $fileSystem::GetAccessControl($entry, $access)
}
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
[pscustomobject]@{
    sddl = $acl.GetSecurityDescriptorSddlForm($access)
    protected = $acl.AreAccessRulesProtected
    currentSid = $cid
    allowedSids = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' } |
        ForEach-Object { $_.IdentityReference.Value })
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(ps, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    timeout: 12000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
      PSModulePath: join(dirname(ps), 'Modules'),
      DEVHUB_TEST_ACL: path,
      DEVHUB_TEST_EXTRA_SID: extraSid,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as WindowsAclSnapshot;
}

describe.skipIf(process.platform !== 'win32')('SQLite Windows ACLs', () => {
  it('restricts a managed directory, an existing database and its transaction files to the current SID', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    const directory = join(temporary.path, '本机 数据');
    const databasePath = join(directory, 'tasks.sqlite');
    mkdirSync(directory);
    windowsAcl(directory, 'S-1-5-11');
    writeFileSync(databasePath, '');
    writeFileSync(databasePath + '-shm', '');

    const hub = createServer({ port, databasePath, managedDataDirectory: true });
    try {
      for (const path of [directory, databasePath, databasePath + '-shm']) {
        const acl = windowsAcl(path);
        expect(acl.protected).toBe(true);
        expect(acl.allowedSids).toEqual([acl.currentSid]);
      }
      const childPath = join(directory, 'new-sqlite-sidecar');
      writeFileSync(childPath, '');
      const childAcl = windowsAcl(childPath);
      expect(childAcl.allowedSids).toEqual([childAcl.currentSid]);
    } finally {
      await hub.close();
    }
  }, 60000);

  it('leaves safe and shared external directory ACLs untouched', async () => {
    using temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-'));
    const safe = join(temporary.path, '外部 数据');
    const shared = join(temporary.path, '共享 数据');
    mkdirSync(safe);
    mkdirSync(shared);
    const safeAcl = windowsAcl(safe, 'S-1-5-18');
    const sharedAcl = windowsAcl(shared, 'S-1-5-11');
    const databasePath = join(safe, 'tasks.sqlite');
    const hub = createServer({ port, databasePath });
    try {
      expect(windowsAcl(safe).sddl).toBe(safeAcl.sddl);
      const file = windowsAcl(databasePath);
      expect(file.protected).toBe(true);
      expect(file.allowedSids).toEqual([file.currentSid]);
      const rejected = join(shared, 'tasks.sqlite');
      expect(() => createServer({ port, databasePath: rejected })).toThrow('Could not secure SQLite database files');
      expect(windowsAcl(shared).sddl).toBe(sharedAcl.sddl);
      expect(existsSync(rejected)).toBe(false);
    } finally {
      await hub.close();
    }
  }, 60000);
});

function replaceDirectoryDacl(path: string, sddl: string) {
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$dacl = [System.Security.AccessControl.DirectorySecurity]::new()
$dacl.SetSecurityDescriptorSddlForm($env:DEVHUB_TEST_SDDL.Replace('{CURRENT}', $sid), [System.Security.AccessControl.AccessControlSections]::Access)
[IO.Directory]::SetAccessControl($env:DEVHUB_TEST_ACL, $dacl)
`;
  const { executable, args, env } = windowsAclCommand(script, { DEVHUB_TEST_ACL: path, DEVHUB_TEST_SDDL: sddl });
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
}

describe.skipIf(process.platform !== 'win32')('Unity Windows Artifact ACLs', () => {
  const privateDacl = 'D:P(A;OICI;FA;;;{CURRENT})';

  it('keeps default .devhub/unity-runs private and gives new runs and files inheritable access', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-acl-'));
    const databasePath = join(fixture.path, '.devhub', 'tasks.sqlite');
    const root = join(dirname(databasePath), 'unity-runs');
    const project = join(fixture.path, 'project');
    mkdirSync(project);
    const hub = createServer({ port, databasePath, managedDataDirectory: true, unityArtifactRoot: root,
      managedUnityArtifactDirectory: true });
    try {
      await hub.ready();
      const acl = windowsAcl(root);
      expect(acl.protected).toBe(true);
      expect(acl.allowedSids).toEqual([acl.currentSid]);
      const id = randomUUID();
      const run = await createRunDirectory(root, id, project);
      const artifact = join(run, 'editor.log');
      writeFileSync(artifact, 'fixture');
      expect(windowsAcl(run)).toMatchObject({ protected: false, allowedSids: [acl.currentSid] });
      expect(windowsAcl(artifact).allowedSids).toEqual([acl.currentSid]);
      const opened = await readArtifact(root, id, 'editor.log');
      await opened.close();
      windowsAcl(run, 'S-1-5-11');
      await expect(readArtifact(root, id, 'editor.log')).rejects.toThrow('UNITY_ARTIFACT_ACL_UNSAFE');
    } finally { await hub.close(); }
  }, 60000);

  it('preserves a trusted external DACL and rejects it after ACL drift across Hub restart', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-acl-'));
    const databasePath = join(fixture.path, 'db', 'tasks.sqlite');
    const root = join(fixture.path, '外部 Artifact');
    mkdirSync(root);
    replaceDirectoryDacl(root, privateDacl + '(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
    const before = windowsAcl(root);
    const open = () => createServer({ port, databasePath, managedDataDirectory: true, unityArtifactRoot: root });
    const first = open();
    try {
      await first.ready();
      expect(windowsAcl(root).sddl).toBe(before.sddl);
    } finally { await first.close(); }
    const changed = windowsAcl(root, 'S-1-5-11');
    const restarted = open();
    try {
      await expect(restarted.ready()).rejects.toThrow('UNITY_ARTIFACT_ACL_UNSAFE');
      expect(windowsAcl(root).sddl).toBe(changed.sddl);
    } finally { await restarted.close(); }
  }, 60000);

  it.each(['S-1-1-0', 'S-1-5-21-1111-2222-3333-1001'])('rejects an Allow ACE for SID %s and preserves the DACL', async (sid) => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-acl-'));
    const root = join(fixture.path, 'external');
    mkdirSync(root);
    const before = windowsAcl(root, sid);
    const hub = createServer({ port, databasePath: ':memory:', unityArtifactRoot: root });
    try {
      await expect(hub.ready()).rejects.toThrow('UNITY_ARTIFACT_ACL_UNSAFE');
      expect(windowsAcl(root).sddl).toBe(before.sddl);
    } finally { await hub.close(); }
  }, 60000);

  it('fails closed when READ_CONTROL is denied on an empty test directory', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-acl-'));
    const root = join(fixture.path, 'external');
    mkdirSync(root);
    replaceDirectoryDacl(root, 'D:P(D;;RC;;;WD)(A;;WD;;;OW)(A;OICI;FA;;;{CURRENT})');
    const hub = createServer({ port, databasePath: ':memory:', unityArtifactRoot: root });
    try {
      const { executable, args, env } = windowsAclCommand(`$ErrorActionPreference = 'Stop'
[IO.Directory]::GetAccessControl($env:DEVHUB_TEST_ACL) | Out-Null`, { DEVHUB_TEST_ACL: root });
      const unreadable = spawnSync(executable, args, { env, timeout: 15000, windowsHide: true });
      expect(unreadable.status).toBe(1);
      await expect(hub.ready()).rejects.toThrow('UNITY_ARTIFACT_ACL_UNSAFE');
    } finally {
      await hub.close();
      rmdirSync(root);
    }
  }, 60000);

  it('rejects a junction and a path routed through a junction', async () => {
    using fixture = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-acl-'));
    const target = join(fixture.path, 'target');
    const alias = join(fixture.path, 'alias');
    mkdirSync(join(target, 'nested'), { recursive: true });
    replaceDirectoryDacl(target, privateDacl);
    symlinkSync(target, alias, 'junction');
    for (const root of [alias, join(alias, 'nested')]) {
      const hub = createServer({ port, databasePath: ':memory:', unityArtifactRoot: root });
      try { await expect(hub.ready()).rejects.toThrow('UNITY_ARTIFACT_UNSAFE'); }
      finally { await hub.close(); }
    }
  }, 60000);
});
