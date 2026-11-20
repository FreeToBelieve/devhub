import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { operatorSessionSchema } from '@devhub/contracts';
import type { Project } from '@devhub/contracts';
import { mcpDashboardSchema, mcpGroups, mcpIssueSchema, mcpTools } from '@devhub/mcp-contracts';
import type { McpGroup } from '@devhub/mcp-contracts';
import { request } from './api.js';

type Status = ReturnType<typeof mcpDashboardSchema.parse>;
const titles: Record<McpGroup, string> = { projects: '项目与规范', tasks: '开发任务', codex: 'Codex 执行',
  unity: 'Unity 报告与媒体', git: 'Git 交付' };

export function McpIntegration({ projects, projectId }: { projects: Project[]; projectId: string }) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [proof, setProof] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => projects.some((project) =>
    project.id === projectId && project.repositoryRoot && project.status === 'ACTIVE') ? [projectId] : []);
  const [groups, setGroups] = useState<McpGroup[]>([...mcpGroups]);
  const [label, setLabel] = useState('ChatGPT');
  const [hours, setHours] = useState(24);
  const [permanent, setPermanent] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void request('/api/mcp/status', mcpDashboardSchema, { signal: controller.signal }).then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      }).catch(() => {
        if (!controller.signal.aborted) setStatus(undefined);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [attempt]);

  async function mutate(path: string, method: 'POST' | 'DELETE', payload?: unknown) {
    setBusy(true);
    setProof(undefined);
    setError(undefined);
    setMessage(undefined);
    try {
      const { csrfToken } = await request('/api/operator/session', operatorSessionSchema);
      const options: RequestInit = { method, headers: { 'X-CSRF-Token': csrfToken } };
      if (payload) {
        options.headers = { ...options.headers, 'Content-Type': 'application/json' };
        options.body = JSON.stringify(payload);
      }
      if (method === 'DELETE') {
        const response = await fetch(path, options);
        if (!response.ok) throw new Error('无法撤销配对。');
        setMessage('配对已撤销。');
      } else {
        const value = await request(path, mcpIssueSchema, options);
        setProof(value.credential);
      }
      setAttempt((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法更新配对。'); }
    finally { setBusy(false); }
  }

  function issue(event: FormEvent) {
    event.preventDefault();
    void mutate('/api/mcp/pairings', 'POST', { label, projectIds: selected, groups, hours: permanent ? null : hours });
  }

  function copy(value: string, note: string) {
    void navigator.clipboard.writeText(value).then(() => setMessage(note)).catch(() => setError('复制失败。'));
  }

  if (!status) return <p className="panel empty"><a href="#authorization">登录授权中心后管理 MCP 连接</a></p>;
  const now = Date.now();
  const active = status.pairings.filter(({ revokedAt, expiresAt, lastSeenAt }) =>
    revokedAt === null && (expiresAt === null || expiresAt > now) && lastSeenAt !== null && now - lastSeenAt < 45_000);
  const names = new Map(projects.map(({ id, name }) => [id, name]));
  return <>
    <section className="panel">
      <div className="panel-heading"><h2>本机 Bridge</h2>
        <button className="button" onClick={() => setAttempt((value) => value + 1)}>刷新</button></div>
      <p>{active.length > 0 ? `最近有 ${active.length} 个配对连接在线` : '未收到配对连接心跳'}。协议 {active.map(({ protocolVersion }) => protocolVersion).find(Boolean) ?? '待初始化'}。提供 {status.tools.length} 个只读工具。</p>
      <p>Tunnel 就绪状态由本机 <code>tunnel-client doctor</code> 检查。<code>pnpm mcp doctor</code> 查看安装状态及可用连接。</p>
      <button className="button" onClick={() => copy(JSON.stringify({
        transport: 'stdio', command: 'node', args: ['apps/mcp-server/dist/main.js', 'start', 'stdio'],
      }, null, 2), '已复制配置。将脚本改为本机绝对路径。')}>复制 stdio 配置</button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    <section className="panel">
      <h2>新建配对</h2>
      <form className="form" onSubmit={issue}>
        <label>连接名称 <input required maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
        <label><input type="checkbox" checked={permanent} onChange={(event) => setPermanent(event.target.checked)} /> 永久有效，直到轮换或撤销</label>
        <label>有效期（小时） <input type="number" required={!permanent} disabled={permanent} min={1} max={720} value={hours}
          onChange={(event) => setHours(Number(event.target.value))} /></label>
        <fieldset><legend>允许访问的项目</legend>
          {projects.filter(({ repositoryRoot, status }) => repositoryRoot && status === 'ACTIVE').map(({ id, name }) =>
            <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={(event) => setSelected(event.target.checked
              ? [...selected, id] : selected.filter((value) => value !== id))} /> {name}{' '}</label>)}
        </fieldset>
        <fieldset><legend>只读工具权限</legend>
          {mcpGroups.map((group) => <label key={group}><input type="checkbox" checked={groups.includes(group)}
            onChange={(event) => setGroups(event.target.checked ? [...groups, group] : groups.filter((value) => value !== group))} />
          {' '}{titles[group]}{' '}</label>)}
        </fieldset>
        <button className="button primary" disabled={busy || !groups.length || !selected.length}>生成配对凭据</button>
      </form>
      {proof && <div className="notice" role="status">
        <p>凭据只在本次操作后显示。请将它输入本机 Bridge 的启动环境。</p>
        <button className="button" onClick={() => copy(proof, '已复制配对凭据。')}>复制凭据</button>{' '}
        <button className="button" onClick={() => setProof(undefined)}>关闭</button>
      </div>}
    </section>
    <section className="panel">
      <h2>已配对连接</h2>
      {status.pairings.length === 0 && <p>暂无连接。</p>}
      {status.pairings.map((pairing) => {
        const expired = pairing.expiresAt !== null && pairing.expiresAt <= now;
        return <article key={pairing.id}>
          <h3>{pairing.label}</h3>
          <p>{pairing.revokedAt !== null ? '已撤销' : expired ? '已过期' : active.includes(pairing) ? '最近在线' : '等待连接'} ·
            {' '}{pairing.transport ?? '待选择传输'} · {pairing.expiresAt === null ? '永久有效' : new Date(pairing.expiresAt).toLocaleString() + ' 到期'}</p>
          {pairing.tunnel && <p>Tunnel <code>{pairing.tunnel.id}</code> · {active.includes(pairing) ? pairing.tunnel.status : '状态未确认'}</p>}
          <p>{pairing.projectIds.map((id) => names.get(id) ?? id).join('、')} · {pairing.groups.map((group) => titles[group]).join('、')}</p>
          <button className="button" disabled={busy || expired || pairing.revokedAt !== null}
            onClick={() => void mutate(`/api/mcp/pairings/${pairing.id}/rotate`, 'POST', { hours: pairing.expiresAt === null ? null : hours })}>轮换</button>{' '}
          <button className="button" disabled={busy || pairing.revokedAt !== null}
            onClick={() => void mutate(`/api/mcp/pairings/${pairing.id}`, 'DELETE')}>撤销</button>
        </article>;
      })}
    </section>
    <section className="panel">
      <h2>最近调用</h2>
      {status.audit.length === 0 && <p>暂无调用。</p>}
      <ul>{status.audit.slice(0, 20).map((item, index) => <li key={`${item.createdAt}-${index}`}>
        {new Date(item.createdAt).toLocaleString()} · {names.get(item.projectId ?? '') ?? '连接范围'} · <code>{item.tool}</code> · {item.result}
      </li>)}</ul>
      <details><summary>工具目录</summary>
        <ul>{status.tools.map((tool) => <li key={tool}><code>{tool}</code> · {titles[mcpTools[tool].group]}</li>)}</ul>
      </details>
    </section>
  </>;
}
