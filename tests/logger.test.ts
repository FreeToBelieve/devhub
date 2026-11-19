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
