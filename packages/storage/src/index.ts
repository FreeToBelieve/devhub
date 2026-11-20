import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { legacyProjectId, taskSchema } from '@devhub/contracts';
import type { CreateTask, Task } from '@devhub/contracts';
import { protectDatabaseFiles } from './database-permissions.js';
import { createTaskInboxStore } from './task-inbox-store.js';
import { createExecutionStore } from './execution-store.js';
import { createCodexStore } from './codex-store.js';
import { createGitStore } from './git-store.js';
import { createUnityEvidenceStore } from './unity-evidence-store.js';
import { createUnityStore } from './unity-store.js';
import { createProjectStore } from './project-store.js';
import { createMcpStore } from './mcp-store.js';
import { immediate, migrate } from './migrations.js';

export { InboxStateError } from './task-inbox-store.js';
export { AuthorizationError, taskSpecDigest } from './execution-store.js';
export { GitStateError } from './git-store.js';
export { ProjectError, projectContextDigest } from './project-store.js';
export type { VerifiedProjectInput } from './project-store.js';

const taskColumns = 'id, project_id AS projectId, title, description, target_platform AS targetPlatform, status, created_at AS createdAt, revision';

export function openTaskStore(filename: string, managedDataDirectory = false, clock = Date.now) {
  if (filename !== ':memory:') protectDatabaseFiles(filename, managedDataDirectory);

  const database = new DatabaseSync(filename, { timeout: 1000 });
  try {
    migrate(database);
    const projects = createProjectStore(database, clock);

    const insert = database.prepare(`
      INSERT INTO tasks (id, title, description, target_platform, status, created_at, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const selectOne = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
    const selectAll = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`);
    const update = database.prepare(`UPDATE tasks SET title = ?, description = ?, target_platform = ?,
      revision = revision + 1 WHERE id = ? AND revision = ? RETURNING ${taskColumns}`);
    function get(id: string, projectId?: string): Task | undefined {
      const row = selectOne.get(id);
      return !row || (projectId !== undefined && row.projectId !== projectId) ? undefined : taskSchema.parse(row);
    }
    const execution = createExecutionStore(database, get, clock, projects);

    function createInTransaction(input: CreateTask, projectId: string): Task {
      projects.require(projectId, true);
      const task: Task = { ...input, id: randomUUID(), projectId, status: 'CREATED',
        createdAt: new Date().toISOString(), revision: 1 };
      insert.run(task.id, task.title, task.description, task.targetPlatform, task.status, task.createdAt, projectId);
      return task;
    }
    function reviseInTransaction(id: string, expectedRevision: number, input: CreateTask, projectId: string) {
      projects.require(projectId, true);
      if (!get(id, projectId)) return undefined;
      const row = update.get(input.title, input.description, input.targetPlatform, id, expectedRevision);
      if (!row) return undefined;
      database.prepare('INSERT INTO task_revision_history (task_id,revision,updated_at) VALUES (?,?,?)')
        .run(id, Number(row.revision), clock());
      execution.invalidateTaskInTransaction(id);
      return taskSchema.parse(row);
    }
    const inbox = createTaskInboxStore(database, clock, projects, {
      create: createInTransaction,
      revise(id, spec, projectId) {
        const task = get(id, projectId);
        return task && reviseInTransaction(id, task.revision, spec, projectId);
      },
      invalidate: execution.invalidateTaskInTransaction,
    });
    return {
      create(input: CreateTask, projectId: string) {
        return immediate(database, () => createInTransaction(input, projectId));
      },
      get,
      revise(id: string, expectedRevision: number, input: CreateTask, projectId = legacyProjectId) {
        return immediate(database, () => reviseInTransaction(id, expectedRevision, input, projectId));
      },
      inbox,
      list(projectId = legacyProjectId, limit = -1, offset = 0): Task[] {
        return selectAll.all(projectId, limit, offset).map((row) => taskSchema.parse(row));
      },
      revisionHistory(id: string, projectId: string, limit: number, offset: number) {
        return database.prepare(`SELECT h.revision, h.updated_at AS updatedAt FROM task_revision_history h
          JOIN tasks t ON t.id=h.task_id WHERE t.id=? AND t.project_id=?
          ORDER BY h.revision DESC LIMIT ? OFFSET ?`).all(id, projectId, limit, offset)
          .map((row) => ({ revision: Number(row.revision), updatedAt: Number(row.updatedAt) }));
      },
      taskRequests(id: string, projectId: string, limit: number, offset: number) {
        return database.prepare(`SELECT id, status, created_at AS createdAt
          FROM execution_requests WHERE task_id=? AND project_id=?
          ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(id, projectId, limit, offset);
      },
      latestRevisionAt(id: string) {
        const row = database.prepare('SELECT max(updated_at) AS value FROM task_revision_history WHERE task_id=?').get(id);
        return row?.value == null ? null : Number(row.value);
      },
      close() {
        database.close();
      },
      execution,
      mcp: createMcpStore(database, clock),
      projects,
      codex: createCodexStore(database, clock),
      git: createGitStore(database, clock, projects),
      unity: createUnityStore(database, clock),
      unityEvidence: createUnityEvidenceStore(database),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export type TaskStore = ReturnType<typeof openTaskStore>;
