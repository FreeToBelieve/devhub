import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { codexEventSchema, codexRunSchema } from '@devhub/contracts';
import type { CodexRun, CodexRunStatus, ExecutionRequest } from '@devhub/contracts';
import { immediate } from './migrations.js';

const columns = `id AS devhubRunId, request_id AS requestId, worktree_id AS worktreeId,
  prompt_sha256 AS promptSha256, config_sha256 AS sdkConfigSha256, thread_id AS providerThreadId,
  provider_turn_id AS providerTurnId, previous_run_id AS previousRunId, status,
  cancel_requested AS cancelRequested, started_at AS startedAt, finished_at AS finishedAt`;

function decode(row: Record<string, unknown> | undefined): CodexRun | undefined {
  return row && codexRunSchema.parse({ ...row, cancelRequested: row.cancelRequested === 1 });
}

export function createCodexStore(database: DatabaseSync, clock: () => number) {
  const sql = (query: string) => database.prepare(query);
  const get = (id: string) => decode(sql('SELECT ' + columns + ' FROM codex_runs WHERE id=?').get(id));
  const manages = (id: string) => !!sql('SELECT 1 FROM codex_worktrees WHERE worktree_id=?').get(id);

  return {
    manages,
    manage(id: string) {
      sql('INSERT INTO codex_worktrees(worktree_id) VALUES (?) ON CONFLICT DO NOTHING').run(id);
    },
    get,
    reserveWithinClaim(request: ExecutionRequest, ownerPid = process.pid) {
      const { binding } = request;
      const { scope } = binding;
      if (request.status !== 'CLAIMED' || scope.operation !== 'codex.turn' || !manages(binding.worktreeId)) {
        throw new Error('The approval does not cover a managed Codex worktree.');
      }
      if (scope.mode === 'resume') {
        const previous = scope.previousRunId && get(scope.previousRunId);
        if (!previous || previous.providerThreadId === null || previous.providerThreadId !== binding.codexThreadId ||
            previous.worktreeId !== binding.worktreeId || previous.sdkConfigSha256 !== scope.sdkConfigSha256 ||
            previous.status === 'RUNNING' || previous.status === 'INTERRUPTED') {
          throw new Error('The previous Codex Thread cannot be resumed with this approval.');
        }
      }
      const id = randomUUID();
      sql(`INSERT INTO codex_runs (id, request_id, worktree_id, prompt_sha256, config_sha256, thread_id,
        previous_run_id, status, owner_pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`)
        .run(id, request.id, binding.worktreeId, scope.promptSha256, scope.sdkConfigSha256,
          binding.codexThreadId, scope.previousRunId, ownerPid, clock());
      return get(id)!;
    },
    append(id: string, input: unknown) {
      const event = codexEventSchema.parse(input);
      immediate(database, () => {
        const run = get(id);
        if (run?.status !== 'RUNNING') throw new Error('The Codex run is inactive.');
        if (event.kind === 'thread.started') {
          if (!event.threadId || (run.providerThreadId && run.providerThreadId !== event.threadId)) {
            throw new Error('Codex returned an unexpected Thread identity.');
          }
          sql('UPDATE codex_runs SET thread_id=? WHERE id=?').run(event.threadId, id);
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
    finish(id: string, status: Exclude<CodexRunStatus, 'RUNNING' | 'INTERRUPTED'>) {
      sql("UPDATE codex_runs SET status=?,finished_at=? WHERE id=? AND status='RUNNING'").run(status, clock(), id);
      return get(id)!;
    },
    list() {
      const running = sql("SELECT id,owner_pid AS ownerPid FROM codex_runs WHERE status='RUNNING'").all();
      for (const row of running) {
        try {
          process.kill(Number(row.ownerPid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            sql("UPDATE codex_runs SET status='INTERRUPTED',finished_at=? WHERE id=? AND status='RUNNING'")
              .run(clock(), row.id!);
          }
        }
      }
      return sql('SELECT ' + columns + ' FROM codex_runs ORDER BY started_at DESC, rowid DESC LIMIT 100')
        .all().map((row) => decode(row)!);
    },
    events(id: string, after: number) {
      return sql(`SELECT seq, event_json AS eventJson, created_at AS createdAt FROM codex_run_events
        WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200`).all(id, after).map((row) => ({
        seq: Number(row.seq), createdAt: Number(row.createdAt), event: codexEventSchema.parse(JSON.parse(String(row.eventJson))),
      }));
    },
  };
}
