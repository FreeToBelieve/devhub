import { pino } from 'pino';
import type { Bindings, DestinationStream, LevelWithSilent } from 'pino';

const sensitiveKeys = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'rawheaders', 'rawtrailers',
  'token', 'gitlabtoken', 'privatetoken', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'secret', 'clientsecret', 'password', 'apikey', 'xapikey', 'credential', 'credentials',
]);
const serializerKeys = new Set(['__proto__', 'hasOwnProperty', 'toJSON']);
const depthLimit = 64;

function redact(value: unknown, ancestors = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= depthLimit) return '[Truncated]';
  if (ancestors.has(value)) return '[Circular]';
  if (value instanceof Date) {
    return Number.isFinite(Date.prototype.getTime.call(value)) ? Date.prototype.toISOString.call(value) : null;
  }

  ancestors.add(value);
  try {
    const visit = (child: unknown) => redact(child, ancestors, depth + 1);
    if (Array.isArray(value)) return value.map(visit);

    const copy: Record<string, unknown> = {};
    if (value instanceof Error) {
      copy.type = value.name;
      copy.message = value.message;
      copy.stack = value.stack;
      if ('cause' in value) copy.cause = visit(value.cause);
      if (value instanceof AggregateError) copy.errors = visit(value.errors);
    }
    for (const key of Object.keys(value)) {
      if (serializerKeys.has(key)) continue;
      if (sensitiveKeys.has(key.toLowerCase().replace(/[-_]/g, ''))) {
        copy[key] = '[REDACTED]';
        continue;
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && 'value' in property) copy[key] = visit(property.value);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

export function createLogger(level: LevelWithSilent = 'info', destination?: DestinationStream) {
  const logger = pino({
    level,
    serializers: { err: (error: unknown) => error },
    hooks: {
      logMethod(args, method) {
        const values = args.map((value, index) => (
          index === 0 && value instanceof Error ? { err: redact(value) } : redact(value)
        ));
        method.apply(this, values as typeof args);
      },
    },
  }, destination);

  // Pino resets its bindings formatter on child creation. Sanitize before it appends any bindings.
  const child = logger.child;
  logger.child = function (bindings, options) {
    return Reflect.apply(child, this, [redact(bindings), options]);
  };
  const setBindings = logger.setBindings;
  logger.setBindings = function (bindings) {
    setBindings.call(this, redact(bindings) as Bindings);
  };
  return logger;
}
