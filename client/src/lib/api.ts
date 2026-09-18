export interface User {
  id: number;
  username: string;
}

export interface GroupSummary {
  id: number;
  name: string;
  description: string;
  createdBy: number;
  createdAt: string;
  memberCount: number;
  myStatus: 'pending' | 'approved' | null;
  myRole: 'admin' | 'member' | null;
}

export interface GroupMember {
  id: number;
  username: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

export interface GroupRequest {
  id: number;
  username: string;
  requestedAt: string;
}

export interface GroupDetail {
  group: GroupSummary;
  members: GroupMember[];
  requests: GroupRequest[];
}

const TOKEN_KEY = 'quizbuzz.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

/** Thrown for any non-2xx response, carrying the server's own wording. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, body.error ?? 'Something went wrong.', body.code ?? 'error');
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  register: (username: string, password: string) =>
    post<{ token: string; user: User }>('/auth/register', { username, password }),
  login: (username: string, password: string) =>
    post<{ token: string; user: User }>('/auth/login', { username, password }),
  me: () => request<{ user: User }>('/auth/me'),

  myGroups: () => request<{ groups: GroupSummary[]; pending: GroupSummary[] }>('/groups/mine'),
  searchGroups: (q: string) => request<{ groups: GroupSummary[] }>(`/groups/search?q=${encodeURIComponent(q)}`),
  createGroup: (name: string, description: string) =>
    post<{ group: GroupSummary }>('/groups', { name, description }),
  group: (id: number) => request<GroupDetail>(`/groups/${id}`),

  apply: (id: number) => post<{ status: string }>(`/groups/${id}/apply`),
  withdraw: (id: number) => del<{ status: null }>(`/groups/${id}/apply`),
  approve: (groupId: number, userId: number) => post(`/groups/${groupId}/members/${userId}/approve`),
  setRole: (groupId: number, userId: number, role: 'admin' | 'member') =>
    post(`/groups/${groupId}/members/${userId}/role`, { role }),
  removeMember: (groupId: number, userId: number) => del(`/groups/${groupId}/members/${userId}`),
};
