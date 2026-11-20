import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  executionRequestSchema, operatorSessionSchema, unityEnvironmentSchema, unityReviewRunSchema, unityStageSchema,
  unityEvidenceContentType, unityEvidenceFiles, unityEvidenceHeader, unityEvidenceManifestLimit,
  unityEvidenceManifestSchema, unityEvidenceRunSchema,
} from '@devhub/contracts';
import type {
  CodexRun, ExecutionRequest, RunnerRecord, Task, UnityArtifact, UnityEnvironment, UnityReviewRun, UnityStage, WorktreeRecord,
} from '@devhub/contracts';
import { scopedRequest } from './api.js';

const stages: Record<UnityStage, string> = {
  EDITOR: '启动并检查 Editor', IMPORT: '导入与编译', EDITMODE: 'EditMode 测试', PLAYMODE: 'PlayMode 测试',
  BUILD: '构建 Player', PLAYER: '构建并运行 Player', GAME_VIEW: '运行并采集 Editor Game View',
  PIPELINE: '导入、测试、构建和运行',
};
const results = { RUNNING: '运行中', COMPLETED: '完成', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '退出未确认' };
const identity = <T,>() => ({ parse: (value: unknown) => value as T });
const decoded = (value: unknown) => ({ runs: (value as { runs: unknown[] }).runs.map((run) => unityReviewRunSchema.parse(run)) });
type Catalog = { tasks: Task[]; runners: RunnerRecord[]; worktrees: (WorktreeRecord & { codexManaged: boolean })[] };

