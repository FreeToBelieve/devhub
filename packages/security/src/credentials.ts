import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateLocalProof(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function csrfForSession(proof: string): string {
  return sha256('devhub:operator-csrf:v1:' + proof);
}

export function verifyCsrf(proof: string, received: string | undefined): boolean {
  return received !== undefined && /^[a-f0-9]{64}$/.test(received) &&
    timingSafeEqual(Buffer.from(csrfForSession(proof), 'hex'), Buffer.from(received, 'hex'));
}
