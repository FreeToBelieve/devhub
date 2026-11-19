import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectEnvironment } from '@devhub/runner';
import { expect, it } from 'vitest';

it('recognizes Windows PATH launchers, custom Unicode Unity locations and CRLF project files', () => {
  const files = [
    'C:\\Program Files\\工具\\pnpm.cmd',
    'C:\\Program Files\\工具\\git.exe',
    'C:\\Program Files\\工具\\codex.cmd',
    'D:\\Unity 编辑器\\6000.3.28f1\\Editor\\Unity.exe',
  ].map((filename) => filename.toLowerCase());
  const report = inspectEnvironment({
    platform: 'win32',
    arch: 'x64',
    nodeLts: true,
    nodeVersion: '24.22.3',
    cwd: 'C:\\ShanHe DevHub',
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

it('finds the standard macOS Unity executable', () => {
  const report = inspectEnvironment({
    platform: 'darwin',
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

it('warns when macOS has a different Unity version and fails on the wrong Node major', () => {
  const report = inspectEnvironment({
    platform: 'darwin',
    nodeVersion: '22.0.0',
    nodeLts: true,
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

it('reports CLI JSON and uses its check results as the exit status', () => {
  const entry = fileURLToPath(new URL('../apps/runner/bin/devhub.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'doctor', '--json'], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout) as { checks: { status: string }[] };
  expect(report.checks).toHaveLength(7);
  expect(result.status).toBe(report.checks.some((check) => check.status === 'fail') ? 1 : 0);
});
