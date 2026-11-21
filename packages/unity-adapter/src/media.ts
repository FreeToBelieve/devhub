import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UnityArtifact } from '@devhub/contracts';
import { readArtifact, withArtifactScratch } from './artifacts.js';
import { findFfmpeg, findFfprobe } from './discovery.js';
import { verifyEvidenceMedia } from './evidence.js';

export class UnityMediaError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'LIMIT' | 'INTEGRITY' | 'INVALID' | 'TIMESTAMP' | 'UNAVAILABLE' | 'TIMEOUT') {
    super(code);
  }
}

const invalid = () => new UnityMediaError('INVALID');
const integrity = () => new UnityMediaError('INTEGRITY');
const limit = () => new UnityMediaError('LIMIT');
const assertSize = (size: number, max: number) => {
  if (!Number.isSafeInteger(size) || size < 1) throw invalid();
  if (size > max) throw limit();
};
const pngMagic = '89504e470d0a1a0a';
const mov = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
const output = ['-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1'];
const scale = "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const maxOutput = 2 * 1024 * 1024;
const maxAllocation = String(64 * 1024 * 1024);
const probeWindow = 8_000;

type Dimensions = { width: number; height: number };
export type VideoFacts = Dimensions & { durationSeconds: number; fps: number; startTime: number };

function jpegDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  for (let pos = 2; pos + 4 <= bytes.length;) {
    if (bytes[pos++] !== 0xff) return;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++]!;
    if (pos + 2 > bytes.length || marker === 0xda || marker === 0xd9) return;
    const size = bytes.readUInt16BE(pos);
    if (size < 2 || pos + size > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker) && size >= 8) {
      const height = bytes.readUInt16BE(pos + 3);
      const width = bytes.readUInt16BE(pos + 5);
      return width && height ? { width, height } : undefined;
    }
    pos += size;
  }
}

function mediaSignature(bytes: Buffer, artifact: UnityArtifact) {
  if (artifact.mime === 'video/mp4') {
    const size = bytes.length >= 16 ? bytes.readUInt32BE(0) : 0;
    return size >= 16 && size <= artifact.size && bytes.toString('ascii', 4, 8) === 'ftyp';
  }
  if (artifact.mime === 'image/jpeg') return !!jpegDimensions(bytes);
  if (artifact.mime !== 'image/png' || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== pngMagic) return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && verifyEvidenceMedia('screenshot.png', bytes, width, height);
}

async function openPublished(root: string, runId: string, artifact: UnityArtifact, max: number) {
  assertSize(artifact.size, max);
  const file = await readArtifact(root, runId, artifact.name).catch(() => { throw new UnityMediaError('NOT_FOUND'); });
  try {
    const { size } = await file.stat();
    if (size !== artifact.size) throw integrity();
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function readPublishedMedia(root: string, runId: string, artifact: UnityArtifact, max: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await openPublished(root, runId, artifact, max);
  try {
    const bytes = Buffer.alloc(artifact.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const result = bytes.subarray(0, count);
    if (count !== artifact.size || createHash('sha256').update(result).digest('hex') !== artifact.sha256) throw integrity();
    if (!mediaSignature(result, artifact)) throw invalid();
    return result;
  } finally { await file.close(); }
}

async function saveVerifiedRecording(root: string, runId: string, artifact: UnityArtifact, max: number, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await openPublished(root, runId, artifact, max);
  try {
    const header = Buffer.alloc(16);
    if ((await file.read(header, 0, 16, 0)).bytesRead !== header.length || !mediaSignature(header, artifact)) throw invalid();
    let count = 0;
    const hash = createHash('sha256');
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        count += chunk.length;
        if (count > artifact.size) return done(integrity());
        hash.update(chunk);
        done(null, chunk);
      },
    });
    // Use the validated open handle. The decoder never reopens the published pathname.
    await pipeline(file.createReadStream({ start: 0, autoClose: false }), verify,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
    if (count !== artifact.size || hash.digest('hex') !== artifact.sha256) throw integrity();
  } finally { await file.close(); }
}

function safeMediaEnvironment() {
  const allow = new Set(['path', 'systemroot', 'windir', 'tmp', 'temp', 'tmpdir']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key.toLowerCase()))),
    LC_ALL: 'C', LANG: 'C', AV_LOG_FORCE_NOCOLOR: '1' };
}

export function runReviewCommand(executable: string, args: string[], signal?: AbortSignal, stdin?: Buffer, timeout = probeWindow) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = execFile(executable, args, {
      encoding: 'buffer', env: safeMediaEnvironment(), shell: false, windowsHide: true, maxBuffer: maxOutput,
      killSignal: 'SIGKILL', timeout, signal,
    }, (error: ExecFileException | null, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr: stderr.toString('utf8') }); return; }
      const code = error.code;
      reject(code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? limit() :
        signal?.aborted || error.killed ? new UnityMediaError('TIMEOUT') :
        code === 'ENOENT' || code === 'EACCES' ? new UnityMediaError('UNAVAILABLE') : invalid());
    });
    child.stdin?.on('error', () => { /* process result is reported by execFile */ });
    child.stdin?.end(stdin);
  });
}

