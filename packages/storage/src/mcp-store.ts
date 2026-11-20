import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { McpPairInput, McpPair, McpTool, McpTunnel } from '@devhub/mcp-contracts';
import { mcpAuditSchema, mcpPairSchema } from '@devhub/mcp-contracts';
import { immediate } from './migrations.js';

// Version 8 stores expiry in a non-null INTEGER. Epoch 0 is reserved for permanent pairings.
const noExpiry = 0;
const available = 'revoked_at IS NULL AND (expires_at = 0 OR expires_at > ?)';
const expiresAt = (hours: number | null, now: number) => hours === null ? noExpiry : now + hours * 3_600_000;

export function createMcpStore(database: DatabaseSync, clock: () => number) {
  const columns = `id, label, projects, groups, expires_at AS expiresAt, revoked_at AS revokedAt,
    last_seen_at AS lastSeenAt, transport, protocol_version AS protocolVersion, tunnel_json AS tunnelJson`;
  function decode(row: Record<string, unknown> | undefined): McpPair | undefined {
    if (!row) return undefined;
    const { projects, groups, tunnelJson, expiresAt, ...metadata } = row;
    return mcpPairSchema.parse({ ...metadata, expiresAt: expiresAt === noExpiry ? null : expiresAt, projectIds: JSON.parse(String(projects)), groups: JSON.parse(String(groups)), tunnel: tunnelJson ? JSON.parse(String(tunnelJson)) : null });
  }
  function get(id: string) {
    return decode(database.prepare('SELECT ' + columns + ' FROM mcp_pairings WHERE id=?').get(id));
  }
  return {
    issue(input: McpPairInput, proofDigest: string) {
      return immediate(database, () => {
        const id = randomUUID();
        const now = clock();
        const count = database.prepare(`SELECT count(*) AS count FROM mcp_pairings WHERE ${available}`).get(now);
        if (Number(count?.count) >= 64) return undefined;
        database.prepare('INSERT INTO mcp_pairings (id,label,projects,groups,digest,expires_at) VALUES (?,?,?,?,?,?)')
          .run(id, input.label, JSON.stringify([...new Set(input.projectIds)]), JSON.stringify([...new Set(input.groups)]),
            proofDigest, expiresAt(input.hours, now));
        return get(id)!;
      });
    },
    rotate(id: string, hours: number | null, proofDigest: string) {
      return immediate(database, () => {
        const now = clock();
        const result = database.prepare(`UPDATE mcp_pairings SET digest=?,expires_at=?,last_seen_at=NULL,
          transport=NULL,protocol_version=NULL,tunnel_json=NULL WHERE id=? AND ${available}`)
          .run(proofDigest, expiresAt(hours, now), id, now);
        return result.changes === 1 ? get(id) : undefined;
      });
    },
    revoke(id: string) {
      return database.prepare('UPDATE mcp_pairings SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?').run(clock(), id).changes === 1;
    },
    authenticate(digest: string) {
      return decode(database.prepare('SELECT ' + columns + ' FROM mcp_pairings WHERE digest=?').get(digest));
    },
    touch(id: string, transport: NonNullable<McpPair['transport']>, protocolVersion?: string, tunnel?: McpTunnel) {
      database.prepare(`UPDATE mcp_pairings SET last_seen_at=?,transport=?,
        protocol_version=CASE WHEN transport=? THEN COALESCE(?,protocol_version) ELSE ? END,
        tunnel_json=CASE WHEN ?='http' THEN NULL ELSE COALESCE(?,tunnel_json) END WHERE id=?`)
        .run(clock(), transport, transport, protocolVersion ?? null, protocolVersion ?? null, transport,
          tunnel ? JSON.stringify(tunnel) : null, id);
    },
    list() {
      return database.prepare('SELECT ' + columns + ' FROM mcp_pairings ORDER BY rowid DESC LIMIT 128').all().map((row) => decode(row)!);
    },
    audit(connectionId: string, tool: McpTool, result: string, projectId: string | null) {
      immediate(database, () => {
        const { lastInsertRowid } = database.prepare(`INSERT INTO mcp_audit
          (connection_id,project_id,tool,result,created_at) VALUES (?,?,?,?,?)`)
          .run(connectionId, projectId, tool, result, clock());
        database.prepare('DELETE FROM mcp_audit WHERE id <= ?').run(BigInt(lastInsertRowid) - 5_000n);
      });
    },
    recent() {
      return database.prepare(`SELECT connection_id AS connectionId,project_id AS projectId,tool,result,created_at AS createdAt
        FROM mcp_audit ORDER BY id DESC LIMIT 100`).all().map((row) => mcpAuditSchema.parse(row));
    },
  };
}
