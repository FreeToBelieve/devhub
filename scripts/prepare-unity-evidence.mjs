import { createHash } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { projectRelativePathSchema, unityEvidenceFiles, unityEvidenceManifestSchema } from '../packages/contracts/dist/index.js';
import { pathInside, readRegular, verifyEvidenceMedia } from '../packages/unity-adapter/dist/index.js';

const [reviewPath, destination, ...unexpected] = process.argv.slice(2);
if (!reviewPath || !destination || unexpected.length) {
  console.error('Usage: node scripts/prepare-unity-evidence.mjs /path/to/review.json /new/evidence-directory');
  process.exit(2);
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
const spec = (value) => ({ size: value.length, sha256: digest(value) });
let created;
try {
  const report = await readRegular(resolve(reviewPath), 1024 ** 2);
  const review = JSON.parse(report.toString('utf8'));
  if (!Array.isArray(review.captures) || !Array.isArray(review.artifacts) ||
      review.captures.length > 16 || review.artifacts.length > 130) throw new Error();
  const root = await realpath(dirname(resolve(reviewPath)));
  const capture = await Promise.all(review.captures.map(async ({ key, name }) => {
    if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(key)) throw new Error();
    const assets = review.artifacts.filter((entry) => typeof entry.name === 'string' && entry.name.startsWith(key + '__'));
    const frames = assets.filter(({ name }) => name.endsWith('.png'));
    const videos = assets.filter(({ name }) => name.endsWith('.mp4'));
    if (videos.length !== 1 || frames.length < 1 || assets.length !== frames.length + 1) throw new Error();
    const sample = (entry) => ({ name: entry.name.slice(key.length + 2, -4), size: entry.size, sha256: entry.sha256 });
    return { id: key, name, frames: frames.map(sample), recording: sample(videos[0]) };
  }));
  const consoleEntry = review.artifacts.find(({ name }) => name === 'console.json' || name === 'console.log');
  const audit = review.artifacts.find(({ name }) => name === 'review.txt');
  const manifest = unityEvidenceManifestSchema.parse({
    version: 1, projectId: review.projectId, commit: review.commitSha, scene: review.scene, captureSource: review.source,
    editorVersion: review.editorVersion, platform: review.platform, capturedAt: Date.parse(review.recordedAt),
    width: review.width, height: review.height, skills: capture,
    console: { name: consoleEntry?.name, size: consoleEntry?.size, sha256: consoleEntry?.sha256 },
    report: spec(report),
    ...(audit ? { visualAudit: { size: audit.size, sha256: audit.sha256 } } : {}),
  });
  const source = new Map(review.artifacts.map((entry) => [entry.name, entry.path]));
  if (source.size !== review.artifacts.length) throw new Error();
  if (audit) source.set('visual-audit.txt', audit.path);
  const target = resolve(destination);
  if (target === root || pathInside(root, target)) throw new Error();
  await mkdir(target, { mode: 0o700 });
  created = target;
  for (const file of unityEvidenceFiles(manifest)) {
    let data = report;
    if (file.name !== 'evidence-report.json') {
      const path = projectRelativePathSchema.parse(source.get(file.name));
      const raw = join(root, path);
      if (await realpath(raw) !== raw) throw new Error();
      data = await readRegular(raw, file.size);
    }
    if (data.length !== file.size || digest(data) !== file.sha256) throw new Error();
    if ((file.kind === 'editor-screenshot' || file.kind === 'editor-recording') &&
        !verifyEvidenceMedia(file.name, data, manifest.width, manifest.height)) throw new Error();
    await writeFile(join(target, file.name), data, { mode: 0o600, flag: 'wx' });
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Prepared %d files and manifest.json in %s', unityEvidenceFiles(manifest).length, target);
} catch {
  if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
  console.error('UNITY_EVIDENCE_BUNDLE_INVALID');
  process.exitCode = 1;
}
