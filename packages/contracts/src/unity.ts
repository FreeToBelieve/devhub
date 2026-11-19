import { z } from 'zod';

export const unityVersion = '6000.3.28f1';
export const unityStageSchema = z.enum(['EDITOR', 'IMPORT', 'EDITMODE', 'PLAYMODE', 'BUILD', 'PLAYER', 'GAME_VIEW', 'PIPELINE']);
export const unityPlanSchema = z.strictObject({
  stage: unityStageSchema,
  scene: z.string().max(220).regex(/^Assets\/(?:[A-Za-z0-9_ -]+\/)*[A-Za-z0-9_ -]+\.unity$/).optional(),
  testFilter: z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_.]*$/).optional(),
  timeoutSeconds: z.int().min(5).max(1800),
  capture: z.strictObject({
    width: z.int().min(320).max(1920).multipleOf(2),
    height: z.int().min(240).max(1080).multipleOf(2),
    seconds: z.int().min(1).max(12),
  }).optional(),
}).superRefine((input, issues) => {
  if ((input.stage === 'BUILD' || input.stage === 'PLAYER' || input.stage === 'GAME_VIEW' || input.stage === 'PIPELINE') && !input.scene) {
    issues.addIssue({ code: 'custom', path: ['scene'], message: 'A scene is required.' });
  }
  if (input.capture && !['PLAYER', 'GAME_VIEW', 'PIPELINE'].includes(input.stage)) {
    issues.addIssue({ code: 'custom', path: ['capture'], message: 'This stage cannot capture rendering.' });
  }
  if (input.stage === 'GAME_VIEW' && !input.capture) {
    issues.addIssue({ code: 'custom', path: ['capture'], message: 'Game View requires capture settings.' });
  }
});

export const unityRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export const unityReportSchema = z.object({
  stage: unityStageSchema,
  code: z.string().max(80).nullable(),
  exitCode: z.int().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int(),
  diagnostics: z.array(z.object({
    severity: z.enum(['error', 'warning']), code: z.string(), file: z.string().nullable(), line: z.int().nullable(),
    message: z.string(),
  })).max(100),
  tests: z.object({ total: z.int(), passed: z.int(), failed: z.int(), skipped: z.int(), names: z.array(z.string()).max(50),
    failures: z.array(z.object({ name: z.string(), message: z.string() })).max(50).optional() }).optional(),
  scene: z.object({ path: z.string(), objectPresent: z.boolean(), skillTriggered: z.boolean(), frames: z.int() }).optional(),
  build: z.object({ target: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.int() }).optional(),
});
export const unityArtifactSchema = z.object({
  name: z.string().max(100), kind: z.enum(['log', 'report', 'test', 'editor-screenshot', 'player-screenshot', 'recording', 'editor-recording']),
  mime: z.enum(['text/plain', 'application/json', 'application/xml', 'image/png', 'video/mp4']),
  size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.int(),
});
export const unityRunSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), taskId: z.uuid(), runnerId: z.uuid(), worktreeId: z.string(),
  baseHeadSha: z.string(), platform: z.enum(['WINDOWS', 'MACOS']), version: z.literal(unityVersion),
  plan: unityPlanSchema, status: unityRunStatusSchema, phase: unityStageSchema.nullable(),
  pid: z.int().positive().nullable(), processIdentity: z.string().nullable(), cancelRequested: z.boolean(),
  startedAt: z.int(), finishedAt: z.int().nullable(), exitConfirmed: z.boolean(),
  diagnostic: z.string().nullable(), reports: z.array(unityReportSchema), artifacts: z.array(unityArtifactSchema),
});
export const unityEnvironmentSchema = z.object({
  version: z.literal(unityVersion),
  platform: z.enum(['WINDOWS', 'MACOS']).nullable(),
  editor: z.string().nullable(),
  hub: z.boolean(),
  projectVersion: z.string().nullable(),
  buildSupport: z.boolean(),
  license: z.enum(['UNVERIFIED', 'FILE_PRESENT', 'RUN_VERIFIED']),
  graphics: z.boolean(),
  freeBytes: z.number().nonnegative().nullable(),
  projectLocked: z.boolean(),
  diagnostics: z.array(z.string()),
});

export type UnityPlan = z.infer<typeof unityPlanSchema>;
export type UnityStage = z.infer<typeof unityStageSchema>;
export type UnityRun = z.infer<typeof unityRunSchema>;
export type UnityReport = z.infer<typeof unityReportSchema>;
export type UnityArtifact = z.infer<typeof unityArtifactSchema>;
export type UnityEnvironment = z.infer<typeof unityEnvironmentSchema>;
