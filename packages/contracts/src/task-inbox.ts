import { z } from 'zod';
import { codexThreadIdSchema, digestSchema, gitHeadSchema, runnerPlatformSchema } from './authorization.js';
import { unityEditorVersionSchema } from './project.js';
import { unityScenePathSchema } from './unity.js';

export const taskInbox = {
  repository: 'FreeToBelieve/devhub-task-inbox', repositoryId: 1465512371,
  author: 'FreeToBelieve', authorId: 53510330, base: 'main', intervalMs: 30_000,
} as const;
export const inboxTaskKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const inboxTokenSchema = z.string().regex(/^github_pat_[A-Za-z0-9_]{20,500}$/);
export const inboxTextLimit = 16_000;
export const inboxSourceSchema = z.strictObject({
  repositoryId: z.literal(taskInbox.repositoryId), number: z.int().positive(), headSha: gitHeadSchema,
  key: inboxTaskKeySchema, title: z.string().trim().min(1).max(120), projectId: z.uuid(),
  unityVersion: unityEditorVersionSchema, scene: unityScenePathSchema,
  text: z.string().min(1).max(inboxTextLimit), blobSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export const inboxMessageStatus = z.enum(['PENDING', 'DELIVERING', 'DELIVERED', 'PROCESSING', 'COMPLETED', 'FAILED', 'STALE']);
export const inboxHostSchema = z.object({
  id: z.uuid(), installationId: z.uuid(), runnerId: z.uuid(), platform: runnerPlatformSchema,
  status: z.enum(['ACTIVE', 'DISCONNECTED']), version: z.string(), heartbeatAt: z.int(),
  connectedAt: z.int(), disconnectedAt: z.int().nullable(),
});
export const inboxSessionSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), projectId: z.uuid(), hostId: z.uuid().nullable(), worktreeId: digestSchema.nullable(),
  providerThreadId: codexThreadIdSchema.nullable(), currentRunId: z.uuid().nullable(), lastRunId: z.uuid().nullable(),
  status: z.enum(['QUEUED', 'WAITING_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CLOSED']),
  title: z.string(), updatedAt: z.int(),
});
export const inboxMessageSchema = z.object({
  id: z.uuid(), sessionId: z.uuid(), projectId: z.uuid(), taskId: z.uuid(), headSha: gitHeadSchema,
  pullRequestNumber: z.int().positive(), sequence: z.int().positive(), taskRevision: z.int().positive(),
  status: inboxMessageStatus, createdAt: z.int(), deliveredAt: z.int().nullable(), errorCode: z.string().nullable(),
  requestId: z.uuid().nullable(), source: inboxSourceSchema,
});
export const inboxStatusSchema = z.object({
  host: inboxHostSchema.nullable(),
  listener: z.object({ enabled: z.boolean(), configured: z.boolean(), scanning: z.boolean(),
    scannedAt: z.int().nullable(), errorCode: z.string().nullable(), prCount: z.int().nonnegative() }),
  sessions: z.array(inboxSessionSchema), messageCounts: z.record(inboxMessageStatus, z.int().nonnegative()),
});
export type InboxSource = z.infer<typeof inboxSourceSchema>;
export type InboxHost = z.infer<typeof inboxHostSchema>;
export type InboxSession = z.infer<typeof inboxSessionSchema>;
export type InboxMessage = z.infer<typeof inboxMessageSchema>;
