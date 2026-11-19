import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathInside } from './artifacts.js';
import { readRegular } from './protocol.js';
import type { UnityWorkerInput } from './protocol.js';

const exec = promisify(execFile);
export const captureFramesPerSecond = 8;

export function pngDimensions(buffer: Buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      buffer.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('UNITY_CAPTURE_INVALID');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function finalizeUnityCapture(input: UnityWorkerInput, editor: boolean, signal: AbortSignal) {
  const options = input.plan.capture;
  if (!options) return;
  if (!input.ffmpeg) throw new Error('UNITY_CAPTURE_ENCODER_MISSING');
  const folder = join(input.directory, 'frames');
  if (await realpath(folder) !== folder || !pathInside(input.directory, folder) || !(await lstat(folder)).isDirectory()) {
    throw new Error('UNITY_CAPTURE_INVALID');
  }
  const prefix = editor ? 'game-view' : 'player';
  const expected = options.seconds * captureFramesPerSecond;
  const imageHash = new Set<string>();
  for (let index = 0; index < expected; index++) {
    const png = await readRegular(join(folder, 'frame-' + String(index).padStart(4, '0') + '.png'), 12 * 1024 ** 2);
    const dimensions = pngDimensions(png);
    if (dimensions.width !== options.width || dimensions.height !== options.height) throw new Error('UNITY_CAPTURE_INVALID');
    imageHash.add(createHash('sha256').update(png).digest('hex'));
  }
  if (imageHash.size < 2) throw new Error('UNITY_CAPTURE_STATIC');
  const snapshot = join(input.directory, prefix + '.png');
  const image = pngDimensions(await readRegular(snapshot, 12 * 1024 ** 2));
  if (image.width !== options.width || image.height !== options.height) throw new Error('UNITY_CAPTURE_INVALID');
  const movie = join(input.directory, prefix + '.mp4');
  const settings = { signal, timeout: 35_000, windowsHide: true, maxBuffer: 128 * 1024 };
  try {
    await exec(input.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-framerate', String(captureFramesPerSecond), '-start_number', '0',
      '-i', join(folder, 'frame-%04d.png'), '-frames:v', String(expected), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', movie], settings);
    await exec(input.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', movie, '-f', 'null', '-'], settings);
  } catch { throw new Error('UNITY_CAPTURE_ENCODE_FAILED'); }
  await rm(folder, { recursive: true });
}
