import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  CodexRun, GitBranch, GitCandidateBlob, GitCandidatePreview, GitChange, GitCheck, GitConnection, GitDiffFile, GitOperation,
  GitReview, Project, RunnerRecord, Task, WorktreeRecord,
} from '@devhub/contracts';
import { gitCandidateStaleCodes, operatorSessionSchema } from '@devhub/contracts';
import { scopedRequest } from './api.js';

interface Catalog {
  connections: GitConnection[];
  tasks: Task[];
  worktrees: WorktreeRecord[];
  runners: RunnerRecord[];
}

interface Operations {
  changes: GitChange[];
  operations: GitOperation[];
  audit: { id: number; kind: string; reason: string | null; createdAt: number }[];
  credentialCleanup: { attempts: number; lastErrorCode: string | null; nextAttemptAt: number }[];
}

interface Details { change: GitChange; diff: GitDiffFile[]; reviews: GitReview[]; checks: GitCheck[] }

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel">
    <div className="panel-heading"><h2>{title}</h2></div>
    <div className="form">{children}</div>
  </section>;
}

function formValue(data: FormData, name: string) { return String(data.get(name) ?? ''); }

const changeLabels = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名', 'type-changed': '类型变化' };
const previewWarnings: Record<string, string> = {
  GIT_BINARY_METADATA_ONLY: '二进制内容以元数据展示。',
  GIT_TEXT_ENCODING_UNSUPPORTED: '内容无法按 UTF-8 解码，显示原始字节摘要。',
  GIT_TEXT_PREVIEW_LIMIT: '文件超过文本展示上限。已计算完整文件 SHA-256。',
  GIT_PATCH_TRUNCATED: '差异达到展示上限，剩余文本未显示。',
  GIT_LFS_POINTER_ONLY: '这里只审查 Git LFS 指针。资源内容由 LFS 独立保存。',
  GIT_LFS_POINTER_REQUIRED: '该路径由 Git LFS 管理，需先生成合法指针。',
  GIT_SUBMODULE_POINTER_ONLY: '这里记录的是子模块提交引用。该变更需要单独交付。',
  GIT_SYMLINK_UNSUPPORTED: '链接目标未展开，该变更需要单独处理。',
  GIT_HISTORICAL_SECRET_HIDDEN: '历史文件触发秘密检测，差异已隐藏。',
};

function CandidateBlob({ label, blob }: { label: string; blob: GitCandidateBlob }) {
  return <div className="git-blob">
    <strong>{label}</strong> <span>{blob.mediaType}{blob.size !== null && ' · ' + blob.size.toLocaleString() + ' B'}</span>
    {blob.sha256 && <div>SHA-256 <code>{blob.sha256}</code></div>}
    {blob.lfs && <div>LFS 资源大小 {blob.lfs.size.toLocaleString()} B · SHA-256 <code>{blob.lfs.sha256}</code></div>}
    {blob.kind === 'submodule' && <div>Gitlink <code>{blob.objectSha}</code></div>}
  </div>;
}

