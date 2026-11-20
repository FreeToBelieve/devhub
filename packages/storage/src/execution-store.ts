import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  executionAuditEventSchema, executionBindingSchema, executionPolicyVersion, executionRequestSchema, legacyProjectId, runnerRecordSchema, worktreeRecordSchema,
} from '@devhub/contracts';
import type {
  ExecutionBinding, ExecutionRequest, ExecutionState, RunnerClaimInput, RunnerRecord, Task, WorktreeRecord,
} from '@devhub/contracts';
import { generateLocalProof, sha256 } from '@devhub/security';
import { immediate } from './migrations.js';
import { ProjectError, projectContextDigest } from './project-store.js';
import type { ProjectStore } from './project-store.js';

const minute = 60_000;
const operatorId = 'local-operator';
type AuthorizationCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'STALE_CONTEXT' | 'VERSION_CONFLICT' |
  'STATE_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'ALREADY_CLAIMED';

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationCode) {
    super(code);
  }
}

export function taskSpecDigest(task: Pick<Task, 'title' | 'description' | 'targetPlatform'>): string {
  return sha256(JSON.stringify([task.title, task.description, task.targetPlatform]));
}

type OperatorMutation = {
  kind: 'approve' | 'deny' | 'revoke';
  requestId: string;
  expectedVersion: number;
  sessionDigest: string;
  idempotencyKey: string;
  workspaceMatches: boolean;
};
type RunnerMutation = RunnerClaimInput & {
  kind: 'claim';
  runnerId: string;
  proofDigest: string;
  deviceId: string;
  workspaceMatches: boolean;
};
type Actor = { kind: 'operator' | 'runner' | 'system'; id: string };