async function probe(ffprobe: string, path: string, signal?: AbortSignal): Promise<VideoFacts> {
  const { stdout } = await runReviewCommand(ffprobe, ['-v', 'error', '-max_alloc', maxAllocation, ...mov,
    '-select_streams', 'v:0', '-show_entries', 'format=duration,start_time:stream=width,height,avg_frame_rate,r_frame_rate,start_time,duration',
    '-of', 'json', path], signal);
  let data: { streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; start_time?: string; duration?: string }>;
    format?: { duration?: string; start_time?: string } };
  try { data = JSON.parse(stdout.toString('utf8')); } catch { throw invalid(); }
  const stream = data?.streams?.[0];
  const width = stream?.width ?? 0, height = stream?.height ?? 0;
  const fpsFrom = (fraction?: string) => {
    const values = fraction?.match(/^(\d+)\/(\d+)$/);
    return values ? Number(values[1]) / Number(values[2]) : 0;
  };
  const fps = fpsFrom(stream?.avg_frame_rate) || fpsFrom(stream?.r_frame_rate);
  const durationSeconds = Number(stream?.duration ?? data?.format?.duration);
  const startTime = Number(stream?.start_time ?? data?.format?.start_time ?? 0);
  if (![width, height].every(Number.isSafeInteger) || width < 2 || height < 2 || !Number.isFinite(fps) || fps <= 0 ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(startTime)) throw invalid();
  if (width * height > 4096 * 2304 || width > 4096 || height > 4096 || fps > 120 || durationSeconds > 900) throw limit();
  return { width, height, fps, durationSeconds, startTime };
}

async function jpeg(ffmpeg: string, input: string[], filters: string, budget: number, signal?: AbortSignal, bytes?: Buffer) {
  for (const quality of [3, 5, 8, 12]) {
    const { stdout, stderr } = await runReviewCommand(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-xerror',
      '-max_alloc', maxAllocation, '-threads', '1', '-filter_threads', '1', ...input, ...output, '-vf', filters,
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', String(quality), '-f', 'image2pipe', 'pipe:1'], signal, bytes);
    if (!stdout.length) return;
    const dimensions = jpegDimensions(stdout);
    if (!dimensions || dimensions.width > 1280 || dimensions.height > 720) throw invalid();
    if (stdout.length <= budget) return { image: stdout, dimensions, stderr };
  }
  throw limit();
}

export async function withRecordingReview<T>(root: string, runId: string, artifact: UnityArtifact, max: number,
  signal: AbortSignal | undefined, use: (facts: VideoFacts, encoder: string, input: string) => Promise<T>) {
  assertSize(artifact.size, max);
  const encoder = await findFfmpeg();
  const decoder = encoder && await findFfprobe(encoder);
  if (!encoder || !decoder) throw new UnityMediaError('UNAVAILABLE');
  return withArtifactScratch(root, async (directory) => {
    const input = join(directory, 'recording.mp4');
    await saveVerifiedRecording(root, runId, artifact, max, input, signal);
    const facts = await probe(decoder, input, signal);
    return use(facts, encoder, input);
  });
}

export async function recordingFrames(encoder: string, path: string, facts: VideoFacts, options: {
  sampleCount: number; timestamps?: readonly number[]; imageBudget: number; signal?: AbortSignal;
}) {
  const { sampleCount, timestamps, imageBudget, signal } = options;
  const { durationSeconds, fps, startTime } = facts;
  if (timestamps?.some((time) => time > durationSeconds)) throw new UnityMediaError('TIMESTAMP');
  const seconds = timestamps ?? Array.from({ length: sampleCount }, (_, index) => durationSeconds * (index + 0.5) / sampleCount);
  const end = Math.max(0, durationSeconds - 1 / fps);
  const hashes = new Set<string>();
  async function extract(requested: number) {
    const at = Math.min(requested, end);
    const sample = await jpeg(encoder, ['-seek_timestamp', '1', '-ss', (startTime + at).toFixed(6), '-copyts', ...mov, '-i', path],
      scale + ',showinfo,blackframe=amount=98:threshold=24', imageBudget, signal);
    if (!sample) return;
    const line = sample.stderr.split(/\r?\n/).find((value) => /Parsed_showinfo_.*\bn:\s*0\b/.test(value));
    const pts = Number(/\bpts_time:(-?[\d.eE+\-]+)/.exec(line ?? '')?.[1]);
    if (!Number.isFinite(pts) || pts < startTime - 0.05 || pts > startTime + durationSeconds + 0.05) throw invalid();
    const timestampSeconds = Number(Math.max(0, pts - startTime).toFixed(6));
    const dark = /\bn:0\s+pblack:(?:9[89]|100)\b/.test(sample.stderr);
    const hash = createHash('sha256').update(sample.image).digest('hex');
    return { timestampSeconds, image: sample.image, dimensions: sample.dimensions, dark, hash };
  }
  const frames = [];
  for (const [index, requestedSeconds] of seconds.entries()) {
    let frame = await extract(requestedSeconds);
    if (!timestamps && (!frame || frame.dark || hashes.has(frame.hash))) {
      const alternate = await extract((index + 0.78) * durationSeconds / sampleCount);
      if (alternate && (!frame || !alternate.dark && !hashes.has(alternate.hash))) frame = alternate;
    }
    // Container duration can include a final packet with no frame at the requested PTS.
    if (!frame && requestedSeconds >= end) frame = await extract(Math.max(0, end - 1 / fps));
    if (!frame) throw invalid();
    const duplicate = hashes.has(frame.hash);
    hashes.add(frame.hash);
    frames.push({ frameIndex: index + 1, requestedSeconds: Number(requestedSeconds.toFixed(6)), timestampSeconds: frame.timestampSeconds,
      dimensions: frame.dimensions, dark: frame.dark, duplicate, image: frame.image });
  }
  return frames;
}

export async function reviewScreenshot(encoder: string, bytes: Buffer, mime: string, budget: number, signal?: AbortSignal) {
  const demux = mime === 'image/png' ? 'png_pipe' : 'jpeg_pipe';
  const sample = await jpeg(encoder, ['-protocol_whitelist', 'pipe', '-f', demux, '-i', 'pipe:0'], scale, budget, signal, bytes);
  if (!sample) throw invalid();
  return { image: sample.image, dimensions: sample.dimensions };
}
