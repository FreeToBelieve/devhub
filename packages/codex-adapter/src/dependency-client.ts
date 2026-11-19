import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { startDeveloperConnectProxy } from '@devhub/security';

export const dependencyClientOperations = ['npm-install', 'pnpm-install', 'git-fetch', 'upm-download'] as const;
export type DependencyClientOperation = typeof dependencyClientOperations[number];
export const dependencyClientPolicy = Object.freeze({
  version: 2, containment: 'macOS-Seatbelt', operations: dependencyClientOperations, timeoutMs: 120_000, maxCommands: 4,
  gitAttempts: 3, gitAttemptMs: 25_000,
});

const systemReads = ['/System', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/sbin', '/usr/share', '/bin', '/sbin',
  '/Library/Developer/CommandLineTools', '/etc/ssl', '/private/etc/ssl', '/private/etc/hosts', '/private/etc/resolv.conf',
  '/private/var/db/dyld', '/dev/null', '/dev/random', '/dev/urandom'];

export function dependencySandbox(root: string, scratch: string, runtime: readonly string[], port: number) {
  const nodes = (paths: readonly string[]) => paths.map((path) => '(subpath ' + JSON.stringify(path) + ')').join(' ');
  return [
    '(version 1)', '(allow default)',
    '(deny network*)', '(allow network-outbound (remote tcp "localhost:' + port + '"))',
    '(deny file-read*)',
    '(allow file-read* ' + nodes([...systemReads, root, scratch, ...runtime]) + ')',
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read-metadata)',
    '(deny file-write*)',
    '(allow file-write* ' + nodes([root, scratch, '/dev/null']) + ')',
    '(deny file-write* ' + nodes([join(root, '.git'), join(root, '.codex')]) + ')',
    // Older npm versions can still attempt to create an on-disk error log.
    '(deny file-write* ' + nodes([join(scratch, 'cache', '_logs')]) +
      ' (regex #"/(npm|pnpm)-debug[^/]*[.]log$"))',
    '(deny file-read-data (regex #"/([.]env([.]|$)|[.]npmrc$|[.]netrc$|[.]git-credentials$|[.]ssh(/|$)|[.]aws(/|$)|[^/]+[.](pem|key|pfx|p12)$|credentials[.]json$)"))',
    '(allow file-read-data (literal "/etc/ssl/cert.pem") (literal "/private/etc/ssl/cert.pem"))',
  ].join('\n');
}

export function gitFetchDiagnostic(stderr: string, timedOut = false) {
  if (timedOut || /timed out|operation too slow|curl 28\b/i.test(stderr)) return 'GIT_FETCH_TIMEOUT';
  if (/(?:response|HTTP code) 407\b|proxy authentication required/i.test(stderr)) return 'GIT_FETCH_PROXY_AUTH';
  if (/certificate problem|certificate verification failed|SSL certificate|curl (?:51|60)\b/i.test(stderr)) return 'GIT_FETCH_TLS_CERTIFICATE';
  if (/SSL connect error|SSL_ERROR|TLS alert|curl 35\b/i.test(stderr)) return 'GIT_FETCH_TLS_HANDSHAKE';
  if (/HTTP\/2 stream|curl (?:16|92)\b/i.test(stderr)) return 'GIT_FETCH_HTTP2';
  if (/could not resolve|failed to connect|CONNECT tunnel failed|curl (?:5|6|7)\b/i.test(stderr)) return 'GIT_FETCH_CONNECTION';
  if (/connection reset|unexpected disconnect|early EOF|RPC failed|curl (?:18|52|55|56)\b/i.test(stderr)) return 'GIT_FETCH_TRANSFER';
  if (/requested URL returned error|repository not found|could not read Username/i.test(stderr)) return 'GIT_FETCH_REMOTE_REJECTED';
  return 'GIT_FETCH_FAILED';
}

