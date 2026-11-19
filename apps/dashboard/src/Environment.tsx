import { useEffect, useState } from 'react';
import type { DoctorCheck, DoctorReport } from '@devhub/contracts';
import { getDoctorReport } from './api.js';

const checkLabel: Record<DoctorCheck['id'], string> = {
  platform: '操作系统',
  node: 'Node.js',
  pnpm: 'pnpm',
  git: 'Git',
  codex: 'Codex CLI',
  unity: 'Unity Editor',
  unityProject: 'Unity 工程版本',
};
const statusLabel: Record<DoctorCheck['status'], string> = {
  pass: '通过',
  warning: '注意',
  fail: '失败',
  skipped: '跳过',
};

export function Environment() {
  const [report, setReport] = useState<DoctorReport>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getDoctorReport(controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setReport(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setError(true);
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [attempt]);

  function refresh() {
    setError(false);
    setLoading(true);
    setAttempt((current) => current + 1);
  }

  return <section className="panel" aria-labelledby="environment-title">
    <div className="panel-heading">
      <div>
        <h2 id="environment-title">本机环境</h2>
        <p>终端命令 <code>pnpm exec devhub doctor</code></p>
      </div>
      <button className="button" disabled={loading} onClick={refresh}>{loading ? '检测中…' : '重新检测'}</button>
    </div>
    {error && <p className="alert inset" role="alert">无法获取检测结果，请检查 Hub 后重试。</p>}
    {loading && !report && <p className="empty" role="status">正在检测本机环境…</p>}
    {report && <ul className="check-list">
      {report.checks.map((check) => <li key={check.id}>
        <div>
          <strong>{checkLabel[check.id]}</strong>
          <p>{check.detail}</p>
        </div>
        <span className={`pill ${check.status}`}>{statusLabel[check.status]}</span>
      </li>)}
    </ul>}
  </section>;
}
