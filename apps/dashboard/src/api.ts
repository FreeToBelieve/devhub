import { apiErrorSchema, doctorReportSchema, taskListSchema, taskSchema } from '@devhub/contracts';
import type { CreateTask } from '@devhub/contracts';

async function request<T>(
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

export const listTasks = (signal: AbortSignal) => request('/api/tasks', taskListSchema, { signal });
export const getDoctorReport = (signal: AbortSignal) => request('/api/doctor', doctorReportSchema, { signal });
export const createTask = (input: CreateTask) => request('/api/tasks', taskSchema, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
});
