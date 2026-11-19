import { useEffect, useState } from 'react';
import type { Task } from '@devhub/contracts';
import { listTasks } from './api.js';
import { Environment } from './Environment.js';
import { NewTask, TaskList } from './Tasks.js';

const titles = {
  overview: '项目总览',
  tasks: '任务列表',
  'new-task': '新建任务',
  codex: 'Codex 执行',
  unity: 'Unity 测试',
  gitlab: 'GitLab MR',
  settings: '系统设置',
};
type Page = keyof typeof titles;
const navGroups: { label: string; pages: Page[] }[] = [
  { label: '工作区', pages: ['overview', 'tasks'] },
  { label: '执行记录', pages: ['codex', 'unity', 'gitlab'] },
  { label: '本机', pages: ['settings'] },
];

function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(titles, hash) ? hash as Page : 'overview';
}

type TaskState =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; tasks: Task[] };

function TaskResults({ state, recent = false }: { state: TaskState; recent?: boolean }) {
  if (state.status === 'ready') return <TaskList tasks={recent ? state.tasks.slice(0, 5) : state.tasks} />;
  if (state.status === 'loading') return <p className="empty" role="status">正在读取任务…</p>;
  return <p className="alert inset" role="alert">无法读取任务，请确认本机 Hub 正在运行后刷新。</p>;
}

export function App() {
  const [page, setPage] = useState(currentPage);
  const [data, setData] = useState<TaskState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [created, setCreated] = useState(false);

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
    listTasks(controller.signal).then(({ tasks }) => {
      if (!controller.signal.aborted) setData({ status: 'ready', tasks });
    }).catch(() => {
      if (!controller.signal.aborted) setData({ status: 'error' });
    });
    return () => controller.abort();
  }, [attempt]);

  function refresh() {
    setData({ status: 'loading' });
    setAttempt((previous) => previous + 1);
  }

  function onCreated(task: Task) {
    setData((previous) => ({
      status: 'ready',
      tasks: previous.status === 'ready'
        ? [task, ...previous.tasks.filter((item) => item.id !== task.id)]
        : [task],
    }));
    setCreated(true);
    setAttempt((previous) => previous + 1);
    window.location.hash = 'tasks';
  }

  const connected = data.status === 'ready';
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="ShanHe DevHub 项目总览">
        <span className="monogram" aria-hidden="true">山</span>
        <span><strong>ShanHe DevHub</strong><small>山河问仙</small></span>
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
        <span>山河问仙 <span className="separator">/</span> 开发工作台</span>
        <span className={`connection ${data.status}`} role="status">
          {connected ? 'Hub 已连接' : data.status === 'error' ? 'Hub 连接异常' : '正在连接 Hub'}
        </span>
      </div>
      <div className="content">
        <header className="page-heading">
          <h1>{titles[page]}</h1>
          {(page === 'overview' || page === 'tasks') && (
            <a className="button primary" href="#new-task" onClick={() => setCreated(false)}>
              <span aria-hidden="true">＋</span> 新建任务
            </a>
          )}
        </header>

        {page === 'overview' && <>
          <div className="overview">
            <section className="panel summary-card" aria-labelledby="task-count">
              <h2 id="task-count">本地任务</h2>
              <strong className="metric">{connected ? data.tasks.length : '—'}</strong>
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
            <TaskResults state={data} recent />
          </section>
        </>}

        {page === 'tasks' && <>
          {created && <p className="notice" role="status">任务已保存。</p>}
          <section className="panel" aria-labelledby="all-tasks">
            <div className="panel-heading">
              <h2 id="all-tasks">全部任务 <span className="muted">{connected && data.tasks.length}</span></h2>
              <button className="button" onClick={refresh} disabled={data.status === 'loading'}>刷新</button>
            </div>
            <TaskResults state={data} />
          </section>
        </>}
        {page === 'new-task' && <NewTask onCreated={onCreated} />}
        {page === 'settings' && <Environment />}
        {page === 'codex' && <p className="panel empty">接入 Codex SDK 后，这里会显示会话和执行事件。</p>}
        {page === 'unity' && <p className="panel empty">接入 Unity 测试后，这里会显示报告和日志。</p>}
        {page === 'gitlab' && <p className="panel empty">接入 GitLab 后，这里会显示合并请求。</p>}
      </div>
    </main>
  </div>;
}
