import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GitChange, Project, Task, UnityArtifact, UnityEnvironment, UnityRun } from '@devhub/contracts';
import { containsWorkspaceSecret, isWorkspaceSecretPath, sha256 } from '@devhub/security';
import type { TaskStore } from '@devhub/storage';
import { localGitIdentity } from '@devhub/git-adapter';
import { mcpMediaLimit, mcpTools } from '@devhub/mcp-contracts';
import type { McpOutput, McpPair, McpTool } from '@devhub/mcp-contracts';
import { readArtifact, readRegular, sanitizeUnityText } from '@devhub/unity-adapter';
import type { unityRuntime } from './unity-runtime.js';
import type { gitDelivery } from './git-delivery.js';
import { projectPath, projectWorkspace } from './project-context.js';

export class McpReadError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

function missing(): never { throw new McpReadError('MCP_NOT_FOUND', 404); }
function page<T>(items: T[], { offset, limit }: { offset: number; limit: number }) {
  return { items: items.slice(0, limit), nextOffset: items.length > limit ? offset + limit : null };
}
function pageArray<T>(items: T[], query: { offset: number; limit: number }) {
  return page(items.slice(query.offset, query.offset + query.limit + 1), query);
}
function publicText(value: string, limit = 2000): string {
  return sanitizeUnityText(value.split(/\r?\n/).map((line) =>
    containsWorkspaceSecret(line.replace(/^[+-]/, ''), true) ? '[REDACTED]' : line).join('\n'))
    .replace(/\bdhm_[\w-]{43}\b/g, '[REDACTED]')
    .replace(/\bsk-[\w-]{16,}\b/g, '[REDACTED]')
    .replace(/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|var|tmp|Volumes|Applications|opt|etc)\/)[^\r\n"'<>\t]+/g, ' <local-path>')
    .slice(0, limit);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin + publicText(url.pathname, 512) : null;
  } catch { return null; }
}
function environment(value: UnityEnvironment | null) {
  if (!value) return null;
  const { editor, version, installedVersions, platform, hub, projectVersion, buildSupport, license, graphics,
    projectLocked, diagnostics } = value;
  return { version, installedVersions: installedVersions.slice(0, 30), platform, editorAvailable: !!editor,
    hub, projectVersion, buildSupport, license, graphics, projectLocked, diagnostics: diagnostics.map((line) => publicText(line, 200)) };
}
function runSummary(run: UnityRun) {
  const { id, projectId, taskId, version, platform, phase, status, startedAt, finishedAt, exitConfirmed } = run;
  return { id, projectId, taskId, version, platform, phase, status, startedAt, finishedAt, exitConfirmed,
    diagnostic: run.diagnostic ? publicText(run.diagnostic, 180) : null, stages: run.reports.map(({ stage, code }) => ({ stage, code })) };
}
function artifactSummary(run: UnityRun, { name, kind, mime, size, sha256: digest, createdAt }: UnityArtifact) {
  const id = sha256(JSON.stringify([run.projectId, run.id, name, digest]));
  const resource = mime === 'image/png' ? 'image' : mime === 'video/mp4' ? 'recording' : null;
  return { id, kind, mime, size, sha256: digest, createdAt,
    uri: resource ? `devhub://projects/${run.projectId}/unity-runs/${run.id}/artifacts/${id}/${resource}` : null };

}
function changeSummary(change: GitChange) {
  return { ...change, url: safeUrl(change.url), title: publicText(change.title, 160), description: publicText(change.description, 3000),
    sourceBranch: publicText(change.sourceBranch, 120), targetBranch: publicText(change.targetBranch, 120) };
}

