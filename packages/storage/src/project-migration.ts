import type { DatabaseSync } from 'node:sqlite';
import { legacyProjectId } from '@devhub/contracts';

export function migrateProjects(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine='UNITY'),
      repository_root TEXT,
      repo_id TEXT,
      unity_project_path TEXT,
      unity_version TEXT,
      target_platform TEXT NOT NULL CHECK (target_platform IN ('WINDOWS','MACOS','BOTH')),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
      settings TEXT NOT NULL CHECK (json_valid(settings)),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX projects_checkout ON projects(repository_root,unity_project_path) WHERE repository_root IS NOT NULL;
    CREATE TABLE project_migration_report (
      entity_type TEXT NOT NULL CHECK (entity_type IN ('TASK','WORKTREE')),
      entity_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('NO_GIT_EVIDENCE','MULTIPLE_GIT_PROJECTS')),
      candidates TEXT NOT NULL CHECK (json_valid(candidates)),
      PRIMARY KEY (entity_type, entity_id)
    ) STRICT;
  `);
  const insert = database.prepare(`INSERT INTO projects
    (id,name,engine,target_platform,status,settings,created_at,updated_at)
    VALUES (?,?,'UNITY','BOTH','ACTIVE','{}',?,?)`);
  const migratedAt = Date.now();
  insert.run(legacyProjectId, 'Legacy / Unassigned', migratedAt, migratedAt);
  for (const row of database.prepare(`
    SELECT id, MAX(repository_url) AS remote FROM (
      SELECT project_id AS id, repository_url FROM project_provider_connections
      UNION ALL SELECT project_id, NULL FROM git_credentials_refs
    ) GROUP BY id ORDER BY id
  `).all()) {
    const name = typeof row.remote === 'string' ? row.remote.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '') : undefined;
    if (row.id !== legacyProjectId) insert.run(row.id!, (name || 'Imported Git Project').slice(0,120), migratedAt, migratedAt);
  }

  for (const table of ['tasks', 'authorization_worktrees', 'execution_requests', 'codex_runs', 'unity_runs']) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT '${legacyProjectId}';
      CREATE INDEX ${table}_by_project ON ${table}(project_id);`);
  }
  database.exec("ALTER TABLE unity_runs ADD COLUMN editor_version TEXT NOT NULL DEFAULT '6000.3.28f1'");

  // The connected component is the evidence boundary. Shared tasks or trees with conflicting
  // provider IDs all stay unassigned so an execution never spans two inferred projects.
  const parents = new Map<string, string>();
  function root(key: string): string {
    let current = key;
    while (parents.has(current)) current = parents.get(current)!;
    while (parents.has(key) && parents.get(key) !== current) {
      const next = parents.get(key)!;
      parents.set(key, current);
      key = next;
    }
    return current;
  }
  const links = database.prepare(`SELECT task_id,worktree_id,project_id AS anchor FROM git_operations
    UNION ALL SELECT task_id,worktree_id,NULL FROM execution_requests
    UNION ALL SELECT task_id,worktree_id,NULL FROM unity_runs`).all();
  for (const row of links) {
    const task = root('task:' + row.task_id);
    const tree = root('tree:' + row.worktree_id);
    if (task !== tree) parents.set(tree, task);
  }
  const anchors = new Map<string, Set<string>>();
  for (const row of links) {
    if (typeof row.anchor !== 'string') continue;
    const component = root('task:' + row.task_id);
    const known = anchors.get(component) ?? new Set<string>();
    known.add(row.anchor);
    anchors.set(component, known);
  }
  const report = database.prepare('INSERT INTO project_migration_report VALUES (?,?,?,?)');
  for (const [table, column, prefix, entity] of [
    ['tasks', 'id', 'task:', 'TASK'], ['authorization_worktrees', 'worktree_id', 'tree:', 'WORKTREE'],
  ] as const) {
    const update = database.prepare(`UPDATE ${table} SET project_id=? WHERE ${column}=?`);
    for (const { id } of database.prepare(`SELECT ${column} AS id FROM ${table}`).all()) {
      const candidates = [...(anchors.get(root(prefix + id)) ?? [])].sort();
      if (candidates.length === 1) update.run(candidates[0]!, id!);
      else report.run(entity, id!, candidates.length ? 'MULTIPLE_GIT_PROJECTS' : 'NO_GIT_EVIDENCE', JSON.stringify(candidates));
    }
  }
  database.exec(`
    UPDATE execution_requests SET project_id=(SELECT project_id FROM tasks WHERE id=task_id);
    UPDATE codex_runs SET project_id=(SELECT project_id FROM execution_requests WHERE id=request_id);
    UPDATE unity_runs SET project_id=(SELECT project_id FROM execution_requests WHERE id=request_id);
    CREATE INDEX codex_thread_by_project ON codex_runs(thread_id,project_id);
    CREATE TRIGGER project_execution_scope BEFORE INSERT ON execution_requests WHEN
      NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id=NEW.task_id) OR
      NEW.project_id IS NOT (SELECT project_id FROM authorization_worktrees WHERE worktree_id=NEW.worktree_id)
      BEGIN SELECT RAISE(ABORT,'PROJECT_SCOPE_MISMATCH'); END;
    CREATE TRIGGER project_git_scope BEFORE INSERT ON git_operations WHEN
      NEW.project_id IS NOT (SELECT project_id FROM tasks WHERE id=NEW.task_id) OR
      NEW.project_id IS NOT (SELECT project_id FROM authorization_worktrees WHERE worktree_id=NEW.worktree_id)
      BEGIN SELECT RAISE(ABORT,'PROJECT_SCOPE_MISMATCH'); END;
    PRAGMA user_version=7;
  `);
  for (const table of ['tasks','authorization_worktrees','git_credentials_refs','project_provider_connections']) {
    database.exec(`CREATE TRIGGER project_exists_${table} BEFORE INSERT ON ${table}
      WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id)
      BEGIN SELECT RAISE(ABORT,'PROJECT_NOT_FOUND'); END;`);
  }
  for (const table of ['codex_runs','unity_runs']) {
    database.exec(`CREATE TRIGGER project_scope_${table} BEFORE INSERT ON ${table} WHEN NOT EXISTS (
      SELECT 1 FROM execution_requests WHERE id=NEW.request_id AND project_id=NEW.project_id AND worktree_id=NEW.worktree_id
      ${table === 'unity_runs' ? 'AND task_id=NEW.task_id' : ''}
    ) BEGIN SELECT RAISE(ABORT,'PROJECT_SCOPE_MISMATCH'); END;`);
  }
  for (const operation of ['INSERT','UPDATE OF project_id,credential_ref']) {
    database.exec(`CREATE TRIGGER project_vault_${operation === 'INSERT' ? 'insert' : 'update'}
      BEFORE ${operation} ON project_provider_connections WHEN NEW.credential_ref IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM git_credentials_refs WHERE id=NEW.credential_ref AND project_id=NEW.project_id
      ) BEGIN SELECT RAISE(ABORT,'PROJECT_SCOPE_MISMATCH'); END;`);
  }
}
