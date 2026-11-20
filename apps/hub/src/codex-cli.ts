import { z } from 'zod';
import { runnerClaimInputSchema } from '@devhub/contracts';
import { AuthorizationError, openTaskStore } from '@devhub/storage';
import { executeApprovedTurn } from './codex-runtime.js';
import { createCodexWorktree } from './codex-worktree.js';
import { readRuntimeConfig } from './runtime-config.js';
import { join } from 'node:path';
import { projectWorkspace } from './project-context.js';

async function readPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const input of process.stdin) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    length += chunk.length;
    if (length > 24_000) throw new Error('The prompt must fit in 24000 UTF-8 bytes.');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

async function main(args: string[]) {
  const [command, first, version, bindingDigest, idempotencyKey] = args;
  if (!command || command === '--help') {
    console.log('pnpm codex-runtime worktree-create <project-id>\npnpm codex-runtime run <grant-id> <version> <binding-digest> <idempotency-key> < prompt.txt');
    return;
  }
  if (!(command === 'worktree-create' && args.length === 2) && !(command === 'run' && args.length === 5)) {
    throw new Error('Invalid runtime arguments. Run pnpm codex-runtime --help.');
  }
  const config = readRuntimeConfig();
  const store = openTaskStore(config.databasePath, config.managedDataDirectory);
  try {
    if (command === 'worktree-create') {
      const project = store.projects.require(z.uuid().parse(first), true, true);
      const identity = await createCodexWorktree(project.repositoryRoot!, join(config.codexWorktreeRoot, project.id), project);
      await projectWorkspace(project, identity.root);
      const saved = store.execution.registerWorktree(identity, project.id);
      store.codex.manage(identity.worktreeId);
      console.log(JSON.stringify(saved));
      return;
    }
    const claim = runnerClaimInputSchema.parse({
      grantId: first, expectedVersion: Number(version), bindingDigest, idempotencyKey,
    });
    if (!config.codexHome) throw new Error('Set DEVHUB_CODEX_HOME to a dedicated logged-in Codex profile.');
    const prompt = await readPrompt();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      const result = await executeApprovedTurn(store, claim, prompt, config.codexHome, controller.signal);
      console.log(JSON.stringify(result));
      if (result.status !== 'COMPLETED') process.exitCode = result.status === 'CANCELLED' ? 130 : 1;
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  } finally {
    store.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof AuthorizationError) console.error(error.code);
  else if (error instanceof z.ZodError) console.error('Invalid runtime arguments.');
  else console.error(error instanceof Error ? error.message : 'The Codex runtime failed.');
  process.exitCode = 1;
}
