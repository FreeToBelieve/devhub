import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unityScenePathSchema, unityVersion } from '@devhub/contracts';
import type { UnityEnvironment, UnityPlan } from '@devhub/contracts';
import { sha256, windowsPowerShellEnvironment, windowsPowerShellPath } from '@devhub/security';
import { pathInside } from './artifacts.js';

const exec = promisify(execFile);
export const unityPolicyVersion = 1;
export const minimumFreeBytes = 5 * 1024 ** 3;

async function exists(path: string) {
  return !!await lstat(path).catch(() => undefined);
}

export function unityEditorRoots(env: NodeJS.ProcessEnv, platform = process.platform) {
  const defaults = platform === 'win32'
    ? [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter(Boolean).map((path) => join(path!, 'Unity', 'Hub', 'Editor'))
    : ['/Applications/Unity/Hub/Editor', join(homedir(), 'Applications', 'Unity', 'Hub', 'Editor')];
  return [...new Set([...(env.DEVHUB_UNITY_HUB_ROOT ? [resolve(env.DEVHUB_UNITY_HUB_ROOT)] : []), ...defaults])];
}

async function executable(path: string) {
  try {
    const actual = await realpath(path);
    await access(actual, constants.X_OK);
    if ((await stat(actual)).isFile()) return actual;
  } catch { /* missing or inaccessible */ }
  return null;
}

export async function findFfmpeg(env = process.env) {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const configured = env.DEVHUB_UNITY_FFMPEG;
  if (configured) return isAbsolute(configured) ? executable(configured) : null;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const found = await executable(join(directory, name));
    if (found) return found;
  }
  return null;
}

async function graphicsAvailable() {
  if (process.platform === 'darwin') {
    const console = await stat('/dev/console').catch(() => undefined);
    return console?.uid === process.getuid?.();
  }
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await exec(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command',
      '[int]([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -gt 0)'], {
      env: windowsPowerShellEnvironment(), timeout: 4000, windowsHide: true,
    });
    return stdout.trim() === '1';
  } catch { return false; }
}

export async function inspectUnityEnvironment(project?: string, env = process.env): Promise<UnityEnvironment> {
  const windows = process.platform === 'win32';
  const supported = windows ? process.arch === 'x64' : process.platform === 'darwin' && process.arch === 'arm64';
  const platform = supported ? (windows ? 'WINDOWS' : 'MACOS') : null;
  let editor: string | null = null;
  let buildSupport = false;
  let projectVersion: string | null = null;
  let projectLocked = false;
  let layoutValid = true;
  const paths = windows ? ['Editor', 'Unity.exe'] : ['Unity.app', 'Contents', 'MacOS', 'Unity'];
  if (supported) for (const root of unityEditorRoots(env)) {
    editor = await executable(join(root, unityVersion, ...paths));
    if (editor) break;
  }
  if (editor) buildSupport = await exists(windows
    ? join(dirname(editor), 'Data', 'PlaybackEngines', 'WindowsStandaloneSupport')
    : join(dirname(editor), '..', 'PlaybackEngines', 'MacStandaloneSupport'));
  if (project) {
    const version = await readFile(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').catch(() => '');
    projectVersion = /^m_EditorVersion:[ \t]*(\d+\.\d+\.\d+[abfp]\d+)\s*$/m.exec(version)?.[1] ?? null;
    projectLocked = await exists(join(project, 'Temp', 'UnityLockfile'));
    layoutValid = (await lstat(join(project, 'Assets')).catch(() => undefined))?.isDirectory() === true;
  }
  const hubPaths = windows
    ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'Unity Hub', 'Unity Hub.exe')]
    : ['/Applications/Unity Hub.app', join(homedir(), 'Applications', 'Unity Hub.app')];
  const licensePaths = windows
    ? [join(env.ProgramData ?? 'C:\\ProgramData', 'Unity', 'Unity_lic.ulf')]
    : ['/Library/Application Support/Unity/Unity_lic.ulf', join(homedir(), 'Library', 'Application Support', 'Unity', 'Unity_lic.ulf')];
  const space = await statfs(project ?? process.cwd()).catch(() => undefined);
  const freeBytes = space ? space.bavail * space.bsize : null;
  const [graphics, hubs, licenses] = await Promise.all([
    graphicsAvailable(), Promise.all(hubPaths.map(exists)), Promise.all(licensePaths.map(exists)),
  ]);
  const diagnostics = [
    ...(!platform ? ['UNITY_PLATFORM_UNSUPPORTED'] : []), ...(!editor ? ['UNITY_EDITOR_MISSING'] : []),
    ...(editor && !buildSupport ? ['UNITY_BUILD_SUPPORT_MISSING'] : []),
    ...(project && projectVersion !== unityVersion ? ['UNITY_PROJECT_VERSION_MISMATCH'] : []),
    ...(!layoutValid ? ['UNITY_PROJECT_LAYOUT_INVALID'] : []),
    ...(projectLocked ? ['UNITY_PROJECT_LOCKED'] : []), ...(!graphics ? ['UNITY_GRAPHICS_UNAVAILABLE'] : []),
    ...(freeBytes === null || freeBytes < minimumFreeBytes ? ['UNITY_DISK_LIMIT'] : []),
  ];
  return { version: unityVersion, platform, editor, hub: hubs.some(Boolean), projectVersion, buildSupport,
    license: licenses.some(Boolean) ? 'FILE_PRESENT' : 'UNVERIFIED', graphics, freeBytes, projectLocked, diagnostics };
}