function run(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, diagnoseGit = false) {
  return new Promise<{ exitCode: number; diagnostic?: ReturnType<typeof gitFetchDiagnostic> }>((accept) => {
    let child;
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'ignore', diagnoseGit ? 'pipe' : 'ignore'] });
    } catch {
      accept({ exitCode: -1, ...(diagnoseGit ? { diagnostic: 'GIT_FETCH_FAILED' } : {}) });
      return;
    }
    let timedOut = false;
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => { timedOut = true; child.stderr?.destroy(); child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', () => { if (!child.pid) { clearTimeout(timer); accept({ exitCode: -1 }); } });
    child.once('close', (code) => {
      clearTimeout(timer);
      accept({ exitCode: code ?? -1, ...(diagnoseGit && code !== 0 ? { diagnostic: gitFetchDiagnostic(stderr, timedOut) } : {}) });
    });
  });
}

export function runDependencySandboxed(executable: string, args: readonly string[], cwd: string,
  environment: NodeJS.ProcessEnv, profile: string, timeoutMs: number = dependencyClientPolicy.timeoutMs) {
  if (process.platform !== 'darwin' || !isAbsolute(executable)) throw new Error('PROXY_OS_CONTAINMENT_UNAVAILABLE');
  return run('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], cwd, environment, timeoutMs)
    .then(({ exitCode }) => exitCode);
}

function pinnedCli(tool: 'npm' | 'pnpm', node: string) {
  const runtime = dirname(dirname(node));
  for (const folder of [join(runtime, 'node_modules'), join(runtime, 'lib', 'node_modules'), '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules']) {
    const pkg = join(folder, tool);
    for (const file of tool === 'npm' ? ['npm-cli.js'] : ['pnpm.mjs', 'pnpm.cjs']) {
      const path = join(pkg, 'bin', file);
      if (existsSync(path)) return { path, pkg };
    }
  }
  throw new Error('DEPENDENCY_CLIENT_UNAVAILABLE');
}

export async function installDeveloperDependency(operation: DependencyClientOperation, project: string, remote?: string) {
  if (process.platform !== 'darwin') throw new Error('PROXY_OS_CONTAINMENT_UNAVAILABLE');
  if (!dependencyClientOperations.includes(operation)) throw new Error('DEPENDENCY_OPERATION_DENIED');
  const root = await realpath(project);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'devhub-connect-')));
  let proxy;
  try {
    const node = await realpath(process.execPath);
    const runtime = [dirname(dirname(node))];
    let executable = node;
    let args: string[];
    let cwd = root;
    let artifact: string | undefined;
    if (operation === 'git-fetch') {
      const target = /^https:\/\/github[.]com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i.exec(remote ?? '');
      if (!remote || !target || target.slice(1).some((part) => part === '.' || part === '..')) {
        throw new Error('DEPENDENCY_REMOTE_DENIED');
      }
      const commandLineGit = '/Library/Developer/CommandLineTools/usr/bin/git';
      executable = existsSync(commandLineGit) ? commandLineGit : '/usr/bin/git';
      cwd = join(scratch, 'git');
      await mkdir(cwd);
      args = ['-c', 'http.version=HTTP/2', '-c', 'http.sslCAInfo=/etc/ssl/cert.pem', '-c', 'http.sslVerify=true',
        '-c', 'http.followRedirects=false', '-c', 'http.proxyAuthMethod=basic', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=10',
        '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--depth=1', remote, 'HEAD'];
    } else if (operation === 'upm-download') {
      const archive = /^(?:https:\/\/(?:download[.])?packages[.]unity[.]com)\/(com[.]unity[.][a-z0-9.-]+)\/-\/\1-[0-9][a-z0-9.-]*[.]tgz$/i;
      if (!remote || !archive.test(remote)) throw new Error('DEPENDENCY_REMOTE_DENIED');
      executable = '/usr/bin/curl';
      artifact = 'devhub-upm-' + randomUUID() + '.tgz';
      args = ['--disable', '--http1.1', '--fail', '--silent', '--location', '--max-redirs', '4',
        '--retry', '2', '--retry-all-errors', '--max-time', '90', '--proto', '=https',
        '--proto-redir', '=https', '--output', join(root, artifact), remote];
    } else {
      const tool = operation === 'npm-install' ? 'npm' : 'pnpm';
      const cli = pinnedCli(tool, node);
      const packageRoot = await realpath(cli.pkg);
      const cliPath = await realpath(cli.path);
      const packagePath = relative(packageRoot, cliPath);
      if (packagePath.startsWith('..') || isAbsolute(packagePath)) throw new Error('DEPENDENCY_CLIENT_UNAVAILABLE');
      runtime.push(packageRoot);
      args = [cliPath, 'install', '--ignore-scripts', '--registry=https://registry.npmjs.org/',
        ...(tool === 'npm' ? ['--no-audit', '--no-fund'] :
          ['--reporter=silent', '--ignore-pnpmfile', '--store-dir', join(scratch, 'store')])];
    }
    proxy = await startDeveloperConnectProxy(undefined, operation === 'git-fetch');
    const userConfig = join(scratch, 'empty-user-config');
    const globalConfig = join(scratch, 'empty-global-config');
    await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')]);
    const environment = {
      HOME: scratch, TMPDIR: scratch, PATH: [dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: join(scratch, 'cache'), npm_config_manage_package_manager_versions: 'false',
      npm_config_loglevel: 'silent', npm_config_logs_max: '0', npm_config_timing: 'false',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    };
    const policy = dependencySandbox(root, scratch, runtime, proxy.port);
    if (operation === 'git-fetch' && await runDependencySandboxed(executable, ['init', '--bare', '--quiet'], cwd, environment, policy) !== 0) {
      throw new Error('DEPENDENCY_GIT_SETUP_FAILED');
    }
    let exitCode = -1;
    const gitAttempts: ReturnType<typeof gitFetchDiagnostic>[] = [];
    const target = proxy.clientProxyUrl();
    const networkEnvironment = {
      ...environment, HTTP_PROXY: target, HTTPS_PROXY: target, http_proxy: target, https_proxy: target,
      NO_PROXY: '', no_proxy: '',
    };
    const attempts = operation === 'git-fetch' ? dependencyClientPolicy.gitAttempts : 1;
    const timeout = operation === 'git-fetch' ? dependencyClientPolicy.gitAttemptMs : dependencyClientPolicy.timeoutMs;
    for (let attempt = 0; attempt < attempts && exitCode !== 0; attempt++) {
      if (operation === 'git-fetch') {
        const result = await run('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], cwd, networkEnvironment, timeout, true);
        exitCode = result.exitCode;
        if (result.diagnostic) gitAttempts.push(result.diagnostic);
      } else {
        exitCode = await runDependencySandboxed(executable, args, cwd, networkEnvironment, policy, timeout);
      }
    }
    if (artifact && exitCode !== 0) await rm(join(root, artifact), { force: true });
    if (artifact && exitCode === 0) {
      const stat = await lstat(join(root, artifact));
      if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0) throw new Error('DEPENDENCY_TRANSFER_FAILED');
    }
    if (operation === 'git-fetch' && exitCode === 0 &&
        await runDependencySandboxed(executable, ['rev-parse', '--verify', 'FETCH_HEAD'], cwd, environment, policy) !== 0) {
      throw new Error('DEPENDENCY_TRANSFER_FAILED');
    }
    return { exitCode, proxy: proxy.stats(), ...(artifact && exitCode === 0 ? { artifact } : {}),
      ...(gitAttempts.length ? { gitDiagnostics: gitAttempts } : {}),
      ...(operation === 'git-fetch' && exitCode === 0 ? { gitHeadVerified: true } : {}) };
  } finally {
    if (proxy) await proxy.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
