import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { DoctorCheck, DoctorReport } from '@devhub/contracts';
import { supportsUnityEditorVersion, unityEditorVersionSchema } from '@devhub/contracts';
import { inspectUnityEnvironment } from '@devhub/unity-adapter';
import { checkOperatingSystem, readOperatingSystem } from './operating-system.js';

interface FileProbes {
  isExecutable(filename: string): boolean;
  readDirectory(directory: string): string[];
  readText(filename: string): string;
}

interface Machine {
  platform: string;
  arch: string;
  nodeVersion: string;
  nodeLts: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  files: FileProbes;
  readOperatingSystem: typeof readOperatingSystem;
}

const localFiles: FileProbes = {
  isExecutable(filename) {
    try {
      accessSync(filename, constants.X_OK);
      return statSync(filename).isFile();
    } catch {
      return false;
    }
  },
  readDirectory: readdirSync,
  readText: (filename) => readFileSync(filename, 'utf8'),
};

function pathHasCommand(machine: Machine, command: string): boolean {
  const paths = machine.platform === 'win32' ? win32 : posix;
  const suffixes = machine.platform === 'win32'
    ? (machine.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      .filter((suffix) => /^\.(exe|cmd|bat|com)$/i.test(suffix))
    : [''];
  const directories = (machine.env.PATH ?? machine.env.Path ?? '').split(paths.delimiter);
  return directories.some((entry) => {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    return directory !== '' && suffixes.some((suffix) => (
      machine.files.isExecutable(paths.resolve(machine.cwd, directory, command + suffix))
    ));
  });
}

function checkUnity(machine: Machine, requested: string | undefined): DoctorCheck {
  if (machine.platform !== 'win32' && machine.platform !== 'darwin') {
    return { id: 'unity', status: 'skipped', detail: 'Unity detection is available on Windows and macOS.' };
  }

  const { env, files } = machine;
  const windows = machine.platform === 'win32';
  const paths = windows ? win32 : posix;
  const defaults = windows
    ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']
      .filter((directory): directory is string => Boolean(directory))
      .map((directory) => paths.join(directory, 'Unity', 'Hub', 'Editor'))
    : [
      '/Applications/Unity/Hub/Editor',
      ...(env.HOME ? [paths.join(env.HOME, 'Applications', 'Unity', 'Hub', 'Editor')] : []),
    ];
  const roots = new Set([
    ...(env.DEVHUB_UNITY_HUB_ROOT ? [paths.resolve(machine.cwd, env.DEVHUB_UNITY_HUB_ROOT)] : []),
    ...defaults,
  ]);
  const executable = windows ? ['Editor', 'Unity.exe'] : ['Unity.app', 'Contents', 'MacOS', 'Unity'];
  const hasEditor = (root: string, version: string) => files.isExecutable(paths.join(root, version, ...executable));
  const detected = new Set<string>();
  for (const root of roots) {
    if (requested && supportsUnityEditorVersion(requested) && hasEditor(root, requested)) {
      return { id: 'unity', status: 'pass', detail: `Unity ${requested} executable found.` };
    }
    let folders: string[];
    try { folders = files.readDirectory(root); }
    catch { continue; }
    for (const folder of folders) {
      if (supportsUnityEditorVersion(folder) && hasEditor(root, folder)) detected.add(folder);
    }
  }
  const alternatives = [...detected].sort();
  if (!requested && alternatives.length) return { id: 'unity', status: 'pass', detail: 'Installed Unity: ' + alternatives.join(', ') };
  return { id: 'unity', status: 'warning', detail: requested
    ? 'Requested Unity ' + requested + ' was not found. Installed: ' + (alternatives.join(', ') || 'none')
    : 'No supported Unity executable was found in the configured or standard locations.' };
}

function checkUnityProject(machine: Machine): { check: DoctorCheck; version?: string } {
  const project = machine.env.DEVHUB_UNITY_PROJECT;
  if (!project) return { check: { id: 'unityProject', status: 'skipped', detail: 'DEVHUB_UNITY_PROJECT is unset.' } };
  const paths = machine.platform === 'win32' ? win32 : posix;
  try {
    const content = machine.files.readText(paths.resolve(machine.cwd, project, 'ProjectSettings', 'ProjectVersion.txt'));
    const version = unityEditorVersionSchema.safeParse(/^m_EditorVersion:[ \t]*(\S+)[ \t]*\r?$/m.exec(content)?.[1]);
    if (version.success) {
      return { version: version.data, check: { id: 'unityProject', status: supportsUnityEditorVersion(version.data) ? 'pass' : 'warning',
        detail: 'Project requests Unity ' + version.data + '.' } };
    }
  } catch {
    return { check: { id: 'unityProject', status: 'warning', detail: 'ProjectSettings/ProjectVersion.txt cannot be read.' } };
  }
  return { check: { id: 'unityProject', status: 'warning', detail: 'ProjectVersion.txt has no valid Editor version.' } };
}

export async function inspectEnvironment(overrides: Partial<Machine> = {}): Promise<DoctorReport> {
  const machine: Machine = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    nodeLts: Boolean(process.release.lts),
    cwd: process.cwd(),
    env: process.env,
    files: localFiles,
    readOperatingSystem,
    ...overrides,
  };
  const { platform, arch, nodeVersion, nodeLts } = machine;
  const checks: DoctorCheck[] = [
    await checkOperatingSystem(platform, arch, machine.readOperatingSystem),
    {
      id: 'node',
      status: nodeLts && nodeVersion.startsWith('24.') ? 'pass' : 'fail',
      detail: `Node.js ${nodeVersion}. DevHub requires Node.js 24 LTS.`,
    },
  ];
  for (const command of ['pnpm', 'git', 'codex'] as const) {
    const found = pathHasCommand(machine, command);
    checks.push({
      id: command,
      status: found ? 'pass' : command === 'codex' ? 'warning' : 'fail',
      detail: found ? `${command} is available on PATH.` : `${command} was not found on PATH.`,
    });
  }
  const project = checkUnityProject(machine);
  const editor = checkUnity(machine, project.version);
  checks.push(editor, project.check);
  const unity = Object.keys(overrides).length === 0 ? await inspectUnityEnvironment(machine.env.DEVHUB_UNITY_PROJECT) : undefined;
  if (unity && !unity.editor && editor.status === 'pass') {
    editor.status = 'warning';
    editor.detail = 'The installed Unity executable could not be verified for this project.';
  }
  return { platform, arch, checks, ...(unity ? { unity } : {}) };
}
