import type { AppState, Message, Project, Session } from './types';
import { demoRequest } from './demo';

export const isDemo = new URLSearchParams(location.search).get('demo') === '1';
let token = '';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request<T>(route: string, body?: Record<string, unknown>, method = 'POST'): Promise<T> {
  if (isDemo) return demoRequest(route, body) as Promise<T>;
  let response: Response;
  try {
    response = await fetch(route, {
      method: body === undefined ? 'GET' : method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(route === '/api/credentials' || route === '/api/bots' || /^\/api\/bots\/[^/]+\/credentials$/.test(route) ? 60_000 : 20_000)
    });
  } catch { throw new ApiError(body === undefined ? '暂时无法连接本机服务，正在尝试恢复。' : '提交结果尚未确认，请先查看任务记录，避免重复发送。', 0); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error || `操作未完成（${response.status}）`, response.status);
  return result as T;
}
export async function getState(): Promise<AppState> {
  const state = await request<AppState>('/api/state');
  token = state.csrfToken;
  return state;
}
export const getProjects = () => request<{ projects: Project[] }>('/api/projects');
export const getSessions = (cwd: string, chatId?: string) => request<{ sessions: Session[] }>(`/api/sessions?cwd=${encodeURIComponent(cwd)}${chatId ? `&chatId=${encodeURIComponent(chatId)}` : ''}`);
export const getHistory = (chatId: string) => request<{ messages: Message[]; threadId?: string; source: string }>(`/api/history?chatId=${encodeURIComponent(chatId)}`);
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请稍后重试。'; }
