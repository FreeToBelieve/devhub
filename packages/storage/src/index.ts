import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { taskSchema } from '@devhub/contracts';
import type { CreateTask, Task } from '@devhub/contracts';
import { protectDatabaseFiles } from './database-permissions.js';

const taskColumns = 'id, title, description, target_platform AS targetPlatform, status, created_at AS createdAt';

export function openTaskStore(filename: string, managedDataDirectory = false) {
  if (filename !== ':memory:') protectDatabaseFiles(filename, managedDataDirectory);

  const database = new DatabaseSync(filename, { timeout: 1000 });
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        target_platform TEXT NOT NULL CHECK (target_platform IN ('WINDOWS', 'MACOS', 'BOTH')),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);

    const insert = database.prepare(`
      INSERT INTO tasks (id, title, description, target_platform, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const selectOne = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
    const selectAll = database.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at DESC, rowid DESC`);

    return {
      create(input: CreateTask): Task {
        const task: Task = {
          ...input,
          id: randomUUID(),
          status: 'CREATED',
          createdAt: new Date().toISOString(),
        };
        insert.run(task.id, task.title, task.description, task.targetPlatform, task.status, task.createdAt);
        return task;
      },
      get(id: string): Task | undefined {
        const row = selectOne.get(id);
        return row === undefined ? undefined : taskSchema.parse(row);
      },
      list(): Task[] {
        return selectAll.all().map((row) => taskSchema.parse(row));
      },
      close() {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
