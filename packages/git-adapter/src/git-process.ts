import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { GitProviderError } from '@devhub/git-provider';

const exec = promisify(execFile);
const runtimeEnv = ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR'];
export const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

function command(root: string, args: readonly string[], extra: NodeJS.ProcessEnv) {
  const argv = ['-C', root, '-c', 'core.hooksPath=' + nullDevice, '-c', 'core.fsmonitor=false', '-c', 'core.trustctime=true',
    '-c', 'core.checkStat=default', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false',
    '-c', 'protocol.allow=never', '-c', 'commit.gpgSign=false', '-c', 'core.logAllRefUpdates=true',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args];
  const env = Object.fromEntries(runtimeEnv.map((key) => [key, process.env[key]]));
  return { argv, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1', ...extra } };
}

const localFailure = () => new GitProviderError('GIT_LOCAL_COMMAND_FAILED');

export async function git(root: string, args: readonly string[], extra: NodeJS.ProcessEnv = {},
  allowedCodes: readonly number[] = [], input?: string) {
  const { argv, env } = command(root, args, extra);
  try {
    const run = exec('git', argv, { env, windowsHide: true, timeout: 100_000, maxBuffer: 4 * 1024 ** 2 });
    if (input !== undefined) {
      run.child.stdin?.on('error', () => undefined);
      run.child.stdin?.end(input);
    }
    return (await run).stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && allowedCodes.includes(code)) return '';
    throw localFailure();
  }
}

export async function gitStream(root: string, args: readonly string[], env: NodeJS.ProcessEnv,
  consume: (data: Buffer) => void, stdin: number | 'ignore' = 'ignore') {
  const config = command(root, args, env);
  const child = spawn('git', config.argv, {
    env: config.env, windowsHide: true, stdio: [stdin, 'pipe', 'ignore'], timeout: 100_000,
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  try {
    if (!child.stdout) throw localFailure();
    for await (const data of child.stdout) consume(data as Buffer);
    if (await exit !== 0) throw localFailure();
  } catch (error) {
    child.kill();
    await exit;
    throw error instanceof GitProviderError ? error : localFailure();
  }
}
