import { z } from 'zod';
import { digestSchema, gitHeadSchema } from './authorization.js';
import { unityEditorVersionSchema } from './project.js';
import { unityArtifactSchema, unityRunSchema, unityScenePathSchema } from './unity.js';

export const unityEvidenceContentType = 'application/vnd.devhub.unity-evidence';
export const unityEvidenceManifestLimit = 32 * 1024;
export const unityEvidenceTotalLimit = 160 * 1024 ** 2;
const mediaLimit = { png: 12 * 1024 ** 2, mp4: 24 * 1024 ** 2, text: 1024 ** 2 } as const;
const file = (limit: number) => z.strictObject({ size: z.int().min(1).max(limit), sha256: digestSchema });
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const frameName = z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/);
const evidenceFields = z.strictObject({
  projectId: z.uuid(), commit: gitHeadSchema, scene: unityScenePathSchema,
  captureSource: z.string().max(180).regex(/^[A-Za-z][A-Za-z0-9_.-]+$/),
  editorVersion: unityEditorVersionSchema,
  platform: z.enum(['WINDOWS', 'MACOS']),
  capturedAt: z.int().positive(),
  width: z.int().min(320).max(7680), height: z.int().min(240).max(4320),
});
const manifestFields = evidenceFields.extend({
  version: z.literal(1),
  skills: z.array(z.strictObject({ id: slug, name: z.string().trim().min(1).max(100),
    frames: z.array(file(mediaLimit.png).extend({ name: frameName })).min(1).max(24),
    recording: file(mediaLimit.mp4).extend({ name: frameName }),
  })).min(1).max(16),
  console: file(mediaLimit.text).extend({ name: z.enum(['console.log', 'console.json']) }),
  report: file(mediaLimit.text),
  visualAudit: file(mediaLimit.text).optional(),
});
export type UnityEvidenceManifest = z.infer<typeof manifestFields>;
export const unityEvidenceManifestSchema = manifestFields.refine((manifest) =>
  new Set(manifest.skills.map(({ id }) => id)).size === manifest.skills.length &&
  manifest.skills.every(({ frames }) => new Set(frames.map(({ name }) => name.toLowerCase())).size === frames.length) &&
  unityEvidenceFiles(manifest).length <= 130 &&
  unityEvidenceFiles(manifest).reduce((sum, { size }) => sum + size, 0) <= unityEvidenceTotalLimit, 'Invalid evidence scope or size.');
export function unityEvidenceFiles(manifest: UnityEvidenceManifest) {
  return [...manifest.skills.flatMap(({ id, frames, recording }) => [
    ...frames.map(({ name, ...frame }) => ({ name: `${id}__${name}.png`, kind: 'editor-screenshot' as const, ...frame })),
    { ...recording, name: `${id}__${recording.name}.mp4`, kind: 'editor-recording' as const },
  ]), { ...manifest.console, kind: 'log' as const },
  { name: 'evidence-report.json', kind: 'report' as const, ...manifest.report },
  ...(manifest.visualAudit ? [{ name: 'visual-audit.txt', kind: 'report' as const, ...manifest.visualAudit }] : [])];
}

export function unityEvidenceHeader(manifest: UnityEvidenceManifest) {
  const payload = new TextEncoder().encode(JSON.stringify(manifest));
  if (payload.length > unityEvidenceManifestLimit) throw new Error('UNITY_EVIDENCE_MANIFEST_LIMIT');
  const header = new Uint8Array(4 + payload.length);
  new DataView(header.buffer).setUint32(0, payload.length);
  header.set(payload, 4);
  return header;
}

export const unityEvidenceRunSchema = evidenceFields.extend({
  id: z.uuid(), source: z.literal('EXTERNAL_CAPTURE'), status: z.literal('IMPORTED'),
  manifestSha256: digestSchema, importedAt: z.int().positive(),
  skills: z.array(z.object({ id: slug, name: z.string() })).min(1).max(16),
  artifacts: z.array(unityArtifactSchema),
});
export type UnityEvidenceRun = z.infer<typeof unityEvidenceRunSchema>;
export const unityReviewRunSchema = z.union([unityRunSchema, unityEvidenceRunSchema]);
export type UnityReviewRun = z.infer<typeof unityReviewRunSchema>;
export function unityArtifactsAvailable(run: UnityReviewRun): boolean {
  return 'source' in run || run.exitConfirmed;
}
