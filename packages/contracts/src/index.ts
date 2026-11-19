import { z } from 'zod';

export * from './authorization.js';
export * from './codex-runtime.js';

export const targetPlatformSchema = z.enum(['WINDOWS', 'MACOS', 'BOTH']);
export const taskStatusSchema = z.enum([
  'CREATED', 'QUEUED', 'RUNNING', 'TESTING', 'WAITING_APPROVAL', 'PUSHED',
  'MR_CREATED', 'REVIEWING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED',
]);

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4000),
  targetPlatform: targetPlatformSchema,
});

export const taskIdSchema = z.uuid();
export const taskSchema = createTaskSchema.extend({
  id: taskIdSchema,
  status: taskStatusSchema,
  createdAt: z.iso.datetime(),
  revision: z.int().positive().default(1),
});
export const reviseTaskSchema = createTaskSchema.extend({ expectedRevision: z.int().positive() });
export const taskListSchema = z.object({ tasks: z.array(taskSchema) });
export const apiErrorSchema = z.object({ code: z.string(), message: z.string() });

export const doctorCheckSchema = z.object({
  id: z.enum(['platform', 'node', 'pnpm', 'git', 'codex', 'unity', 'unityProject']),
  status: z.enum(['pass', 'warning', 'fail', 'skipped']),
  detail: z.string(),
});
export const doctorReportSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  checks: z.array(doctorCheckSchema),
});

export type TargetPlatform = z.infer<typeof targetPlatformSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export * from './git-delivery.js';
