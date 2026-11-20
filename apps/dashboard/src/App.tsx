import { useEffect, useState } from 'react';
import { legacyProjectId } from '@devhub/contracts';
import type { Project, Task } from '@devhub/contracts';
import { listTasks, request } from './api.js';
import { Environment } from './Environment.js';
import { NewTask, TaskList } from './Tasks.js';
import { Authorization } from './Authorization.js';
import { CodexRuns } from './CodexRuns.js';
import { GitManagement } from './GitManagement.js';
import { UnityRuntime } from './UnityRuntime.js';
import { TaskInbox } from './TaskInbox.js';
import { McpIntegration } from './McpIntegration.js';
import { Projects, projectsSchema } from './Projects.js';

const titles = {
  overview: '项目总览',
  projects: '项目管理',
  tasks: '任务列表',
  'new-task': '新建任务',
  codex: 'Codex 执行',
  'task-inbox': 'GitHub 任务收件箱',
  unity: 'Unity 测试',
  gitlab: 'Git 管理',
  settings: '系统设置',
  mcp: 'MCP 集成',
  authorization: '授权中心',
};
type Page = keyof typeof titles;
const navGroups: { label: string; pages: Page[] }[] = [
  { label: '工作区', pages: ['overview', 'projects', 'tasks', 'task-inbox', 'authorization'] },
  { label: '执行记录', pages: ['codex', 'unity', 'gitlab'] },
  { label: '本机', pages: ['settings', 'mcp'] },
];

function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(titles, hash) ? hash as Page : 'overview';
}

type TaskState =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; projectId: string; tasks: Task[] };

function TaskResults({ state, recent = false }: { state: TaskState; recent?: boolean }) {
  if (state.status === 'ready') return <TaskList tasks={recent ? state.tasks.slice(0, 5) : state.tasks} />;
  if (state.status === 'loading') return <p className="empty" role="status">正在读取任务…</p>;
  return <p className="empty"><a href="#authorization">登录后查看当前项目任务</a></p>;
}

