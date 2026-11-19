import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { createTaskSchema, targetPlatformSchema } from '@devhub/contracts';
import type { TargetPlatform, Task, TaskStatus } from '@devhub/contracts';
import { createTask } from './api.js';

const platformLabel: Record<TargetPlatform, string> = {
  WINDOWS: 'Windows',
  MACOS: 'macOS',
  BOTH: 'Windows + macOS',
};

const statusLabel: Record<TaskStatus, string> = {
  CREATED: '已创建',
  QUEUED: '已排队',
  RUNNING: '运行中',
  TESTING: '测试中',
  WAITING_APPROVAL: '待审批',
  PUSHED: '已推送',
  MR_CREATED: '已创建 MR',
  REVIEWING: '审核中',
  COMPLETED: '已完成',
  FAILED: '失败',
  BLOCKED: '已阻塞',
  CANCELLED: '已取消',
};

const taskDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return <div className="empty">
      <p>暂无本地任务</p>
      <a href="#new-task">创建第一条任务 <span aria-hidden="true">→</span></a>
    </div>;
  }
  return <ul className="task-list">
    {tasks.map((task) => (
      <li key={task.id}>
        <details>
          <summary>
            <span className="task-name">
              <strong>{task.title}</strong>
              <span>{platformLabel[task.targetPlatform]} · <time dateTime={task.createdAt}>{taskDate.format(new Date(task.createdAt))}</time></span>
            </span>
            <span className="pill">{statusLabel[task.status]}</span>
            <span className="chevron" aria-hidden="true" />
          </summary>
          <div className="task-details">
            <p>{task.description || '无任务说明。'}</p>
            <small>任务 ID <code>{task.id}</code></small>
          </div>
        </details>
      </li>
    ))}
  </ul>;
}

export function NewTask({ onCreated }: { onCreated(task: Task): void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const result = createTaskSchema.safeParse({
      title: form.get('title'),
      description: form.get('description'),
      targetPlatform: form.get('targetPlatform'),
    });
    if (!result.success) {
      setError('请输入 1–120 字的标题，并检查说明和目标平台。');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const task = await createTask(result.data);
      onCreated(task);
    } catch (failure) {
      setError(failure instanceof TypeError
        ? '未能连接本机 Hub。请检查任务列表后再重试。'
        : failure instanceof Error ? failure.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  return <form className="panel task-form" onSubmit={submit}>
    <fieldset disabled={saving}>
      <label htmlFor="title">任务标题</label>
      <input id="title" name="title" maxLength={120} required placeholder="例如：更新青溪地图的设计说明" />

      <label htmlFor="description">任务说明 <span className="muted">（选填）</span></label>
      <textarea id="description" name="description" rows={6} maxLength={4000} placeholder="写下要做的工作和验收条件" />

      <label htmlFor="targetPlatform">目标平台</label>
      <select id="targetPlatform" name="targetPlatform" defaultValue="BOTH">
        {targetPlatformSchema.options.map((platform) => <option value={platform} key={platform}>{platformLabel[platform]}</option>)}
      </select>

      {error && <p className="alert" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="button primary" type="submit">{saving ? '保存中…' : '保存任务'}</button>
        {!saving && <a className="button" href="#tasks">取消</a>}
      </div>
    </fieldset>
  </form>;
}
