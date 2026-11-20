import type { DatabaseSync } from 'node:sqlite';

export function worktreeBusy(database: DatabaseSync, worktreeId: string): boolean {
  return !!database.prepare(`
    SELECT 1 FROM codex_runs WHERE worktree_id=? AND status IN ('RUNNING','INTERRUPTED')
    UNION ALL
    SELECT 1 FROM unity_runs WHERE worktree_id=? AND status IN ('RUNNING','INTERRUPTED')
    UNION ALL
    SELECT 1 FROM git_operations WHERE worktree_id=? AND owner IS NOT NULL
    LIMIT 1
  `).get(worktreeId, worktreeId, worktreeId);
}
