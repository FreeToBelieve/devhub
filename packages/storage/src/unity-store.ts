import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { unityRunSchema, unityVersion } from '@devhub/contracts';
import type { ExecutionRequest, UnityArtifact, UnityReport, UnityRun, UnityStage } from '@devhub/contracts';
import { immediate } from './migrations.js';

const fields = `id,request_id AS requestId,task_id AS taskId,runner_id AS runnerId,worktree_id AS worktreeId,
  base_head_sha AS baseHeadSha,platform,plan,status,phase,pid,process_identity AS processIdentity,
  cancel_requested AS cancelRequested,started_at AS startedAt,finished_at AS finishedAt,
  exit_confirmed AS exitConfirmed,diagnostic,reports,artifacts`;

function decode(row: Record<string, unknown> | undefined) {
  return row && unityRunSchema.parse({ ...row, version: unityVersion, plan: JSON.parse(String(row.plan)),
    reports: JSON.parse(String(row.reports)), artifacts: JSON.parse(String(row.artifacts)),
    cancelRequested: row.cancelRequested === 1, exitConfirmed: row.exitConfirmed === 1 });
}

export function createUnityStore(database: DatabaseSync, clock: () => number) {
  const sql = (statement: string) => database.prepare(statement);
  const get = (id: string) => decode(sql('SELECT ' + fields + ' FROM unity_runs WHERE id=?').get(id));
  return {
    get,
    reserveWithinClaim(request: ExecutionRequest, workerId: string) {
      const { binding } = request;
      const scope = binding.scope;
      if (request.status !== 'CLAIMED' || scope.operation !== 'unity.run' ||
          !sql('SELECT 1 FROM codex_worktrees WHERE worktree_id=?').get(binding.worktreeId)) {
        throw new Error('UNITY_APPROVAL_REQUIRED');
      }
      const id = randomUUID();
      const now = clock();
      sql(`INSERT INTO unity_runs(id,request_id,task_id,runner_id,worktree_id,base_head_sha,platform,plan,
        status,worker_id,started_at,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,'RUNNING',?,?,?)`)
        .run(id, request.id, binding.taskId, binding.runnerId, binding.worktreeId, binding.baseHeadSha,
          binding.platform, JSON.stringify(scope.plan), workerId, now, now);
      return get(id)!;
    },
    list() {
      const now = clock();
      sql("UPDATE unity_runs SET status='INTERRUPTED', finished_at=?, diagnostic='UNITY_WORKER_HEARTBEAT_EXPIRED' WHERE status='RUNNING' AND heartbeat_at<=?")
        .run(now, now - 15_000);
      return sql('SELECT ' + fields + ' FROM unity_runs ORDER BY started_at DESC, rowid DESC LIMIT 100').all().map((row) => decode(row)!);
    },
    heartbeat(id: string, workerId: string) {
      return sql("UPDATE unity_runs SET heartbeat_at=? WHERE id=? AND worker_id=? AND status='RUNNING'")
        .run(clock(), id, workerId).changes === 1;
    },
    showProcess(id: string, workerId: string, phase: UnityStage, pid: number, identity: string) {
      sql("UPDATE unity_runs SET phase=?,pid=?,process_identity=? WHERE id=? AND worker_id=? AND status='RUNNING'")
        .run(phase, pid, identity, id, workerId);
    },
    append(id: string, workerId: string, report: UnityReport) {
      immediate(database, () => {
        const run = get(id);
        if (!run || run.status !== 'RUNNING') return;
        sql('UPDATE unity_runs SET reports=? WHERE id=? AND worker_id=?')
          .run(JSON.stringify([...run.reports, report]), id, workerId);
      });
    },
    requestCancel(id: string) {
      return sql("UPDATE unity_runs SET cancel_requested=1 WHERE id=? AND status='RUNNING'").run(id).changes === 1;
    },
    shouldCancel(id: string) {
      return get(id)?.cancelRequested === true;
    },
    pruneIds() {
      return sql('SELECT id FROM unity_runs WHERE exit_confirmed=1').all().map((row) => String(row.id));
    },
    finish(id: string, workerId: string, status: UnityRun['status'], exitConfirmed: boolean,
      diagnostic: string | null, artifacts: UnityArtifact[]) {
      sql(`UPDATE unity_runs SET status=?, finished_at=?, exit_confirmed=?, diagnostic=?, artifacts=?
        WHERE id=? AND worker_id=? AND status IN ('RUNNING','INTERRUPTED')`)
        .run(exitConfirmed ? status : 'INTERRUPTED', clock(), Number(exitConfirmed),
          diagnostic ?? (exitConfirmed ? null : 'UNITY_PROCESS_EXIT_UNCONFIRMED'), JSON.stringify(artifacts), id, workerId);
      return get(id)!;
    },
  };
}