export function App() {
  const [page, setPage] = useState(currentPage);
  const [data, setData] = useState<TaskState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [created, setCreated] = useState<string>();
  const [projects, setProjects] = useState<Project[]>();
  const [projectId, setProjectId] = useState(() => localStorage.getItem('devhub.project') ?? legacyProjectId);
  const [registryAttempt, setRegistryAttempt] = useState(0);
  const [preferred, setPreferred] = useState<string>();
  const project = projects?.find((entry) => entry.id === projectId);
  const canCreate = !!project?.repositoryRoot && project.status === 'ACTIVE';

  useEffect(() => {
    const navigate = () => setPage(currentPage());
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  useEffect(() => {
    document.title = `${titles[page]} · ShanHe DevHub`;
  }, [page]);

  useEffect(() => {
    const controller = new AbortController();
    void request('/api/projects', projectsSchema, { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      setProjects(data.projects);
      setProjectId((current) => (preferred ? data.projects.find((item) => item.id === preferred)?.id : undefined) ??
        data.projects.find((item) => item.id === current)?.id ?? data.projects[0]?.id ?? legacyProjectId);
    }).catch(() => { if (!controller.signal.aborted) setProjects(undefined); });
    return () => controller.abort();
  }, [registryAttempt, preferred]);

  useEffect(() => {
    localStorage.setItem('devhub.project', projectId);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setData({ status: 'loading' });
    listTasks(projectId, controller.signal).then(({ tasks }) => {
      if (!controller.signal.aborted) setData({ status: 'ready', projectId, tasks });
    }).catch(() => {
      if (!controller.signal.aborted) setData({ status: 'error' });
    });
    return () => controller.abort();
  }, [attempt, projectId, registryAttempt]);

  function reloadProjects(selected?: string) {
    setPreferred(selected);
    setRegistryAttempt((value) => value + 1);
  }

  function refresh() {
    setData({ status: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  function onCreated(task: Task) {
    setCreated(task.projectId);
    setAttempt((previous) => previous + 1);
    window.location.hash = 'tasks';
  }

  const current: TaskState = data.status === 'ready' && data.projectId !== projectId ? { status: 'loading' } : data;
  const connected = current.status === 'ready';
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="ShanHe DevHub 项目总览">
        <span className="monogram" aria-hidden="true">山</span>
        <span><strong>ShanHe DevHub</strong><small>本机游戏开发</small></span>
      </a>
      <nav aria-label="主导航">
        {navGroups.map((group) => <div className="nav-group" key={group.label}>
          <p>{group.label}</p>
          {group.pages.map((item) => <a
            href={`#${item}`}
            key={item}
            aria-current={page === item || (page === 'new-task' && item === 'tasks') ? 'page' : undefined}
          >{titles[item]}</a>)}
        </div>)}
      </nav>
      <div className="sidebar-footer">本机工作区 <span>v0.1</span></div>
    </aside>

    <main>
      <div className="topbar">
        <label className="project-picker">当前项目 <select aria-label="当前项目" value={projectId} disabled={!projects?.length}
          onChange={(event) => { setData({ status: 'loading' }); setCreated(undefined); setProjectId(event.target.value); }}>
          {!projects?.length && <option value={projectId}>请先登录</option>}
          {projects?.map((item) => <option value={item.id} key={item.id}>{item.name}{item.status === 'ARCHIVED' ? '（已归档）' : ''}</option>)}
        </select></label>
        <span className={`connection ${current.status}`} role="status">
          {connected ? '操作员已登录' : current.status === 'error' ? '请登录授权中心' : '正在读取项目'}
        </span>
      </div>
      <div className="content">
        <header className="page-heading">
          <h1>{titles[page]}</h1>
          {(page === 'overview' || page === 'tasks') && canCreate && (
            <a className="button primary" href="#new-task" onClick={() => setCreated(undefined)}>
              <span aria-hidden="true">＋</span> 新建任务
            </a>
          )}
        </header>
        {page === 'projects' && <Projects key={projectId} project={project} onRefresh={reloadProjects} signedIn={projects !== undefined} />}

        {page === 'overview' && <>
          <div className="overview">
            <section className="panel summary-card" aria-labelledby="task-count">
              <h2 id="task-count">本地任务</h2>
              <strong className="metric">{connected ? current.tasks.length : '—'}</strong>
              <a href="#tasks">查看任务列表 <span aria-hidden="true">→</span></a>
            </section>
            <section className="panel summary-card environment-card" aria-labelledby="doctor-overview">
              <h2 id="doctor-overview">运行环境</h2>
              <p>检查 Node.js、Git、Codex CLI 和 Unity Editor。</p>
              <a href="#settings">打开环境检测 <span aria-hidden="true">→</span></a>
            </section>
          </div>
          <section className="panel" aria-labelledby="recent-tasks">
            <div className="panel-heading">
              <h2 id="recent-tasks">最近任务</h2>
              <button className="button" onClick={refresh} disabled={data.status === 'loading'}>刷新</button>
            </div>
            <TaskResults state={current} recent />
          </section>
        </>}

        {page === 'tasks' && <>
          {created === projectId && <p className="notice" role="status">任务已保存。</p>}
          <section className="panel" aria-labelledby="all-tasks">
            <div className="panel-heading">
              <h2 id="all-tasks">全部任务 <span className="muted">{connected && current.tasks.length}</span></h2>
              <button className="button" onClick={refresh} disabled={data.status === 'loading'}>刷新</button>
            </div>
            <TaskResults state={current} />
          </section>
        </>}
        {page === 'new-task' && (canCreate && project ? <NewTask key={projectId} project={project} onCreated={onCreated} /> :
          <p className="panel empty"><a href="#projects">选择一个已注册且未归档的项目</a></p>)}
        {page === 'task-inbox' && <TaskInbox key={projectId} projectId={projectId} projects={projects ?? []} />}
        {page === 'settings' && <Environment />}
        {page === 'mcp' && <McpIntegration key={projectId} projectId={projectId} projects={projects ?? []} />}
        {page === 'authorization' && <Authorization key={projectId} projectId={projectId} registered={!!project?.repositoryRoot}
          onSessionChange={() => reloadProjects()} />}
        {page === 'codex' && <CodexRuns key={projectId} projectId={projectId} />}
        {page === 'unity' && <UnityRuntime key={projectId} projectId={projectId} />}
        {page === 'gitlab' && (project ? <GitManagement key={projectId} project={project} /> :
          <p className="panel empty"><a href="#projects">选择项目后管理 Git</a></p>)}
      </div>
    </main>
  </div>;
}
