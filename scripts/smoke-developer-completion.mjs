import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, mkdtempDisposableSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexConfiguration } from '../packages/codex-adapter/dist/index.js';
import { dependencySandbox, installDeveloperDependency, runDependencySandboxed } from '../packages/codex-adapter/dist/dependency-client.js';
import { startDeveloperConnectProxy } from '../packages/security/dist/index.js';

if (process.platform !== 'darwin' || !process.env.DEVHUB_CODEX_BIN) throw new Error('Set DEVHUB_CODEX_BIN to the installed macOS SDK CLI.');
const temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-completion-'));

try {
  const root = realpathSync(temporary.path);
  function directory(name) { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; }
  const project = directory('secrets-fixture');
  const profile = directory('synthetic-profile');
  const fixture = directory('network-fixture');
  mkdirSync(join(project, 'nested'));
  const secrets = ['.env', '.npmrc', 'nested/private-fixture.pem', 'nested/signing.key', 'nested/credentials.json'];
  for (const file of [...secrets, '.env.example', 'nested/component.cs']) {
    writeFileSync(join(project, file), file === '.env.example' ? 'API_TOKEN=example\n' : 'synthetic fixture\n');
  }
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: profile, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe',
  });
  git(project, 'init', '-q');
  const native = codexConfiguration(project);
  const result = execFileSync(process.env.DEVHUB_CODEX_BIN, ['sandbox', '--permission-profile', 'PROJECT_DEVELOPER', '--cd', project,
    ...native.rawConfigOverrides.flatMap((value) => ['-c', value]), '--', '/bin/sh', '-c',
    'set -eu; for fixture in "$@"; do if /bin/cat "$fixture" >/dev/null 2>&1; then exit 21; fi; done; ' +
    '/bin/cat .env.example nested/component.cs >/dev/null; printf ok >> nested/component.cs; printf PASS',
    'devhub-fixture', ...secrets], { env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: profile }, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result, 'PASS');
  console.log('PASS native PROJECT_DEVELOPER denies 5 in-workspace secret fixtures and permits the template and source');

  const proxy = await startDeveloperConnectProxy();
  let decoyRequests = 0;
  const decoy = createServer((_request, response) => { decoyRequests++; response.end('synthetic fixture'); });
  await new Promise((accept) => decoy.listen(0, '127.0.0.1', accept));
  try {
    const direct = await lookup('registry.npmjs.org', { family: 4 });
    for (const [kind, url] of [['other loopback', 'http://127.0.0.1:' + decoy.address().port],
      ['direct public HTTPS', 'https://registry.npmjs.org/is-number']]) {
      const code = await runDependencySandboxed('/usr/bin/curl', ['--noproxy', '*', '--connect-timeout', '3', '--max-time', '4',
        '--resolve', 'registry.npmjs.org:443:' + direct.address, '--silent', '--fail', url],
      fixture, { PATH: '/usr/bin:/bin', HOME: fixture }, dependencySandbox(fixture, fixture, [], proxy.port), 6000);
      assert.notEqual(code, 0, kind);
    }
    assert.equal(proxy.stats().attempts, 0);
    assert.equal(decoyRequests, 0);
    const logDir = join(fixture, 'cache', '_logs');
    mkdirSync(logDir, { recursive: true });
    const logGuard = await runDependencySandboxed('/bin/sh', ['-c',
      '! (printf fixture > "$1") && ! (printf fixture > "$2") && ! (printf fixture > "$3")',
      'devhub-log-fixture', join(logDir, 'unexpected.log'), join(fixture, 'npm-debug.log'), join(fixture, 'pnpm-debug.log')],
    fixture, { PATH: '/usr/bin:/bin', HOME: fixture }, dependencySandbox(fixture, fixture, [], proxy.port), 6000);
    assert.equal(logGuard, 0);
    console.log('PASS Seatbelt denies dependency debug log writes');
    const proxied = await runDependencySandboxed('/usr/bin/curl', ['--disable', '--http1.1',
      '--max-time', '12', '--retry', '2', '--retry-all-errors', '--silent', '--fail', 'https://registry.npmjs.org/is-number/7.0.0'],
    fixture, { PATH: '/usr/bin:/bin', HOME: fixture, HTTPS_PROXY: proxy.clientProxyUrl() },
    dependencySandbox(fixture, fixture, [], proxy.port), 42_000);
    assert.equal(proxied, 0, JSON.stringify(proxy.stats()));
    assert.ok(proxy.stats().accepted >= 1);
    assert.ok(proxy.stats().downloaded > 0);
    console.log('PASS Seatbelt denies public and other loopback direct connections and allows HTTPS through CONNECT');
  } finally {
    await proxy.close();
    decoy.closeAllConnections();
    await new Promise((accept) => decoy.close(accept));
  }

  for (const operation of ['npm-install', 'pnpm-install', 'git-fetch']) {
    const path = directory(operation);
    git(path, 'init', '-q');
    writeFileSync(join(path, 'package.json'), JSON.stringify({
      name: 'devhub-connect-fixture', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' },
    }));
    const result = await installDeveloperDependency(operation, path,
      operation === 'git-fetch' ? 'https://github.com/FreeToBelieve/devhub.git' : undefined);
    console.log(JSON.stringify({ operation, ...result }));
    assert.equal(result.exitCode, 0, operation);
    assert.ok(result.proxy.accepted > 0 && result.proxy.downloaded > 0, operation);
    if (operation === 'git-fetch') assert.equal(result.gitHeadVerified, true);
    else assert.ok(existsSync(join(path, 'node_modules', 'is-number', 'package.json')));
  }
} finally { temporary.remove(); }
