import { useEffect, useState } from 'react';
import { z } from 'zod';
import { codexEventSchema, codexRunSchema, operatorSessionSchema } from '@devhub/contracts';
import type { CodexRun } from '@devhub/contracts';
import { request } from './api.js';

const listSchema = z.object({ runs: z.array(codexRunSchema) });
const eventsSchema = z.object({
  run: codexRunSchema,
  events: z.array(z.object({ seq: z.int(), createdAt: z.int(), event: codexEventSchema })),
});
type Events = z.infer<typeof eventsSchema>['events'];

export function CodexRuns() {
  const [runs, setRuns] = useState<CodexRun[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<Events>([]);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const active = runs.find((run) => run.devhubRunId === selected);

  useEffect(() => {
    const controller = new AbortController();
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const { runs: history } = await request('/api/codex-runs', listSchema, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRuns(history);
        if (selected) {
          const result = await request(`/api/codex-runs/${selected}/events?after=${after}`, eventsSchema, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (result.events.length) {
            setEvents((previous) => [...previous, ...result.events].slice(-200));
            after = result.events.at(-1)!.seq;
          }
        }
        setError('');
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof Error && failure.message === 'UNAUTHENTICATED') {
          setError('请先在授权中心登录。');
          return;
        }
        setError('暂时无法读取 Codex 运行记录。');
      }
      timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected]);

  async function cancel() {
    if (!active) return;
    setCancelling(true);
    try {
      const session = await request('/api/operator/session', operatorSessionSchema);
      await request('/api/codex-runs/' + active.devhubRunId + '/cancel', z.unknown(), {
        method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
      });
    } catch {
      setError('无法请求取消。');
    } finally {
      setCancelling(false);
    }
  }

  return <section className="panel">
    <div className="panel-heading"><h2>Codex Turn</h2></div>
    {error && <p className="alert inset" role="alert">{error} <a href="#authorization">授权中心</a></p>}
    {!runs.length && !error && <p className="empty">暂无运行记录</p>}
    <ul className="check-list">
      {runs.map((run) => <li key={run.devhubRunId}>
        <div>
          <strong>{run.providerThreadId ?? '新 Thread'}</strong>
          <p>{run.devhubRunId} · {run.status}{run.cancelRequested && run.status === 'RUNNING' ? ' · 正在取消' : ''}</p>
        </div>
        <button className="button" onClick={() => {
          if (selected === run.devhubRunId) return;
          setEvents([]);
          setSelected(run.devhubRunId);
        }}>查看事件</button>
      </li>)}
    </ul>
    {active && <div className="task-details">
      <dl className="authorization-details">
        <dt>DevHub Run ID</dt><dd><code>{active.devhubRunId}</code></dd>
        <dt>提示词 SHA256</dt><dd><code>{active.promptSha256}</code></dd>
        <dt>配置 SHA256</dt><dd><code>{active.sdkConfigSha256}</code></dd>
        {active.diagnosticCode && <><dt>诊断</dt><dd><code>{active.diagnosticCode}</code></dd></>}
        {active.status === 'INTERRUPTED' && <><dt>工作树</dt><dd>锁定，等待确认执行进程退出</dd></>}
      </dl>
      {active.status === 'RUNNING' && <button className="button" disabled={cancelling || active.cancelRequested}
        onClick={() => void cancel()}>取消 Turn</button>}
      <ol>
        {events.map(({ seq, event }) => <li key={seq}>
          {event.kind}{event.itemType && ' · ' + event.itemType}
          {event.exitCode !== undefined && ' · exit ' + event.exitCode}
          {event.changedFiles !== undefined && ' · ' + event.changedFiles + ' 个文件'}
          {event.toolStatus && ' · ' + event.toolStatus}
          {event.toolDiagnostic && ' · ' + event.toolDiagnostic}
        </li>)}
      </ol>
    </div>}
  </section>;
}
