import { useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { z } from 'zod';
import {
  executionBindingSchema, executionDetailSchema, executionRequestSchema, gitHeadSchema,
  operatorSessionSchema, runnerRecordSchema, taskSchema, worktreeRecordSchema, digestSchema, codexRunSchema,
  developerNetworkModeSchema,
} from '@devhub/contracts';
import type { ExecutionRequest, ExecutionAuditEvent, ExecutionState, CodexRun } from '@devhub/contracts';
import { request } from './api.js';

const catalogSchema = z.object({
  tasks: z.array(taskSchema.extend({ taskSpecSha256: digestSchema })),
  runners: z.array(runnerRecordSchema),
  worktrees: z.array(worktreeRecordSchema.extend({ codexManaged: z.boolean() })),
  policyVersion: z.int(),
});
const listSchema = z.object({ requests: z.array(executionRequestSchema) });
const liveSchema = worktreeRecordSchema.extend({
  baseHeadSha: gitHeadSchema,
  workspaceSha256: digestSchema.optional(),
  sdkConfigSha256: digestSchema.optional(),
  executionProfile: z.literal('PROJECT_DEVELOPER').optional(),
  networkMode: developerNetworkModeSchema.optional(),
});
const runListSchema = z.object({ runs: z.array(codexRunSchema) });
type Session = z.infer<typeof operatorSessionSchema>;
type Catalog = z.infer<typeof catalogSchema>;

const stateNames: Record<ExecutionState, string> = {
  PENDING: '待审批', APPROVED: '已批准', DENIED: '已拒绝', EXPIRED: '已过期',
  CLAIMED: '已领取', REVOKED: '已撤销',
};
const messages: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，或启动凭据已使用、过期。',
  STALE_CONTEXT: '任务规范或 Git 工作树已变化。请重新核对后发起申请。',
  WORKSPACE_SECRET_DETECTED: '工作树包含受保护的秘密文件或认证配置。移出后重新申请。',
  WORKSPACE_SECRET_SCAN_LIMIT: '凭据模板或认证配置超过检查限额。',
  PROXY_OS_CONTAINMENT_UNAVAILABLE: '当前系统无法约束 CONNECT 客户端网络。',
  VERSION_CONFLICT: '申请已更新。请刷新并审查最新状态。',
  STATE_CONFLICT: '当前状态不允许该操作。',
  INVALID_AUTHORIZATION_INPUT: '请检查任务、线程 ID 和操作参数。',
};