function CandidatePreview({ candidate }: { candidate: GitCandidatePreview }) {
  return <section className="git-candidate" aria-label="候选提交预览">
    <dl className="git-candidate-ids">
      <dt>Candidate Tree</dt><dd><code>{candidate.candidateTreeSha}</code></dd>
      <dt>Base HEAD</dt><dd><code>{candidate.baseHeadSha}</code></dd>
      <dt>Worktree SHA-256</dt><dd><code>{candidate.workspaceSha256}</code></dd>
      <dt>Diff SHA-256</dt><dd><code>{candidate.candidateDiffDigest}</code></dd>
    </dl>
    <p>{Object.entries(candidate.candidateFileSummary).filter(([, count]) => count > 0)
      .map(([status, count]) => changeLabels[status as keyof typeof changeLabels] + ' ' + count).join(' · ')}</p>
    {!candidate.canCommit && <p className="alert inset">此候选需要处理下列警告后重新预览。</p>}
    {candidate.changedFiles.map((file) => <details key={file.path} open>
      <summary><span className={'git-status git-status-' + file.status}>{changeLabels[file.status]}</span>
        {file.previousPath && <><code>{file.previousPath}</code> → </>}<code>{file.path}</code>
      </summary>
      {file.warnings.length > 0 && <ul>{file.warnings.map((warning) => <li key={warning}>{previewWarnings[warning] ?? warning}</li>)}</ul>}
      {file.patch && <pre className="git-output git-patch">{file.patch.split('\n').map((line, index) =>
        <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'git-added' :
          line.startsWith('-') && !line.startsWith('---') ? 'git-removed' : undefined}>{line + '\n'}</span>)}</pre>}
      {file.before && (file.before.kind !== 'text' || !file.patch) && <CandidateBlob label="原版本" blob={file.before} />}
      {file.after && (file.after.kind !== 'text' || !file.patch) && <CandidateBlob label="候选版本" blob={file.after} />}
    </details>)}
  </section>;
}

