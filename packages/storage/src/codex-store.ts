import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { codexEventSchema, codexRunSchema, legacyProjectId } from '@devhub/contracts';
import type { CodexDiagnostic, CodexRun, CodexRunStatus, ExecutionRequest } from '@devhub/contracts';
import { immediate } from './migrations.js';
import { worktreeBusy } from './worktree-lock.js';

const columns = `id AS devhubRunId, request_id AS requestId, worktree_id AS worktreeId, project_id AS projectId,
  prompt_sha256 AS promptSha256, config_sha256 AS sdkConfigSha256, thread_id AS providerThreadId,
  provider_turn_id AS providerTurnId, previous_run_id AS previousRunId, status,
  cancel_requested AS cancelRequested, started_at AS startedAt, finished_at AS finishedAt,
  heartbeat_at AS heartbeatAt, exit_confirmed_at AS exitConfirmedAt, diagnostic_code AS diagnosticCode`;
const heartbeatTimeout = 15_000;

function decode(row: Record<string, unknown> | undefined): CodexRun | undefined {
  return row && codexRunSchema.parse({ ...row, cancelRequested: row.cancelRequested === 1 });
}

export function createCodexStore(database: DatabaseSync, clock: () => number) {
  const sql = (query: string) => database.prepare(query);
  const get = (id: string, projectId?: string) => decode(projectId === undefined ?
    sql('SELECT ' + columns + ' FROM codex_runs WHERE id=?').get(id) :
    sql('SELECT ' + columns + ' FROM codex_runs WHERE id=? AND project_id=?').get(id, projectId));
  const manages = (id: string) => !!sql('SELECT 1 FROM codex_worktrees WHERE worktree_id=?').get(id);

  return {
    manages,
    manage(id: string) {
      sql('INSERT INTO codex_worktrees(worktree_id) VALUES (?) ON CONFLICT DO NOTHING').run(id);
    },
    get,
    reserveWithinClaim(request: ExecutionRequest, workerId: string, hostOwner?: string) {
      if (!database.isTransaction) throw new Error('CODEX_CLAIM_TRANSACTION_REQUIRED');
      const { binding } = request;
      const { scope } = binding;
      if (request.status !== 'CLAIMED' || scope.operation !== 'codex.turn' ||
          !scope.executionProfile || !scope.networkMode || !manages(binding.worktreeId)) {
        throw new Error('The approval does not cover a managed Codex worktree.');
      }
      if (worktreeBusy(database, binding.worktreeId)) throw new Error('CODEX_WORKTREE_BUSY');
      const session = sql(`SELECT id,task_id,worktree_id,provider_thread_id,current_run_id,last_run_id FROM codex_task_sessions
        WHERE task_id=? OR worktree_id=? LIMIT 1`).get(binding.taskId, binding.worktreeId);
      const message = session && sql(`SELECT m.id,repair.request_id AS repair FROM codex_session_messages m
        LEFT JOIN codex_session_repairs repair ON repair.message_id=m.id AND repair.request_id=?
        JOIN github_inbox_prs p ON p.repository_id=m.repository_id AND p.number=m.pull_request_number
        JOIN codex_host_connections h ON h.id=(SELECT host_id FROM codex_task_sessions WHERE id=m.session_id)
        WHERE ((m.request_id=? AND m.status='DELIVERED') OR
          (repair.request_id IS NOT NULL AND repair.run_id IS NULL AND m.status='COMPLETED'))
          AND m.session_id=? AND m.task_revision=? AND p.open=1 AND p.head_sha=m.head_sha AND h.status='ACTIVE' AND h.lease_owner=?
          AND h.heartbeat_at>? AND h.runner_id=?`).get(request.id, request.id, session.id!, binding.taskRevision, hostOwner ?? null,
          clock() - heartbeatTimeout, binding.runnerId);
      if (session && (!message || scope.executionProfile !== 'PROJECT_DEVELOPER' || scope.networkMode !== 'OFF' ||
          (binding.codexThreadId !== null && scope.previousRunId !== session.last_run_id) || session.task_id !== binding.taskId || session.worktree_id !== binding.worktreeId ||
          session.provider_thread_id !== binding.codexThreadId || session.current_run_id !== null)) {
        throw new Error('INBOX_APPROVAL_MISMATCH');
      }
      if (binding.codexThreadId && sql(`SELECT 1 FROM codex_runs r JOIN execution_requests e ON e.id=r.request_id
        WHERE r.thread_id=? AND (r.worktree_id<>? OR r.project_id<>? OR e.task_id<>? OR r.status IN ('RUNNING','INTERRUPTED'))`)
        .get(binding.codexThreadId, binding.worktreeId, request.projectId, binding.taskId)) throw new Error('CODEX_THREAD_BUSY');

      if (scope.mode === 'resume') {
        const previous = scope.previousRunId && get(scope.previousRunId, request.projectId);
        if (!previous || previous.providerThreadId === null || previous.providerThreadId !== binding.codexThreadId ||
            previous.worktreeId !== binding.worktreeId ||
            previous.status === 'RUNNING' || previous.status === 'INTERRUPTED') {
          throw new Error('The previous Codex Thread cannot be resumed with this approval.');
        }
      }
      const id = randomUUID();
      sql(`INSERT INTO codex_runs (id, request_id, worktree_id, prompt_sha256, config_sha256, thread_id,
        previous_run_id, status, owner_pid, started_at, worker_id, heartbeat_at, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)`)
        .run(id, request.id, binding.worktreeId, scope.promptSha256, scope.sdkConfigSha256,
          binding.codexThreadId, scope.previousRunId, process.pid, clock(), workerId, clock(), request.projectId);
      if (session && message) {
        if (message.repair) sql('UPDATE codex_session_repairs SET run_id=?,error_code=NULL WHERE request_id=?').run(id, request.id);
        else sql("UPDATE codex_session_messages SET run_id=?,status='PROCESSING' WHERE id=?").run(id, message.id!);
        sql('UPDATE codex_task_sessions SET current_run_id=?,updated_at=? WHERE id=?').run(id, clock(), session.id!);
      }
      return get(id)!;
    },
    append(id: string, input: unknown) {
      const event = codexEventSchema.parse(input);
      immediate(database, () => {
        const run = get(id);
        if (run?.status !== 'RUNNING') throw new Error('The Codex run is inactive.');
        if (event.kind === 'thread.started') {
          if (!event.threadId || (run.providerThreadId && run.providerThreadId !== event.threadId) ||
              sql(`SELECT 1 FROM codex_runs r JOIN execution_requests e ON e.id=r.request_id
                WHERE thread_id=? AND r.id<>? AND (r.project_id<>? OR r.worktree_id<>?
                  OR e.task_id<>(SELECT task_id FROM execution_requests WHERE id=?) OR r.status IN ('RUNNING','INTERRUPTED'))`)
                .get(event.threadId, id, run.projectId, run.worktreeId, run.requestId)) {
            throw new Error('Codex returned an unexpected Thread identity.');
          }
          sql('UPDATE codex_runs SET thread_id=? WHERE id=?').run(event.threadId, id);
          sql('UPDATE codex_task_sessions SET provider_thread_id=?,updated_at=? WHERE current_run_id=?')
            .run(event.threadId, clock(), id);
        }
        sql('INSERT INTO codex_run_events (run_id,event_json,created_at) VALUES (?, ?, ?)')
          .run(id, JSON.stringify(event), clock());
      });
    },
    requestCancel(id: string) {
      return sql("UPDATE codex_runs SET cancel_requested=1 WHERE id=? AND status='RUNNING'").run(id).changes === 1;
    },
    shouldCancel(id: string) {
      return get(id)?.cancelRequested === true;
    },
    heartbeat(id: string, workerId: string) {
      return sql("UPDATE codex_runs SET heartbeat_at=? WHERE id=? AND worker_id=? AND status='RUNNING'")
        .run(clock(), id, workerId).changes === 1;
    },
    finish(id: string, workerId: string, status: Exclude<CodexRunStatus, 'RUNNING' | 'INTERRUPTED'>,
      exitConfirmed: boolean, diagnostic: CodexDiagnostic | null) {
      const now = clock();
      sql(`UPDATE codex_runs SET status=?,finished_at=?,exit_confirmed_at=?,diagnostic_code=?
        WHERE id=? AND worker_id=? AND status IN ('RUNNING', 'INTERRUPTED')`)
        .run(exitConfirmed ? status : 'INTERRUPTED', now, exitConfirmed ? now : null,
          diagnostic ?? (exitConfirmed ? null : 'PROCESS_EXIT_UNCONFIRMED'), id, workerId);
      return get(id)!;
    },
    list(projectId = legacyProjectId, refresh = true) {
      const now = clock();
      if (refresh) sql(`UPDATE codex_runs SET status='INTERRUPTED',finished_at=?,diagnostic_code='WORKER_HEARTBEAT_EXPIRED'
        WHERE status='RUNNING' AND heartbeat_at<=?`).run(now, now - heartbeatTimeout);
      return sql('SELECT ' + columns + ' FROM codex_runs WHERE project_id=? ORDER BY started_at DESC, rowid DESC LIMIT 100')
        .all(projectId).map((row) => decode(row)!);
    },
    eventSummary(id: string) {
      const row = sql(`SELECT COUNT(*) AS eventCount,
        SUM(CASE WHEN json_extract(event_json,'$.kind')='item.completed' THEN json_extract(event_json,'$.changedFiles') END) AS changedFiles
        FROM codex_run_events WHERE run_id=?`).get(id);
      const latest = sql('SELECT event_json FROM codex_run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(id);
      return { eventCount: Number(row?.eventCount ?? 0), changedFiles: Number(row?.changedFiles ?? 0),
        lastEvent: latest ? codexEventSchema.parse(JSON.parse(String(latest.event_json))).kind : null, usage: null };
    },
    events(id: string, after: number) {
      return sql(`SELECT seq, event_json AS eventJson, created_at AS createdAt FROM codex_run_events
        WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200`).all(id, after).map((row) => ({
        seq: Number(row.seq), createdAt: Number(row.createdAt), event: codexEventSchema.parse(JSON.parse(String(row.eventJson))),
      }));
    },
  };
}
