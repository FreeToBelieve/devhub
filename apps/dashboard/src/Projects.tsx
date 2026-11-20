import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import { z } from 'zod';
import { codexRunSchema, legacyProjectId, operatorSessionSchema, projectDocumentSchema, projectInputSchema,
  projectSchema, taskSchema, unityEnvironmentSchema, unityRunSchema } from '@devhub/contracts';
import type { Project, ProjectInput } from '@devhub/contracts';
import { request, scopedRequest } from './api.js';
import { TaskList } from './Tasks.js';

export const projectsSchema = z.object({ projects: z.array(projectSchema.extend({
  provider: z.enum(['github', 'gitlab']).nullable(), repositoryUrl: z.string().nullable(), defaultBranch: z.string().nullable(),
})) });
const detailsSchema = z.object({
  project: projectSchema, environment: unityEnvironmentSchema.nullable(), remote: z.string().nullable(),
  connection: z.object({ provider: z.enum(['github', 'gitlab']), repositoryUrl: z.string(), defaultBranch: z.string(),
    connected: z.boolean() }).nullable(),
  tasks: z.array(taskSchema), unityRuns: z.array(unityRunSchema), codexRuns: z.array(codexRunSchema),
  migrationReport: z.array(z.object({ entityType: z.string(), entityId: z.string(), reason: z.string(), candidates: z.array(z.string()) })),
});
const kinds = { AGENTS: 'AGENTS.md', TECHNICAL: '技术设计', ART: '美术风格', VFX: '技能特效', UI: 'UI',
  NAMING: '资源命名', ARCHITECTURE: '架构约束' };

function ProjectForm({ initial, busy, save }: { initial?: Project | undefined; busy: boolean; save(value: ProjectInput): void }) {
  const [documents, setDocuments] = useState(initial?.settings.documents ?? []);
  const [invalid, setInvalid] = useState(false);
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('authorName') ?? '').trim();
    const email = String(form.get('authorEmail') ?? '').trim();
    const outcome = projectInputSchema.safeParse({
      name: form.get('name'), repositoryRoot: form.get('repositoryRoot'), unityProjectPath: form.get('unityProjectPath'),
      targetPlatform: form.get('targetPlatform'), settings: { description: form.get('description'), gameType: form.get('gameType'),
        documents, ...(name || email ? { gitAuthor: { name, email } } : {}) },
    });
    setInvalid(!outcome.success);
    if (outcome.success) save(outcome.data);
  }

  return <form className="task-form project-form" onSubmit={submit}>
    <label>项目名称<input name="name" defaultValue={initial?.name} required maxLength={120} /></label>
    <label>本地 Git 仓库根目录<input name="repositoryRoot" defaultValue={initial?.repositoryRoot ?? ''} required /></label>
    <label>Unity 工程相对路径<input name="unityProjectPath" defaultValue={initial?.unityProjectPath ?? '.'} required /></label>
    <label>游戏类型<input name="gameType" defaultValue={initial?.settings.gameType ?? ''} maxLength={80} /></label>
    <label className="project-wide">项目说明<textarea name="description" rows={3} defaultValue={initial?.settings.description ?? ''} maxLength={4000} /></label>
    <label>目标平台<select name="targetPlatform" defaultValue={initial?.targetPlatform ?? 'BOTH'}>
      <option value="BOTH">Windows + macOS</option><option value="MACOS">macOS</option><option value="WINDOWS">Windows</option>
    </select></label>
    <label>Git 作者<input name="authorName" defaultValue={initial?.settings.gitAuthor?.name} maxLength={100} /></label>
    <label>Git 作者邮箱<input name="authorEmail" type="email" defaultValue={initial?.settings.gitAuthor?.email} /></label>
    <fieldset className="project-documents">
      <legend>项目规范</legend>
      {documents.map(({ kind, path }, index) => <div className="project-document" key={index}>
        <label>类型<select value={kind} onChange={(event) => {
          const value = projectDocumentSchema.shape.kind.parse(event.target.value);
          setDocuments((current) => current.map((entry, row) => row === index ? { ...entry, kind: value } : entry));
        }}>{Object.entries(kinds).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
        <label>工程内 Markdown 路径<input value={path} required onChange={(event) => {
          const value = event.target.value;
          setDocuments((current) => current.map((entry, row) => row === index ? { ...entry, path: value } : entry));
        }} /></label>
        <button type="button" className="button" onClick={() => setDocuments((current) => current.filter((_, row) => row !== index))}>移除</button>
      </div>)}
      <button type="button" className="button" disabled={documents.length >= 24}
        onClick={() => setDocuments((current) => [...current, { kind: 'TECHNICAL', path: '' }])}>登记规范文件</button>
    </fieldset>
    {invalid && <p className="alert" role="alert">请检查项目路径、Markdown 相对路径和 Git 作者信息。</p>}
    <button className="button primary" disabled={busy}>{initial ? '保存并重新检测' : '注册项目'}</button>
  </form>;
}