export function mcpReads(tasks: TaskStore, git: ReturnType<typeof gitDelivery>, unity: ReturnType<typeof unityRuntime>) {
  const describe = (project: Project) => {
    const connection = tasks.git.connection(project.id);
    return {
      id: project.id, name: publicText(project.name, 120), engine: project.engine, unityVersion: project.unityVersion,
      targetPlatform: project.targetPlatform, status: project.status, revision: project.revision,
      createdAt: project.createdAt, updatedAt: project.updatedAt, description: publicText(project.settings.description, 4000),
      gameType: publicText(project.settings.gameType, 80),
      git: connection ? { provider: connection.provider, repository: safeUrl(connection.repositoryUrl),
        defaultBranch: connection.defaultBranch, connected: !!connection.credentialRef } : null,
    };
  };
  const describeTask = (task: Task) => ({ ...task, title: publicText(task.title, 120), description: publicText(task.description, 4000),
    updatedAt: tasks.latestRevisionAt(task.id) ?? (task.revision === 1 ? Date.parse(task.createdAt) : null) });
  async function getEnvironment(project: Project) {
    return environment(await unity.environment(undefined, project.id));
  }
  function documents(project: Project) {
    return project.settings.documents.filter(({ path }) => !isWorkspaceSecretPath(path)).map(({ kind, path }) =>
      ({ id: sha256(JSON.stringify([project.id, kind, path])), kind, path }));
  }

  async function read(tool: McpTool, rawInput: unknown, pairing: McpPair): Promise<McpOutput> {
    const definition = mcpTools[tool];
    if (!pairing.groups.includes(definition.group)) throw new McpReadError('MCP_TOOL_FORBIDDEN', 403);
    const parsed = definition.input.safeParse(rawInput);
    if (!parsed.success) throw new McpReadError('MCP_INVALID_INPUT');
    function input<Name extends McpTool>() { return parsed.data as z.output<(typeof mcpTools)[Name]['input']>; }
    const projectId = parsed.data.projectId;
    if (projectId && !pairing.projectIds.includes(projectId)) throw new McpReadError('MCP_PROJECT_FORBIDDEN', 403);
    if (tool === 'devhub_list_projects') {
      const scope = input<typeof tool>();
      return { data: pageArray(pairing.projectIds.filter((id) => !projectId || id === projectId)
        .flatMap((id) => { const value = tasks.projects.get(id); return value ? [describe(value)] : []; }), scope) };
    }
    const project = projectId ? tasks.projects.get(projectId) : missing();
    if (!project) missing();
    const id = project.id;
    const run = () => tasks.unity.get(input<'devhub_get_unity_run'>().runId, id) ?? missing();
    const codex = () => tasks.codex.get(input<'devhub_get_codex_run'>().runId, id) ?? missing();
    const task = () => tasks.get(input<'devhub_get_task'>().taskId, id) ?? missing();
    switch (tool) {
      case 'devhub_get_project': return { data: describe(project) };
      case 'devhub_get_project_overview':
        return { data: { project: describe(project),
          ...(pairing.groups.includes('tasks') ? { recentTasks: tasks.list(id, 5).map(describeTask) } : {}),
          ...(pairing.groups.includes('codex') ? { recentCodexRuns: tasks.codex.list(id, false).slice(0, 5) } : {}),
          ...(pairing.groups.includes('unity') ? { recentUnityRuns: tasks.unity.list(id, false).slice(0, 5).map(runSummary) } : {}) } };
      case 'devhub_get_project_environment':
      case 'devhub_get_unity_environment': return { data: await getEnvironment(project) };
      case 'devhub_list_project_documents':
        return { data: documents(project).map(({ id, kind }) => ({ id, kind })) };
      case 'devhub_read_project_document': {
        const { documentId, offset } = input<typeof tool>();
        const doc = documents(project).find((item) => item.id === documentId);
        if (!doc || !project.repositoryRoot) missing();
        const path = await projectWorkspace(project, project.repositoryRoot)
          .then((workspace) => projectPath(workspace, doc.path, 'file')).catch(() => missing());
        const buffer = await readRegular(path, 512 * 1024).catch(() => { throw new McpReadError('MCP_DOCUMENT_UNAVAILABLE', 404); });
        const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (containsWorkspaceSecret(body, true) || body.includes('\0')) throw new McpReadError('MCP_DOCUMENT_UNAVAILABLE', 403);
        const text = publicText(body, body.length);
        return { data: { id: doc.id, kind: doc.kind, text: text.slice(offset, offset + 12_000),
          nextOffset: text.length > offset + 12_000 ? offset + 12_000 : null } };
      }
      case 'devhub_list_tasks': {
        const query = input<typeof tool>();
        return { data: page(tasks.list(id, query.limit + 1, query.offset).map(describeTask), query) };
      }
      case 'devhub_get_task': return { data: describeTask(task()) };
      case 'devhub_get_task_history': {
        const { id: taskId } = task();
        const query = input<typeof tool>();
        return { data: { revisions: page(tasks.revisionHistory(taskId, id, query.limit + 1, query.offset), query),
          requests: page(tasks.taskRequests(taskId, id, query.limit + 1, query.offset), query) } };
      }
      case 'devhub_list_codex_runs': return { data: pageArray(tasks.codex.list(id, false), input<typeof tool>()) };
      case 'devhub_get_codex_run': return { data: codex() };
      case 'devhub_get_codex_events': {
        const { devhubRunId } = codex();
        const { after, limit } = input<typeof tool>();
        const events = tasks.codex.events(devhubRunId, after);
        return { data: { events: events.slice(0, limit), nextAfter: events.length > limit ? events[limit - 1]?.seq : null } };
      }
      case 'devhub_get_codex_thread_summary': {
        const current = codex();
        const events = tasks.codex.eventSummary(current.devhubRunId);
        return { data: { run: current, ...events,
          runIds: current.providerThreadId ? tasks.codex.list(id, false).filter((row) => row.providerThreadId === current.providerThreadId)
            .slice(0, 20).map((row) => row.devhubRunId) : [current.devhubRunId] } };
      }
      case 'devhub_list_unity_runs': return { data: pageArray(tasks.unity.list(id, false).map(runSummary), input<typeof tool>()) };
      case 'devhub_get_unity_run': return { data: runSummary(run()) };
      case 'devhub_get_unity_test_report': return { data: run().reports.filter((report) => report.tests).map(({ stage, tests }) => ({
        stage, tests: tests && { ...tests, names: tests.names.map((name) => publicText(name, 160)),
          failures: tests.failures?.map(({ name, message }) => ({ name: publicText(name, 160), message: publicText(message, 350) })) },
      })) };
      case 'devhub_get_unity_build_report':
        return { data: run().reports.filter((report) => report.stage === 'BUILD').map(({ stage, code, exitCode, build }) =>
          ({ stage, code, exitCode, build })) };
      case 'devhub_get_unity_diagnostics': {
        const item = run();
        const query = input<typeof tool>();
        const rows = item.reports.flatMap(({ stage, diagnostics }) => diagnostics.map(({ severity, code, line, message }) =>
          ({ stage, severity, code, line, message: publicText(message, 700) })));
        const logs = query.offset === 0 && item.exitConfirmed ? await Promise.all(item.artifacts.filter(({ kind }) => kind === 'log')
          .slice(0, 2).map(async ({ name, size }) => {
            const file = await readArtifact(unity.artifacts, item.id, name).catch(() => null);
            if (!file) return null;
            try {
              const buffer = Buffer.alloc(Math.min(size, 8192));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
              return { name, text: publicText(buffer.subarray(0, bytesRead).toString('utf8'), 8000), truncated: size > bytesRead };
            } finally { await file.close(); }
          })) : [];
        return { data: { summary: runSummary(item), diagnostics: pageArray(rows, query), logs: logs.filter(Boolean) } };
      }
      case 'devhub_list_unity_artifacts': {
        const item = run();
        return { data: item.exitConfirmed ? item.artifacts.map((entry) => artifactSummary(item, entry)) : [] };
      }
      case 'devhub_get_unity_screenshot':
      case 'devhub_get_unity_recording_metadata':
      case 'devhub_get_unity_recording_resource': {
        const item = run();
        const { artifactId } = input<typeof tool>();
        const artifact = item.artifacts.find((entry) => artifactSummary(item, entry).id === artifactId);
        const mime = tool === 'devhub_get_unity_screenshot' ? 'image/png' : 'video/mp4';
        if (!item.exitConfirmed || !artifact || artifact.mime !== mime) missing();
        const frames = mime === 'video/mp4' ? item.artifacts.filter(({ mime: kind }) => kind === 'image/png')
          .map((entry) => artifactSummary(item, entry)) : [];
        const data = { ...artifactSummary(item, artifact), runId: item.id, recordingResourceAvailable: mime === 'video/mp4' && artifact.size <= mcpMediaLimit,
          ...(mime === 'video/mp4' ? { reviewFrames: frames } : {}) };
        if (tool !== 'devhub_get_unity_screenshot' && (tool === 'devhub_get_unity_recording_metadata' || artifact.size > mcpMediaLimit)) {
          return { data };
        }
        if (artifact.size > mcpMediaLimit) throw new McpReadError('MCP_RESPONSE_LIMIT', 413);
        const file = await readArtifact(unity.artifacts, item.id, artifact.name).catch(() => missing());
        try {
          const buffer = Buffer.alloc(artifact.size + 1);
          let count = 0;
          while (count < buffer.length) {
            const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
          }
          const bytes = buffer.subarray(0, count);
          const magic = mime === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
            : bytes.subarray(4, 8).toString('ascii') === 'ftyp';
          if (!magic || count !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) missing();
          return { data, media: { mimeType: mime, data: bytes.toString('base64') } };
        } finally { await file.close(); }
      }
      case 'devhub_get_git_status': {
        const { worktreeId } = input<typeof tool>();
        const tree = worktreeId ? tasks.execution.getWorktree(worktreeId, id) : undefined;
        if (worktreeId && !tree) missing();
        const root = tree?.root ?? project.repositoryRoot;
        const git = root ? await localGitIdentity(root).catch(() => null) : null;
        return { data: { connection: describe(project).git,
          currentBranch: git?.ref.startsWith('refs/heads/') ? publicText(git.ref.slice(11), 120) : null,
          headSha: git?.head ?? null,
          recentOperations: tasks.git.operations(id).slice(0, 10).map(({ id, phase, binding, commitSha, changeNumber, updatedAt }) =>
            ({ id, phase, branch: binding.branch, commitSha, changeNumber, updatedAt })) } };
      }
      case 'devhub_list_commits': return { data: pageArray(tasks.git.operations(id).filter(({ commitSha }) => commitSha)
        .map(({ commitSha, binding, updatedAt }) => ({ sha: commitSha, branch: binding.branch, updatedAt })), input<typeof tool>()) };
      case 'devhub_list_pull_requests': return { data: pageArray(tasks.git.changes(id).map(changeSummary), input<typeof tool>()) };
      case 'devhub_get_pull_request':
      case 'devhub_get_merge_request': {
        const provider = tasks.git.connection(id)?.provider;
        if (provider !== (tool === 'devhub_get_merge_request' ? 'gitlab' : 'github')) missing();
        return { data: changeSummary(await git.inspectChange(id, input<typeof tool>().number, 'change')) };
      }
      case 'devhub_get_git_diff': {
        const query = input<typeof tool>();
        if (query.operationId) {
          const operation = tasks.git.operation(query.operationId);
          if (!operation || operation.projectId !== id) missing();
          const candidate = operation.summary.candidate;
          const items = candidate?.changedFiles ?? operation.summary.changes.map((path) => ({ path, patch: null }));
          return { data: { candidateTreeSha: candidate?.candidateTreeSha ?? null, candidateDiffDigest: candidate?.candidateDiffDigest ?? null,
            summary: candidate?.candidateFileSummary ?? null, ...pageArray(items.map((item) =>
              ({ ...item, path: publicText(item.path, 512), patch: item.patch ? publicText(item.patch, 6000) : null,
                patchTruncated: (item.patch?.length ?? 0) > 6000 })), query) } };
        }
        const diff = await git.inspectChange(id, query.number!, 'diff');
        return { data: pageArray(diff.map(({ path, status, patch }) => ({ path: publicText(path, 512), status,
          patch: patch ? publicText(patch, 6000) : null, patchTruncated: (patch?.length ?? 0) > 6000 })), query) };
      }
      case 'devhub_get_pull_request_reviews': {
        const query = input<typeof tool>();
        const reviews = await git.inspectChange(id, query.number, 'reviews');
        return { data: pageArray(reviews.map(({ id, body, author, path, url }) => ({
          id, body: publicText(body), author: publicText(author, 100), path: path ? publicText(path, 512) : null, url: url && safeUrl(url),
        })), query) };
      }
      case 'devhub_get_ci_status': {
        const query = input<typeof tool>();
        const checks = await git.inspectChange(id, query.number, 'checks');
        return { data: pageArray(checks.map(({ name, status, conclusion }) => ({
          name: publicText(name, 180), status: publicText(status, 80), conclusion: conclusion && publicText(conclusion, 80),
        })), query) };
      }
    }
  }
  return read;
}
