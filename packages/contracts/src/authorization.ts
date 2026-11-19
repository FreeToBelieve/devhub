import { z } from 'zod';

export const executionPolicyVersion = 1;
export const runnerPlatformSchema = z.enum(['WINDOWS', 'MACOS']);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const localProofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const revisionSchema = z.int().positive();
export const requestKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const codexThreadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const repoPathSchema = z.string().min(1).max(512).refine((value) => value.split('/').every((part) => (
  /^[\p{L}\p{N}._ -]{1,100}$/u.test(part) &&
  part === part.trim() && !part.endsWith('.') &&
  !/^\.(?:git|devhub)$/i.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
)));

export const executionScopeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('workspace.write'), paths: z.array(repoPathSchema).min(1).max(16) }),
  z.strictObject({ operation: z.literal('process.run'), executable: z.literal('git'), action: z.enum(['status', 'diff-check']) }),
]);

export const executionBindingSchema = z.strictObject({
  taskId: z.uuid(),
  taskRevision: revisionSchema,
  taskSpecSha256: digestSchema,
  repoId: digestSchema,
  worktreeId: digestSchema,
  baseHeadSha: gitHeadSchema,
  codexThreadId: codexThreadIdSchema,
  runnerId: z.uuid(),
  platform: runnerPlatformSchema,
  scope: executionScopeSchema,
  policyVersion: z.int().positive(),
});

export const executionStateSchema = z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CLAIMED', 'REVOKED']);
export const executionRequestSchema = z.object({
  id: z.uuid(),
  binding: executionBindingSchema,
  bindingDigest: digestSchema,
  status: executionStateSchema,
  version: revisionSchema,
  createdAt: z.int(),
  expiresAt: z.int(),
  grantId: z.uuid().nullable(),
  grantExpiresAt: z.int().nullable(),
});

export const executionAuditEventSchema = z.object({
  id: z.int(),
  kind: executionStateSchema,
  actorKind: z.enum(['operator', 'runner', 'system']),
  actorId: z.string(),
  reason: z.string().nullable(),
  bindingDigest: digestSchema,
  createdAt: z.int(),
});

export const executionDetailSchema = z.object({
  request: executionRequestSchema,
  events: z.array(executionAuditEventSchema),
});
export const versionInputSchema = z.strictObject({ expectedVersion: revisionSchema });
export const decisionInputSchema = versionInputSchema.extend({ decision: z.enum(['approve', 'deny']) });
export const runnerClaimInputSchema = versionInputSchema.extend({
  grantId: z.uuid(),
  bindingDigest: digestSchema,
  idempotencyKey: requestKeySchema,
});
export const runnerIpcMessageSchema = z.strictObject({
  kind: z.literal('claim'),
  runnerId: z.uuid(),
  runnerProof: localProofSchema,
  claim: runnerClaimInputSchema,
});
export const runnerReceiptSchema = z.strictObject({
  kind: z.literal('receipt'),
  requestId: z.uuid(),
  status: z.literal('CLAIMED'),
  bindingDigest: digestSchema,
});
export const runnerRecordSchema = z.object({
  id: z.uuid(),
  deviceId: digestSchema,
  label: z.string().min(1).max(80),
  platform: runnerPlatformSchema,
});
export const worktreeRecordSchema = z.object({
  repoId: digestSchema,
  worktreeId: digestSchema,
  root: z.string().min(1),
});
export const operatorSessionSchema = z.object({ csrfToken: digestSchema, expiresAt: z.int() });

export type ExecutionBinding = z.infer<typeof executionBindingSchema>;
export type ExecutionScope = z.infer<typeof executionScopeSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type ExecutionAuditEvent = z.infer<typeof executionAuditEventSchema>;
export type RunnerRecord = z.infer<typeof runnerRecordSchema>;
export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;
export type RunnerClaimInput = z.infer<typeof runnerClaimInputSchema>;
export type RunnerIpcMessage = z.infer<typeof runnerIpcMessageSchema>;
