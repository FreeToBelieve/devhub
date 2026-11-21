import type { UnityArtifact, UnityReviewRun } from '@devhub/contracts';
import { unityArtifactsAvailable } from '@devhub/contracts';
import { mcpMediaLimit, mcpRecordingInputLimit } from '@devhub/mcp-contracts';
import type { McpOutput } from '@devhub/mcp-contracts';
import { readPublishedMedia, recordingFrames, reviewScreenshot, UnityMediaError, withRecordingReview } from '@devhub/unity-adapter';
import { McpReadError, missing } from './mcp-errors.js';

export const isScreenshot = (mime: string): mime is 'image/png' | 'image/jpeg' => mime === 'image/png' || mime === 'image/jpeg';
type CatalogEntry = { id: string; file: string; uri: string | null; sha256: string } & Record<string, unknown>;
type Query = { artifactId: string; sampleCount?: number; timestamps?: readonly number[] };
type RecordingAction = 'metadata' | 'resource' | 'frames' | 'review';
const maxDecoders = 2;
const stages = ['before_activation', 'activation', 'orbit', 'wolf_windup', 'hit', 'return', 'deactivation', 'cleared'];
const stageOf = ({ name }: UnityArtifact) => name.split('__').at(-1)!.replace(/\.[^.]+$/, '');

function mediaError(error: unknown): never {
  if (!(error instanceof UnityMediaError)) throw error;
  switch (error.code) {
    case 'NOT_FOUND': return missing();
    case 'LIMIT': throw new McpReadError('MCP_RESPONSE_LIMIT', 413);
    case 'INTEGRITY': throw new McpReadError('MCP_ARTIFACT_INTEGRITY', 409);
    case 'UNAVAILABLE': throw new McpReadError('MCP_MEDIA_ENCODER_UNAVAILABLE', 503);
    case 'TIMEOUT': throw new McpReadError('MCP_MEDIA_TIMEOUT', 504);
    case 'TIMESTAMP': throw new McpReadError('MCP_MEDIA_TIMESTAMP', 400);
    case 'INVALID': throw new McpReadError('MCP_INVALID_MEDIA', 422);
  }
}

