import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export const dashboardDirectory = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));
const configSchema = z.object({
  DEVHUB_PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
  DEVHUB_DB_PATH: z.string().trim().min(1).default('.devhub/devhub.sqlite'),
  DEVHUB_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export class HubConfigError extends Error {}

export function readRuntimeConfig() {
  const envFile = resolve(workspace, '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const config = configSchema.safeParse(process.env);
  if (!config.success) {
    const keys = config.error.issues.map((issue) => issue.path.join('.'));
    throw new HubConfigError(`Invalid DevHub configuration: ${keys.join(', ')}`);
  }
  const { DEVHUB_PORT: port, DEVHUB_DB_PATH: filename, DEVHUB_LOG_LEVEL: level } = config.data;
  const databasePath = resolve(workspace, filename);
  return { port, databasePath, managedDataDirectory: dirname(databasePath) === resolve(workspace, '.devhub'), level };
}
