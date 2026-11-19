import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GitChange, GitConnection, GitDeliveryApproval, GitDeliveryBinding, GitOperation, GitReview } from '@devhub/contracts';
import { immediate } from './migrations.js';

export class GitStateError extends Error {
  constructor(readonly code: string) { super(code); }
}

type SecureConnection = Omit<GitConnection, 'connected'> & { credentialRef: string | null };
const connections = `SELECT c.project_id AS projectId, g.kind AS provider, c.repository_url AS repositoryUrl,
  g.api_base_url AS apiBaseUrl, c.remote_id AS remoteId, c.default_branch AS defaultBranch, c.account,
  c.version, c.credential_ref AS credentialRef FROM project_provider_connections c
  JOIN git_providers g ON c.provider_id=g.id`;
const operationColumns = `id, project_id AS projectId, binding, summary, digest, phase, version, commit_sha AS commitSha,
  change_number AS changeNumber, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt`;

function decode(row: Record<string, unknown> | undefined) {
  return row && { ...row, binding: JSON.parse(String(row.binding)), summary: JSON.parse(String(row.summary)) } as GitOperation | undefined;
}

export function createGitStore(database: DatabaseSync, clock: () => number) {
  const sql = (query: string) => database.prepare(query);
  const connection = (projectId: string) => sql(connections + ' WHERE c.project_id=?').get(projectId) as SecureConnection | undefined;
  const operation = (id: string) => decode(sql('SELECT ' + operationColumns + ' FROM git_operations WHERE id=?').get(id));
  function audit(projectId: string, operationId: string | null, actor: string, kind: string, reason: string | null = null) {
    sql('INSERT INTO git_audit_events(project_id,operation_id,actor_digest,kind,reason,created_at) VALUES (?,?,?,?,?,?)')
      .run(projectId, operationId, actor, kind, reason, clock());
  }
  function approved(id: string, input: GitDeliveryApproval) {
    const draft = operation(id);
    if (!draft) throw new GitStateError('GIT_OPERATION_NOT_FOUND');
    if (draft.version !== input.expectedVersion || draft.digest !== input.digest) throw new GitStateError('GIT_APPROVAL_STALE');
    return draft;
  }

  return {
    connection,
    connections(): GitConnection[] {
      return (sql(connections + ' ORDER BY c.project_id').all() as unknown as SecureConnection[]).map(
        ({ credentialRef, ...row }) => ({ ...row, connected: credentialRef !== null }));
    },
    connect(input: Omit<SecureConnection, 'version'> & { credentialRef: string }, expectedVersion: number, actor: string) {
      return immediate(database, () => {
        const previous = connection(input.projectId);
        if ((previous?.version ?? 0) !== expectedVersion) throw new GitStateError('GIT_CONNECTION_CHANGED');
        if (previous && (previous.repositoryUrl !== input.repositoryUrl || previous.remoteId !== input.remoteId ||
            previous.provider !== input.provider || previous.apiBaseUrl !== input.apiBaseUrl)) {
          throw new GitStateError('GIT_PROJECT_BINDING_CHANGED');
        }
        const providerId = randomUUID();
        sql('INSERT INTO git_providers(id, kind, api_base_url) VALUES (?,?,?) ON CONFLICT DO NOTHING')
          .run(providerId, input.provider, input.apiBaseUrl);
        const provider = sql('SELECT id FROM git_providers WHERE kind=? AND api_base_url=?').get(input.provider, input.apiBaseUrl);
        sql('INSERT INTO git_credentials_refs(id, project_id, created_at) VALUES (?,?,?)')
          .run(input.credentialRef, input.projectId, clock());
        sql(`INSERT INTO project_provider_connections(project_id, provider_id, credential_ref, repository_url, remote_id, default_branch, account, version)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET credential_ref=excluded.credential_ref,
          default_branch=excluded.default_branch, account=excluded.account, version=excluded.version`)
          .run(input.projectId, String(provider?.id), input.credentialRef, input.repositoryUrl, input.remoteId,
            input.defaultBranch, input.account, expectedVersion + 1);
        audit(input.projectId, null, actor, previous ? 'REAUTHORIZED' : 'CONNECTED');
        return previous?.credentialRef ?? null;
      });
    },
    revoke(projectId: string, version: number, actor: string) {
      return immediate(database, () => {
        const previous = connection(projectId);
        if (!previous || version !== previous.version) throw new GitStateError('GIT_CONNECTION_CHANGED');
        if (sql('SELECT 1 FROM git_operations WHERE project_id=? AND owner IS NOT NULL').get(projectId)) {
          throw new GitStateError('GIT_WORKTREE_BUSY');
        }
        if (!previous.credentialRef) return null;
        sql('UPDATE project_provider_connections SET credential_ref=NULL, version=version+1 WHERE project_id=?').run(projectId);
        audit(projectId, null, actor, 'REVOKED');
        return previous.credentialRef;
      });
    },
    removeReference(reference: string) {
      sql('DELETE FROM git_credentials_refs WHERE id=?').run(reference);
    },
    operation,
    operations(projectId: string) {
      return sql('SELECT ' + operationColumns + ' FROM git_operations WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100')
        .all(projectId).map((row) => decode(row)!);
    },
    preview(binding: GitDeliveryBinding, summary: GitOperation['summary'], digest: string, actor: string, requestedId: string) {
      return immediate(database, () => {
        const previous = operation(requestedId);
        if (previous) {
          if (previous.digest !== digest || previous.projectId !== binding.projectId) throw new GitStateError('GIT_APPROVAL_STALE');
          return previous;
        }
        sql(`INSERT INTO git_operations (id,project_id,task_id,worktree_id,branch,binding,summary,digest,phase,version,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'PREVIEW',1,?,?)`).run(requestedId, binding.projectId, binding.taskId, binding.worktreeId,
          binding.branch, JSON.stringify(binding), JSON.stringify(summary), digest, clock(), clock());
        audit(binding.projectId, requestedId, actor, 'PREVIEW');
        return operation(requestedId)!;
      });
    },
    approve(id: string, input: GitDeliveryApproval, actor: string) {
      return immediate(database, () => {
        const draft = approved(id, input);
        if (draft.phase === 'DELIVERED' || sql('SELECT 1 FROM git_operations WHERE id=? AND owner IS NOT NULL').get(id)) {
          throw new GitStateError('GIT_OPERATION_BUSY');
        }
        const phase = draft.phase === 'PREVIEW' ? 'APPROVED' : draft.phase;
        sql(`UPDATE git_operations SET phase=?, operator_digest=?, approved_until=?, version=version+1, updated_at=? WHERE id=?`)
          .run(phase, actor, clock() + 120_000, clock(), id);
        audit(draft.projectId, id, actor, 'APPROVED');
        return operation(id)!;
      });
    },
    claim(id: string, input: GitDeliveryApproval, actor: string, owner: string) {
      return immediate(database, () => {
        const draft = approved(id, input);
        if (draft.phase === 'DELIVERED') return draft;
        if (sql(`SELECT 1 FROM codex_runs WHERE worktree_id=? AND status IN ('RUNNING','INTERRUPTED')`).get(draft.binding.worktreeId) ||
            sql('SELECT 1 FROM git_operations WHERE worktree_id=? AND owner IS NOT NULL').get(draft.binding.worktreeId)) {
          throw new GitStateError('GIT_WORKTREE_BUSY');
        }
        const claim = sql(`UPDATE git_operations SET owner=?,approved_until=NULL,error_code=NULL,updated_at=?
          WHERE id=? AND operator_digest=? AND approved_until>? AND owner IS NULL`).run(owner, clock(), id, actor, clock());
        if (claim.changes !== 1) throw new GitStateError('GIT_APPROVAL_REQUIRED');
        audit(draft.projectId, id, actor, 'CLAIMED');
        return draft;
      });
    },
    advance(id: string, owner: string, phase: GitOperation['phase'], actor: string,
      values: { commitSha?: string; changeNumber?: number } = {}) {
      return immediate(database, () => {
        const change = sql(`UPDATE git_operations SET phase=?, commit_sha=COALESCE(?,commit_sha),
          change_number=COALESCE(?,change_number), updated_at=? WHERE id=? AND owner=?`)
          .run(phase, values.commitSha ?? null, values.changeNumber ?? null, clock(), id, owner);
        if (change.changes !== 1) throw new GitStateError('GIT_OPERATION_BUSY');
        const row = operation(id)!;
        audit(row.projectId, id, actor, phase);
        return row;
      });
    },
    release(id: string, owner: string, actor: string, error: string | null) {
      immediate(database, () => {
        const change = sql('UPDATE git_operations SET owner=NULL,error_code=?,updated_at=? WHERE id=? AND owner=?')
          .run(error, clock(), id, owner);
        if (change.changes === 1 && error) audit(operation(id)!.projectId, id, actor, 'FAILED', error);
      });
    },
    busy(worktreeId: string) {
      return !!sql(`SELECT 1 FROM codex_runs WHERE worktree_id=? AND status IN ('RUNNING','INTERRUPTED')`).get(worktreeId) ||
        !!sql('SELECT 1 FROM git_operations WHERE worktree_id=? AND owner IS NOT NULL').get(worktreeId);
    },
    recordChange(projectId: string, change: GitChange, reviews?: GitReview[]) {
      immediate(database, () => {
        sql(`INSERT INTO pull_requests (project_id,number,branch,state,data) VALUES (?,?,?,?,?)
          ON CONFLICT (project_id,number) DO UPDATE SET state=excluded.state,data=excluded.data`)
          .run(projectId, change.number, change.sourceBranch, change.state, JSON.stringify(change));
        if (!reviews) return;
        sql('DELETE FROM pull_request_reviews WHERE project_id=? AND number=?').run(projectId, change.number);
        for (const note of reviews) {
          sql('INSERT OR REPLACE INTO pull_request_reviews (project_id,number,review_id,data) VALUES (?,?,?,?)')
            .run(projectId, change.number, note.id, JSON.stringify(note));
        }
      });
    },
    changes(projectId: string): GitChange[] {
      return sql('SELECT data FROM pull_requests WHERE project_id=? ORDER BY number DESC LIMIT 100').all(projectId)
        .map((row) => JSON.parse(String(row.data)) as GitChange);
    },
    claimMutation(projectId: string, number: number, key: string, digest: string) {
      return immediate(database, () => {
        const now = clock();
        sql(`UPDATE git_change_mutations SET claimed_at=NULL WHERE project_id=? AND number=? AND claimed_at<=?`)
          .run(projectId, number, now - 20 * 60_000);
        if (sql('SELECT 1 FROM git_change_mutations WHERE project_id=? AND number=? AND claimed_at IS NOT NULL').get(projectId, number)) {
          throw new GitStateError('GIT_CHANGE_BUSY');
        }
        const previous = sql('SELECT digest FROM git_change_mutations WHERE project_id=? AND number=? AND mutation_key=?')
          .get(projectId, number, key);
        if (previous && previous.digest !== digest) throw new GitStateError('GIT_IDEMPOTENCY_CONFLICT');
        sql(`INSERT INTO git_change_mutations(project_id,number,mutation_key,digest,claimed_at) VALUES (?,?,?,?,?)
          ON CONFLICT (project_id,number,mutation_key) DO UPDATE SET claimed_at=excluded.claimed_at`)
          .run(projectId, number, key, digest, now);
        return now;
      });
    },
    releaseMutation(projectId: string, number: number, key: string, claimedAt: number) {
      sql(`UPDATE git_change_mutations SET claimed_at=NULL WHERE project_id=? AND number=? AND mutation_key=? AND claimed_at=?`)
        .run(projectId, number, key, claimedAt);
    },
    audit,
    events(projectId: string) {
      return sql(`SELECT id, operation_id AS operationId, kind, reason, created_at AS createdAt
        FROM git_audit_events WHERE project_id=? ORDER BY id DESC LIMIT 100`).all(projectId);
    },
  };
}
