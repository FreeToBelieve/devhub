import { createHash } from 'node:crypto';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { gitHeadSchema } from '@devhub/contracts';
import type { GitCandidateBlob, GitCandidateFile, GitCandidatePreview } from '@devhub/contracts';
import { GitProviderError } from '@devhub/git-provider';
import { containsWorkspaceSecret, isSensitiveConfig, isWorkspaceSecretPath, sha256 } from '@devhub/security';
import { git, gitStream, nullDevice } from './git-process.js';

const limits = { files: 1000, totalScan: 512 * 1024 ** 2, text: 128 * 1024, patch: 48 * 1024, preview: 256 * 1024 };
const fileStatus = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type-changed' } as const;
type CandidateSummary = Omit<GitCandidatePreview, 'workspaceSha256'>;

interface RawChange {
  path: string;
  previousPath: string | null;
  status: GitCandidateFile['status'];
  from: { mode: string; sha: string };
  to: { mode: string; sha: string };
}

function changesFromRaw(value: string) {
  const fields = value.split('\0');
  const changes: RawChange[] = [];
  let index = 0;
  while (index < fields.length - 1) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMDRT])(?:\d+)?$/.exec(fields[index++]!);
    const name = fields[index++];
    const destination = header?.[5] === 'R' ? fields[index++] : name;
    if (!header || !name || !destination || changes.length >= limits.files) throw new GitProviderError('GIT_CANDIDATE_DIFF_LIMIT');
    const [_, oldMode, newMode, oldSha, newSha, status] = header;
    if (!gitHeadSchema.safeParse(oldSha).success || !gitHeadSchema.safeParse(newSha).success) {
      throw new GitProviderError('GIT_CANDIDATE_DIFF_UNSUPPORTED');
    }
    changes.push({ path: destination, previousPath: name !== destination ? name : null,
      status: fileStatus[status as keyof typeof fileStatus],
      from: { mode: oldMode!, sha: oldSha! }, to: { mode: newMode!, sha: newSha! } });
  }
  return changes;
}

function mediaType(path: string, bytes: Buffer, text: boolean) {
  if (text) return ['.meta', '.unity', '.prefab', '.yaml', '.yml'].includes(extname(path).toLowerCase())
    ? 'text/yaml' : 'text/plain';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'PK\u0003\u0004') return 'application/zip';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}

function candidateGit(root: string, environment: NodeJS.ProcessEnv) {
  return (args: readonly string[], input?: string) => git(root, args, environment, [], input);
}

