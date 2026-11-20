import { z } from 'zod';

export const legacyProjectId = '00000000-0000-4000-8000-000000000001';
export const unityEditorVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,2}\.\d{1,4}[abfp]\d{1,5}$/);
export function supportsUnityEditorVersion(version: string) {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return unityEditorVersionSchema.safeParse(version).success && /[fp]\d+$/.test(version) &&
    ((major === 2022 && minor >= 3) || major === 2023 || major >= 6000);
}
export const projectRelativePathSchema = z.string().min(1).max(1024).refine((value) => value.split('/').every((part) =>
  part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
  !/[\\:*?"<>|\p{Cc}\p{Cs}]/u.test(part) && !/^\.(?:git|devhub)$/i.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
));
export const projectUnityPathSchema = z.union([z.literal('.'), projectRelativePathSchema]);
export const projectDocumentSchema = z.strictObject({
  kind: z.enum(['AGENTS', 'TECHNICAL', 'ART', 'VFX', 'UI', 'NAMING', 'ARCHITECTURE']),
  path: projectRelativePathSchema.refine((path) => /\.md$/i.test(path)),
});
export const projectSettingsSchema = z.strictObject({
  description: z.string().trim().max(4000).default(''),
  gameType: z.string().trim().max(80).default(''),
  documents: z.array(projectDocumentSchema).max(24).default([]),
  gitAuthor: z.strictObject({ name: z.string().trim().min(1).max(100), email: z.email().max(254) }).optional(),
});
export const projectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  repositoryRoot: z.string().trim().min(1).max(2048),
  unityProjectPath: projectUnityPathSchema,
  targetPlatform: z.enum(['WINDOWS', 'MACOS', 'BOTH']),
  settings: projectSettingsSchema.default(() => projectSettingsSchema.parse({})),
});
export const projectSchema = projectInputSchema.extend({
  id: z.uuid(),
  engine: z.literal('UNITY'),
  repositoryRoot: z.string().nullable(),
  repoId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  unityProjectPath: projectUnityPathSchema.nullable(),
  unityVersion: unityEditorVersionSchema.nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  revision: z.int().positive(),
  createdAt: z.int(),
  updatedAt: z.int(),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type Project = z.infer<typeof projectSchema>;
