import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import { codexEventSchema, codexRunSchema, inboxMessageSchema, inboxSessionSchema, inboxStatusSchema,
  operatorSessionSchema, runnerRecordSchema, taskInbox } from '@devhub/contracts';
import type { InboxMessage, Project, RunnerRecord } from '@devhub/contracts';
import { request, scopedRequest } from './api.js';

const catalog = z.object({ runners: z.array(runnerRecordSchema) });
const messageList = z.object({ messages: z.array(inboxMessageSchema) });
const runEvents = z.object({ run: codexRunSchema, events: z.array(z.object({ seq: z.int(), event: codexEventSchema })) });
const date = (value?: number | null) => value == null ? '—' : new Date(value).toLocaleString();

export function TaskInbox({ projectId, projects }: { projectId: string; projects: Project[] }) {
  const [project, setProject] = useState(projectId);
  const [task, setTask] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState('');
  const [data, setData] = useState<z.infer<typeof inboxStatusSchema>>();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [events, setEvents] = useState<z.infer<typeof runEvents>>();
  const [runners, setRunners] = useState<RunnerRecord[]>([]);
  const [runnerId, setRunner] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = data?.sessions.find((item) => item.id === selected);
  const runId = active?.currentRunId ?? active?.lastRunId;
  const sessionProjectId = active?.projectId;
  const resetSelection = () => { setSelected(''); setMessages([]); setEvents(undefined); };

  useEffect(() => {
    const controller = new AbortController();
    void scopedRequest(projectId)('/api/authorization/catalog', catalog, { signal: controller.signal }).then(({ runners }) => {
      if (controller.signal.aborted) return;
      setRunners(runners);
      setRunner((chosen) => runners.some((runner) => runner.id === chosen) ? chosen : runners[0]?.id ?? '');
    }).catch(() => {});
    return () => controller.abort();
  }, [projectId, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const filters = new URLSearchParams();
    if (project) filters.set('projectId', project);
    if (task) filters.set('taskId', task);
    if (status) filters.set('status', status);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await request('/api/task-inbox?' + filters, inboxStatusSchema, options);
        const detail = selected && next.sessions.some((entry) => entry.id === selected) ?
          await request('/api/task-inbox/sessions/' + selected + '/messages', messageList, options) : undefined;
        if (!controller.signal.aborted) {
          setData(next);
          setMessages(detail?.messages ?? []);
          setLoadError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setData(undefined);
          setLoadError(failure instanceof Error && failure.message === 'UNAUTHENTICATED' ? '请先登录。' : '暂时无法读取收件箱。');
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project, task, status, selected, refresh]);

  useEffect(() => {
    if (!sessionProjectId || !runId) { setEvents(undefined); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    async function poll() {
      let delay = 2000;
      try {
        const result = await scopedRequest(sessionProjectId!)('/api/codex-runs/' + runId + '/events?after=' + after, runEvents,
          { signal: controller.signal });
        if (controller.signal.aborted) return;
        after = result.events.at(-1)?.seq ?? after;
        setEvents((previous) => ({ run: result.run, events: [...(previous?.events ?? []), ...result.events].slice(-200) }));
        if (result.events.length === 200) delay = 0;
        else if (result.run.status !== 'RUNNING') return;
      } catch {
        // Keep the last confirmed events until the next poll.
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
    }
    setEvents(undefined);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionProjectId, runId]);

  async function mutate(path: string, method: string, body?: object, success?: string) {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const { csrfToken } = await request('/api/operator/session', operatorSessionSchema);
      const headers = new Headers({ 'X-CSRF-Token': csrfToken, 'Idempotency-Key': crypto.randomUUID() });
      if (body) headers.set('Content-Type', 'application/json');
      await request('/api/task-inbox' + path, z.unknown(), { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (success) setFeedback(success);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。');
    } finally {
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = new FormData(form).get('token');
    form.reset();
    if (typeof token === 'string' && token.trim()) void mutate('/credential', 'PUT', { token: token.trim() }, '凭据已保存到系统凭据库。');
  }

  if (!data) return <p className="panel empty" role="status">{loadError || '正在读取收件箱…'}
    {loadError && <a href="#authorization">授权中心</a>}</p>;

  const { host, listener, sessions, messageCounts } = data;
  const hostActive = host?.status === 'ACTIVE';
  const byTask = [...new Map(sessions.map((entry) => [entry.taskId, entry])).values()];
  return <div className="authorization">
    {error && <p className="alert inset" role="alert">{error}</p>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
    <section className="panel">
      <div className="panel-heading"><h2>GitHub 收件箱</h2><span>{listener.enabled ? '监听中' : '已暂停'}</span></div>
      <div className="task-details">
        <p><a href={'https://github.com/' + taskInbox.repository} rel="noreferrer">{taskInbox.repository}</a></p>
        <p>最近扫描 {date(listener.scannedAt)} · 匹配 PR {listener.prCount} · 待投递 {messageCounts.PENDING} · 待重试 {messageCounts.FAILED}</p>
        {listener.errorCode && <p role="status"><code>{listener.errorCode}</code></p>}
        <div className="form-actions">
          <button className="button" disabled={busy || !listener.configured}
            onClick={() => void mutate('/listener', 'PUT', { enabled: !listener.enabled })}>{listener.enabled ? '暂停监听' : '启用监听'}</button>
          <button className="button" disabled={busy || !listener.enabled || listener.scanning}
            onClick={() => void mutate('/scan', 'POST')}>{listener.scanning ? '正在扫描…' : '立即扫描'}</button>
        </div>
      </div>
      <form className="task-form" onSubmit={saveCredential}>
        <label htmlFor="inbox-token">Inbox 专用只读 GitHub 令牌</label>
        <input id="inbox-token" name="token" type="password" autoComplete="new-password" required />
        <button className="button" disabled={busy}>{listener.configured ? '更换凭据' : '验证并保存'}</button>
      </form>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>本机 Codex Host</h2><span>{hostActive ? '已连接' : '未连接'}</span></div>
      <div className="task-details">
        {host && <dl className="authorization-details">
          <dt>Host ID</dt><dd><code>{host.id}</code></dd>
          <dt>Runner ID</dt><dd><code>{host.runnerId}</code></dd>
          <dt>平台和版本</dt><dd>{host.platform} · {host.version}</dd>
          <dt>最近心跳</dt><dd>{date(host.heartbeatAt)}</dd>
          <dt>上次断开</dt><dd>{date(host.disconnectedAt)}</dd>
        </dl>}
        {hostActive ? <button className="button" disabled={busy} onClick={() => void mutate('/host', 'DELETE')}>断开 Host</button> :
          <div className="form-actions"><select aria-label="本机 Runner" value={host?.runnerId ?? runnerId}
            disabled={!!host || busy} onChange={(event) => setRunner(event.target.value)}>
            <option value="">选择已注册的 Runner</option>
            {runners.map(({ id, label, platform }) => <option value={id} key={id}>{label} · {platform}</option>)}
          </select>
          <button className="button" disabled={busy || !(host?.runnerId ?? runnerId)}
            onClick={() => void mutate('/host', 'POST', { runnerId: host?.runnerId ?? runnerId })}>连接 Host</button></div>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>任务 Session</h2></div>
      <div className="task-details form-actions">
        <label>项目 <select value={project} onChange={(event) => { setProject(event.target.value); setTask(''); resetSelection(); }}>
          <option value="">全部项目</option>
          {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <label>任务 <select value={task} onChange={(event) => { setTask(event.target.value); resetSelection(); }}>
          <option value="">全部任务</option>
          {task && !byTask.some((entry) => entry.taskId === task) && <option value={task}>{task}</option>}
          {byTask.map((entry) => <option key={entry.taskId} value={entry.taskId}>{entry.title}</option>)}
        </select></label>
        <label>状态 <select value={status} onChange={(event) => { setStatus(event.target.value); resetSelection(); }}>
          <option value="">全部状态</option>
          {inboxSessionSchema.shape.status.options.map((value) => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      {!sessions.length && <p className="empty">暂无匹配的任务 Session</p>}
      <ul className="check-list">{sessions.map((entry) => <li key={entry.id}>
        <div><strong>{entry.title}</strong><p>{entry.status} · {projects.find((item) => item.id === entry.projectId)?.name ?? entry.projectId}</p></div>
        <button className="button" aria-pressed={selected === entry.id} onClick={() => {
          setMessages([]); setEvents(undefined); setSelected(entry.id);
        }}>查看 Session</button>
      </li>)}</ul>
      {active && <div className="task-details">
        <dl className="authorization-details">
          <dt>Session</dt><dd><code>{active.id}</code></dd>
          <dt>Task</dt><dd><code>{active.taskId}</code></dd>
          <dt>Worktree</dt><dd><code>{active.worktreeId ?? '待准备'}</code></dd>
          <dt>Codex Thread</dt><dd><code>{active.providerThreadId ?? '待首次执行'}</code></dd>
          {runId && <><dt>DevHub Run</dt><dd><code>{runId}</code></dd></>}
        </dl>
        {active.status === 'INTERRUPTED' && <p role="status">工作树保持锁定，等待确认执行进程退出。</p>}
        <h3>任务消息</h3>
        {messages.map((message) => <details key={message.id}>
          <summary>PR #{message.pullRequestNumber} · 版本 {message.taskRevision} · {message.status}</summary>
          <p><code>{message.headSha}</code> · {date(message.createdAt)}{message.errorCode && ' · ' + message.errorCode}</p>
          <pre className="git-patch">{message.source.text}</pre>
          <div className="form-actions">
            {message.status === 'DELIVERED' && <>
              <button className="button" disabled={busy || !hostActive} onClick={() =>
                void mutate('/messages/' + message.id + '/prepare', 'POST', undefined, '执行申请已准备。请在授权中心选择对应项目。')}>准备执行申请</button>
              <a href="#authorization">打开授权中心</a>
              {message.requestId && <button className="button" disabled={busy || !hostActive} onClick={() =>
                void mutate('/messages/' + message.id + '/start', 'POST', undefined, '已提交批准后的启动请求。')}>启动已批准的申请</button>}
            </>}
            {message.status === 'FAILED' && <button className="button" disabled={busy || !hostActive || !!active.currentRunId}
              onClick={() => void mutate('/messages/' + message.id + '/retry', 'POST', undefined, '已重新排队。请重新准备执行申请。')}>重试准备</button>}
          </div>
        </details>)}
        {events && <>
          <h3>执行事件 · {events.run.status}</h3>
          <ol>{events.events.map(({ seq, event }) => <li key={seq}>{event.kind}
            {event.itemType && ' · ' + event.itemType}{event.toolDiagnostic && ' · ' + event.toolDiagnostic}</li>)}</ol>
        </>}
      </div>}
    </section>
  </div>;
}
