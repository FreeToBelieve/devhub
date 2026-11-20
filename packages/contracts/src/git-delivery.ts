import { z } from 'zod';
import { digestSchema, gitHeadSchema } from './authorization.js';

export const gitProviderKind = z.enum(['github', 'gitlab']);
export const remoteBranchName = z.string().max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((name) => !name.includes('..') && name.split('/').every((part) =>
    !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')));
export const deliveryBranchName = remoteBranchName.refine((name) => name.startsWith('devhub/') && name.length > 7);
export const gitProjectInput = z.strictObject({
  projectId: z.uuid(),
  provider: gitProviderKind,
  repositoryUrl: z.string().url().max(512),
  apiBaseUrl: z.string().url().max(512).optional(),
  token: z.string().min(8).max(2048).regex(/^[!-~]+$/),
});
export const gitAuthorInput = z.strictObject({
  name: z.string().trim().min(1).max(100).regex(/^[^<>\x00-\x1f\x7f]+$/),
  email: z.email().max(254),
});
export const gitChangeTitle = z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/);
export const gitChangeInput = z.strictObject({ title: gitChangeTitle, description: z.string().max(5000) });
export const gitDeliveryInput = gitChangeInput.extend({
  taskId: z.uuid(),
  worktreeId: digestSchema,
  branch: deliveryBranchName,
  author: gitAuthorInput,
});
export const gitDeliveryApproval = z.strictObject({
  expectedVersion: z.int().positive(),
  digest: digestSchema,
});
export const gitCandidateStaleCodes: readonly string[] = [
  'GIT_WORKTREE_CHANGED', 'GIT_HEAD_CHANGED', 'GIT_CANDIDATE_TREE_CHANGED', 'WORKSPACE_SECRET_DETECTED',
];

export interface GitConnection {
  projectId: string;
  provider: z.infer<typeof gitProviderKind>;
  repositoryUrl: string;
  apiBaseUrl: string;
  remoteId: string;
  defaultBranch: string;
  account: string;
  version: number;
  connected: boolean;
}

export interface GitBranch {
  name: string;
  sha: z.infer<typeof gitHeadSchema>;
  protected: boolean;
}

export interface GitChange {
  number: number;
  title: string;
  description: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
}

export interface GitReview {
  id: string;
  author: string;
  body: string;
  path: string | null;
  url: string | null;
}

export interface GitCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitDiffFile {
  path: string;
  status: string;
  patch: string | null;
}

export type GitProjectInput = z.infer<typeof gitProjectInput>;
export type GitDeliveryInput = z.infer<typeof gitDeliveryInput>;
export type GitDeliveryApproval = z.infer<typeof gitDeliveryApproval>;

export interface GitCandidateBlob {
  kind: 'text' | 'binary' | 'lfs-pointer' | 'submodule' | 'symlink';
  mediaType: string;
  size: number | null;
  sha256: string | null;
  objectSha: string;
  lfs?: { sha256: string; size: number };
}

export interface GitCandidateFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';
  before: GitCandidateBlob | null;
  after: GitCandidateBlob | null;
  patch: string | null;
  warnings: string[];
}

export interface GitCandidatePreview {
  candidateTreeSha: string;
  baseHeadSha: string;
  workspaceSha256: string;
  changedFiles: GitCandidateFile[];
  candidateDiffDigest: string;
  candidateFileSummary: Record<GitCandidateFile['status'], number>;
  canCommit: boolean;
}

export interface GitDeliveryBinding extends GitDeliveryInput {
  projectId: string;
  projectContextSha256?: string;
  connectionVersion: number;
  targetBranch: string;
  worktreeRoot: string;
  repoId: string;
  head: string;
  workspaceSha256: string;
  taskRevision: number;
  taskSpecSha256: string;
  remoteHead: string | null;
  candidateTreeSha?: string;
  candidateDiffDigest?: string;
}

export interface GitOperation {
  id: string;
  projectId: string;
  binding: GitDeliveryBinding;
  digest: string;
  summary: { changes: string[]; diff: string; candidate?: GitCandidatePreview };
  phase: 'PREVIEW' | 'APPROVED' | 'COMMITTED' | 'PUSHED' | 'DELIVERED';
  version: number;
  commitSha: string | null;
  changeNumber: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}
