import { win32 } from 'node:path';

export const LOOPBACK_HOST = '127.0.0.1';

export function windowsPowerShellPath(): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function allowsLocalRequest(
  host: string | undefined,
  origin: string | undefined,
  port: number,
): boolean {
  const authority = `${LOOPBACK_HOST}:${port}`;
  return host === authority && (origin === undefined || origin === `http://${authority}`);
}
