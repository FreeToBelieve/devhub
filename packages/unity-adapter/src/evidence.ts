import { sanitizeUnityText } from './protocol.js';

function* boxes(data: Buffer) {
  for (let start = 0; start < data.length;) {
    if (data.length - start < 8) throw new Error('UNITY_EVIDENCE_MEDIA_INVALID');
    const size = data.readUInt32BE(start);
    const type = data.toString('ascii', start + 4, start + 8);
    let header = 8;
    let end = size === 0 ? data.length : start + size;
    if (size === 1) {
      header = 16;
      if (data.length - start < header) throw new Error('UNITY_EVIDENCE_MEDIA_INVALID');
      end = start + Number(data.readBigUInt64BE(start + 8));
    }
    if (end < start + header || end > data.length) throw new Error('UNITY_EVIDENCE_MEDIA_INVALID');
    yield { type, data: data.subarray(start + header, end) };
    start = end;
  }
}

function box(data: Buffer, type: string) {
  for (const entry of boxes(data)) if (entry.type === type) return entry.data;
  return undefined;
}

function movieDuration(header: Buffer) {
  if (header[0] === 0 && header.length >= 20) return header.readUInt32BE(16) / header.readUInt32BE(12);
  if (header[0] === 1 && header.length >= 32) return Number(header.readBigUInt64BE(24)) / header.readUInt32BE(20);
  return NaN;
}

export function verifyEvidenceMedia(name: string, data: Buffer, width: number, height: number) {
  if (name.endsWith('.png')) {
    if (data.length < 33 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) return false;
    let pixels = false;
    for (let start = 33; start + 12 <= data.length;) {
      const size = data.readUInt32BE(start);
      const end = start + size + 12;
      if (end > data.length) return false;
      const type = data.toString('ascii', start + 4, start + 8);
      if (type === 'IEND') return pixels && size === 0 && end === data.length;
      if (type === 'IDAT' && size > 0) pixels = true;
      start = end;
    }
    return false;
  }
  if (data.toString('ascii', 4, 8) !== 'ftyp') return false;
  let movie: Buffer | undefined;
  let samples = false;
  for (const entry of boxes(data)) {
    if (entry.type === 'moov') movie = entry.data;
    if (entry.type === 'mdat' && entry.data.length > 0) samples = true;
  }
  if (!samples) return false;
  const header = movie && box(movie, 'mvhd');
  if (!movie || !header) return false;
  const duration = movieDuration(header);
  if (!Number.isFinite(duration) || duration < 3 || duration > 5) return false;
  for (const { type, data } of boxes(movie)) {
    if (type !== 'trak') continue;
    const media = box(data, 'mdia');
    const handler = media && box(media, 'hdlr');
    const mediaHeader = media && box(media, 'mdhd');
    const videoSeconds = mediaHeader ? movieDuration(mediaHeader) : NaN;
    const track = box(data, 'tkhd');
    if (handler?.toString('ascii', 8, 12) === 'vide' && videoSeconds >= 3 && videoSeconds <= 5 && track && track.length >= (track[0] === 1 ? 96 : 84) &&
        track.readUInt32BE(track.length - 8) / 65536 === width &&
        track.readUInt32BE(track.length - 4) / 65536 === height) return true;
  }
  return false;
}

export function sanitizedEvidenceText(text: string, project: string) {
  return sanitizeUnityText(text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED]'), project)
    .replace(/\b(?:dhm_[\w-]{43}|sk-[\w-]{16,})\b/g, '[REDACTED]');
}