export function createMcpMedia(root: string, entry: (run: UnityReviewRun, artifact: UnityArtifact) => CatalogEntry,
  describeRun: (run: UnityReviewRun) => unknown) {
  let active = 0;
  function lookup(run: UnityReviewRun, id: string, matches: (mime: string) => boolean) {
    if (!unityArtifactsAvailable(run)) missing();
    const artifact = run.artifacts.find((item) => matches(item.mime) && entry(run, item).id === id);
    if (!artifact) missing();
    return artifact;
  }
  async function decode<T>(operation: () => Promise<T>) {
    if (active >= maxDecoders) throw new McpReadError('MCP_MEDIA_BUSY', 429);
    active++;
    try { return await operation(); } finally { active--; }
  }
  async function screenshot(run: UnityReviewRun, id: string, signal?: AbortSignal): Promise<McpOutput> {
    const artifact = lookup(run, id, isScreenshot);
    try {
      const bytes = await readPublishedMedia(root, run.id, artifact, mcpMediaLimit, signal);
      if (!isScreenshot(artifact.mime)) return missing();
      return { data: { ...entry(run, artifact), runId: run.id, integrity: 'verified' },
        media: { mimeType: artifact.mime, data: bytes.toString('base64') } };
    } catch (error) { return mediaError(error); }
  }
  async function recording(action: RecordingAction, run: UnityReviewRun, input: Query, signal?: AbortSignal): Promise<McpOutput> {
    const artifact = lookup(run, input.artifactId, (mime) => mime === 'video/mp4');
    const recorded = entry(run, artifact);
    const related = run.artifacts.filter(({ name, mime, kind }) => isScreenshot(mime) && (
      'source' in run ? name.split('__', 1)[0] === artifact.name.split('__', 1)[0] :
        artifact.kind === 'recording' ? kind === 'player-screenshot' : kind === 'editor-screenshot'
    ));
    const collection = related.map((image) => entry(run, image));
    const resource = recorded.uri && artifact.size > 0 && artifact.size <= mcpMediaLimit
      ? { uri: recorded.uri, name: recorded.file, mimeType: 'video/mp4' as const, size: artifact.size } : undefined;
    const data = { ...recorded, runId: run.id, recordingResourceAvailable: !!resource, reviewFrames: collection };
    try {
      if (action === 'resource') {
        // Larger recordings keep their catalog entry and can still use the frame tools.
        if (!resource) return { data: { ...data, resourceDiagnostic: 'MCP_RESPONSE_LIMIT' } };
        const bytes = await readPublishedMedia(root, run.id, artifact, mcpMediaLimit, signal);
        return { data: { ...data, integrity: 'verified' }, resource, media: { mimeType: 'video/mp4', data: bytes.toString('base64') } };
      }
      return await decode(() => withRecordingReview(root, run.id, artifact, mcpRecordingInputLimit, signal,
        async ({ startTime: _startTime, ...video }, encoder, path) => {
          const verified = { ...data, video, integrity: 'verified' };
          if (action === 'metadata') return { data: verified, ...(resource ? { resource } : {}) };
          const selected = action === 'review' ? [...related].sort((a, b) => {
            const stage = (item: UnityArtifact) => {
              const rank = stages.indexOf(stageOf(item));
              return rank === -1 ? stages.length : rank;
            };
            return stage(a) - stage(b) || a.createdAt - b.createdAt || a.name.localeCompare(b.name);
          }).slice(0, 8) : [];
          const sampleCount = input.sampleCount ?? 8;
          const imageBudget = Math.floor(mcpMediaLimit / ((input.timestamps?.length ?? sampleCount) + selected.length));
          const sampled = await recordingFrames(encoder, path, { ...video, startTime: _startTime }, {
            sampleCount, timestamps: input.timestamps, imageBudget, signal,
          });
          const images: NonNullable<McpOutput['images']> = [];
          const timeline = sampled.map(({ image, dimensions, ...detail }) => {
            const flags = [detail.dark ? 'near-black' : '', detail.duplicate ? 'duplicate' : ''].filter(Boolean).join(', ');
            images.push({ mimeType: 'image/jpeg', data: image.toString('base64'),
              caption: `Frame ${detail.frameIndex} — ${detail.timestampSeconds}s / ${video.durationSeconds}s · source ${video.width}×${video.height} · image ${dimensions.width}×${dimensions.height}${flags ? ' · ' + flags : ''}` });
            return { ...detail, durationSeconds: video.durationSeconds,
              originalResolution: { width: video.width, height: video.height }, imageResolution: dimensions };
          });
          const stageScreenshots = [];
          for (const screenshot of selected) {
            const description = entry(run, screenshot);
            try {
              const bytes = await readPublishedMedia(root, run.id, screenshot, mcpMediaLimit, signal);
              const { image, dimensions } = await reviewScreenshot(encoder, bytes, screenshot.mime, imageBudget, signal);
              const stage = stageOf(screenshot);
              images.push({ mimeType: 'image/jpeg', data: image.toString('base64'), caption: 'Stage screenshot — ' + stage +
                ' · ' + dimensions.width + '×' + dimensions.height });
              stageScreenshots.push({ ...description, stage, integrity: 'verified', imageResolution: dimensions });
            } catch (error) {
              if (signal?.aborted || !(error instanceof UnityMediaError) || ['TIMEOUT','UNAVAILABLE','LIMIT'].includes(error.code)) throw error;
              stageScreenshots.push({ ...description, stage: stageOf(screenshot), integrity: error.code });
            }
          }
          return { data: { ...verified, timeline, ...(action === 'review' ? { stageScreenshots, run: describeRun(run),
            commit: 'source' in run ? run.commit : run.baseHeadSha, scene: ('source' in run ? run.scene : run.plan.scene) ?? null,
            unityVersion: 'source' in run ? run.editorVersion : run.version } : {}) }, images, ...(resource ? { resource } : {}) };
        }));
    } catch (error) {
      if (action === 'metadata' && error instanceof UnityMediaError &&
          (error.code === 'UNAVAILABLE' || error.code === 'LIMIT')) {
        return { data: { ...data, video: null, mediaDiagnostic: error.code === 'LIMIT' ?
          'MCP_RESPONSE_LIMIT' : 'MCP_MEDIA_ENCODER_UNAVAILABLE' } };
      }
      return mediaError(error);
    }
  }
  return { screenshot, recording };
}
