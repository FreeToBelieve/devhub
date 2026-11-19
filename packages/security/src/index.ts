import { win32 } from 'node:path';

export const LOOPBACK_HOST = '127.0.0.1';

export function windowsPowerShellPath(): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  // A parent pwsh session may export module paths for an incompatible PowerShell version.
  return { ...env, PSModulePath: win32.join(win32.dirname(windowsPowerShellPath()), 'Modules') };
}

export function allowsLocalRequest(
  host: string | undefined,
  origin: string | undefined,
  port: number,
): boolean {
  const authority = `${LOOPBACK_HOST}:${port}`;
  return host === authority && (origin === undefined || origin === `http://${authority}`);
}
