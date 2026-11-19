import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { codexEnvironment, defaultToolNetworkPolicy, providerProxyEndpoint, sha256 } from '@devhub/security';

const sdkVersion = '0.170.0';

interface AdapterConfiguration {
  sdkVersion: string;
  thread: ThreadOptions;
  config: NonNullable<CodexOptions['config']>;
  providerProxy: string | null;
}

export function codexConfiguration(worktree: string, platform = process.platform): AdapterConfiguration {
  const thread: ThreadOptions = {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    workingDirectory: worktree,
    skipGitRepoCheck: false,
    networkAccessEnabled: defaultToolNetworkPolicy.enabled,
    webSearchMode: 'disabled',
    additionalDirectories: [],
  };
  const config: NonNullable<CodexOptions['config']> = {
    approvals_reviewer: 'user',
    sandbox_workspace_write: { exclude_tmpdir_env_var: true, exclude_slash_tmp: true, writable_roots: [] },
    shell_environment_policy: { inherit: 'none', ignore_default_excludes: false },
    features: { apps: false, plugins: false, remote_plugin: false },
    ...(platform === 'win32' ? { windows: { sandbox: 'elevated' } } : {}),
  };
  return { sdkVersion, thread, config, providerProxy: providerProxyEndpoint(process.env.DEVHUB_CODEX_PROVIDER_PROXY) };
}

export function codexConfigDigest(worktree: string): string {
  return sha256(JSON.stringify(codexConfiguration(worktree)));
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
  for (const name of ['config.toml', 'rules', 'hooks', 'hooks.json', 'plugins', 'AGENTS.md', 'AGENTS.override.md']) {
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
}): Promise<AsyncGenerator<ThreadEvent>> {
  const profile = await isolatedCodexHome(input.profile, input.worktree);
  input.signal.throwIfAborted();
  const { thread, config, providerProxy } = codexConfiguration(input.worktree);
  const sdk = new Codex({ env: codexEnvironment(process.env, profile, providerProxy), config });
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
