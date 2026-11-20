#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

if (!process.versions.node.startsWith('24.') || !process.release.lts) {
  console.error('DevHub requires Node.js 24 LTS.');
  process.exitCode = 1;
} else if (process.argv[2] === 'mcp') {
  const bridge = new URL('../../mcp-server/dist/main.js', import.meta.url);
  if (!existsSync(bridge)) {
    console.error('DevHub MCP is not built. Run pnpm build:ts from the workspace.');
    process.exitCode = 1;
  } else {
    process.argv.splice(2, 1);
    await import(bridge);
  }
} else {
  const entry = new URL('../dist/doctor.js', import.meta.url);
  if (!existsSync(entry)) {
    console.error('DevHub CLI is not built. Run pnpm build:ts from the workspace.');
    process.exitCode = 1;
  } else {
    const envFile = resolve(import.meta.dirname, '../../../.env');
    try {
      if (existsSync(envFile)) process.loadEnvFile(envFile);
    } catch {
      console.error('DevHub could not read the workspace .env file.');
      process.exit(1);
    }
    const { runCli } = await import(entry);
    process.exitCode = await runCli(process.argv.slice(2));
  }
}
