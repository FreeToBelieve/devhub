import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { legacyProjectId, taskSchema } from '@devhub/contracts';
import type { CreateTask, Task } from '@devhub/contracts';
import { protectDatabaseFiles } from './database-permissions.js';
import { createExecutionStore } from './execution-store.js';
import { createCodexStore } from './codex-store.js';
import { createGitStore } from './git-store.js';
import { createUnityStore } from './unity-store.js';
import { createProjectStore } from './project-store.js';
import { immediate, migrate } from './migrations.js';

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
    const selectAll = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id=? ORDER BY created_at DESC, rowid DESC`);
    const update = database.prepare(`UPDATE tasks SET title = ?, description = ?, target_platform = ?,
      revision = revision + 1 WHERE id = ? AND revision = ? RETURNING ${taskColumns}`);
    function get(id: string, projectId?: string): Task | undefined {
      const row = selectOne.get(id);
      return !row || (projectId !== undefined && row.projectId !== projectId) ? undefined : taskSchema.parse(row);
    }
    const execution = createExecutionStore(database, get, clock, projects);

    return {
      create(input: CreateTask, projectId: string): Task {
        return immediate(database, () => {
          projects.require(projectId, true);
          const task: Task = { ...input, id: randomUUID(), projectId, status: 'CREATED',
            createdAt: new Date().toISOString(), revision: 1 };
          insert.run(task.id, task.title, task.description, task.targetPlatform, task.status, task.createdAt, projectId);
          return task;
        });
      },
      get,
      revise(id: string, expectedRevision: number, input: CreateTask, projectId = legacyProjectId): Task | undefined {
        return immediate(database, () => {
          projects.require(projectId, true);
          if (!get(id, projectId)) return undefined;
          const row = update.get(input.title, input.description, input.targetPlatform, id, expectedRevision);
          if (!row) return undefined;
          execution.invalidateTaskInTransaction(id);
          return taskSchema.parse(row);
        });
      },
      list(projectId = legacyProjectId): Task[] {
        return selectAll.all(projectId).map((row) => taskSchema.parse(row));
      },
      close() {
        database.close();
      },
      execution,
      projects,
      codex: createCodexStore(database, clock),
      git: createGitStore(database, clock, projects),
      unity: createUnityStore(database, clock),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export type TaskStore = ReturnType<typeof openTaskStore>;
