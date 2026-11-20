import type { DatabaseSync } from 'node:sqlite';
import { migrateProjects } from './project-migration.js';

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

export function migrate(database: DatabaseSync, target = 10) {
  immediate(database, () => {
    const previous = database.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof previous !== 'number' || previous < 0 || previous > target || target > 10) {
      throw new Error('Unsupported DevHub database version.');
    }
    if (previous < 1 && target >= 1) database.exec(`
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
    if (previous < 2 && target >= 2) database.exec(`
      CREATE TABLE codex_worktrees (
        worktree_id TEXT PRIMARY KEY NOT NULL REFERENCES authorization_worktrees(worktree_id)
      ) STRICT;
      CREATE TABLE codex_runs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES execution_requests(id),
        worktree_id TEXT NOT NULL REFERENCES codex_worktrees(worktree_id),
        prompt_sha256 TEXT NOT NULL,
        config_sha256 TEXT NOT NULL,
        thread_id TEXT,
        provider_turn_id TEXT CHECK (provider_turn_id IS NULL),
        previous_run_id TEXT REFERENCES codex_runs(id),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
        owner_pid INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX codex_one_active_run_per_worktree ON codex_runs(worktree_id)
        WHERE status IN ('RUNNING', 'INTERRUPTED');
      CREATE TABLE codex_run_events (
        seq INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES codex_runs(id),
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX codex_run_event_order ON codex_run_events(run_id, seq);
      PRAGMA user_version = 2;
    `);
    if (previous < 3 && target >= 3) database.exec(`
      ALTER TABLE codex_runs ADD COLUMN worker_id TEXT;
      ALTER TABLE codex_runs ADD COLUMN heartbeat_at INTEGER;
      ALTER TABLE codex_runs ADD COLUMN exit_confirmed_at INTEGER;
      ALTER TABLE codex_runs ADD COLUMN diagnostic_code TEXT;
      UPDATE codex_runs SET status='INTERRUPTED',diagnostic_code='PROCESS_EXIT_UNCONFIRMED'
        WHERE status='RUNNING';
      PRAGMA user_version = 3;
    `);
    if (previous < 4 && target >= 4) database.exec(`
      CREATE TABLE git_providers (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('github','gitlab')),
        api_base_url TEXT NOT NULL,
        UNIQUE (kind,api_base_url)
      ) STRICT;
      CREATE TABLE git_credentials_refs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE project_provider_connections (
        project_id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL REFERENCES git_providers(id),
        credential_ref TEXT REFERENCES git_credentials_refs(id),
        repository_url TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        account TEXT NOT NULL,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE git_operations (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES project_provider_connections(project_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        worktree_id TEXT NOT NULL REFERENCES codex_worktrees(worktree_id),
        branch TEXT NOT NULL,
        binding TEXT NOT NULL CHECK (json_valid(binding)),
        summary TEXT NOT NULL CHECK (json_valid(summary)),
        digest TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('PREVIEW','APPROVED','COMMITTED','PUSHED','DELIVERED')),
        version INTEGER NOT NULL,
        operator_digest TEXT,
        approved_until INTEGER,
        owner TEXT,
        commit_sha TEXT,
        change_number INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX git_operations_active_worktree ON git_operations(worktree_id) WHERE owner IS NOT NULL;
      CREATE INDEX git_operations_branch ON git_operations(project_id,branch,updated_at);
      CREATE TABLE pull_requests (
        project_id TEXT NOT NULL REFERENCES project_provider_connections(project_id),
        number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        PRIMARY KEY (project_id,number)
      ) STRICT;
      CREATE TABLE pull_request_reviews (
        project_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        review_id TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        PRIMARY KEY (project_id,number,review_id),
        FOREIGN KEY (project_id,number) REFERENCES pull_requests(project_id,number)
      ) STRICT;
      CREATE TABLE git_audit_events (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project_provider_connections(project_id),
        operation_id TEXT REFERENCES git_operations(id),
        actor_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE git_change_mutations (
        project_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        mutation_key TEXT NOT NULL,
        digest TEXT NOT NULL,
        claimed_at INTEGER,
        PRIMARY KEY (project_id,number,mutation_key),
        FOREIGN KEY (project_id,number) REFERENCES pull_requests(project_id,number)
      ) STRICT;
      CREATE UNIQUE INDEX git_change_mutation_lock ON git_change_mutations(project_id,number) WHERE claimed_at IS NOT NULL;
      CREATE TRIGGER git_worktree_excludes_codex_run BEFORE INSERT ON codex_runs
      WHEN EXISTS (SELECT 1 FROM git_operations WHERE worktree_id=NEW.worktree_id AND owner IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'GIT_WORKTREE_BUSY');
      END;
      PRAGMA user_version = 4;
    `);
    if (previous < 5 && target >= 5) database.exec(`
      CREATE TABLE git_credential_cleanup (
        credential_ref TEXT PRIMARY KEY NOT NULL REFERENCES git_credentials_refs(id),
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error_code TEXT,
        owner TEXT,
        lease_until INTEGER
      ) STRICT;
      INSERT INTO git_credential_cleanup(credential_ref, next_attempt_at)
        SELECT r.id, 0 FROM git_credentials_refs r
        WHERE NOT EXISTS (SELECT 1 FROM project_provider_connections c WHERE c.credential_ref=r.id);
      PRAGMA user_version = 5;
    `);
    if (previous < 6 && target >= 6) database.exec(`
      CREATE TABLE unity_runs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES execution_requests(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        runner_id TEXT NOT NULL REFERENCES authorization_runners(id),
        worktree_id TEXT NOT NULL REFERENCES codex_worktrees(worktree_id),
        base_head_sha TEXT NOT NULL, platform TEXT NOT NULL, plan TEXT NOT NULL CHECK (json_valid(plan)),
        status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
        phase TEXT, pid INTEGER, process_identity TEXT, worker_id TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER,
        heartbeat_at INTEGER NOT NULL, exit_confirmed INTEGER NOT NULL DEFAULT 0, diagnostic TEXT,
        reports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reports)),
        artifacts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts))
      ) STRICT;
      CREATE UNIQUE INDEX unity_worktree_lock ON unity_runs(worktree_id) WHERE status IN ('RUNNING','INTERRUPTED');
      CREATE TRIGGER unity_excludes_other_work BEFORE INSERT ON unity_runs
      WHEN EXISTS (SELECT 1 FROM codex_runs WHERE worktree_id=NEW.worktree_id AND status IN ('RUNNING','INTERRUPTED'))
        OR EXISTS (SELECT 1 FROM git_operations WHERE worktree_id=NEW.worktree_id AND owner IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'UNITY_WORKTREE_BUSY'); END;
      CREATE TRIGGER unity_excludes_codex BEFORE INSERT ON codex_runs
      WHEN EXISTS (SELECT 1 FROM unity_runs WHERE worktree_id=NEW.worktree_id AND status IN ('RUNNING','INTERRUPTED'))
      BEGIN SELECT RAISE(ABORT, 'UNITY_WORKTREE_BUSY'); END;
      CREATE TRIGGER unity_excludes_git BEFORE UPDATE OF owner ON git_operations
      WHEN NEW.owner IS NOT NULL AND EXISTS
        (SELECT 1 FROM unity_runs WHERE worktree_id=NEW.worktree_id AND status IN ('RUNNING','INTERRUPTED'))
      BEGIN SELECT RAISE(ABORT, 'UNITY_WORKTREE_BUSY'); END;
      PRAGMA user_version=6;
    `);
    if (previous < 7 && target >= 7) migrateProjects(database);
    if (previous < 8 && target >= 8) database.exec(`
      CREATE TABLE mcp_pairings (
        id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL,
        projects TEXT NOT NULL CHECK (json_valid(projects)),
        groups TEXT NOT NULL CHECK (json_valid(groups)),
        digest TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER,
        last_seen_at INTEGER, transport TEXT, protocol_version TEXT,
        tunnel_json TEXT CHECK (json_valid(tunnel_json))
      ) STRICT;
      CREATE TABLE mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL REFERENCES mcp_pairings(id),
        project_id TEXT, tool TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE task_revision_history (
        task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (task_id,revision)
      ) STRICT;
      PRAGMA user_version=8;
    `);
    if (previous < 9 && target >= 9) database.exec(`
      CREATE TABLE unity_evidence_runs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        manifest_sha256 TEXT NOT NULL, imported_at INTEGER NOT NULL, actor_digest TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)), UNIQUE(project_id,manifest_sha256)
      ) STRICT;
      CREATE INDEX unity_evidence_project ON unity_evidence_runs(project_id,imported_at DESC);
      PRAGMA user_version=9;
    `);
    if (previous < 10 && target >= 10) database.exec(`
      CREATE TABLE github_inbox_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton=1), credential_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 0, scanned_at INTEGER, error_code TEXT, pr_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO github_inbox_settings(singleton) VALUES(1);
      CREATE TABLE github_inbox_prs (
        repository_id INTEGER NOT NULL, number INTEGER NOT NULL, task_key TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), project_id TEXT NOT NULL REFERENCES projects(id),
        head_sha TEXT NOT NULL, open INTEGER NOT NULL CHECK (open IN (0,1)),
        PRIMARY KEY (repository_id,number), UNIQUE(repository_id,task_key)
      ) STRICT;
      CREATE TABLE codex_host_connections (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE, installation_id TEXT NOT NULL UNIQUE,
        runner_id TEXT NOT NULL REFERENCES authorization_runners(id), platform TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISCONNECTED')), version TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL, connected_at INTEGER NOT NULL, disconnected_at INTEGER, lease_owner TEXT,
        reconnect INTEGER NOT NULL DEFAULT 1 CHECK(reconnect IN (0,1)),
        CHECK ((status='ACTIVE')=(lease_owner IS NOT NULL))
      ) STRICT;
      CREATE TABLE codex_task_sessions (
        id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), host_id TEXT REFERENCES codex_host_connections(id),
        worktree_id TEXT UNIQUE REFERENCES codex_worktrees(worktree_id), provider_thread_id TEXT UNIQUE,
        current_run_id TEXT UNIQUE REFERENCES codex_runs(id), last_run_id TEXT REFERENCES codex_runs(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX codex_session_project ON codex_task_sessions(project_id,updated_at);
      CREATE TABLE codex_session_messages (
        id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES codex_task_sessions(id),
        project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        repository_id INTEGER NOT NULL, pull_request_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
        sequence INTEGER NOT NULL, task_revision INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        status TEXT NOT NULL CHECK(status IN ('PENDING','DELIVERING','DELIVERED','PROCESSING','COMPLETED','FAILED','STALE')),
        created_at INTEGER NOT NULL, delivered_at INTEGER, error_code TEXT,
        request_id TEXT UNIQUE REFERENCES execution_requests(id), run_id TEXT UNIQUE REFERENCES codex_runs(id),
        UNIQUE(repository_id,pull_request_number,head_sha), UNIQUE(session_id,sequence),
        FOREIGN KEY(repository_id,pull_request_number) REFERENCES github_inbox_prs(repository_id,number)
      ) STRICT;
      CREATE TABLE codex_session_repairs (
        request_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_requests(id),
        message_id TEXT NOT NULL REFERENCES codex_session_messages(id),
        prompt TEXT NOT NULL, run_id TEXT UNIQUE REFERENCES codex_runs(id), error_code TEXT
      ) STRICT;
      PRAGMA user_version=10;
    `);
  });
}
