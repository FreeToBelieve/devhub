import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gitHeadSchema, inboxSourceSchema, inboxTaskKeySchema, inboxTextLimit, taskInbox } from '@devhub/contracts';
import { gitApiTransport } from './endpoint.js';
import type { GitApiTransport } from './endpoint.js';

export class InboxRemoteError extends Error {
  constructor(readonly code: string) { super(code); }
}

const identity = z.object({ id: z.literal(taskInbox.repositoryId), full_name: z.literal(taskInbox.repository) });
const pr = z.object({
  number: z.int().positive(), state: z.literal('open'), title: z.string().startsWith('[DEVHUB-TASK]'),
  user: z.object({ id: z.literal(taskInbox.authorId), login: z.literal(taskInbox.author) }),
  head: z.object({ ref: z.string().startsWith('ai-task/'), sha: gitHeadSchema, repo: identity }),
  base: z.object({ ref: z.literal(taskInbox.base), repo: identity }),
});
function candidate(value: unknown) {
  const parsed = pr.safeParse(value);
  if (!parsed.success) return undefined;
  const key = inboxTaskKeySchema.safeParse(parsed.data.head.ref.slice('ai-task/'.length));
  const title = parsed.data.title.slice('[DEVHUB-TASK]'.length).trim();
  if (!key.success || !title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) return undefined;
  return { number: parsed.data.number, headSha: parsed.data.head.sha, title, key: key.data };
}

const objectSha = z.string().regex(/^[a-f0-9]{40}$/);
const commitSchema = z.object({ sha: gitHeadSchema, tree: z.object({ sha: objectSha }) });
const treeSchema = z.object({ truncated: z.literal(false), tree: z.array(z.object({
  path: z.string(), mode: z.string(), type: z.string(), sha: objectSha, size: z.int().optional(),
})) });
const blobSchema = z.object({
  sha: objectSha, encoding: z.literal('base64'), size: z.int().positive().max(inboxTextLimit), content: z.string().max(24_000),
});

function field(text: string, label: string) {
  const matches = [...text.matchAll(new RegExp('^- ' + label + ': `([^`\\r\\n]+)`[ \\t]*$', 'gm'))];
  if (matches.length !== 1) throw new InboxRemoteError('INBOX_TASK_FORMAT');
  return matches[0]![1]!;
}

export function parseInboxTask(text: string, source: NonNullable<ReturnType<typeof candidate>>, blobSha: string) {
  if (Buffer.byteLength(text) > inboxTextLimit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new InboxRemoteError('INBOX_TASK_FORMAT');
  }
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('# DevHub AI Task\n') || field(normalized, 'Task ID') !== source.key ||
      !['Objective', 'Strictly out of scope', 'Acceptance plan', 'Expected completion report'].every((heading) =>
        normalized.includes('\n## ' + heading + '\n'))) throw new InboxRemoteError('INBOX_TASK_FORMAT');
  const parsed = inboxSourceSchema.safeParse({ ...source, repositoryId: taskInbox.repositoryId, blobSha, text,
    projectId: field(normalized, 'Project ID'), unityVersion: field(normalized, 'Target Unity'), scene: field(normalized, 'Test scene') });
  if (!parsed.success) throw new InboxRemoteError('INBOX_TASK_FORMAT');
  return parsed.data;
}

export function githubTaskInbox(token: string, transport: GitApiTransport = gitApiTransport, signal?: AbortSignal) {
  const repository = '/repos/' + taskInbox.repository;
  async function get(path: string) {
    let response;
    try {
      signal?.throwIfAborted();
      response = await transport(new URL('https://api.github.com' + repository + path), 'GET', {
        authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      }, undefined, signal);
      signal?.throwIfAborted();
    } catch { throw new InboxRemoteError('INBOX_UNAVAILABLE'); }
    if (response.status === 401 || response.status === 403) throw new InboxRemoteError('INBOX_ACCESS_DENIED');
    if (response.status !== 200) throw new InboxRemoteError('INBOX_UNAVAILABLE');
    if (JSON.stringify(response.data)?.includes(token)) throw new InboxRemoteError('INBOX_UNSAFE_CONTENT');
    return response.data;
  }
  return {
    async verify() {
      const valid = identity.extend({ default_branch: z.literal(taskInbox.base), private: z.literal(true) }).safeParse(await get(''));
      if (!valid.success) throw new InboxRemoteError('INBOX_REPOSITORY_MISMATCH');
    },
    async open() {
      const results: NonNullable<ReturnType<typeof candidate>>[] = [];
      for (let page = 1; page <= 30; page++) {
        const batch = z.array(z.unknown()).max(100).safeParse(await get('/pulls?state=open&base=main&per_page=100&page=' + page));
        if (!batch.success) throw new InboxRemoteError('INBOX_INVALID_RESPONSE');
        for (const item of batch.data) {
          const value = candidate(item);
          if (value) results.push(value);
        }
        if (batch.data.length < 100) return results;
      }
      throw new InboxRemoteError('INBOX_PAGINATION_LIMIT');
    },
    async current(number: number) { return candidate(await get('/pulls/' + z.int().positive().parse(number))); },
    async read(source: NonNullable<ReturnType<typeof candidate>>) {
      const result = commitSchema.safeParse(await get('/git/commits/' + source.headSha));
      if (!result.success || result.data.sha !== source.headSha) throw new InboxRemoteError('INBOX_TASK_FORMAT');
      let sha = result.data.tree.sha;
      for (const name of ['.devhub', 'tasks', source.key + '.md']) {
        const tree = treeSchema.safeParse(await get('/git/trees/' + sha));
        const entry = tree.success ? tree.data.tree.find((item) => item.path === name) : undefined;
        if (!entry || (name.endsWith('.md') ? entry.type !== 'blob' || entry.mode !== '100644' ||
            !entry.size || entry.size > inboxTextLimit : entry.type !== 'tree' || entry.mode !== '040000')) {
          throw new InboxRemoteError('INBOX_TASK_FORMAT');
        }
        sha = entry.sha;
      }
      const blob = blobSchema.safeParse(await get('/git/blobs/' + sha));
      if (!blob.success || blob.data.sha !== sha) throw new InboxRemoteError('INBOX_TASK_FORMAT');
      const bytes = Buffer.from(blob.data.content, 'base64');
      if (bytes.length !== blob.data.size || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== sha) {
        throw new InboxRemoteError('INBOX_TASK_FORMAT');
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new InboxRemoteError('INBOX_TASK_FORMAT'); }
      if (text.includes(token)) throw new InboxRemoteError('INBOX_UNSAFE_CONTENT');
      return parseInboxTask(text, source, sha);
    },
  };
}
