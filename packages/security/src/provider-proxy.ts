export function providerProxyEndpoint(input: string | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('The Codex provider proxy must be a local HTTP proxy.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The Codex provider proxy must be a numeric loopback HTTP endpoint with a port.');
  }
  return url.origin;
}
