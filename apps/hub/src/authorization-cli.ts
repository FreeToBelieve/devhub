import { z } from 'zod';
import { runnerClaimInputSchema } from '@devhub/contracts';
import { AuthorizationError, openTaskStore } from '@devhub/storage';
import { localDevice } from './authorization-context.js';
import { claimFromLocalRunner } from './runner-ipc.js';
import { readRuntimeConfig } from './runtime-config.js';
import { inspectWorktree } from './worktree.js';

const usage = `Usage:
  pnpm authorization bootstrap
  pnpm authorization runner-register <label>
  pnpm authorization worktree-register <project-id> <worktree-root>
  pnpm authorization runner-claim <runner-id> <grant-id> <version> <binding-digest> <idempotency-key>`;

async function run(args: string[]) {
  const [command, first, ...rest] = args;
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }
  const bootstrap = command === 'bootstrap' && args.length === 1;
  const register = (command === 'runner-register' && args.length === 2) || (command === 'worktree-register' && args.length === 3);
  const claim = command === 'runner-claim' && args.length === 6;
  if (!(bootstrap || register || claim)) throw new Error(usage);
  if (bootstrap && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Bootstrap issuance requires a local interactive terminal.');
  }

  const { databasePath, managedDataDirectory } = readRuntimeConfig();
  const store = openTaskStore(databasePath, managedDataDirectory);
  try {
    if (bootstrap) {
      // This is the local interactive display, outside the application logger and redirected output.
      const credential = store.execution.createBootstrap();
      process.stdout.write(`One-time startup credential (expires in five minutes):\n${credential.proof}\n`);
    } else if (command === 'runner-register') {
      const label = z.string().trim().min(1).max(80).parse(first);
      console.log(JSON.stringify(store.execution.registerRunner({ ...localDevice(), label })));
    } else if (command === 'worktree-register') {
      const project = store.projects.require(z.uuid().parse(first), true, true);
      const worktree = await inspectWorktree(z.string().min(1).parse(rest[0]));
      if (!worktree.linked) throw new Error('Register a separate linked worktree.');
      console.log(JSON.stringify(store.execution.registerWorktree(worktree, project.id)));
    } else {
      const runnerId = z.uuid().parse(first);
      const [grantId, version, bindingDigest, idempotencyKey] = rest;
      const parsed = runnerClaimInputSchema.parse({ grantId, expectedVersion: Number(version), bindingDigest, idempotencyKey });
      const result = await claimFromLocalRunner(store.execution, runnerId, parsed);
      console.log(JSON.stringify({ id: result.id, status: result.status, version: result.version }));
    }
  } finally {
    store.close();
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof AuthorizationError) console.error(error.code);
  else if (error instanceof z.ZodError) console.error('Invalid authorization command arguments.');
  else console.error(error instanceof Error ? error.message : 'Authorization command failed.');
  process.exitCode = 1;
}