export function GitManagement({ project }: { project: Project }) {
  const selected = project.id;
  const request = scopedRequest(selected);
  const read = <T,>(path: string, options?: RequestInit) => request(path, { parse: (value) => value as T }, options);
  const [csrf, setCsrf] = useState('');
  const [catalog, setCatalog] = useState<Catalog>();
  const [operations, setOperations] = useState<Operations>();
  const [branches, setBranches] = useState<GitBranch[]>();
  const [details, setDetails] = useState<Details>();
  const [runs, setRuns] = useState<CodexRun[]>([]);
  const commentIntent = useRef<{ number: number; body: string; key: string } | undefined>(undefined);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [renew, setRenew] = useState(false);
  const connection = catalog?.connections.find((item) => item.projectId === selected);
  const query = '?projectId=' + encodeURIComponent(selected);

  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const { csrfToken } = await request('/api/operator/session', operatorSessionSchema, { signal: abort.signal });
        const data = await read<Catalog>('/api/git/connections', { signal: abort.signal });
        setCsrf(csrfToken);
        setCatalog(data);
      } catch {
        if (!abort.signal.aborted) setError('请先在授权中心登录。');
      } finally {
        if (!abort.signal.aborted) setReady(true);
      }
    }
    void load();
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void read<Operations>('/api/git/operations' + query, { signal: abort.signal }).then((data) => {
      if (!abort.signal.aborted) setOperations(data);
    }).catch(() => { if (!abort.signal.aborted) setError('无法读取交付记录。'); });
    return () => abort.abort();
  }, [selected, query]);

  function write<T>(path: string, body: object, method = 'POST') {
    return read<T>(path, { method, headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID(),
    }, body: JSON.stringify(body) });
  }
  async function action(run: () => Promise<unknown>, message: string) {
    setError('');
    setStatus('');
    setBusy(true);
    try { await run(); setStatus(message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, run: (data: FormData) => Promise<unknown>, message: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = form.elements.namedItem('token');
    if (password instanceof HTMLInputElement) password.value = '';
    void action(() => run(data), message);
  }
  async function refreshCatalog() {
    setCatalog(await read<Catalog>('/api/git/connections'));
  }
  async function refreshRecords() {
    setOperations(await read<Operations>('/api/git/operations' + query));
  }
  async function openChange(number: number) {
    const inspected = await read<Details>('/api/git/changes/' + number + query);
    setDetails(inspected);
    const result = await read<{ runs: CodexRun[] }>('/api/codex-runs');
    setRuns(result.runs);
  }
  if (!ready) return <p className="panel empty" role="status">正在读取 Git 管理…</p>;
  if (!csrf || !catalog) return <p className="panel empty"><a href="#authorization">{error}</a></p>;

  const change = details?.change;
  const delivery = operations?.operations.find((op) => op.changeNumber === change?.number && op.phase === 'DELIVERED');

  return <div aria-busy={busy}>
    {status && <p className="notice" role="status">{status}</p>}
    {error && <p className="alert inset" role="alert">{error}</p>}
    <Panel title="仓库连接">
      {connection && <p>{connection.account} · 默认分支 {connection.defaultBranch} · {connection.connected ? '凭据已登记' : '凭据已撤销'}</p>}
      {connection?.connected && <div className="actions">
        <button className="button" disabled={busy} onClick={() => setRenew(!renew)}>重新授权</button>
        <button className="button" disabled={busy} onClick={() => void action(async () => {
          if (!window.confirm('撤销此项目在本机的 Git 凭据？')) return;
          await write('/api/git/connections/revoke', { projectId: selected, expectedVersion: connection.version });
          await refreshCatalog();
        }, '连接状态已刷新。')}>撤销凭据</button>
      </div>}
      {project.repositoryRoot && project.status === 'ACTIVE' && (!connection?.connected || renew) && <form className="form" key={connection?.projectId ?? 'new'} onSubmit={(event) => submit(event, async (data) => {
        const apiBaseUrl = formValue(data, 'api');
        await write<GitConnection>('/api/git/connections', {
          projectId: selected, expectedVersion: connection?.version ?? 0,
          provider: connection?.provider ?? formValue(data, 'provider'),
          repositoryUrl: connection?.repositoryUrl ?? formValue(data, 'repository'),
          apiBaseUrl: connection?.apiBaseUrl || apiBaseUrl || undefined, token: formValue(data, 'token'),
        }, 'PUT');
        await refreshCatalog();
        setRenew(false);
      }, '仓库连接已验证。')}>
        {!connection && <>
          <label>Provider<select name="provider"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
          <label>仓库 HTTPS URL<input name="repository" type="url" required /></label>
          <label>自定义 API Base URL<input name="api" type="url" /></label>
        </>}
        <label>访问令牌<input name="token" type="password" autoComplete="off" spellCheck={false} required /></label>
        <button className="button primary" disabled={busy}>验证并保存到系统凭据库</button>
      </form>}
    </Panel>
    {connection?.connected && <>
      <Panel title="分支和工作树">
        <button className="button" disabled={busy} onClick={() => void action(async () => {
          const result = await read<{ branches: GitBranch[] }>('/api/git/branches' + query);
          setBranches(result.branches);
        }, '远端分支已刷新。')}>刷新远端分支</button>
        {branches?.length ? <ul>{branches.map((branch) => <li key={branch.name}>
          {branch.name} · <code>{branch.sha.slice(0, 12)}</code>{branch.protected && ' · 受保护'}</li>)}</ul> : null}
        <form className="form" onSubmit={(event) => submit(event, async (data) => {
          await write('/api/git/worktrees', { projectId: selected, repositoryRoot: formValue(data, 'root'), branch: formValue(data, 'branch') });
          await refreshCatalog();
        }, '开发分支与受管工作树已创建。')}>
          <label>已登记的本地仓库<input name="root" defaultValue={project.repositoryRoot ?? ''} readOnly required /></label>
          <label>开发分支<input name="branch" placeholder="devhub/feature-name" required /></label>
          <button className="button" disabled={busy}>创建开发分支和工作树</button>
        </form>
      </Panel>
      <Panel title="交付预览">
        <form className="form" onSubmit={(event) => submit(event, async (data) => {
          await write('/api/git/operations', {
            projectId: selected, operationId: crypto.randomUUID(), worktreeId: formValue(data, 'worktree'),
            taskId: formValue(data, 'task'), branch: formValue(data, 'branch'), title: formValue(data, 'title'),
            description: formValue(data, 'description'), author: { name: formValue(data, 'author'), email: formValue(data, 'email') },
          });
          await refreshRecords();
        }, '请审查本次交付变更。')}>
          <label>任务<select name="task" required><option value="">选择任务</option>
            {catalog.tasks.map((task) => <option value={task.id} key={task.id}>{task.title}</option>)}</select></label>
          <label>受管工作树<select name="worktree" required><option value="">选择工作树</option>
            {catalog.worktrees.map((tree) => <option value={tree.worktreeId} key={tree.worktreeId}>{tree.root}</option>)}</select></label>
          <label>开发分支<input name="branch" placeholder="devhub/feature-name" required /></label>
          <label>Git 作者<input name="author" defaultValue={project.settings.gitAuthor?.name ?? ''} required /></label>
          <label>Git 作者邮箱<input name="email" type="email" defaultValue={project.settings.gitAuthor?.email ?? ''} required /></label>
          <label>Commit 和 PR/MR 标题<input name="title" required /></label>
          <label>PR/MR 说明<textarea name="description" /></label>
          <button className="button" disabled={busy}>检查变更并生成预览</button>
        </form>
      </Panel>
    </>}
    {connection && <Panel title="交付记录">
      <button className="button" disabled={busy} onClick={() => void action(refreshRecords, '交付记录已刷新。')}>刷新记录</button>
      {operations?.credentialCleanup.length ? <p role="status">系统凭据待清理 {operations.credentialCleanup.length} 项。
        {operations.credentialCleanup.some(({ lastErrorCode }) => lastErrorCode) && ' 上次删除失败，Hub 将自动重试。'}</p> : null}
      {operations?.operations.map((op) => {
        const needsPreview = !!op.errorCode && gitCandidateStaleCodes.includes(op.errorCode);
        return <div key={op.id} className="git-record">
        <strong>{op.binding.title}</strong>
        <p>{op.binding.branch} → {op.binding.targetBranch} · {op.phase} · <code>{(op.commitSha ?? op.binding.head).slice(0, 12)}</code></p>
        <p>变更摘要 <code>{op.digest.slice(0, 12)}</code>{op.errorCode && ' · ' + op.errorCode}</p>
        {needsPreview && <p className="alert inset">此审批已失效。请重新生成变更预览，再批准新的候选 Tree。</p>}
        <details open={op.phase === 'PREVIEW'}><summary>变更文件 ({op.summary.changes.length})</summary>
          {op.summary.candidate ? <CandidatePreview candidate={op.summary.candidate} /> :
            <><p>历史预览。交付需要重新生成候选 Tree。</p>
              <pre className="git-output">{[...op.summary.changes, '', op.summary.diff].join('\n')}</pre></>}
        </details>
        {connection.connected && op.phase !== 'DELIVERED' && !needsPreview && op.summary.candidate?.canCommit && <div className="actions">
          <button className="button" disabled={busy} onClick={() => void action(async () => {
            await write('/api/git/operations/' + op.id + '/approve', { expectedVersion: op.version, digest: op.digest });
            await refreshRecords();
          }, '交付已批准，授权有效期两分钟。')}>批准当前摘要</button>
          {op.phase !== 'PREVIEW' && <button className="button primary" disabled={busy} onClick={() => void action(async () => {
            try { await write('/api/git/operations/' + op.id + '/execute', { expectedVersion: op.version, digest: op.digest }); }
            finally { await refreshRecords(); }
          }, '提交、推送和 PR/MR 已确认。')}>执行已批准交付</button>}
        </div>}
      </div>;
      })}
      {operations?.audit.length ? <details><summary>审计记录</summary><ul>{operations.audit.map((event) => <li key={event.id}>
        {new Date(event.createdAt).toLocaleString()} · {event.kind}{event.reason && ' · ' + event.reason}</li>)}</ul></details> : null}
    </Panel>}
    {connection && <Panel title="PR / MR">
      {operations?.changes.map((item) => <div className="git-record" key={item.number}>
        <a href={item.url} target="_blank" rel="noreferrer">#{item.number} {item.title}</a> · {item.state}
        {connection.connected && <button className="button" disabled={busy} onClick={() =>
          void action(() => openChange(item.number), '差异、检查和 Review 已刷新。')}>读取详情</button>}
      </div>)}
      {details && change && connection.connected && <div className="form" key={change.number}>
        <h3>#{change.number} {change.title}</h3>
        <details><summary>文件差异 ({details.diff.length})</summary>{details.diff.map((file) => <div key={file.path}>
          <p>{file.status} · {file.path}</p>{file.patch && <pre className="git-output">{file.patch}</pre>}
        </div>)}</details>
        <details open><summary>CI 检查 ({details.checks.length})</summary>
          <ul>{details.checks.map((check, index) => <li key={index}>{check.name} · {check.conclusion ?? check.status}</li>)}</ul>
        </details>
        <details><summary>Review 评论 ({details.reviews.length})</summary>{details.reviews.map((note) => <div className="git-record" key={note.id}>
          <strong>{note.author}{note.path && ' · ' + note.path}</strong><pre className="git-output">{note.body}</pre>
        </div>)}</details>
        {change.state === 'open' && <>
          <form className="form" onSubmit={(event) => submit(event, async (data) => {
            await write('/api/git/changes/' + change.number + query, {
              action: 'update', title: formValue(data, 'title'), description: formValue(data, 'description'),
            });
            await Promise.all([openChange(change.number), refreshRecords()]);
          }, '标题和说明已更新。')}>
            <label>标题<input name="title" defaultValue={change.title} required /></label>
            <label>说明<textarea name="description" defaultValue={change.description} /></label>
            <button className="button" disabled={busy}>更新 PR/MR</button>
          </form>
          <form className="form" onSubmit={(event) => submit(event, async (data) => {
            const body = formValue(data, 'comment');
            if (commentIntent.current?.number !== change.number || commentIntent.current.body !== body) {
              commentIntent.current = { number: change.number, body, key: crypto.randomUUID() };
            }
            await write('/api/git/changes/' + change.number + query, { action: 'comment', key: commentIntent.current.key, body });
            commentIntent.current = undefined;
            await openChange(change.number);
          }, '评论已确认。')}>
            <label>评论<textarea name="comment" maxLength={4500} required /></label>
            <button className="button" disabled={busy}>发布评论</button>
          </form>
          <button className="button" disabled={busy} onClick={() => {
            if (!window.confirm('关闭此 PR/MR？')) return;
            void action(async () => {
              await write('/api/git/changes/' + change.number + query, { action: 'close' });
              await Promise.all([openChange(change.number), refreshRecords()]);
            }, 'PR/MR 已关闭。');
          }}>关闭 PR/MR</button>
          {delivery && <form className="form" onSubmit={(event) => submit(event, (data) =>
            write('/api/git/changes/' + change.number + '/follow-up' + query, {
              operationId: delivery.id, runId: formValue(data, 'runId'), runnerId: formValue(data, 'runnerId'),
              instructions: formValue(data, 'instructions'),
            }), '续跑申请已创建。请保留同一份提示词，并在授权中心审批后运行。')}>
            <label>已完成的 Codex 执行<select name="runId" required><option value="">选择执行</option>
              {runs.filter((run) => run.worktreeId === delivery.binding.worktreeId && run.status === 'COMPLETED')
                .map((run) => <option value={run.devhubRunId} key={run.devhubRunId}>{run.devhubRunId}</option>)}</select></label>
            <label>Runner<select name="runnerId" required><option value="">选择 Runner</option>
              {catalog.runners.map((runner) => <option value={runner.id} key={runner.id}>{runner.label}</option>)}</select></label>
            <label>已审阅的后续修改指令<textarea name="instructions" required maxLength={6000} /></label>
            <button className="button" disabled={busy}>创建 Codex 续跑申请</button>
            <a href="#authorization">打开授权中心</a>
          </form>}
        </>}
      </div>}
    </Panel>}
  </div>;
}