export async function verifyUnityScene(project: string, scene: string) {
  if (!unityScenePathSchema.safeParse(scene).success) throw new Error('UNITY_SCENE_MISSING');
  const root = await realpath(project);
  const requested = join(root, scene);
  const actual = await realpath(requested).catch(() => null);
  if (!actual || !pathInside(root, actual) || !(await lstat(requested).catch(() => null))?.isFile()) {
    throw new Error('UNITY_SCENE_MISSING');
  }
}

export async function unityConfiguration(project: string, plan: UnityPlan) {
  if (plan.scene) await verifyUnityScene(project, plan.scene);
  const environment = await inspectUnityEnvironment(project);
  if (!environment.editor || !environment.platform || environment.projectVersion !== unityVersion ||
      environment.projectLocked || environment.freeBytes === null || environment.freeBytes < minimumFreeBytes) {
    throw new Error(environment.diagnostics.find((code) => code !== 'UNITY_GRAPHICS_UNAVAILABLE' &&
      code !== 'UNITY_BUILD_SUPPORT_MISSING') ?? 'UNITY_ENVIRONMENT_UNAVAILABLE');
  }
  if (environment.diagnostics.includes('UNITY_PROJECT_LAYOUT_INVALID')) throw new Error('UNITY_PROJECT_LAYOUT_INVALID');
  if (['BUILD', 'PLAYER', 'PIPELINE'].includes(plan.stage) && !environment.buildSupport) throw new Error('UNITY_BUILD_SUPPORT_MISSING');
  if (['EDITOR', 'GAME_VIEW', 'PLAYER', 'PIPELINE'].includes(plan.stage) && !environment.graphics) throw new Error('UNITY_GRAPHICS_UNAVAILABLE');
  const ffmpeg = plan.capture ? await findFfmpeg() : null;
  if (plan.capture && !ffmpeg) throw new Error('UNITY_CAPTURE_ENCODER_MISSING');
  const binary = await stat(environment.editor, { bigint: true });
  const configSha256 = sha256(JSON.stringify({ policy: unityPolicyVersion, version: unityVersion, plan,
    platform: environment.platform, executable: environment.editor, size: binary.size.toString(), mtimeNs: binary.mtimeNs.toString(), ffmpeg }));
  return { environment, configSha256, editor: environment.editor, ffmpeg };
}
