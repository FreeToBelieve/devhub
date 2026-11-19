import type { DatabaseSync } from 'node:sqlite';

export function immediate<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const outcome = operation();
    database.exec('COMMIT');
    return outcome;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function migrate(database: DatabaseSync) {
  immediate(database, () => {
    const previous = database.prepare('PRAGMA user_version').get()?.user_version;
    if (previous === 1) return;
    if (previous !== 0) throw new Error('Unsupported DevHub database version.');
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        target_platform TEXT NOT NULL CHECK (target_platform IN ('WINDOWS', 'MACOS', 'BOTH')),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

      CREATE TABLE operator_bootstraps (
        digest TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE TABLE operator_sessions (
        digest TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE authorization_runners (
        id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('WINDOWS', 'MACOS')),
        label TEXT NOT NULL
      ) STRICT;
      CREATE TABLE runner_credentials (
        digest TEXT PRIMARY KEY NOT NULL,
        runner_id TEXT NOT NULL REFERENCES authorization_runners(id),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE TABLE authorization_worktrees (
        worktree_id TEXT PRIMARY KEY NOT NULL,
        repo_id TEXT NOT NULL,
        root TEXT NOT NULL
      ) STRICT;
      CREATE TABLE execution_requests (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        runner_id TEXT NOT NULL REFERENCES authorization_runners(id),
        worktree_id TEXT NOT NULL REFERENCES authorization_worktrees(worktree_id),
        binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
        binding_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CLAIMED', 'REVOKED')),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX execution_requests_active ON execution_requests(status, expires_at);
      CREATE TABLE execution_grants (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES execution_requests(id),
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER,
        revoked_at INTEGER,
        CHECK (claimed_at IS NULL OR revoked_at IS NULL)
      ) STRICT;
      CREATE TABLE execution_audit_events (
        id INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES execution_requests(id),
        kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'runner', 'system')),
        actor_id TEXT NOT NULL,
        reason TEXT,
        binding_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX execution_audit_sequence ON execution_audit_events(request_id, id);
      CREATE TABLE execution_idempotency (
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        key TEXT NOT NULL,
        digest TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES execution_requests(id),
        PRIMARY KEY (actor_id, action, key)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
  });
}
