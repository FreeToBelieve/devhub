import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { codexEnvironment, developerDomains, providerProxyEndpoint, sha256 } from '@devhub/security';

const sdkVersion = '0.170.0';
const exec = promisify(execFile);
const windowsProfileCheck = fileURLToPath(new URL('../windows/profile-permissions.ps1', import.meta.url));
const brokerPath = fileURLToPath(new URL('./dependency-broker.js', import.meta.url));
export type DeveloperNetworkMode = 'OFF' | 'DEVELOPER_ALLOWLIST';

interface AdapterConfiguration {
  sdkVersion: string;
  thread: ThreadOptions;
  config: NonNullable<CodexOptions['config']>;
  providerProxy: string | null;
  executionProfile: 'PROJECT_DEVELOPER';
  networkMode: DeveloperNetworkMode;
  rawConfigOverrides: string[];
  dependencyDomains: readonly string[];
  usesLocalLogin: boolean;
}

export function codexConfiguration(worktree: string, platform = process.platform,
  networkMode: DeveloperNetworkMode = 'OFF'): AdapterConfiguration {
  const thread: ThreadOptions = {
    approvalPolicy: 'never',
    workingDirectory: worktree,
    skipGitRepoCheck: false,
    webSearchMode: 'disabled',
    additionalDirectories: [],
  };
  const config: NonNullable<CodexOptions['config']> = {
    approvals_reviewer: 'user',
    default_permissions: 'PROJECT_DEVELOPER',
    shell_environment_policy: { inherit: 'none', ignore_default_excludes: false },
    features: { apps: false, plugins: false, remote_plugin: false, network_proxy: false },
    ...(platform === 'win32' ? { windows: { sandbox: 'elevated' } } : {}),
    mcp_servers: networkMode === 'DEVELOPER_ALLOWLIST' ? { devhub_dependencies: {
      enabled: true, command: process.execPath, args: [brokerPath, worktree], required: true, tool_timeout_sec: 60,
    } } : {},
  };
  // CLI sandbox_mode would select the legacy workspace profile instead of the native named profile.
  const rawConfigOverrides = [
    'permissions.PROJECT_DEVELOPER.extends=":workspace"',
    'permissions.PROJECT_DEVELOPER.filesystem={ ":root" = "deny", ":minimal" = "read", ":tmpdir" = "deny", ":slash_tmp" = "deny" }',
    'permissions.PROJECT_DEVELOPER.network.enabled=false',
  ];
  return {
    sdkVersion, thread, config, rawConfigOverrides, executionProfile: 'PROJECT_DEVELOPER', networkMode,
    dependencyDomains: networkMode === 'DEVELOPER_ALLOWLIST' ? developerDomains : [],
    usesLocalLogin: process.platform === 'darwin' && process.env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN === '1',
    providerProxy: providerProxyEndpoint(process.env.DEVHUB_CODEX_PROVIDER_PROXY),
  };
}

export function codexConfigDigest(worktree: string, networkMode: DeveloperNetworkMode = 'OFF'): string {
  return sha256(JSON.stringify(codexConfiguration(worktree, process.platform, networkMode)));
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

function profileEntry(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export async function isolatedCodexHome(home: string, worktree: string): Promise<string> {
  if (!isAbsolute(home)) throw new Error('DEVHUB_CODEX_HOME must be an absolute dedicated profile path.');
  const entry = await lstat(home);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('An ordinary Codex profile directory is required.');
  if (process.platform !== 'win32' && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.())) {
    throw new Error('The Codex profile must be private to the current user.');
  }
  const [profile, workspace] = await Promise.all([realpath(home), realpath(worktree)]);
  if (inside(workspace, profile) || inside(profile, workspace)) {
    throw new Error('The Codex login profile must be separate from the worktree.');
  }
  const loginPath = join(profile, 'auth.json');
  let auth = await profileEntry(loginPath);
  if (auth?.isSymbolicLink() && process.platform === 'darwin' && process.env.DEVHUB_REUSE_LOCAL_CODEX_LOGIN === '1') {
    const localHome = join(homedir(), '.codex');
    const localDirectory = await lstat(localHome);
    if (!localDirectory.isDirectory() || localDirectory.uid !== process.getuid?.() || (localDirectory.mode & 0o022) !== 0) {
      throw new Error('CODEX_AUTH_FILE_NOT_PRIVATE');
    }
    const localAuth = join(await realpath(localHome), 'auth.json');
    if (await realpath(loginPath) !== localAuth || inside(workspace, localAuth)) {
      throw new Error('CODEX_AUTH_FILE_NOT_PRIVATE');
    }
    auth = await lstat(localAuth);
  }
  if (auth && (!auth.isFile() || auth.nlink !== 1 || (process.platform !== 'win32' &&
    ((auth.mode & 0o077) !== 0 || auth.uid !== process.getuid?.())))) {
    throw new Error('CODEX_AUTH_FILE_NOT_PRIVATE');
  }
  if (process.platform === 'win32') {
    try {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsProfileCheck], {
        env: { ...codexEnvironment(process.env, profile), DEVHUB_PROFILE_CHECK_ROOT: profile },
        windowsHide: true, timeout: 8000,
      });
    } catch {
      throw new Error('CODEX_PROFILE_ACL_UNVERIFIED');
    }
  }
  for (const name of ['config.toml', 'requirements.toml', 'environments.toml', 'environments', '.env',
    'rules', 'hooks', 'hooks.json', 'plugins', 'AGENTS.md', 'AGENTS.override.md']) {
    const path = await profileEntry(join(profile, name));
    if (path) throw new Error('Use a dedicated login-only Codex profile without custom configuration or extensions.');
  }
  const skillsPath = join(profile, 'skills');
  const skills = await profileEntry(skillsPath);
  if (skills) {
    // Codex installs skills/.system during the first turn in a fresh profile.
    if (!skills.isDirectory() || (await readdir(skillsPath, { withFileTypes: true })).some(
      (installed) => installed.name !== '.system' || !installed.isDirectory(),
    )) {
      throw new Error('Use a dedicated Codex profile without custom skills.');
    }
  }
  return profile;
}

export async function streamCodexTurn(input: {
  worktree: string;
  profile: string;
  prompt: string;
  threadId: string | null;
  signal: AbortSignal;
  networkMode?: DeveloperNetworkMode;
}): Promise<AsyncGenerator<ThreadEvent>> {
  const profile = await isolatedCodexHome(input.profile, input.worktree);
  input.signal.throwIfAborted();
  const { thread, config, providerProxy, rawConfigOverrides } = codexConfiguration(input.worktree, process.platform, input.networkMode);
  const sdk = new Codex({ env: codexEnvironment(process.env, profile, providerProxy), config, configOverrides: rawConfigOverrides });
  const conversation = input.threadId === null ? sdk.startThread(thread) : sdk.resumeThread(input.threadId, thread);
  return (await conversation.runStreamed(input.prompt, { signal: input.signal })).events;
}

export function summarizeCodexEvent(event: ThreadEvent) {
  const summary: {
    kind: ThreadEvent['type']; threadId?: string; itemType?: string; exitCode?: number; changedFiles?: number;
  } = { kind: event.type };
  if (event.type === 'thread.started') summary.threadId = event.thread_id;
  if ('item' in event) {
    summary.itemType = event.item.type;
    if (event.item.type === 'command_execution' && Number.isSafeInteger(event.item.exit_code)) {
      summary.exitCode = event.item.exit_code;
    }
    if (event.item.type === 'file_change') summary.changedFiles = event.item.changes.length;
  }
  return summary;
}
