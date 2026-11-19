import { pino } from 'pino';
import type { DestinationStream, LevelWithSilent } from 'pino';

export function createLogger(level: LevelWithSilent = 'info', destination?: DestinationStream) {
  return pino({
    level,
    redact: {
      paths: [
        'authorization', 'cookie', 'token', 'gitlabToken', 'password', 'apiKey',
        'headers.authorization', 'headers.cookie', 'headers["private-token"]',
        'req.headers.authorization', 'req.headers.cookie', 'req.headers["private-token"]',
        'res.headers["set-cookie"]',
        '*.token', '*.gitlabToken', '*.password', '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
  }, destination);
}
