import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@devhub/logger';
import { LOOPBACK_HOST } from '@devhub/security';
import { createServer } from './server.js';
import { dashboardDirectory, HubConfigError, readRuntimeConfig } from './runtime-config.js';

async function start() {
  const { port, databasePath, managedDataDirectory, level, codexWorktreeRoot, unityArtifactRoot } = readRuntimeConfig();
  if (!existsSync(resolve(dashboardDirectory, 'index.html'))) {
    console.error('Dashboard is not built. Run pnpm build from the workspace.');
    process.exitCode = 1;
    return;
  }

  const app = createServer({
    port,
    databasePath,
    managedDataDirectory,
    dashboardDirectory,
    codexWorktreeRoot,
    unityArtifactRoot,
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
  if (error instanceof HubConfigError) {
    console.error(error.message);
  } else if (code === 'EADDRINUSE') {
    console.error('DevHub could not start because the configured port is in use. Check DEVHUB_PORT.');
  } else if (code === 'DEVHUB_DB_PERMISSIONS') {
    console.error('DevHub could not secure its SQLite files. Check ownership and permissions on DEVHUB_DB_PATH and its parent directory.');
  } else {
    console.error('DevHub could not start. Check the local .env and permissions on the database directory.');
  }
  process.exitCode = 1;
}
