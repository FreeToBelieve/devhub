import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inboxHostSchema, inboxMessageSchema, inboxMessageStatus, inboxSessionSchema, taskInbox } from '@devhub/contracts';
import type { CreateTask, ExecutionRequest, InboxSource, RunnerRecord, Task } from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import { immediate } from './migrations.js';
import type { ProjectStore } from './project-store.js';
import { worktreeBusy } from './worktree-lock.js';

const leaseMs = 15_000;
const hostColumns = `id,installation_id AS installationId,runner_id AS runnerId,platform,status,version,
  heartbeat_at AS heartbeatAt,connected_at AS connectedAt,disconnected_at AS disconnectedAt`;
const sessionColumns = `s.id,s.task_id AS taskId,s.project_id AS projectId,s.host_id AS hostId,
  s.worktree_id AS worktreeId,s.provider_thread_id AS providerThreadId,s.current_run_id AS currentRunId,s.last_run_id AS lastRunId,
  s.updated_at AS updatedAt,t.title,CASE
    WHEN r.status='INTERRUPTED' THEN 'INTERRUPTED'
    WHEN r.status='RUNNING' THEN 'RUNNING'
    WHEN p.open=0 OR j.status='ARCHIVED' THEN 'CLOSED'
    WHEN m.status='FAILED' THEN 'FAILED'
    WHEN m.status='COMPLETED' THEN 'COMPLETED'
    WHEN m.status='DELIVERED' THEN 'WAITING_APPROVAL'
    ELSE 'QUEUED' END AS status`;
const sessionJoin = ` FROM codex_task_sessions s JOIN tasks t ON t.id=s.task_id JOIN github_inbox_prs p ON p.task_id=s.task_id
  JOIN projects j ON j.id=s.project_id LEFT JOIN codex_runs r ON r.id=s.current_run_id
  LEFT JOIN codex_session_messages m ON m.session_id=s.id AND m.head_sha=p.head_sha`;
const messageColumns = `id,session_id AS sessionId,project_id AS projectId,task_id AS taskId,head_sha AS headSha,
  pull_request_number AS pullRequestNumber,sequence,task_revision AS taskRevision,status,created_at AS createdAt,
  delivered_at AS deliveredAt,error_code AS errorCode,request_id AS requestId,payload_json AS payload`;

export class InboxStateError extends Error {
  constructor(readonly code: string) { super(code); }
}
type TaskMutations = {
  create(spec: CreateTask, projectId: string): Task;
  revise(id: string, spec: CreateTask, projectId: string): Task | undefined;
  invalidate(id: string): void;
};