export async function withCandidate<T>(root: string, head: string, forbiddenText: string | undefined,
  use: (candidate: { summary: CandidateSummary; importObjects(): Promise<void> }) => Promise<T>): Promise<T> {
  const baseHeadSha = gitHeadSchema.parse(head);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'devhub-candidate-')));
  try {
    const isolated = join(scratch, 'git');
    const objectDirectory = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim());
    const format = baseHeadSha.length === 64 ? 'sha256' : 'sha1';
    await git(scratch, ['init', '--bare', '--template=', '--object-format=' + format, isolated]);
    const environment = { GIT_DIR: isolated, GIT_WORK_TREE: root, GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectDirectory) };
    const run = candidateGit(root, environment);
    // Preserve safe repository settings. Filter commands and diff drivers are absent from the isolated config.
    for (const key of ['filemode', 'ignorecase', 'symlinks', 'autocrlf', 'eol']) {
      const value = (await git(root, ['config', '--get', 'core.' + key], {}, [1])).trim();
      if (/^(true|false|input|lf|crlf|native)$/i.test(value)) await run(['config', '--local', 'core.' + key, value]);
    }
    await run(['config', '--local', 'core.attributesFile', nullDevice]);
    await run(['read-tree', baseHeadSha]);
    await run(['add', '--all', '--', '.']);
    const candidateTreeSha = gitHeadSchema.parse((await run(['write-tree'])).trim());
    const raw = await run(['diff-tree', '--raw', '-r', '-z', '--no-abbrev', '--no-commit-id', '--no-ext-diff', '--no-textconv',
      '--find-renames=50%', '-l1000', baseHeadSha, candidateTreeSha]);
    const changed = changesFromRaw(raw);
    if (!changed.length) throw new GitProviderError('GIT_NO_CHANGES');
    const changedFiles: GitCandidateFile[] = [];
    const candidateFileSummary = { added: 0, modified: 0, deleted: 0, renamed: 0, 'type-changed': 0 };
    let canCommit = true;
    let previewBytes = 0;
    let scannedBytes = 0;

    async function scan(entry: RawChange['from'], path: string) {
      if (entry.mode === '000000') return null;
      if (!['100644', '100755', '120000', '160000'].includes(entry.mode)) throw new GitProviderError('GIT_CANDIDATE_DIFF_UNSUPPORTED');
      if (entry.mode === '160000') {
        return { blob: { kind: 'submodule', mediaType: 'application/x-gitlink', size: null, sha256: null,
          objectSha: entry.sha } as GitCandidateBlob, secret: false, invalidEncoding: false };
      }
      const size = Number((await run(['cat-file', '-s', entry.sha])).trim());
      const config = isSensitiveConfig(path);
      if (!Number.isSafeInteger(size) || size < 0 || (scannedBytes += size) > limits.totalScan || config && size > 256000) {
        throw new GitProviderError('GIT_CANDIDATE_SCAN_LIMIT');
      }
      const hash = createHash('sha256');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = !['.bin', '.bytes'].includes(extname(path).toLowerCase());
      let invalidEncoding = false;
      let content = '';
      let tail = '';
      let prefix = Buffer.alloc(0);
      let secret = isWorkspaceSecretPath(path);
      await gitStream(root, ['cat-file', 'blob', entry.sha], environment, (data) => {
        hash.update(data);
        if (prefix.length < 8) prefix = Buffer.concat([prefix, data.subarray(0, 8 - prefix.length)]);
        const inspect = tail + data.toString('latin1');
        secret ||= !!forbiddenText && inspect.includes(forbiddenText) || containsWorkspaceSecret(inspect);
        tail = inspect.slice(-Math.max(4096, forbiddenText?.length ?? 0));
        if (text && data.includes(0)) text = false;
        if (text) {
          try {
            const decoded = decoder.decode(data, { stream: true });
            if (size <= limits.text || config) content += decoded;
          } catch { text = false; invalidEncoding = true; }
        }
      });
      if (text) {
        try { content += decoder.decode(); }
        catch { text = false; invalidEncoding = true; }
      }
      if (config) {
        if (!text) secret = true;
        else secret ||= containsWorkspaceSecret(content, true, path.toLowerCase().split('/').at(-1) === '.npmrc');
      }
      const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/.exec(content);
      const pointer = match && Number.isSafeInteger(Number(match[2])) ? { sha256: match[1]!, size: Number(match[2]) } : undefined;
      const kind = entry.mode === '120000' ? 'symlink' : pointer ? 'lfs-pointer' : text ? 'text' : 'binary';
      const blob: GitCandidateBlob = { kind, mediaType: pointer ? 'application/vnd.git-lfs.pointer' : mediaType(path, prefix, text),
        size, sha256: hash.digest('hex'), objectSha: entry.sha, ...(pointer ? { lfs: pointer } : {}) };
      return { blob, secret, invalidEncoding: invalidEncoding && blob.mediaType === 'application/octet-stream' };
    }

    for (const change of changed) {
      const { path, previousPath, status } = change;
      for (const name of [path, previousPath]) {
        if (name && (name.includes('\ufffd') || /[\u0000-\u001f\u007f]/.test(name))) throw new GitProviderError('GIT_CANDIDATE_DIFF_UNSUPPORTED');
        if (name && (containsWorkspaceSecret(name) || forbiddenText && name.includes(forbiddenText))) {
          throw new GitProviderError('WORKSPACE_SECRET_DETECTED');
        }
      }
      const before = await scan(change.from, previousPath ?? path);
      const after = await scan(change.to, path);
      if (after?.secret) throw new GitProviderError('WORKSPACE_SECRET_DETECTED');
      const warnings: string[] = [];
      const kinds = [before?.blob.kind, after?.blob.kind];
      const lfs = after && (await run(['check-attr', '--cached', '-z', 'filter', '--', path])).split('\0')[2] === 'lfs';
      if (lfs && after?.blob.kind !== 'lfs-pointer') { warnings.push('GIT_LFS_POINTER_REQUIRED'); canCommit = false; }
      if (kinds.includes('lfs-pointer')) warnings.push('GIT_LFS_POINTER_ONLY');
      if (kinds.includes('submodule')) { warnings.push('GIT_SUBMODULE_POINTER_ONLY'); canCommit = false; }
      if (kinds.includes('symlink')) { warnings.push('GIT_SYMLINK_UNSUPPORTED'); canCommit = false; }
      if (kinds.includes('binary')) warnings.push('GIT_BINARY_METADATA_ONLY');
      if (before?.invalidEncoding || after?.invalidEncoding) warnings.push('GIT_TEXT_ENCODING_UNSUPPORTED');
      if (before?.secret) { warnings.push('GIT_HISTORICAL_SECRET_HIDDEN'); canCommit = false; }
      let patch: string | null = null;
      if (!warnings.length) {
        if ((before?.blob.size ?? 0) > limits.text || (after?.blob.size ?? 0) > limits.text) {
          warnings.push('GIT_TEXT_PREVIEW_LIMIT');
        } else {
          const paths = previousPath ? [previousPath, path] : [path];
          const full = await run(['--literal-pathspecs', 'diff', '--no-color', '--no-textconv', '--no-ext-diff', '--text',
            '--find-renames=50%', '-l1000', baseHeadSha, candidateTreeSha, '--', ...paths]);
          const bytes = Buffer.byteLength(full);
          const available = Math.min(limits.patch, limits.preview - previewBytes);
          if (bytes > available) warnings.push('GIT_PATCH_TRUNCATED');
          if (available > 0) {
            const buffer = Buffer.from(full).subarray(0, available);
            patch = buffer.toString('utf8');
            previewBytes += buffer.length;
          }
        }
      }
      candidateFileSummary[status]++;
      changedFiles.push({ path, previousPath, status, before: before?.blob ?? null, after: after?.blob ?? null, patch, warnings });
    }

    return await use({
      summary: { candidateTreeSha, baseHeadSha, changedFiles, candidateDiffDigest: sha256(JSON.stringify(changedFiles)),
        candidateFileSummary, canCommit },
      async importObjects() {
        if (!canCommit) throw new GitProviderError('GIT_CANDIDATE_UNSAFE');
        const prefix = join(scratch, 'approved');
        const pack = gitHeadSchema.parse((await run(['pack-objects', '--revs', prefix], candidateTreeSha + '\n^' + baseHeadSha + '\n')).trim());
        const input = await open(prefix + '-' + pack + '.pack', 'r');
        try {
          await gitStream(root, ['index-pack', '--stdin'], { ...environment, GIT_OBJECT_DIRECTORY: objectDirectory,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined }, () => undefined, input.fd);
        } finally { await input.close(); }
      },
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function inspectCandidate(root: string, head: string, forbiddenText?: string) {
  return withCandidate(root, head, forbiddenText, async ({ summary }) => summary);
}
