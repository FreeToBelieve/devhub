import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  unityEvidenceFiles, unityEvidenceManifestLimit, unityEvidenceManifestSchema, unityEvidenceTotalLimit,
} from '@devhub/contracts';
import type { Project, UnityEvidenceRun } from '@devhub/contracts';
import { verifyCaptureRevision } from '@devhub/git-adapter';
import type { TaskStore } from '@devhub/storage';
import {
  catalogArtifacts, createRunDirectory, directoryBytes, sanitizedEvidenceText, storageByteLimit, verifyEvidenceMedia,
} from '@devhub/unity-adapter';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

function receiver(payload: Readable) {
  const iterator = payload.iterator({ destroyOnReturn: false });
  let chunk = Buffer.alloc(0);
  let seen = 0;
  async function fill() {
    while (!chunk.length) {
      const next = await iterator.next();
      if (next.done) return false;
      chunk = Buffer.from(next.value as Uint8Array);
      seen += chunk.length;
      if (seen > unityEvidenceTotalLimit + unityEvidenceManifestLimit + 4) throw new Error('UNITY_EVIDENCE_SIZE');
    }
    return true;
  }
  return {
    async read(size: number) {
      const data = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        if (!await fill()) throw new Error('UNITY_EVIDENCE_INCOMPLETE');
        const copied = chunk.copy(data, offset, 0, Math.min(size - offset, chunk.length));
        chunk = chunk.subarray(copied);
        offset += copied;
      }
      return data;
    },
    hasTrailingBytes: fill,
  };
}

export function createUnityEvidenceImporter(store: TaskStore, root: string) {
  let receiving = false;
  return async function importEvidence(payload: Readable, project: Project, actorDigest: string, length?: string) {
    if (!project.repositoryRoot || !project.unityProjectPath) throw new Error('UNITY_EVIDENCE_PROJECT_REQUIRED');
    if (length && (!/^\d+$/.test(length) || Number(length) > unityEvidenceTotalLimit + unityEvidenceManifestLimit + 4)) {
      throw new Error('UNITY_EVIDENCE_SIZE');
    }
    if (receiving) throw new Error('UNITY_EVIDENCE_IMPORT_BUSY');
    receiving = true;
    let directory: string | undefined;
    let keep = false;
    const timeout = setTimeout(() => payload.destroy(), 120_000);
    try {
      const input = receiver(payload);
      const manifestBytes = (await input.read(4)).readUInt32BE();
      if (manifestBytes < 2 || manifestBytes > unityEvidenceManifestLimit) throw new Error('UNITY_EVIDENCE_MANIFEST_INVALID');
      const bytes = await input.read(manifestBytes);
      const decoded = unityEvidenceManifestSchema.safeParse(JSON.parse(utf8.decode(bytes)));
      if (!decoded.success) throw new Error('UNITY_EVIDENCE_MANIFEST_INVALID');
      const manifest = decoded.data;
      if (manifest.projectId !== project.id) throw new Error('UNITY_EVIDENCE_PROJECT_MISMATCH');
      if (manifest.capturedAt > Date.now() + 300_000) throw new Error('UNITY_EVIDENCE_TIME_INVALID');
      const scenePath = project.unityProjectPath === '.' ? manifest.scene : project.unityProjectPath + '/' + manifest.scene;
      if (!await verifyCaptureRevision(project.repositoryRoot, manifest.commit, scenePath).catch(() => false)) {
        throw new Error('UNITY_EVIDENCE_REVISION_INVALID');
      }
      const id = randomUUID();
      directory = await createRunDirectory(root, id, project.repositoryRoot);
      const files = unityEvidenceFiles(manifest);
      const total = files.reduce((sum, item) => sum + item.size, 0);
      if ((length !== undefined && Number(length) !== total + 4 + manifestBytes) ||
          await directoryBytes(root, storageByteLimit, true) + total > storageByteLimit) throw new Error('UNITY_EVIDENCE_SIZE');
      for (const file of files) {
        let data: Buffer<ArrayBufferLike> = await input.read(file.size);
        if (digest(data) !== file.sha256) throw new Error('UNITY_EVIDENCE_HASH_MISMATCH');
        if (file.kind === 'editor-screenshot' || file.kind === 'editor-recording') {
          if (!verifyEvidenceMedia(file.name, data, manifest.width, manifest.height)) throw new Error('UNITY_EVIDENCE_MEDIA_INVALID');
        } else {
          const text = utf8.decode(data);
          if (text.includes('\0')) throw new Error('UNITY_EVIDENCE_TEXT_INVALID');
          if (file.name.endsWith('.json')) {
            try { JSON.parse(text); } catch { throw new Error('UNITY_EVIDENCE_REPORT_INVALID'); }
          }
          const safe = sanitizedEvidenceText(text, project.repositoryRoot);
          data = Buffer.from(file.name.endsWith('.json') ? JSON.stringify({ text: safe }) : safe);
        }
        await writeFile(join(directory, file.name), data, { mode: 0o600, flag: 'wx' });
      }
      if (await input.hasTrailingBytes()) throw new Error('UNITY_EVIDENCE_EXTRA_BYTES');
      const canonical = JSON.stringify(manifest);
      const names = [...files.map(({ name }) => name), 'evidence-manifest.json'];
      await writeFile(join(directory, 'evidence-manifest.json'), canonical, { mode: 0o600, flag: 'wx' });
      const artifacts = await catalogArtifacts(directory, names);
      if (artifacts.length !== names.length) throw new Error('UNITY_EVIDENCE_INCOMPLETE');
      if (store.projects.require(project.id, true, true).revision !== project.revision) throw new Error('UNITY_EVIDENCE_PROJECT_CHANGED');
      const { version: _schema, console: _console, report: _report, visualAudit: _audit, skills, ...metadata } = manifest;
      const candidate: UnityEvidenceRun = { ...metadata, source: 'EXTERNAL_CAPTURE', status: 'IMPORTED', id,
        importedAt: Date.now(), manifestSha256: digest(canonical), artifacts,
        skills: skills.map(({ id, name }) => ({ id, name })) };
      const result = store.unityEvidence.add(candidate, actorDigest);
      keep = result.id === id;
      return result;
    } catch (error) {
      if (error instanceof Error && /^UNITY_/.test(error.message)) throw error;
      throw new Error(error instanceof SyntaxError || error instanceof TypeError
        ? 'UNITY_EVIDENCE_FORMAT_INVALID' : 'UNITY_EVIDENCE_IMPORT_FAILED');
    } finally {
      clearTimeout(timeout);
      if (directory && !keep) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      receiving = false;
    }
  };
}