export function UnityRuntime({ projectId }: { projectId: string }) {
  const request = scopedRequest(projectId);
  const [csrf, setCsrf] = useState('');
  const [catalog, setCatalog] = useState<Catalog>();
  const [worktreeId, setWorktreeId] = useState('');
  const [environment, setEnvironment] = useState<UnityEnvironment>();
  const [stage, setStage] = useState<UnityStage>('IMPORT');
  const [runs, setRuns] = useState<UnityReviewRun[]>([]);
  const [requests, setRequests] = useState<ExecutionRequest[]>([]);
  const [codex, setCodex] = useState<CodexRun[]>([]);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const needScene = ['BUILD', 'PLAYER', 'GAME_VIEW', 'PIPELINE'].includes(stage);
  const capture = stage === 'GAME_VIEW' || stage === 'PLAYER' || stage === 'PIPELINE';

  async function refresh(signal?: AbortSignal) {
    const [runData, pending] = await Promise.all([
      request('/api/unity/runs', { parse: decoded }, { signal }),
      request('/api/execution-requests', identity<{ requests: ExecutionRequest[] }>(), { signal }),
    ]);
    if (signal?.aborted) return;
    setRuns(runData.runs);
    setRequests(pending.requests.filter((item) => item.binding.scope.operation === 'unity.run' &&
      ['PENDING', 'APPROVED'].includes(item.status)));
  }

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void async function load() {
      try {
        const session = await request('/api/operator/session', operatorSessionSchema, { signal });
        const [data, threads] = await Promise.all([
          request('/api/authorization/catalog', identity<Catalog>(), { signal }),
          request('/api/codex-runs', identity<{ runs: CodexRun[] }>(), { signal }),
          refresh(signal),
        ]);
        if (!signal.aborted) {
          setCsrf(session.csrfToken);
          setCatalog(data);
          setCodex(threads.runs);
          setWorktreeId(data.worktrees.find((tree) => tree.codexManaged)?.worktreeId ?? '');
        }
      } catch {
        if (!signal.aborted) setError('请先在授权中心登录。');
      }
    }();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!csrf) return;
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void refresh(controller.signal).catch(() => undefined).finally(() => { pending = false; });
    }, 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [csrf]);

  useEffect(() => {
    if (!csrf) return;
    const controller = new AbortController();
    const uri = '/api/unity/environment' + (worktreeId ? '?worktreeId=' + encodeURIComponent(worktreeId) : '');
    void request(uri, unityEnvironmentSchema, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setEnvironment(data);
    }).catch(() => { if (!controller.signal.aborted) setEnvironment(undefined); });
    return () => controller.abort();
  }, [csrf, worktreeId]);

  const post = <T,>(url: string, body: object, schema = identity<T>()) => request(url, schema, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf,
      'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
  });

  async function action(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setStatus('');
    try { await run(); await refresh(); setStatus(message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败。'); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const testFilter = String(fields.get('filter') ?? '').trim();
    const scene = needScene ? String(fields.get('scene') ?? '').trim() : undefined;
    const settings = capture && (stage === 'GAME_VIEW' || fields.get('capture') === 'on') ? {
      width: Number(fields.get('width')), height: Number(fields.get('height')), seconds: Number(fields.get('seconds')),
    } : undefined;
    void action(() => post('/api/unity/requests', { taskId: fields.get('task'), runnerId: fields.get('runner'),
      worktreeId, plan: { stage, timeoutSeconds: Number(fields.get('timeout')), scene, testFilter: testFilter || undefined,
        capture: settings } }, executionRequestSchema), '申请已生成，请审查范围后批准。');
  }

  function submitEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const manifestFile = data.get('manifest');
    const selectedFiles = data.getAll('artifacts');
    void action(async () => {
      if (!(manifestFile instanceof File) || manifestFile.size > unityEvidenceManifestLimit) {
        throw new Error('请选择有效的证据清单。');
      }
      const manifest = unityEvidenceManifestSchema.parse(JSON.parse(await manifestFile.text()));
      if (manifest.projectId !== projectId) throw new Error('清单项目和当前项目不一致。');
      const files = new Map(selectedFiles.flatMap((value) => value instanceof File ? [[value.name, value] as const] : []));
      const expected = unityEvidenceFiles(manifest);
      if (files.size !== expected.length || selectedFiles.length !== expected.length) throw new Error('请选择清单中的全部产物。');
      const body = new Blob([new Uint8Array(unityEvidenceHeader(manifest)), ...expected.map(({ name, size }) => {
        const file = files.get(name);
        if (!file || file.size !== size) throw new Error('产物名称或大小与清单不符。');
        return file;
      })]);
      await request('/api/unity/evidence/import', unityEvidenceRunSchema, {
        method: 'POST', headers: { 'Content-Type': unityEvidenceContentType, 'X-CSRF-Token': csrf }, body,
      });
      form.reset();
    }, '外部采集证据已导入。');
  }

  function preview(runId: string, artifact: UnityArtifact, caption: string) {
    const url = '/api/unity/runs/' + runId + '/artifact?name=' + encodeURIComponent(artifact.name) + '&projectId=' + encodeURIComponent(projectId);
    if (artifact.mime === 'image/png') return <figure key={artifact.name}><img src={url} alt={caption} loading="lazy" />
      <figcaption>{caption}</figcaption></figure>;
    if (artifact.mime === 'video/mp4') return <figure key={artifact.name}><video src={url} controls preload="metadata" />
      <figcaption>{caption}</figcaption></figure>;
    return <p key={artifact.name}><a href={url} download={artifact.name}>{caption}</a></p>;
  }

  if (!catalog) return <div className="panel empty">{error ? <a href="#authorization">{error}</a> : '正在读取 Unity 运行环境…'}</div>;
  return <div className="unity-runtime">
    {error && <p className="alert inset" role="alert">{error}</p>}{status && <p className="notice" role="status">{status}</p>}
    <section className="panel">
      <div className="panel-heading"><h2>Unity 环境</h2></div>
      {environment && <dl className="unity-environment">
        <dt>Editor</dt><dd>{environment.version} · {environment.editor ?? '未安装'}</dd>
        <dt>工程版本</dt><dd>{environment.projectVersion ?? '未选择 Unity 工程'}</dd>
        <dt>Unity Hub</dt><dd>{environment.hub ? '已检测' : '未检测'}</dd>
        <dt>Build Support</dt><dd>{environment.buildSupport ? '可用' : '缺失'}</dd>
        <dt>许可证</dt><dd>{{ RUN_VERIFIED: '实测通过', FILE_PRESENT: '发现许可文件，待运行确认', UNVERIFIED: '待运行确认' }[environment.license]}</dd>
        <dt>图形会话</dt><dd>{environment.graphics ? '可用' : '不可用'}</dd>
        <dt>工作树</dt><dd>{environment.projectLocked ? '锁定' : '空闲'}</dd>
        <dt>可用磁盘</dt><dd>{environment.freeBytes === null ? '未知' : (environment.freeBytes / 1024 ** 3).toFixed(1) + ' GiB'}</dd>
        <dt>已检测版本</dt><dd>{environment.installedVersions.join(' · ') || '无'}</dd>
        {environment.diagnostics.length > 0 && <><dt>诊断</dt><dd><code>{environment.diagnostics.join(' · ')}</code></dd></>}
      </dl>}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>申请 Unity 运行</h2></div>
      <form className="form" onSubmit={submit}>
        <label>任务<select name="task" required><option value="">选择任务</option>
          {catalog.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label>Runner<select name="runner" required><option value="">选择 Runner</option>
          {catalog.runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.label} · {runner.platform}</option>)}</select></label>
        <label>受管 Worktree<select value={worktreeId} onChange={(event) => setWorktreeId(event.target.value)} required>
          <option value="">选择工作树</option>{catalog.worktrees.filter(({ codexManaged }) => codexManaged)
            .map((tree) => <option key={tree.worktreeId} value={tree.worktreeId}>{tree.root}</option>)}</select></label>
        <label>操作<select name="stage" value={stage} onChange={(event) => setStage(unityStageSchema.parse(event.target.value))}>
          {Object.entries(stages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {needScene && <label>场景路径<input name="scene" placeholder="Assets/Automation.unity" required /></label>}
        {['EDITMODE','PLAYMODE','PIPELINE'].includes(stage) && <label>测试过滤器<input name="filter" maxLength={128} /></label>}
        <label>单阶段超时（秒）<input name="timeout" type="number" min={5} max={1800} defaultValue={180} required /></label>
        {capture && <fieldset>
          <legend>渲染采集</legend>
          {stage !== 'GAME_VIEW' && <label><input name="capture" type="checkbox" />采集 Player 截图及视频</label>}
          <label>宽度<input name="width" type="number" min={320} max={1920} step={2} defaultValue={960} required /></label>
          <label>高度<input name="height" type="number" min={240} max={1080} step={2} defaultValue={540} required /></label>
          <label>时长（秒）<input name="seconds" type="number" min={1} max={12} defaultValue={3} required /></label>
        </fieldset>}
        <button className="button primary" disabled={busy}>创建运行申请</button>
      </form>
      {requests.map((entry) => entry.binding.scope.operation === 'unity.run' && <div key={entry.id} className="unity-run">
        <strong>{stages[entry.binding.scope.plan.stage]} · {entry.status === 'PENDING' ? '待审批' : '已批准'}</strong>
        <p>Git HEAD <code>{entry.binding.baseHeadSha.slice(0,12)}</code> · 绑定摘要 <code>{entry.bindingDigest.slice(0,12)}</code></p>
        <p>{entry.binding.scope.plan.scene ?? ''} · 超时 {entry.binding.scope.plan.timeoutSeconds} 秒</p>
        {entry.status === 'PENDING' && <button className="button" disabled={busy} onClick={() => void action(
          () => post('/api/execution-requests/' + entry.id + '/decision', { decision: 'approve', expectedVersion: entry.version }),
          '已批准，Runner 尚未启动。')}>批准本次运行</button>}
        {entry.status === 'APPROVED' && <button className="button primary" disabled={busy} onClick={() => void action(
          () => post('/api/unity/runs', { grantId: entry.grantId, bindingDigest: entry.bindingDigest,
            expectedVersion: entry.version, idempotencyKey: crypto.randomUUID() }), 'Runner 已领取并开始执行。')}>运行已批准任务</button>}
      </div>)}
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>导入外部采集证据</h2></div>
      <form className="form" onSubmit={submitEvidence}>
        <label>证据清单（JSON）<input type="file" name="manifest" accept=".json,application/json" required /></label>
        <label>清单中的 PNG、MP4、Console 和报告<input type="file" name="artifacts" multiple required /></label>
        <label><input type="checkbox" required /> 我已核对采集来源、提交和场景，并批准归档到当前项目。</label>
        <button className="button" disabled={busy}>导入证据</button>
      </form>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>运行报告</h2></div>
      {!runs.length && <p className="empty">暂无 Unity 运行。</p>}
      {runs.map((run) => 'source' in run ? <details key={run.id} className="unity-run">
        <summary>外部采集 · {run.scene} · {new Date(run.capturedAt).toLocaleString()}</summary>
        <p>Run <code>{run.id}</code> · Git <code>{run.commit}</code> · {run.editorVersion} · {run.width} × {run.height}</p>
        <p>{run.captureSource} · 清单 SHA-256 <code>{run.manifestSha256}</code></p>
        {run.skills.map((skill) => <div key={skill.id}>
          <h3>{skill.name}</h3>
          {run.artifacts.filter(({ name }) => name.startsWith(skill.id + '__'))
            .map((artifact) => preview(run.id, artifact, skill.name + ' · ' + artifact.name.split('__')[1]))}
        </div>)}
        {run.artifacts.filter(({ kind }) => kind === 'log' || kind === 'report')
          .map((artifact) => preview(run.id, artifact, artifact.name))}
      </details> : <details key={run.id} className="unity-run" open={run.status === 'RUNNING' || undefined}>
        <summary>{stages[run.plan.stage]} · {results[run.status]} · {new Date(run.startedAt).toLocaleString()}</summary>
        <p>Run <code>{run.id}</code> · {run.plan.scene ?? run.version}</p>
        <p>{run.phase ? stages[run.phase] : '等待 Runner'}{run.pid && ' · PID ' + run.pid}{run.diagnostic && ' · ' + run.diagnostic}</p>
        {run.status === 'RUNNING' && <button className="button" disabled={busy} onClick={() => void action(
          () => post('/api/unity/runs/' + run.id + '/cancel', {}), '取消请求已发送。')}>取消运行</button>}
        {run.reports.map((report, index) => <div key={index}>
          <h3>{stages[report.stage]} · {report.code ?? '通过'}</h3>
          {report.tests && <p>通过 {report.tests.passed} · 失败 {report.tests.failed} · 跳过 {report.tests.skipped} · 共 {report.tests.total}</p>}
          {report.tests?.failures?.map((failure) => <div key={failure.name}><strong>{failure.name}</strong><pre>{failure.message}</pre></div>)}
          {!!report.diagnostics.length && <ul>{report.diagnostics.map((item, row) => <li key={row}>
            {item.code} {item.file} {item.line ?? ''} {item.message}</li>)}</ul>}
          {report.build && <p>{report.build.target} · {report.build.size.toLocaleString()} B · SHA-256 <code>{report.build.sha256}</code></p>}
          {report.scene && <p>{report.scene.path} · 帧 {report.scene.frames} · {report.scene.skillTriggered ? '技能已触发' : '技能未触发'}</p>}
        </div>)}
        {run.exitConfirmed && run.artifacts.map((artifact) => preview(run.id, artifact, artifact.mime === 'image/png'
          ? artifact.kind === 'editor-screenshot' ? 'Editor Game View' : '独立 Player'
          : artifact.mime === 'video/mp4' ? artifact.kind === 'editor-recording' ? 'Editor Game View 录屏' : '独立 Player 录屏'
          : artifact.name))}
        {run.status === 'COMPLETED' && <p><a href="#gitlab">打开 Git 管理，审查候选 Tree</a></p>}
        {run.status === 'FAILED' && run.exitConfirmed && <form className="form" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void action(async () => {
            const outcome = await post<{ prompt: string }>('/api/unity/runs/' + run.id + '/repair',
              { previousRunId: fields.get('thread'), notes: fields.get('notes') });
            setPrompt(outcome.prompt);
          }, '已为原 Thread 创建新的 Codex 审批申请。');
        }}>
          <label>原 Codex 执行<select name="thread" required><option value="">选择原 Thread</option>
            {codex.filter((entry) => entry.worktreeId === run.worktreeId && entry.status === 'COMPLETED')
              .map((entry) => <option key={entry.devhubRunId} value={entry.devhubRunId}>{entry.devhubRunId}</option>)}</select></label>
          <label>补充说明<textarea name="notes" maxLength={1500} /></label>
          <button className="button" disabled={busy}>申请 Codex 续跑</button>
        </form>}
      </details>)}
      {prompt && <div className="form"><label>续跑提示词<textarea readOnly rows={8} value={prompt} /></label>
        <a href="#authorization">在授权中心审查续跑申请</a></div>}
    </section>
  </div>;
}