export function Projects({ project, onRefresh, signedIn }: { project: Project | undefined; signedIn: boolean;
  onRefresh(preferred?: string): void }) {
  const [details, setDetails] = useState<z.infer<typeof detailsSchema>>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(!project || project.id === legacyProjectId);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    void scopedRequest(project.id)('/api/projects/' + project.id, detailsSchema, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setDetails(value); })
      .catch((error) => { if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : '读取项目失败。'); });
    return () => controller.abort();
  }, [project, version]);

  async function mutate<T>(path: string, method: 'POST' | 'PUT', body: object, schema: { parse(data: unknown): T },
    selectExisting = true): Promise<T> {
    const { csrfToken } = await request('/api/operator/session', operatorSessionSchema);
    const send = selectExisting && project ? scopedRequest(project.id) : request;
    return send(path, schema, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body) });
  }

  async function action(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    setIssue('');
    setNotice('');
    try { await run(); setNotice(done); }
    catch (failure) { setIssue(failure instanceof Error ? failure.message : '无法保存项目。'); }
    finally { setBusy(false); }
  }

  if (!signedIn) return <p className="panel empty"><a href="#authorization">在授权中心登录后管理项目</a></p>;
  return <div className="project-registry">
    {notice && <p className="notice" role="status">{notice}</p>}
    {issue && <p className="alert inset" role="alert">{issue}</p>}
    {details && <section className="panel">
      <div className="panel-heading"><h2>{details.project.name}</h2>
        <button className="button" onClick={() => setAdding(!adding)}>{adding ? '关闭注册表单' : '添加项目'}</button>
      </div>
      <dl className="unity-environment">
        <dt>状态</dt><dd>{details.project.status === 'ACTIVE' ? '使用中' : '已归档'}</dd>
        <dt>游戏类型</dt><dd>{details.project.settings.gameType || '未登记'}</dd>
        <dt>Unity 版本</dt><dd>{details.project.unityVersion ?? '待登记'}</dd>
        <dt>Editor</dt><dd>{details.environment?.editor ?? '未找到匹配的 Editor'}</dd>
        <dt>Build Support</dt><dd>{details.environment?.buildSupport ? '已安装' : '未检测到'}</dd>
        <dt>Git Provider</dt><dd>{details.connection?.provider ?? '未连接'}</dd>
        <dt>仓库</dt><dd>{details.connection?.repositoryUrl ?? details.remote ?? details.project.repositoryRoot ?? '未登记'}</dd>
        <dt>默认分支</dt><dd>{details.connection?.defaultBranch ?? '未检测'}</dd>
        <dt>项目 ID</dt><dd><code>{details.project.id}</code></dd>
      </dl>
      {details.environment?.diagnostics.length ? <p className="inset"><code>{details.environment.diagnostics.join(' · ')}</code></p> : null}
      {details.project.repositoryRoot && details.project.status === 'ACTIVE' && <div className="form-actions inset">
        <button className="button" disabled={busy} onClick={() => void action(
          () => mutate('/api/projects/' + details.project.id + '/worktrees', 'POST', {}, z.unknown()), '受管 Worktree 已创建。')}>创建独立 Worktree</button>
        <a href="#gitlab" className="button">Git 管理</a>
      </div>}
    </section>}
    {adding && <section className="panel">
      <div className="panel-heading"><h2>注册 Unity 项目</h2></div>
      <ProjectForm busy={busy} save={(input) => void action(async () => {
        const created = await mutate('/api/projects', 'POST', input, z.object({ project: projectSchema }), false);
        onRefresh(created.project.id);
        setAdding(false);
      }, '项目已注册。')} />
    </section>}
    {details && <section className="panel">
      <div className="panel-heading"><h2>最近活动</h2></div>
      <TaskList tasks={details.tasks} />
      <div className="inset project-activity">
        <h3><a href="#codex">Codex 执行</a></h3>
        {!details.codexRuns.length && <p className="muted">暂无 Codex 执行</p>}
        {details.codexRuns.map((run) => <p key={run.devhubRunId}><code>{run.devhubRunId.slice(0, 8)}</code> · {run.status}</p>)}
        <h3><a href="#unity">Unity 运行</a></h3>
        {!details.unityRuns.length && <p className="muted">暂无 Unity 运行</p>}
        {details.unityRuns.map((run) => <p key={run.id}><code>{run.id.slice(0, 8)}</code> · {run.version} · {run.status}</p>)}
      </div>
    </section>}
    {details && details.project.id !== legacyProjectId && details.project.status === 'ACTIVE' && <section className="panel">
      <div className="panel-heading"><h2>项目设置</h2></div>
      <ProjectForm key={details.project.revision} initial={details.project} busy={busy} save={(input) => void action(async () => {
        await mutate('/api/projects/' + details.project.id, 'PUT', { ...input, expectedRevision: details.project.revision }, projectSchema);
        onRefresh();
        setVersion((previous) => previous + 1);
      }, '设置已保存。')} />
      <div className="form-actions inset"><button className="button" disabled={busy} onClick={() => {
        if (window.confirm('归档该项目？历史任务和执行记录将继续保留。')) void action(async () => {
          await mutate('/api/projects/' + details.project.id + '/archive', 'POST',
            { expectedRevision: details.project.revision }, projectSchema);
          onRefresh();
          setVersion((previous) => previous + 1);
        }, '项目已归档。');
      }}>归档项目</button></div>
    </section>}
    {!!details?.migrationReport.length && <section className="panel">
      <div className="panel-heading"><h2>历史迁移报告</h2></div>
      <ul className="inset">{details.migrationReport.map((row) => <li key={row.entityType + row.entityId}>
        {row.entityType} <code>{row.entityId}</code> · {row.reason === 'MULTIPLE_GIT_PROJECTS' ? '有多个候选 Git 项目' : '没有 Git 归属证据'}
        {row.candidates.length > 0 && <small> · {row.candidates.join(', ')}</small>}
      </li>)}</ul>
    </section>}
  </div>;
}