export function Authorization() {
  const [session, setSession] = useState<Session>();
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>();
  const [items, setItems] = useState<ExecutionRequest[]>([]);
  const [runs, setRuns] = useState<CodexRun[]>([]);
  const [audit, setAudit] = useState<Record<string, ExecutionAuditEvent[]>>({});
  const [operation, setOperation] = useState('status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keys = useRef(new Map<string, string>());

  function showError(failure: unknown) {
    const code = failure instanceof Error ? failure.message : '';
    if (code === 'UNAUTHENTICATED') setSession(undefined);
    setError(messages[code] ?? '无法完成授权中心请求。');
  }

  useEffect(() => {
    const controller = new AbortController();
    request('/api/operator/session', operatorSessionSchema, { signal: controller.signal })
      .then(setSession)
      .catch((failure: Error) => {
        if (!controller.signal.aborted && failure.message !== 'UNAUTHENTICATED') showError(failure);
      })
      .finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, []);

  async function refresh(signal?: AbortSignal) {
    const [current, result, history] = await Promise.all([
      request('/api/authorization/catalog', catalogSchema, { signal }),
      request('/api/execution-requests', listSchema, { signal }),
      request('/api/codex-runs', runListSchema, { signal }),
    ]);
    if (!signal?.aborted) {
      setCatalog(current);
      setItems(result.requests);
      setRuns(history.runs);
    }
  }

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((failure) => { if (!controller.signal.aborted) showError(failure); });
    return () => controller.abort();
  }, [session]);

  async function action(operation: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(false);
    }
  }

  function login(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const bootstrapCredential = new FormData(form).get('bootstrapCredential');
    form.reset();
    void action(async () => {
      setSession(await request('/api/operator/session', operatorSessionSchema, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCredential }),
      }));
    });
  }

  async function write(path: string, value: unknown) {
    if (!session) return;
    const body = JSON.stringify(value);
    const identity = path + body;
    const key = keys.current.get(identity) ?? crypto.randomUUID();
    keys.current.set(identity, key);
    await request(path, executionRequestSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': key },
      body,
    });
    keys.current.delete(identity);
  }

  function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void action(async () => {
      const task = catalog?.tasks.find((entry) => entry.id === values.get('task'));
      const runner = catalog?.runners.find((entry) => entry.id === values.get('runner'));
      const tree = catalog?.worktrees.find((entry) => entry.worktreeId === values.get('worktree'));
      if (!task || !runner || !tree || !catalog) throw new Error('INVALID_AUTHORIZATION_INPUT');
      const chosenOperation = values.get('operation');
      const codexMode = chosenOperation === 'codex.start' ? 'start' : chosenOperation === 'codex.resume' ? 'resume' : null;
      const networkMode = codexMode ? developerNetworkModeSchema.parse(values.get('network')) : 'OFF';
      const live = await request('/api/authorization/worktrees/' + tree.worktreeId + '?network=' + networkMode, liveSchema);
      const previous = codexMode === 'resume' ? runs.find((run) => run.devhubRunId === values.get('previousRun')) : undefined;
      let scope: unknown = chosenOperation === 'workspace.write'
        ? { operation: 'workspace.write', paths: String(values.get('paths') ?? '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean) }
        : { operation: 'process.run', executable: 'git', action: chosenOperation };
      if (codexMode !== null) {
        const prompt = new TextEncoder().encode(String(values.get('prompt') ?? ''));
        if (!prompt.length || prompt.length > 24_000 || !tree.codexManaged ||
          live.executionProfile !== 'PROJECT_DEVELOPER' || live.networkMode !== networkMode ||
          (codexMode === 'resume' && previous?.worktreeId !== tree.worktreeId)) throw new Error('INVALID_AUTHORIZATION_INPUT');
        const digest = await crypto.subtle.digest('SHA-256', prompt);
        scope = {
          operation: 'codex.turn', mode: codexMode, previousRunId: previous?.devhubRunId ?? null,
          promptSha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
          sdkConfigSha256: live.sdkConfigSha256, workspaceSha256: live.workspaceSha256,
          executionProfile: live.executionProfile, networkMode: live.networkMode,
        };
      }
      const binding = executionBindingSchema.safeParse({
        taskId: task.id, taskRevision: task.revision, taskSpecSha256: task.taskSpecSha256,
        runnerId: runner.id, platform: runner.platform, repoId: live.repoId, worktreeId: live.worktreeId,
        baseHeadSha: live.baseHeadSha, codexThreadId: codexMode === null ? values.get('thread') : previous?.providerThreadId ?? null,
        policyVersion: catalog.policyVersion, scope,
      });
      if (!binding.success) throw new Error('INVALID_AUTHORIZATION_INPUT');
      await write('/api/execution-requests', binding.data);
      await refresh();
    });
  }

  const alert = error && <p className="alert" role="alert">{error}</p>;
  if (!ready) return <p className="empty" role="status">正在检查操作员会话…</p>;
  if (!session) return <form className="panel task-form" onSubmit={login} autoComplete="off">
    <p>在本机终端运行 <code>pnpm authorization bootstrap</code> 签发启动凭据。</p>
    <label htmlFor="bootstrap-credential">一次性启动凭据</label>
    <input type="password" id="bootstrap-credential" name="bootstrapCredential" required autoComplete="off" maxLength={43} />
    {alert}
    <button className="button primary" disabled={busy}>登录授权中心</button>
  </form>;

  async function decide(item: ExecutionRequest, decision: 'approve' | 'deny' | 'revoke') {
    await action(async () => {
      try {
        const base = '/api/execution-requests/' + item.id;
        await write(base + (decision === 'revoke' ? '/revoke' : '/decision'),
          decision === 'revoke' ? { expectedVersion: item.version } : { expectedVersion: item.version, decision });
      } finally {
        await refresh();
      }
      setAudit((current) => ({ ...current, [item.id]: [] }));
    });
  }

  return <div className="authorization">
    {alert}
    <section className="panel">
      <div className="panel-heading">
        <h2>执行申请</h2>
        <div className="form-actions">
          <button className="button" disabled={busy} onClick={() => void action(() => refresh())}>刷新</button>
          <button className="button" disabled={busy} onClick={() => void action(async () => {
            await request('/api/operator/session', z.unknown(), { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } });
            keys.current.clear();
            setCatalog(undefined);
            setItems([]);
            setRuns([]);
            setAudit({});
            setSession(undefined);
          })}>退出</button>
        </div>
      </div>
      {items.length === 0 && <p className="empty">暂无授权申请</p>}
      <ul className="task-list">
        {items.map((item) => <li key={item.id}><details>
          <summary>
            <span className="task-name">
              <strong>{catalog?.tasks.find((entry) => entry.id === item.binding.taskId)?.title ?? item.binding.taskId}</strong>
              <span>{item.binding.platform} · 版本 {item.version}</span>
            </span>
            <span className="pill">{stateNames[item.status]}</span><span className="chevron" aria-hidden="true" />
          </summary>
          <div className="task-details">
            <dl className="authorization-details">
              <dt>任务 revision / SHA256</dt><dd><code>{item.binding.taskRevision} / {item.binding.taskSpecSha256}</code></dd>
              <dt>工作树 / 仓库</dt><dd><code>{item.binding.worktreeId}<br />{item.binding.repoId}</code></dd>
              <dt>Git HEAD</dt><dd><code>{item.binding.baseHeadSha}</code></dd>
              <dt>线程 / Runner</dt><dd><code>{item.binding.codexThreadId ?? '新 Thread'} / {item.binding.runnerId}</code></dd>
              <dt>范围 / 策略版本</dt><dd><code>{JSON.stringify(item.binding.scope)} / {item.binding.policyVersion}</code></dd>
              <dt>到期</dt><dd>{new Date(item.grantExpiresAt ?? item.expiresAt).toLocaleString()}</dd>
              <dt>绑定摘要</dt><dd><code>{item.bindingDigest}</code></dd>
              {item.grantId && <><dt>授予 ID</dt><dd><code>{item.grantId}</code></dd></>}
            </dl>
            <div className="form-actions">
              {item.status === 'PENDING' && <>
                <button className="button primary" disabled={busy} onClick={() => void decide(item, 'approve')}>批准</button>
                <button className="button" disabled={busy} onClick={() => void decide(item, 'deny')}>拒绝</button>
              </>}
              {item.status === 'APPROVED' && <button className="button" disabled={busy} onClick={() => void decide(item, 'revoke')}>撤销</button>}
              <button className="button" disabled={busy} onClick={() => void action(async () => {
                const detail = await request('/api/execution-requests/' + item.id, executionDetailSchema);
                setAudit((current) => ({ ...current, [item.id]: detail.events }));
              })}>读取审计</button>
            </div>
            {!!audit[item.id]?.length && <ul>
              {audit[item.id]?.map((event) => <li key={event.id}>
                {stateNames[event.kind]} · {event.actorKind} · {new Date(event.createdAt).toLocaleString()} {event.reason ?? ''}
              </li>)}
            </ul>}
          </div>
        </details></li>)}
      </ul>
    </section>

    <form className="panel task-form" onSubmit={create}>
      <h2>发起申请</h2>
      {catalog && (!catalog.runners.length || !catalog.worktrees.length) && <p className="muted">请先在本机终端登记 Runner 和 Git 工作树。</p>}
      <fieldset disabled={busy || !catalog?.runners.length || !catalog.worktrees.length || !catalog.tasks.length}>
        <label htmlFor="authorization-task">任务</label>
        <select id="authorization-task" name="task" required>{catalog?.tasks.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · r{entry.revision}</option>)}</select>
        <label htmlFor="authorization-runner">Runner</label>
        <select id="authorization-runner" name="runner" required>{catalog?.runners.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.platform}</option>)}</select>
        <label htmlFor="authorization-worktree">Git 工作树</label>
        <select id="authorization-worktree" name="worktree" required>{catalog?.worktrees.map((entry) => <option key={entry.worktreeId} value={entry.worktreeId}>{entry.root}</option>)}</select>
        <label htmlFor="authorization-operation">操作范围</label>
        <select id="authorization-operation" name="operation" value={operation} onChange={(event) => setOperation(event.target.value)}>
          <option value="status">Git status</option>
          <option value="diff-check">Git diff 检查</option>
          <option value="workspace.write">限定文件写入</option>
          <option value="codex.start">Codex 新 Thread · 整个工作树</option>
          <option value="codex.resume">Codex 恢复 Thread · 整个工作树</option>
        </select>
        {operation.startsWith('codex.') ? <>
          <label htmlFor="authorization-network">Project Developer 网络范围</label>
          <select id="authorization-network" name="network" defaultValue="OFF">
            <option value="OFF">关闭</option>
            <option value="DEVELOPER_ALLOWLIST">允许公共 Unity UPM、npm、GitHub 依赖下载</option>
            <option value="DEVELOPER_CONNECT">macOS 受控依赖客户端 · CONNECT</option>
          </select>
          {operation === 'codex.resume' && <>
            <label htmlFor="authorization-previous-run">上一条 Codex Turn</label>
            <select id="authorization-previous-run" name="previousRun" required>
              {runs.filter((run) => run.providerThreadId && run.status !== 'RUNNING' && run.status !== 'INTERRUPTED')
                .map((run) => <option value={run.devhubRunId} key={run.devhubRunId}>{run.providerThreadId}</option>)}
            </select>
          </>}
          <label htmlFor="authorization-prompt">本次提示词，用于生成审批摘要</label>
          <textarea id="authorization-prompt" name="prompt" required rows={4} maxLength={24000} />
        </> : <>
          <label htmlFor="authorization-thread">Codex Thread ID</label>
          <input id="authorization-thread" name="thread" required maxLength={128} />
        </>}
        {operation === 'workspace.write' && <>
          <label htmlFor="authorization-paths">工作树相对路径，每行一条</label>
          <textarea id="authorization-paths" name="paths" required rows={3} />
        </>}
        <button className="button primary">提交审批</button>
      </fieldset>
    </form>
  </div>;
}