export function createTaskInboxStore(database: DatabaseSync, clock: () => number, projects: ProjectStore, tasks: TaskMutations) {
  const sql = (statement: string) => database.prepare(statement);
  function host() {
    const row = sql('SELECT ' + hostColumns + ' FROM codex_host_connections WHERE singleton=1').get();
    if (!row) return null;
    const state = inboxHostSchema.parse(row);
    return state.status === 'ACTIVE' && state.heartbeatAt <= clock() - leaseMs
      ? { ...state, status: 'DISCONNECTED' as const, disconnectedAt: state.heartbeatAt + leaseMs } : state;
  }
  function settings() {
    const row = sql('SELECT enabled, credential_ref, scanned_at, error_code, pr_count FROM github_inbox_settings WHERE singleton=1').get()!;
    return { enabled: row.enabled === 1, credentialRef: row.credential_ref as string | null,
      scannedAt: row.scanned_at as number | null, errorCode: row.error_code as string | null, prCount: Number(row.pr_count) };
  }
  function session(id: string) {
    const row = sql('SELECT ' + sessionColumns + sessionJoin + ' WHERE s.id=?').get(id);
    return row && inboxSessionSchema.parse(row);
  }
  function message(id: string) {
    const row = sql('SELECT ' + messageColumns + ' FROM codex_session_messages WHERE id=?').get(id);
    return row && inboxMessageSchema.parse({ ...row, source: JSON.parse(String(row.payload)) });
  }
  function live(owner: string) {
    return !!sql(`SELECT 1 FROM codex_host_connections WHERE singleton=1 AND status='ACTIVE'
      AND lease_owner=? AND heartbeat_at>?`).get(owner, clock() - leaseMs);
  }
  function requireOwner(owner: string) {
    if (!live(owner)) throw new InboxStateError('INBOX_HOST_INACTIVE');
  }
  function current(number: number) {
    return sql('SELECT task_id AS taskId,project_id AS projectId,task_key AS taskKey,head_sha AS headSha,open FROM github_inbox_prs WHERE repository_id=? AND number=?')
      .get(taskInbox.repositoryId, number);
  }
  function stale(taskId: string, reason: string) {
    sql(`UPDATE codex_session_messages SET status='STALE',error_code=?
      WHERE task_id=? AND status IN ('PENDING','DELIVERING','DELIVERED','FAILED')`).run(reason, taskId);
    tasks.invalidate(taskId);
  }
  function selected(id: string, expectedStatus: 'DELIVERED' | 'COMPLETED' = 'DELIVERED') {
    const item = message(id);
    const target = item && session(item.sessionId);
    const source = item && current(item.pullRequestNumber);
    if (!item || !target || source?.open !== 1 || source.headSha !== item.headSha ||
        projects.get(item.projectId)?.status !== 'ACTIVE') throw new InboxStateError('INBOX_MESSAGE_STALE');
    if (item.status !== expectedStatus || target.currentRunId) throw new InboxStateError('INBOX_SESSION_BUSY');
    return { item, target };
  }
  function reconcile() {
    const now = clock();
    sql(`UPDATE codex_runs SET status='INTERRUPTED',finished_at=?,diagnostic_code='WORKER_HEARTBEAT_EXPIRED'
      WHERE status='RUNNING' AND heartbeat_at<=? AND id IN (SELECT current_run_id FROM codex_task_sessions)`)
      .run(now, now - leaseMs);
    sql(`UPDATE codex_session_messages SET
      status=CASE WHEN (SELECT status FROM codex_runs WHERE id=run_id)='COMPLETED' THEN 'COMPLETED' ELSE 'FAILED' END,
      error_code=(SELECT COALESCE(diagnostic_code, CASE WHEN status='COMPLETED' THEN NULL ELSE 'INBOX_EXECUTION_FAILED' END)
        FROM codex_runs WHERE id=run_id)
      WHERE status IN ('PROCESSING','FAILED') AND EXISTS(
        SELECT 1 FROM codex_runs WHERE id=run_id AND status NOT IN ('RUNNING','INTERRUPTED') AND exit_confirmed_at IS NOT NULL)`).run();
    sql(`UPDATE codex_task_sessions SET last_run_id=current_run_id,current_run_id=NULL,updated_at=?
      WHERE EXISTS(SELECT 1 FROM codex_runs WHERE id=current_run_id AND exit_confirmed_at IS NOT NULL AND status NOT IN ('RUNNING','INTERRUPTED'))`).run(now);
    sql(`UPDATE codex_session_messages SET status='PENDING',delivered_at=NULL WHERE status='DELIVERING'`).run();
  }

  return {
    host, settings, session, message, live, current,
    reconnectRequested() {
      return sql('SELECT reconnect FROM codex_host_connections WHERE singleton=1').get()?.reconnect === 1;
    },
    acquire(owner: string, runner: RunnerRecord) {
      return immediate(database, () => {
        const prior = host();
        if (prior?.status === 'ACTIVE' && !live(owner)) throw new InboxStateError('INBOX_SECOND_HOST');
        if (prior && prior.runnerId !== runner.id) throw new InboxStateError('INBOX_HOST_RUNNER_MISMATCH');
        const now = clock();
        sql(`INSERT INTO codex_host_connections(singleton,id,installation_id,runner_id,platform,status,version,heartbeat_at,connected_at,lease_owner)
          VALUES(1,?,?,?,?,'ACTIVE','2.8',?,?,?) ON CONFLICT(singleton) DO UPDATE SET
          runner_id=excluded.runner_id,platform=excluded.platform,status='ACTIVE',heartbeat_at=excluded.heartbeat_at,
          connected_at=excluded.connected_at,lease_owner=excluded.lease_owner,reconnect=1,
          disconnected_at=CASE WHEN codex_host_connections.status='ACTIVE' THEN codex_host_connections.heartbeat_at
            ELSE codex_host_connections.disconnected_at END`)
          .run(prior?.id ?? randomUUID(), prior?.installationId ?? randomUUID(), runner.id, runner.platform, now, now, owner);
        reconcile();
        return host()!;
      });
    },
    heartbeat(owner: string) {
      const now = clock();
      return sql(`UPDATE codex_host_connections SET heartbeat_at=? WHERE singleton=1 AND status='ACTIVE'
        AND lease_owner=? AND heartbeat_at>?`).run(now, owner, now - leaseMs).changes === 1;
    },
    disconnect(owner: string, reconnect = false) {
      sql(`UPDATE codex_host_connections SET status='DISCONNECTED',lease_owner=NULL,disconnected_at=?,reconnect=?
        WHERE singleton=1 AND lease_owner=?`).run(clock(), Number(reconnect), owner);
    },
    configure(credentialRef: string) {
      sql('UPDATE github_inbox_settings SET credential_ref=?,error_code=NULL WHERE singleton=1').run(credentialRef);
    },
    enable(enabled: boolean) {
      if (enabled && !settings().credentialRef) throw new InboxStateError('INBOX_CREDENTIAL_REQUIRED');
      sql('UPDATE github_inbox_settings SET enabled=? WHERE singleton=1').run(Number(enabled));
    },
    scanned(prCount: number, errorCode: string | null) {
      sql('UPDATE github_inbox_settings SET scanned_at=?,error_code=?,pr_count=? WHERE singleton=1')
        .run(clock(), errorCode, prCount);
    },
    accept(source: InboxSource) {
      return immediate(database, () => {
        const project = projects.get(source.projectId);
        if (!project?.repositoryRoot || project.status !== 'ACTIVE' || project.unityVersion !== source.unityVersion) {
          throw new InboxStateError('INBOX_PROJECT_INVALID');
        }
        const prior = current(source.number);
        if (prior && (prior.projectId !== project.id || prior.taskKey !== source.key)) throw new InboxStateError('INBOX_TASK_SCOPE_CHANGED');
        if (prior?.headSha === source.headSha) {
          if (prior.open === 0) {
            sql('UPDATE github_inbox_prs SET open=1 WHERE repository_id=? AND number=?').run(source.repositoryId, source.number);
            sql(`UPDATE codex_session_messages SET status='PENDING',delivered_at=NULL,request_id=NULL,error_code=NULL
              WHERE task_id=? AND head_sha=? AND status='STALE' AND run_id IS NULL
                AND task_revision=(SELECT revision FROM tasks WHERE id=?)`)
              .run(prior.taskId!, source.headSha, prior.taskId!);
          }
          return false;
        }
        const duplicate = sql(`SELECT 1 FROM codex_session_messages WHERE repository_id=? AND pull_request_number=? AND head_sha=?`)
          .get(source.repositoryId, source.number, source.headSha);
        if (duplicate) return false;
        const spec = { title: source.title, description: 'GitHub Task Inbox #' + source.number + ' · ' + source.key,
          targetPlatform: project.targetPlatform };
        const now = clock();
        let task: Task;
        let sessionId: string;
        if (!prior) {
          task = tasks.create(spec, project.id);
          sessionId = randomUUID();
          sql('INSERT INTO github_inbox_prs VALUES(?,?,?,?,?,?,1)')
            .run(source.repositoryId, source.number, source.key, task.id, project.id, source.headSha);
          sql('INSERT INTO codex_task_sessions(id,project_id,task_id,created_at,updated_at) VALUES(?,?,?,?,?)')
            .run(sessionId, project.id, task.id, now, now);
        } else {
          task = tasks.revise(String(prior.taskId), spec, project.id)!;
          stale(task.id, 'INBOX_HEAD_CHANGED');
          sql('UPDATE github_inbox_prs SET head_sha=?,open=1 WHERE repository_id=? AND number=?')
            .run(source.headSha, source.repositoryId, source.number);
          sessionId = String(sql('SELECT id FROM codex_task_sessions WHERE task_id=?').get(task.id)?.id);
          sql('UPDATE codex_task_sessions SET updated_at=? WHERE id=?').run(now, sessionId);
        }
        const sequence = Number(sql('SELECT COALESCE(max(sequence),0)+1 AS next FROM codex_session_messages WHERE session_id=?')
          .get(sessionId)?.next);
        sql(`INSERT INTO codex_session_messages(id,session_id,project_id,task_id,repository_id,pull_request_number,
          head_sha,sequence,task_revision,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',?)`)
          .run(randomUUID(), sessionId, project.id, task.id, source.repositoryId, source.number, source.headSha, sequence,
            task.revision, JSON.stringify(source), now);
        return true;
      });
    },
    deactivate(number: number, reason = 'INBOX_PR_CLOSED') {
      immediate(database, () => {
        const found = current(number);
        if (found?.open !== 1) return;
        sql('UPDATE github_inbox_prs SET open=0 WHERE repository_id=? AND number=?').run(taskInbox.repositoryId, number);
        stale(String(found.taskId), reason);
      });
    },
    openNumbers() {
      return sql('SELECT number FROM github_inbox_prs WHERE open=1 AND repository_id=?').all(taskInbox.repositoryId)
        .map((row) => Number(row.number));
    },
    deliver(owner: string) {
      immediate(database, () => {
        requireOwner(owner);
        reconcile();
        const now = clock();
        sql(`UPDATE codex_session_messages SET status='DELIVERED',delivered_at=?
          WHERE status='PENDING' AND id IN (
            SELECT m.id FROM codex_session_messages m JOIN codex_task_sessions s ON s.id=m.session_id
            JOIN github_inbox_prs p ON p.task_id=m.task_id JOIN projects j ON j.id=m.project_id
            WHERE p.open=1 AND p.head_sha=m.head_sha AND j.status='ACTIVE' AND s.current_run_id IS NULL)`).run(now);
        sql(`UPDATE codex_task_sessions SET host_id=(SELECT id FROM codex_host_connections WHERE singleton=1),updated_at=?
          WHERE EXISTS(SELECT 1 FROM codex_session_messages WHERE session_id=codex_task_sessions.id AND delivered_at=?)`)
          .run(now, now);
      });
    },
    sessions(projectId?: string, status?: string, taskId?: string) {
      return sql('SELECT * FROM (SELECT ' + sessionColumns + sessionJoin +
        ') WHERE (? IS NULL OR projectId=?) AND (? IS NULL OR status=?) AND (? IS NULL OR taskId=?) ORDER BY updatedAt DESC,id')
        .all(projectId ?? null, projectId ?? null, status ?? null, status ?? null, taskId ?? null, taskId ?? null)
        .map((row) => inboxSessionSchema.parse(row));
    },
    messages(id: string) {
      return sql('SELECT id FROM codex_session_messages WHERE session_id=? ORDER BY sequence DESC').all(id)
        .map((row) => message(String(row.id))!);
    },
    sessionCounts() {
      const values = Object.fromEntries(inboxSessionSchema.shape.status.options.map((status) => [status, 0]));
      for (const row of sql('SELECT status,count(*) AS n FROM (SELECT ' + sessionColumns + sessionJoin + ') GROUP BY status').all()) {
        values[String(row.status)] = Number(row.n);
      }
      return values;
    },
    counts() {
      const values = Object.fromEntries(inboxMessageStatus.options.map((status) => [status, 0]));
      for (const row of sql('SELECT status,count(*) AS n FROM codex_session_messages GROUP BY status').all()) {
        values[String(row.status)] = Number(row.n);
      }
      return values;
    },
    selected,
    bindWorktree(owner: string, sessionId: string, worktreeId: string) {
      return immediate(database, () => {
        requireOwner(owner);
        const target = session(sessionId);
        const row = sql('SELECT project_id FROM authorization_worktrees WHERE worktree_id=?').get(worktreeId);
        if (!target || target.worktreeId || row?.project_id !== target.projectId || worktreeBusy(database, worktreeId) ||
            sql('SELECT 1 FROM codex_runs WHERE worktree_id=?').get(worktreeId)) {
          throw new InboxStateError('INBOX_WORKTREE_MISMATCH');
        }
        sql('UPDATE codex_task_sessions SET worktree_id=?,updated_at=? WHERE id=?').run(worktreeId, clock(), sessionId);
      });
    },
    linkRequest(owner: string, messageId: string, request: ExecutionRequest) {
      if (!database.isTransaction) throw new InboxStateError('INBOX_TRANSACTION_REQUIRED');
      requireOwner(owner);
      const { item, target } = selected(messageId);
      if (request.projectId !== item.projectId || request.binding.taskId !== item.taskId ||
          request.binding.taskRevision !== item.taskRevision || request.binding.worktreeId !== target.worktreeId ||
          request.binding.codexThreadId !== target.providerThreadId || request.binding.runnerId !== host()?.runnerId) {
        throw new InboxStateError('INBOX_APPROVAL_MISMATCH');
      }
      sql('UPDATE codex_session_messages SET request_id=? WHERE id=?').run(request.id, item.id);
    },
    linkRepair(request: ExecutionRequest, prompt: string) {
      const { binding } = request;
      const row = sql('SELECT id FROM codex_task_sessions WHERE task_id=?').get(binding.taskId);
      if (!row) return;
      if (!database.isTransaction || binding.scope.operation !== 'codex.turn' ||
          binding.scope.mode !== 'resume' || binding.scope.promptSha256 !== sha256(prompt)) {
        throw new InboxStateError('INBOX_APPROVAL_MISMATCH');
      }
      const runner = host();
      if (runner?.status !== 'ACTIVE' || runner.runnerId !== binding.runnerId) throw new InboxStateError('INBOX_HOST_INACTIVE');
      const latest = sql(`SELECT m.id FROM codex_session_messages m JOIN github_inbox_prs p ON p.task_id=m.task_id
        WHERE m.session_id=? AND m.head_sha=p.head_sha AND p.open=1`).get(row.id!);
      const { item, target } = selected(String(latest?.id), 'COMPLETED');
      if (binding.worktreeId !== target.worktreeId || binding.codexThreadId !== target.providerThreadId ||
          binding.taskRevision !== item.taskRevision || binding.scope.previousRunId !== target.lastRunId) {
        throw new InboxStateError('INBOX_APPROVAL_MISMATCH');
      }
      sql('INSERT INTO codex_session_repairs(request_id,message_id,prompt) VALUES (?,?,?)').run(request.id, item.id, prompt);
    },
    requestMessage(requestId: string) {
      const row = sql('SELECT id FROM codex_session_messages WHERE request_id=?').get(requestId);
      const repair = !row && sql('SELECT message_id AS id,prompt FROM codex_session_repairs WHERE request_id=?').get(requestId);
      const item = row || repair;
      return item ? { item: message(String(item.id))!, repairPrompt: repair ? String(repair.prompt) : undefined } : undefined;
    },
    launchFailed(owner: string, id: string, requestId: string, code: string) {
      if (!live(owner)) return;
      sql('UPDATE codex_session_repairs SET error_code=? WHERE request_id=? AND run_id IS NULL').run(code, requestId);
      sql(`UPDATE codex_session_messages SET status='FAILED',error_code=?
        WHERE id=? AND request_id=? AND status='DELIVERED'`).run(code, id, requestId);
    },
    retry(owner: string, id: string) {
      immediate(database, () => {
        requireOwner(owner);
        reconcile();
        const item = message(id);
        const target = item && session(item.sessionId);
        if (!item || item.status !== 'FAILED' || !target || target.currentRunId ||
            current(item.pullRequestNumber)?.headSha !== item.headSha || current(item.pullRequestNumber)?.open !== 1 ||
            projects.get(item.projectId)?.status !== 'ACTIVE') throw new InboxStateError('INBOX_RETRY_NOT_ALLOWED');
        tasks.invalidate(item.taskId);
        sql(`UPDATE codex_session_messages SET status='DELIVERED',delivered_at=?,request_id=NULL,run_id=NULL,error_code=NULL WHERE id=?`).run(clock(), id);
      });
    },
  };
}
