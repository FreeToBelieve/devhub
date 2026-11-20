import { apiErrorSchema, doctorReportSchema, operatorSessionSchema, taskListSchema, taskSchema } from '@devhub/contracts';
import type { CreateTask } from '@devhub/contracts';

export async function request<T>(
  path: string,
  schema: { parse(data: unknown): T },
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, options);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(data);
    throw new Error(error.success ? error.data.message : `请求失败（HTTP ${response.status}）。`);
  }
  return schema.parse(data);
}

export function scopedRequest(projectId: string): typeof request {
  return (path, schema, options) => {
    const headers = new Headers(options?.headers);
    headers.set('X-DevHub-Project-Id', projectId);
    return request(path, schema, { ...options, headers });
  };
}

export const listTasks = (projectId: string, signal: AbortSignal) => scopedRequest(projectId)('/api/tasks', taskListSchema, { signal });
export const getDoctorReport = (signal: AbortSignal) => request('/api/doctor', doctorReportSchema, { signal });
export async function createTask(input: CreateTask, projectId: string) {
  const { csrfToken } = await request('/api/operator/session', operatorSessionSchema);
  return scopedRequest(projectId)('/api/tasks', taskSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ...input, projectId }),
  });
}
