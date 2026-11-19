import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { taskSchema } from '@devhub/contracts';
import type { CreateTask, Task } from '@devhub/contracts';
import { protectDatabaseFiles } from './database-permissions.js';
import { createExecutionStore } from './execution-store.js';
import { createCodexStore } from './codex-store.js';
import { immediate, migrate } from './migrations.js';

export { AuthorizationError, taskSpecDigest } from './execution-store.js';

const taskColumns = 'id, title, description, target_platform AS targetPlatform, status, created_at AS createdAt, revision';

export function openTaskStore(filename: string, managedDataDirectory = false, clock = Date.now) {
  if (filename !== ':memory:') protectDatabaseFiles(filename, managedDataDirectory);

  const database = new DatabaseSync(filename, { timeout: 1000 });
  try {
    migrate(database);

    const insert = database.prepare(`
      INSERT INTO tasks (id, title, description, target_platform, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const selectOne = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
    const selectAll = database.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at DESC, rowid DESC`);
    const update = database.prepare(`UPDATE tasks SET title = ?, description = ?, target_platform = ?,
      revision = revision + 1 WHERE id = ? AND revision = ? RETURNING ${taskColumns}`);
    function get(id: string): Task | undefined {
      const row = selectOne.get(id);
      return row === undefined ? undefined : taskSchema.parse(row);
    }
    const execution = createExecutionStore(database, get, clock);

    return {
      create(input: CreateTask): Task {
        const task: Task = {
          ...input,
          id: randomUUID(),
          status: 'CREATED',
          createdAt: new Date().toISOString(),
          revision: 1,
        };
        insert.run(task.id, task.title, task.description, task.targetPlatform, task.status, task.createdAt);
        return task;
      },
      get,
      revise(id: string, expectedRevision: number, input: CreateTask): Task | undefined {
        return immediate(database, () => {
          const row = update.get(input.title, input.description, input.targetPlatform, id, expectedRevision);
          if (!row) return undefined;
          execution.invalidateTaskInTransaction(id);
          return taskSchema.parse(row);
        });
      },
      list(): Task[] {
        return selectAll.all().map((row) => taskSchema.parse(row));
      },
      close() {
        database.close();
      },
      execution,
      codex: createCodexStore(database, clock),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export type TaskStore = ReturnType<typeof openTaskStore>;
