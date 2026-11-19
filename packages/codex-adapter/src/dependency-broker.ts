import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { dependencyDestination, DeveloperNetworkError, openDependency } from '@devhub/security';

const maximumBytes = 128 * 1024 ** 2;
const maximumDownloads = 20;
const root = await realpath(process.argv[2] ?? '');
let downloads = 0;
let downloadedBytes = 0;
const tool = {
  name: 'fetch_dependency',
  description: 'Download a public Unity UPM, npm, or GitHub dependency through DevHub. Returns the name and SHA256 of a new file at the worktree root.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['url'],
    properties: { url: { type: 'string', maxLength: 2048 } } },
};

async function download(raw: string) {
  if (++downloads > maximumDownloads || downloadedBytes >= maximumBytes) {
    throw new DeveloperNetworkError('DOWNLOAD_LIMIT');
  }
  const source = dependencyDestination(raw);
  const result = await openDependency(raw);
  const suffix = source.pathname.match(/\.(tgz|tar\.gz|zip)$/i)?.[0] ??
    (source.hostname === 'codeload.github.com' && source.pathname.includes('/tar.gz/') ? '.tar.gz' : '');
  const filename = 'devhub-dependency-' + randomUUID() + suffix;
  const path = join(root, filename);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of result) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      downloadedBytes += data.length;
      if (downloadedBytes > maximumBytes) throw new DeveloperNetworkError('DOWNLOAD_LIMIT');
      await file.writeFile(data);
      hash.update(data);
    }
    await file.close();
    return { filename, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    if (file) {
      await file.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    }
    throw error;
  } finally {
    result.destroy();
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 8192) continue;
  try {
    const input = JSON.parse(line);
    if (input.jsonrpc !== '2.0' || !(typeof input.id === 'string' || typeof input.id === 'number')) continue;
    const { id, method, params } = input;
    let result: unknown;
    if (method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'devhub-dependencies', version: '1' } };
    } else if (method === 'tools/list') {
      result = { tools: [tool] };
    } else if (method === 'tools/call' && params?.name === tool.name && typeof params.arguments?.url === 'string') {
      try {
        result = { content: [{ type: 'text', text: JSON.stringify(await download(params.arguments.url)) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text',
          text: error instanceof DeveloperNetworkError ? error.code : 'DEPENDENCY_TRANSFER_FAILED' }] };
      }
    } else if (method === 'ping') result = {};
    const response = result ? { result } : { error: { code: -32601, message: 'Method unavailable' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n');
  } catch {
    // Avoid echoing arbitrary URLs and malformed input to logs.
  }
}