export function createExecutionStore(database: DatabaseSync, getTask: (id: string) => Task | undefined, clock: () => number,
  projects: ProjectStore) {
  const sql = (statement: string) => database.prepare(statement);
  const requestColumns = `
    SELECT r.id, r.project_id AS projectId, r.binding_json AS bindingJson, r.binding_digest AS bindingDigest, r.status,
      r.version, r.created_at AS createdAt, r.expires_at AS expiresAt,
      g.id AS grantId, g.expires_at AS grantExpiresAt
    FROM execution_requests r LEFT JOIN execution_grants g ON g.request_id = r.id
  `;

  function decode(row: Record<string, unknown> | undefined): ExecutionRequest | undefined {
    if (!row) return undefined;
    const request = executionRequestSchema.parse({ ...row, binding: JSON.parse(String(row.bindingJson)) });
    if (sha256(JSON.stringify(request.binding)) !== request.bindingDigest) throw new Error('Invalid execution binding digest.');
    return request;
  }

  function getRequest(id: string) {
    return decode(sql(requestColumns + ' WHERE r.id = ?').get(id));
  }

  function getByGrant(grantId: string) {
    return decode(sql(requestColumns + ' WHERE g.id = ?').get(grantId));
  }

  function getRunner(id: string) {
    const row = sql('SELECT id, device_id AS deviceId, platform, label FROM authorization_runners WHERE id = ?').get(id);
    return row && runnerRecordSchema.parse(row);
  }

  function getWorktree(id: string, projectId?: string) {
    const row = sql('SELECT worktree_id AS worktreeId, repo_id AS repoId, root, project_id AS projectId FROM authorization_worktrees WHERE worktree_id = ?').get(id);
    return row && (projectId === undefined || row.projectId === projectId) ? worktreeRecordSchema.parse(row) : undefined;
  }

  function requireSession(digest: string, now: number) {
    const session = sql('SELECT expires_at AS expiresAt FROM operator_sessions WHERE digest = ? AND expires_at > ?').get(digest, now);
    if (!session) throw new AuthorizationError('UNAUTHENTICATED');
    return Number(session.expiresAt);
  }

  function audit(request: ExecutionRequest, kind: ExecutionState, actor: Actor, now: number, reason: string | null = null) {
    sql(`INSERT INTO execution_audit_events (request_id, kind, actor_kind, actor_id, reason, binding_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(request.id, kind, actor.kind, actor.id, reason, request.bindingDigest, now);
  }

  function advance(request: ExecutionRequest, status: ExecutionState, actor: Actor, now: number, reason: string | null = null) {
    const result = sql('UPDATE execution_requests SET status = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?')
      .run(status, request.id, request.status, request.version);
    if (result.changes !== 1) throw new AuthorizationError('VERSION_CONFLICT');
    audit(request, status, actor, now, reason);
  }

  function invalidate(request: ExecutionRequest, status: 'EXPIRED' | 'REVOKED', now: number, reason: string) {
    sql('UPDATE execution_grants SET revoked_at = ? WHERE request_id = ? AND revoked_at IS NULL AND claimed_at IS NULL')
      .run(now, request.id);
    advance(request, status, { kind: 'system', id: 'policy' }, now, reason);
    return getRequest(request.id)!;
  }

  function expire(request: ExecutionRequest, now: number) {
    if ((request.status === 'PENDING' || request.status === 'APPROVED') &&
        Math.min(request.expiresAt, request.grantExpiresAt ?? request.expiresAt) <= now) {
      return invalidate(request, 'EXPIRED', now, 'TIME_LIMIT');
    }
    return request;
  }

  function matchesBinding(binding: ExecutionBinding, workspaceMatches: boolean, projectId: string): boolean {
    const task = getTask(binding.taskId);
    const runner = getRunner(binding.runnerId);
    const worktree = getWorktree(binding.worktreeId);
    const project = projects.get(projectId);
    return workspaceMatches && binding.policyVersion === executionPolicyVersion && project?.status === 'ACTIVE' &&
      (project.targetPlatform === 'BOTH' || project.targetPlatform === binding.platform) &&
      (!binding.projectId || binding.projectId === projectId) &&
      (project.repositoryRoot ? binding.projectContextSha256 === projectContextDigest(project) && project.repoId === binding.repoId :
        !sql('SELECT 1 FROM projects WHERE repo_id=?').get(binding.repoId)) &&
      task?.projectId === projectId && worktree?.projectId === projectId &&
      !sql('SELECT 1 FROM codex_task_sessions WHERE worktree_id=? AND task_id<>?').get(binding.worktreeId, binding.taskId) &&
      task !== undefined && task.revision === binding.taskRevision && taskSpecDigest(task) === binding.taskSpecSha256 &&
      (task.targetPlatform === 'BOTH' || task.targetPlatform === binding.platform) &&
      runner?.platform === binding.platform && worktree?.repoId === binding.repoId;
  }

  function lookupKey(actor: Actor, action: string, key: string, digest: string) {
    const entry = sql('SELECT digest, request_id AS requestId FROM execution_idempotency WHERE actor_id = ? AND action = ? AND key = ?')
      .get(actor.id, action, key);
    if (entry && entry.digest !== digest) throw new AuthorizationError('IDEMPOTENCY_CONFLICT');
    return entry ? String(entry.requestId) : undefined;
  }

  function rememberKey(actor: Actor, action: string, key: string, digest: string, id: string) {
    sql('INSERT INTO execution_idempotency (actor_id, action, key, digest, request_id) VALUES (?, ?, ?, ?, ?)')
      .run(actor.id, action, key, digest, id);
  }

  function mutate(change: OperatorMutation | RunnerMutation, onClaim?: (request: ExecutionRequest) => void) {
    const outcome = immediate(database, () => {
      const now = clock();
      let actor: Actor;
      let request;
      let fingerprint: string;
      const keyAction = change.kind === 'approve' || change.kind === 'deny' ? 'decision' : change.kind;
      if (change.kind === 'claim') {
        const runner = getRunner(change.runnerId);
        const proof = sql('SELECT runner_id FROM runner_credentials WHERE digest = ? AND used_at IS NULL AND expires_at > ?')
          .get(change.proofDigest, now);
        if (!runner || runner.deviceId !== change.deviceId || proof?.runner_id !== runner.id) {
          throw new AuthorizationError('UNAUTHENTICATED');
        }
        actor = { kind: 'runner', id: runner.id };
        request = getByGrant(change.grantId);
        if (!request || request.binding.runnerId !== runner.id) throw new AuthorizationError('FORBIDDEN');
        fingerprint = sha256(JSON.stringify([change.grantId, change.expectedVersion, change.bindingDigest]));
      } else {
        requireSession(change.sessionDigest, now);
        actor = { kind: 'operator', id: operatorId };
        request = getRequest(change.requestId);
        if (!request) throw new AuthorizationError('NOT_FOUND');
        fingerprint = sha256(JSON.stringify([change.kind, change.requestId, change.expectedVersion]));
      }

      request = expire(request, now);
      const prior = lookupKey(actor, keyAction, change.idempotencyKey, fingerprint);
      if (change.kind === 'claim' && (prior || request.status === 'CLAIMED')) {
        return new AuthorizationError('ALREADY_CLAIMED');
      }
      if (prior) return request;
      if (request.version !== change.expectedVersion) return new AuthorizationError('VERSION_CONFLICT');
      const requiredState = change.kind === 'approve' || change.kind === 'deny' ? 'PENDING' : 'APPROVED';
      if (request.status !== requiredState) return new AuthorizationError('STATE_CONFLICT');
      if (change.kind === 'claim' && ['codex.turn', 'unity.run'].includes(request.binding.scope.operation) && !onClaim) {
        return new AuthorizationError('FORBIDDEN');
      }

      if (change.kind === 'approve' || change.kind === 'claim') {
        if (change.kind === 'claim' && request.bindingDigest !== change.bindingDigest) return new AuthorizationError('STALE_CONTEXT');
        if (!matchesBinding(request.binding, change.workspaceMatches, request.projectId)) {
          invalidate(request, 'REVOKED', now, 'CONTEXT_CHANGED');
          return new AuthorizationError('STALE_CONTEXT');
        }
      }

      if (change.kind === 'approve') {
        sql('INSERT INTO execution_grants (id, request_id, expires_at) VALUES (?, ?, ?)')
          .run(randomUUID(), request.id, Math.min(request.expiresAt, now + 2 * minute));
        advance(request, 'APPROVED', actor, now);
      } else if (change.kind === 'deny') {
        advance(request, 'DENIED', actor, now);
      } else if (change.kind === 'revoke') {
        sql('UPDATE execution_grants SET revoked_at = ? WHERE request_id = ? AND claimed_at IS NULL').run(now, request.id);
        advance(request, 'REVOKED', actor, now);
      } else if (change.kind === 'claim') {
        const grant = sql('UPDATE execution_grants SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
          .run(now, request.grantId, now);
        if (grant.changes !== 1) throw new AuthorizationError('STATE_CONFLICT');
        sql('UPDATE runner_credentials SET used_at = ? WHERE digest = ?').run(now, change.proofDigest);
        advance(request, 'CLAIMED', actor, now);
      }
      rememberKey(actor, keyAction, change.idempotencyKey, fingerprint, request.id);
      const result = getRequest(request.id)!;
      if (change.kind === 'claim') onClaim?.(result);
      return result;
    });
    if (outcome instanceof AuthorizationError) throw outcome;
    return outcome;
  }

  return {
    createBootstrap() {
      const proof = generateLocalProof();
      const now = clock();
      const expiresAt = now + 5 * minute;
      immediate(database, () => {
        sql('DELETE FROM operator_bootstraps WHERE expires_at <= ?').run(now);
        sql('INSERT INTO operator_bootstraps (digest, expires_at) VALUES (?, ?)').run(sha256(proof), expiresAt);
      });
      return { proof, expiresAt };
    },
    exchangeBootstrap(bootstrapDigest: string) {
      const proof = generateLocalProof();
      return immediate(database, () => {
        const now = clock();
        const used = sql('UPDATE operator_bootstraps SET used_at = ? WHERE digest = ? AND used_at IS NULL AND expires_at > ?')
          .run(now, bootstrapDigest, now);
        if (used.changes !== 1) throw new AuthorizationError('UNAUTHENTICATED');
        const expiresAt = now + 8 * 60 * minute;
        sql('DELETE FROM operator_sessions WHERE expires_at <= ?').run(now);
        sql('INSERT INTO operator_sessions (digest, expires_at) VALUES (?, ?)').run(sha256(proof), expiresAt);
        return { proof, expiresAt };
      });
    },
    sessionExpiry(digest: string) {
      return requireSession(digest, clock());
    },
    closeSession(digest: string) {
      sql('DELETE FROM operator_sessions WHERE digest = ?').run(digest);
    },
    registerRunner(record: Omit<RunnerRecord, 'id'>) {
      const runner = { ...record, id: randomUUID() };
      sql('INSERT INTO authorization_runners (id, device_id, platform, label) VALUES (?, ?, ?, ?)')
        .run(runner.id, runner.deviceId, runner.platform, runner.label);
      return runner;
    },
    activateRunner(id: string, deviceId: string, platform: RunnerRecord['platform']) {
      return immediate(database, () => {
        const runner = getRunner(id);
        if (!runner || runner.deviceId !== deviceId || runner.platform !== platform) throw new AuthorizationError('FORBIDDEN');
        const proof = generateLocalProof();
        const now = clock();
        sql('DELETE FROM runner_credentials WHERE expires_at <= ?').run(now);
        sql('INSERT INTO runner_credentials (digest, runner_id, expires_at) VALUES (?, ?, ?)')
          .run(sha256(proof), id, now + minute);
        return proof;
      });
    },
    registerWorktree(record: WorktreeRecord, projectId: string) {
      return immediate(database, () => {
        const project = projects.require(projectId, true);
        if (project.repoId && record.repoId !== project.repoId) throw new ProjectError('PROJECT_SCOPE_MISMATCH');
        const prior = getWorktree(record.worktreeId);
        if (prior && (prior.projectId !== projectId || prior.repoId !== record.repoId || prior.root !== record.root)) {
          throw new ProjectError('PROJECT_SCOPE_MISMATCH');
        }
        sql('INSERT OR IGNORE INTO authorization_worktrees (worktree_id, repo_id, root, project_id) VALUES (?, ?, ?, ?)')
          .run(record.worktreeId, record.repoId, record.root, projectId);
        return { ...record, projectId };
      });
    },
    catalog(projectId = legacyProjectId) {
      return {
        runners: sql('SELECT id, device_id AS deviceId, platform, label FROM authorization_runners ORDER BY label, id')
          .all().map((row) => runnerRecordSchema.parse(row)),
        worktrees: sql('SELECT worktree_id AS worktreeId, repo_id AS repoId, root, project_id AS projectId FROM authorization_worktrees WHERE project_id=? ORDER BY root')
          .all(projectId).map((row) => worktreeRecordSchema.parse(row)),
      };
    },
    getWorktree,
    getProject: projects.get,
    getRequest,
    getByGrant,
    invalidateTaskInTransaction(taskId: string) {
      const now = clock();
      const active = sql(requestColumns + " WHERE r.task_id = ? AND r.status IN ('PENDING', 'APPROVED')").all(taskId);
      for (const row of active) {
        const request = expire(decode(row)!, now);
        if (request.status !== 'EXPIRED') invalidate(request, 'REVOKED', now, 'TASK_REVISION_CHANGED');
      }
    },
    createRequest(input: ExecutionBinding, sessionDigest: string, idempotencyKey: string, workspaceMatches: boolean, onCreate?: (request: ExecutionRequest) => void) {
      const binding = executionBindingSchema.parse(input);
      const digest = sha256(JSON.stringify(binding));
      return immediate(database, () => {
        const now = clock();
        requireSession(sessionDigest, now);
        const projectId = binding.projectId ?? getTask(binding.taskId)?.projectId ?? legacyProjectId;
        const actor: Actor = { kind: 'operator', id: operatorId };
        const retry = lookupKey(actor, 'create', idempotencyKey, digest);
        if (retry) return expire(getRequest(retry)!, now);
        if (!matchesBinding(binding, workspaceMatches, projectId)) throw new AuthorizationError('STALE_CONTEXT');
        if (binding.scope.operation === 'codex.turn' && binding.scope.mode === 'resume' &&
            !sql('SELECT 1 FROM codex_runs WHERE id=? AND project_id=? AND worktree_id=? AND thread_id=?')
              .get(binding.scope.previousRunId, projectId, binding.worktreeId, binding.codexThreadId)) {
          throw new AuthorizationError('STALE_CONTEXT');
        }
        const id = randomUUID();
        sql(`INSERT INTO execution_requests (id, task_id, runner_id, worktree_id, binding_json, binding_digest, status, version, created_at, expires_at, project_id)
          VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?)`)
          .run(id, binding.taskId, binding.runnerId, binding.worktreeId, JSON.stringify(binding), digest, now, now + 10 * minute, projectId);
        const request = getRequest(id)!;
        audit(request, 'PENDING', actor, now);
        rememberKey(actor, 'create', idempotencyKey, digest, id);
        onCreate?.(request);
        return request;
      });
    },
    requests(projectId = legacyProjectId) {
      return immediate(database, () => {
        const rows = sql(requestColumns + ' WHERE r.project_id=? ORDER BY r.created_at DESC, r.rowid DESC').all(projectId);
        const now = clock();
        return rows.map((row) => expire(decode(row)!, now));
      });
    },
    detail(id: string) {
      return immediate(database, () => {
        const found = getRequest(id);
        if (!found) throw new AuthorizationError('NOT_FOUND');
        const request = expire(found, clock());
        const events = sql(`SELECT id, kind, actor_kind AS actorKind, actor_id AS actorId, reason,
          binding_digest AS bindingDigest, created_at AS createdAt
          FROM execution_audit_events WHERE request_id = ? ORDER BY id`)
          .all(id).map((row) => executionAuditEventSchema.parse(row));
        return { request, events };
      });
    },
    mutate,
  };
}
