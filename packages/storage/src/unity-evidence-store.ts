import type { DatabaseSync } from 'node:sqlite';
import { unityEvidenceRunSchema } from '@devhub/contracts';
import type { UnityEvidenceRun } from '@devhub/contracts';
import { immediate } from './migrations.js';

export function createUnityEvidenceStore(database: DatabaseSync) {
  const sql = (statement: string) => database.prepare(statement);
  const decode = (row: Record<string, unknown> | undefined) => row && unityEvidenceRunSchema.parse(JSON.parse(String(row.data)));
  function byManifest(projectId: string, manifestSha256: string) {
    return decode(sql('SELECT data FROM unity_evidence_runs WHERE project_id=? AND manifest_sha256=?').get(projectId, manifestSha256));
  }
  return {
    get(id: string, projectId: string) {
      return decode(sql('SELECT data FROM unity_evidence_runs WHERE id=? AND project_id=?').get(id, projectId));
    },
    list(projectId: string) {
      return sql('SELECT data FROM unity_evidence_runs WHERE project_id=? ORDER BY imported_at DESC LIMIT 100')
        .all(projectId).map((row) => decode(row)!);
    },
    add(run: UnityEvidenceRun, operatorDigest: string) {
      return immediate(database, () => {
        const prior = byManifest(run.projectId, run.manifestSha256);
        if (prior) return prior;
        sql('INSERT INTO unity_evidence_runs (id,project_id,manifest_sha256,imported_at,actor_digest,data) VALUES (?,?,?,?,?,?)')
          .run(run.id, run.projectId, run.manifestSha256, run.importedAt, operatorDigest, JSON.stringify(run));
        return run;
      });
    },
    pruneIds() {
      return sql('SELECT id FROM unity_evidence_runs').all().map(({ id }) => String(id));
    },
  };
}
