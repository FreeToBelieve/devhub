import { z } from 'zod';
import { codexThreadIdSchema, digestSchema } from './authorization.js';

export const codexRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export const codexRunSchema = z.object({
  devhubRunId: z.uuid(),
  requestId: z.uuid(),
  worktreeId: digestSchema,
  promptSha256: digestSchema,
  sdkConfigSha256: digestSchema,
  providerThreadId: codexThreadIdSchema.nullable(),
  providerTurnId: z.null(),
  previousRunId: z.uuid().nullable(),
  status: codexRunStatusSchema,
  cancelRequested: z.boolean(),
  startedAt: z.int(),
  finishedAt: z.int().nullable(),
});

export const codexEventSchema = z.strictObject({
  kind: z.enum([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
    'item.started', 'item.updated', 'item.completed', 'error',
  ]),
  threadId: codexThreadIdSchema.optional(),
  itemType: z.enum(['command_execution', 'file_change', 'mcp_tool_call', 'agent_message',
    'reasoning', 'web_search', 'todo_list', 'error']).optional(),
  exitCode: z.int().optional(),
  changedFiles: z.int().nonnegative().optional(),
});
export type CodexRun = z.infer<typeof codexRunSchema>;
export type CodexRunStatus = z.infer<typeof codexRunStatusSchema>;
export type CodexEvent = z.infer<typeof codexEventSchema>;
