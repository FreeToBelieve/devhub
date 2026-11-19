import { createLogger } from '@devhub/logger';
import { expect, it } from 'vitest';

it('redacts sensitive fields from structured metadata and headers', () => {
  const output: string[] = [];
  const logger = createLogger('info', { write: (line) => output.push(line) });
  logger.info({
    gitlabToken: 'example-token',
    req: { headers: { authorization: 'example-authorization', cookie: 'example-cookie', 'private-token': 'example-header' } },
    config: { password: 'example-password' },
    state: 'CREATED',
  }, 'Task logged');
  const serialized = output.join('');
  const log = JSON.parse(serialized);
  expect(serialized).not.toContain('example-');
  expect(log.gitlabToken).toBe('[REDACTED]');
  expect(log.req.headers['private-token']).toBe('[REDACTED]');
  expect(log.state).toBe('CREATED');
});

it('redacts deep keys and arrays without changing the original metadata', () => {
  const output: string[] = [];
  const logger = createLogger('info', { write: (line) => output.push(line) });
  const credentials = {
    private_token: 'example-private',
    access_token: 'example-access',
    Refresh_Token: 'example-refresh',
    'CLIENT-SECRET': 'example-client',
    allowed: 'visible',
  };
  const metadata = { level1: { level2: { level3: { values: [{ level4: credentials }] } } } };
  logger.info(metadata, 'Task state');
  const data = JSON.parse(output.join(''));
  expect(output.join('')).not.toContain('example-');
  expect(data.level1.level2.level3.values[0].level4).toEqual({
    private_token: '[REDACTED]',
    access_token: '[REDACTED]',
    Refresh_Token: '[REDACTED]',
    'CLIENT-SECRET': '[REDACTED]',
    allowed: 'visible',
  });
  expect(credentials.access_token).toBe('example-access');
});

it('redacts child bindings, structured interpolation, and Error causes', () => {
  const output: string[] = [];
  const root = createLogger('info', { write: (line) => output.push(line) });
  const logger = root.child({ session: { nested: { accessToken: 'example-session', id: 'runner-a' } } });
  logger.setBindings({ oauth: { refresh_token: 'example-binding' } });
  const error = Object.assign(new Error('Operation failed', {
    cause: new Error('Service rejected the request', { cause: { client_secret: 'example-cause' } }),
  }), { response: { headers: { 'Set-Cookie': 'example-cookie' } } });

  logger.error(error, 'Retry with context %j', { configuration: { PRIVATE_TOKEN: 'example-interpolation' } });
  const data = JSON.parse(output.join(''));
  expect(output.join('')).not.toContain('example-');
  expect(data.session.nested).toEqual({ accessToken: '[REDACTED]', id: 'runner-a' });
  expect(data.oauth.refresh_token).toBe('[REDACTED]');
  expect(data.err.cause.cause.client_secret).toBe('[REDACTED]');
  expect(data.err.response.headers['Set-Cookie']).toBe('[REDACTED]');
  expect(data.err.message).toBe('Operation failed');
  expect(data.msg).toContain('[REDACTED]');
});

it('handles circular and very deep structure without calling toJSON or getters', () => {
  const output: string[] = [];
  const logger = createLogger('info', { write: (line) => output.push(line) });
  const cycle: { self?: unknown; rawHeaders: string[] } = { rawHeaders: ['Authorization', 'example-raw'] };
  cycle.self = cycle;
  const deep = Array.from({ length: 70 }).reduce<unknown>((next) => ({ next }), { token: 'example-deep' });
  logger.info({
    cycle,
    deep,
    metadata: {
      get client_secret() { throw new Error('Must not evaluate secret getter'); },
      toJSON() { return { access_token: 'example-serialization' }; },
    },
  });
  const serialized = output.join('');
  expect(serialized).not.toContain('example-');
  const data = JSON.parse(serialized);
  expect(data.cycle).toEqual({ self: '[Circular]', rawHeaders: '[REDACTED]' });
  expect(data.metadata.client_secret).toBe('[REDACTED]');
  expect(serialized).toContain('[Truncated]');
});
