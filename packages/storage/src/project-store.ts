import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { legacyProjectId, projectSchema } from '@devhub/contracts';
import type { Project, ProjectInput } from '@devhub/contracts';
import { sha256 } from '@devhub/security';
import { immediate } from './migrations.js';
import { worktreeBusy } from './worktree-lock.js';

export class ProjectError extends Error {
  constructor(readonly code: 'PROJECT_NOT_FOUND' | 'PROJECT_ARCHIVED' | 'PROJECT_NOT_REGISTERED' | 'PROJECT_PATH_CONFLICT' |
    'PROJECT_VERSION_CONFLICT' | 'PROJECT_BUSY' | 'PROJECT_SCOPE_MISMATCH') { super(code); }
}

export type VerifiedProjectInput = ProjectInput & { repoId: string; unityVersion: string };

const columns = `id,name,engine,repository_root AS repositoryRoot,repo_id AS repoId,unity_project_path AS unityProjectPath,
  unity_version AS unityVersion,target_platform AS targetPlatform,status,settings,revision,
  created_at AS createdAt,updated_at AS updatedAt`;

export function projectContextDigest(project: Project) {
  return sha256(JSON.stringify([project.id, project.repositoryRoot, project.repoId, project.unityProjectPath,
    project.unityVersion, project.targetPlatform, project.settings.documents]));
}

export function createProjectStore(database: DatabaseSync, clock: () => number) {
  const sql = (statement: string) => database.prepare(statement);
  const decode = (row: Record<string, unknown> | undefined) =>
    row && projectSchema.parse({ ...row, settings: JSON.parse(String(row.settings)) });
  const get = (id: string) => decode(sql('SELECT ' + columns + ' FROM projects WHERE id=?').get(id));
  function requireProject(id: string, active = false, registered = false) {
    const project = get(id);
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND');
    if (active && project.status !== 'ACTIVE') throw new ProjectError('PROJECT_ARCHIVED');
    if (registered && !project.repositoryRoot) throw new ProjectError('PROJECT_NOT_REGISTERED');
    return project;
  }
  function checkPaths(input: VerifiedProjectInput, current?: string) {
    const normalize = (root: string, path: string) => resolve(root, path).normalize('NFC').toLowerCase();
    const candidate = normalize(input.repositoryRoot, input.unityProjectPath);
    const neighbors = sql('SELECT id,repository_root AS root,unity_project_path AS path FROM projects WHERE repository_root IS NOT NULL').all();
    if (neighbors.some(({ id, root, path }) => {
      const other = normalize(String(root), String(path));
      return id !== current && (candidate === other || candidate.startsWith(other + sep) || other.startsWith(candidate + sep));
    })) throw new ProjectError('PROJECT_PATH_CONFLICT');
  }
  function editable(id: string, revision: number) {
    const project = requireProject(id, true);
    if (id === legacyProjectId) throw new ProjectError('PROJECT_NOT_REGISTERED');
    if (project.revision !== revision) throw new ProjectError('PROJECT_VERSION_CONFLICT');
    const trees = sql(`SELECT worktree_id AS id FROM authorization_worktrees WHERE project_id=?
      UNION SELECT worktree_id FROM git_operations WHERE project_id=? AND owner IS NOT NULL`).all(id, id);
    if (trees.some((tree) => worktreeBusy(database, String(tree.id)))) throw new ProjectError('PROJECT_BUSY');
    return project;
  }
  return {
    get,
    require: requireProject,
    list() { return sql('SELECT ' + columns + ' FROM projects ORDER BY created_at,id').all().map((row) => decode(row)!); },
    create(input: VerifiedProjectInput) {
      return immediate(database, () => {
        checkPaths(input);
        const now = clock();
        const id = randomUUID();
        sql(`INSERT INTO projects(id,name,engine,repository_root,repo_id,unity_project_path,unity_version,
          target_platform,status,settings,created_at,updated_at)
          VALUES (?,?,'UNITY',?,?,?,?,?,'ACTIVE',?,?,?)`).run(id, input.name, input.repositoryRoot, input.repoId,
          input.unityProjectPath, input.unityVersion, input.targetPlatform, JSON.stringify(input.settings), now, now);
        return get(id)!;
      });
    },
    update(id: string, revision: number, input: VerifiedProjectInput) {
      return immediate(database, () => {
        editable(id, revision);
        checkPaths(input, id);
        sql(`UPDATE projects SET name=?,repository_root=?,repo_id=?,unity_project_path=?,unity_version=?,
          target_platform=?,settings=?,updated_at=?,revision=revision+1 WHERE id=?`).run(input.name, input.repositoryRoot,
          input.repoId, input.unityProjectPath, input.unityVersion, input.targetPlatform, JSON.stringify(input.settings), clock(), id);
        return get(id)!;
      });
    },
    archive(id: string, revision: number) {
      return immediate(database, () => {
        editable(id, revision);
        sql("UPDATE projects SET status='ARCHIVED',revision=revision+1,updated_at=? WHERE id=?").run(clock(), id);
        return get(id)!;
      });
    },
    migrationReport() {
      return sql('SELECT entity_type AS entityType,entity_id AS entityId,reason,candidates FROM project_migration_report ORDER BY entity_type,entity_id')
        .all().map((row) => ({ ...row, candidates: JSON.parse(String(row.candidates)) as string[] }));
    },
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
