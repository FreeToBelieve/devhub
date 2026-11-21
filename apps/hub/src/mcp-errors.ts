export class McpReadError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export function missing(): never { throw new McpReadError('MCP_NOT_FOUND', 404); }
