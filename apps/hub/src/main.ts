import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@devhub/logger';
import { LOOPBACK_HOST } from '@devhub/security';
import { z } from 'zod';
import { createServer } from './server.js';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const dashboardDirectory = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));
const configSchema = z.object({
  DEVHUB_PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
  DEVHUB_DB_PATH: z.string().trim().min(1).default('.devhub/devhub.sqlite'),
  DEVHUB_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

async function start() {
  const envFile = resolve(workspace, '.env');
  if (existsSync(envFile)) loadEnvFile(envFile);

  const config = configSchema.safeParse(process.env);
  if (!config.success) {
    const keys = config.error.issues.map((issue) => issue.path.join('.'));
    console.error(`Invalid DevHub configuration: ${keys.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(resolve(dashboardDirectory, 'index.html'))) {
    console.error('Dashboard is not built. Run pnpm build from the workspace.');
    process.exitCode = 1;
    return;
  }

  const { DEVHUB_PORT: port, DEVHUB_DB_PATH: databasePath, DEVHUB_LOG_LEVEL: level } = config.data;
  const databaseFile = resolve(workspace, databasePath);
  const app = createServer({
    port,
    databasePath: databaseFile,
    managedDataDirectory: dirname(databaseFile) === resolve(workspace, '.devhub'),
    dashboardDirectory,
    logger: createLogger(level),
  });

  try {
    await app.listen({ host: LOOPBACK_HOST, port });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`DevHub Dashboard: http://${LOOPBACK_HOST}:${port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch {
      console.error('DevHub could not close cleanly.');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  await start();
} catch (error) {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === 'EADDRINUSE') {
    console.error('DevHub could not start because the configured port is in use. Check DEVHUB_PORT.');
  } else if (code === 'DEVHUB_DB_PERMISSIONS') {
    console.error('DevHub could not secure its SQLite files. Check ownership and permissions on DEVHUB_DB_PATH and its parent directory.');
  } else {
    console.error('DevHub could not start. Check the local .env and permissions on the database directory.');
  }
  process.exitCode = 1;
}
