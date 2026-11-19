import { isIP } from 'node:net';

export interface EgressPolicy {
  enabled: boolean;
  allowedDomains: readonly string[];
}

export const defaultToolNetworkPolicy: EgressPolicy = Object.freeze({
  enabled: false,
  allowedDomains: Object.freeze([]),
});

export function permitsDestination(policy: EgressPolicy, target: string): boolean {
  if (!policy.enabled) return false;
  try {
    const url = new URL(target);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.port === '' || url.port === '443') && isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0 &&
      policy.allowedDomains.some((domain) => domain.toLowerCase() === url.hostname);
  } catch {
    return false;
  }
}
