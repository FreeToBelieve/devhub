export const LOOPBACK_HOST = '127.0.0.1';

export function allowsLocalRequest(
  host: string | undefined,
  origin: string | undefined,
  port: number,
): boolean {
  const authority = `${LOOPBACK_HOST}:${port}`;
  return host === authority && (origin === undefined || origin === `http://${authority}`);
}
