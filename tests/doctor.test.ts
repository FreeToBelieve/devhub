import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectEnvironment } from '@devhub/runner';
import { expect, it } from 'vitest';

it('recognizes Windows PATH launchers, custom Unicode Unity locations and CRLF project files', async () => {
  const files = [
    'C:\\Program Files\\工具\\pnpm.cmd',
    'C:\\Program Files\\工具\\git.exe',
    'C:\\Program Files\\工具\\codex.cmd',
    'D:\\Unity 编辑器\\6000.3.28f1\\Editor\\Unity.exe',
  ].map((filename) => filename.toLowerCase());
  const report = await inspectEnvironment({
    platform: 'win32',
    arch: 'x64',
    nodeLts: true,
    nodeVersion: '24.22.3',
    cwd: 'C:\\ShanHe DevHub',
    readOperatingSystem: async () => ({ version: '10.0.22631', windowsProductType: 1 }),
    env: {
      Path: '"C:\\Program Files\\工具";C:\\Windows\\System32',
      PATHEXT: '.EXE;.CMD',
      DEVHUB_UNITY_HUB_ROOT: 'D:\\Unity 编辑器',
      DEVHUB_UNITY_PROJECT: 'E:\\山河问仙\\Unity',
    },
    files: {
      isExecutable: (filename) => files.includes(filename.toLowerCase()),
      readDirectory: () => [],
      readText: (filename) => {
        expect(filename).toBe('E:\\山河问仙\\Unity\\ProjectSettings\\ProjectVersion.txt');
        return 'm_EditorVersion: 6000.3.28f1\r\nm_EditorVersionWithRevision: 6000.3.28f1 (abc)\r\n';
      },
    },
  });
  expect(report.platform).toBe('win32');
  expect(report.checks.map((check) => check.status)).toEqual(Array(7).fill('pass'));
});

it('finds the standard macOS Unity executable', async () => {
  const report = await inspectEnvironment({
    platform: 'darwin',
    readOperatingSystem: async () => ({ version: '14.5' }),
    env: {},
    files: {
      isExecutable: (filename) => filename === '/Applications/Unity/Hub/Editor/6000.3.28f1/Unity.app/Contents/MacOS/Unity',
      readDirectory: () => [],
      readText: () => { throw new Error('No configured project'); },
    },
  });
  expect(report.checks.find((check) => check.id === 'unity')?.status).toBe('pass');
  expect(report.checks.find((check) => check.id === 'unityProject')?.status).toBe('skipped');
});

it('warns when macOS has a different Unity version and fails on the wrong Node major', async () => {
  const report = await inspectEnvironment({
    platform: 'darwin',
    nodeVersion: '22.0.0',
    nodeLts: true,
    readOperatingSystem: async () => ({ version: '14.5' }),
    env: { PATH: '/usr/local/bin:/usr/bin' },
    files: {
      isExecutable: (filename) => [
        '/usr/local/bin/pnpm', '/usr/bin/git',
        '/Applications/Unity/Hub/Editor/6000.4.0f1/Unity.app/Contents/MacOS/Unity',
      ].includes(filename),
      readDirectory: () => ['6000.4.0f1', 'not-an-editor'],
      readText: () => { throw new Error('No configured project'); },
    },
  });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'node', status: 'fail' }));
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'codex', status: 'warning' }));
  expect(report.checks).toContainEqual(expect.objectContaining({
    id: 'unity', status: 'warning', detail: expect.stringContaining('6000.4.0f1'),
  }));
});

it.each([
  { name: 'Windows 10', platform: 'win32', arch: 'x64', version: '10.0.19045', windowsProductType: 1, status: 'fail', detail: '19045' },
  { name: 'Windows 11 minimum', platform: 'win32', arch: 'x64', version: '10.0.22000', windowsProductType: 1, status: 'pass', detail: '22000' },
  { name: 'Windows 11 arm64', platform: 'win32', arch: 'arm64', version: '10.0.26100', windowsProductType: 1, status: 'pass', detail: 'Windows 11 client' },
  { name: 'Windows Server', platform: 'win32', arch: 'x64', version: '10.0.26100', windowsProductType: 3, status: 'fail', detail: 'Windows Server' },
  { name: 'macOS below minimum', platform: 'darwin', arch: 'x64', version: '13.4.1', windowsProductType: undefined, status: 'fail', detail: '13.4.1' },
  { name: 'macOS minimum', platform: 'darwin', arch: 'x64', version: '13.5', windowsProductType: undefined, status: 'pass', detail: '13.5' },
  { name: 'macOS arm64', platform: 'darwin', arch: 'arm64', version: '26.0', windowsProductType: undefined, status: 'pass', detail: '26.0' },
  { name: 'unsupported architecture', platform: 'win32', arch: 'ia32', version: '10.0.26100', windowsProductType: 1, status: 'fail', detail: 'ia32' },
])('checks the supported platform boundary for $name', async (testCase) => {
  const { platform, arch, version, windowsProductType, status, detail } = testCase;
  const report = await inspectEnvironment({
    platform,
    arch,
    env: {},
    readOperatingSystem: async () => ({ version, windowsProductType }),
  });
  expect(report.checks[0]).toMatchObject({ id: 'platform', status, detail: expect.stringContaining(detail) });
});

it('fails clearly when the OS version query fails or returns malformed data', async () => {
  for (const readOperatingSystem of [
    async () => { throw new Error('host-specific diagnostic'); },
    async () => ({ version: 'unrecognized' }),
  ]) {
    const report = await inspectEnvironment({ platform: 'darwin', arch: 'arm64', env: {}, readOperatingSystem });
    expect(report.checks[0]).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('Could not determine the OS version'),
    });
    expect(report.checks[0]?.detail).not.toContain('host-specific');
  }
});

it('reports CLI JSON and uses its check results as the exit status', () => {
  const entry = fileURLToPath(new URL('../apps/runner/bin/devhub.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'doctor', '--json'], { encoding: 'utf8', timeout: 15000 });
  const report = JSON.parse(result.stdout) as { checks: { id: string; status: string; detail: string }[] };
  expect(report.checks).toHaveLength(7);
  expect(result.status).toBe(report.checks.some((check) => check.status === 'fail') ? 1 : 0);
  const osCheck = report.checks.find((check) => check.id === 'platform');
  if (process.platform === 'win32') expect(osCheck?.detail).toMatch(/^Windows (?:11 client|Server|client build)/);
  if (process.platform === 'darwin') expect(osCheck?.detail).toMatch(/^macOS \d+\.\d+/);
}, 20000);
