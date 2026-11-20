import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { legacyProjectId } from '../packages/contracts/dist/index.js';
import { migrate } from '../packages/storage/dist/migrations.js';

describe('Project Registry migration', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('preserves and classifies data from SQLite v%s on repeated open', (version) => {
    const db = new DatabaseSync(':memory:');
    try {
      if (version === 0) db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        target_platform TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT`);
      else migrate(db, version);
      const tasks = Array.from({ length: 4 }, () => randomUUID());
      for (const id of tasks) db.prepare(`INSERT INTO tasks(id,title,description,target_platform,status,created_at)
        VALUES (?,'Preserve','Fixture','BOTH','CREATED','2026-01-01T00:00:00Z')`).run(id);
      const trees = Array.from({ length: 3 }, () => randomUUID());
      const projects = Array.from({ length: 3 }, () => randomUUID());
      const references = Array.from({ length: 3 }, () => randomUUID());
      const request = randomUUID();
      const runner = randomUUID();
      const grant = randomUUID();
      const codex = randomUUID();
      const unity = randomUUID();
      const digest = 'f'.repeat(64);
      if (version >= 1) {
        db.prepare("INSERT INTO authorization_runners VALUES (?,'device','MACOS','fixture')").run(runner);
        for (const id of trees) db.prepare("INSERT INTO authorization_worktrees VALUES (?,'repo',?)").run(id, '/fixture/' + id);
        db.prepare("INSERT INTO execution_requests VALUES (?,?,?,?,'{}',?,'APPROVED',2,1,2)")
          .run(request, tasks[0]!, runner, trees[0]!, digest);
        db.prepare('INSERT INTO execution_grants(id,request_id,expires_at) VALUES (?,?,?)').run(grant, request, 2);
      }
      if (version >= 2) {
        for (const id of trees) db.prepare('INSERT INTO codex_worktrees VALUES (?)').run(id);
        db.prepare(`INSERT INTO codex_runs(id,request_id,worktree_id,prompt_sha256,config_sha256,thread_id,status,owner_pid,started_at)
          VALUES (?,?,?,?,?,'provider-thread-fixture','COMPLETED',1,1)`).run(codex, request, trees[0]!, digest, digest);
      }
      if (version >= 4) {
        const provider = randomUUID();
        db.prepare("INSERT INTO git_providers VALUES (?,'github','https://api.github.com')").run(provider);
        for (const [offset, id] of projects.entries()) {
          db.prepare('INSERT INTO git_credentials_refs VALUES (?,?,1)').run(references[offset]!, id);
          db.prepare("INSERT INTO project_provider_connections VALUES (?,?,?,?,?,'main','fixture',1)")
            .run(id, provider, references[offset]!, 'https://github.com/test/repo' + offset, String(offset));
        }
        for (const [taskIndex, treeIndex, projectIndex] of [[0, 0, 0], [1, 1, 1], [1, 2, 2]]) {
          db.prepare(`INSERT INTO git_operations (id,project_id,task_id,worktree_id,branch,binding,summary,digest,phase,version,created_at,updated_at)
            VALUES (?,?,?,?,'devhub/fixture','{}','{}',?,'DELIVERED',1,1,1)`)
            .run(randomUUID(), projects[projectIndex!]!, tasks[taskIndex!]!, trees[treeIndex!]!, digest);
        }
      }
      if (version >= 6) {
        db.prepare(`INSERT INTO unity_runs (id,request_id,task_id,runner_id,worktree_id,base_head_sha,platform,plan,status,worker_id,started_at,heartbeat_at)
          VALUES (?,?,?,?,?,?,'MACOS','{}','COMPLETED','worker',1,1)`).run(unity, request, tasks[0]!, runner, trees[0]!, 'a'.repeat(40));
      }
      migrate(db);
      const rows = () => db.prepare('SELECT id,project_id FROM tasks ORDER BY id').all();
      const migrated = rows();
      expect(migrated).toHaveLength(4);
      expect(migrated.find(({ id }) => id === tasks[0])?.project_id).toBe(version >= 4 ? projects[0] : legacyProjectId);
      expect(migrated.find(({ id }) => id === tasks[1])?.project_id).toBe(legacyProjectId);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()?.n).toBe(version >= 4 ? 4 : 1);
      if (version >= 1) {
        expect(db.prepare('SELECT status,binding_digest FROM execution_requests WHERE id=?').get(request))
          .toEqual({ status: 'APPROVED', binding_digest: digest });
        expect(db.prepare('SELECT claimed_at,revoked_at FROM execution_grants WHERE id=?').get(grant))
          .toEqual({ claimed_at: null, revoked_at: null });
      }
      if (version >= 2) expect(db.prepare('SELECT thread_id FROM codex_runs WHERE id=?').get(codex)?.thread_id).toBe('provider-thread-fixture');
      if (version >= 4) {
        expect(db.prepare('SELECT id FROM git_credentials_refs ORDER BY id').all().map(({ id }) => id)).toEqual([...references].sort());
        expect(db.prepare('SELECT reason,candidates FROM project_migration_report WHERE entity_id=?').get(tasks[1]!))
          .toEqual({ reason: 'MULTIPLE_GIT_PROJECTS', candidates: JSON.stringify(projects.slice(1).sort()) });
      }
      if (version >= 6) expect(db.prepare('SELECT editor_version FROM unity_runs WHERE id=?').get(unity)?.editor_version).toBe('6000.3.28f1');
      migrate(db);
      expect(rows()).toEqual(migrated);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
});
