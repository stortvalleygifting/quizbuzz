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

export type EventStatus = 'scheduled' | 'live' | 'finished';
export type BuzzOutcome = 'waiting' | 'answering' | 'correct' | 'pass' | 'wrong' | 'skipped';

export interface EventSummary {
  id: number;
  groupId: number;
  name: string;
  status: EventStatus;
  scheduledFor: string | null;
  questionMasterId: number | null;
  questionMasterName: string | null;
  createdBy: number;
  createdAt: string;
  participantCount: number;
  joined: boolean;
}

export interface BoardEntry {
  place: number;
  userId: number;
  username: string;
  score: number;
}

/** Everything a screen in an event renders from. The server pushes it on every change. */
export interface EventState {
  event: {
    id: number;
    groupId: number;
    groupName: string;
    name: string;
    status: EventStatus;
    questionMasterId: number | null;
    questionMasterName: string | null;
    scheduledFor: string | null;
    createdBy: number;
  };
  me: {
    userId: number;
    isAdmin: boolean;
    isQuestionMaster: boolean;
    isParticipant: boolean;
    hasBuzzed: boolean;
  };
  question: { id: number; seq: number } | null;
  answering: { userId: number; username: string } | null;
  queue: { userId: number; username: string; seq: number; outcome: BuzzOutcome }[];
  leaderboard: BoardEntry[];
  participants: { id: number; username: string; score: number }[];
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

  groupEvents: (groupId: number) => request<{ events: EventSummary[] }>(`/groups/${groupId}/events`),
  createEvent: (groupId: number, name: string, scheduledFor?: string) =>
    post<{ event: EventSummary }>(`/groups/${groupId}/events`, { name, scheduledFor }),
  event: (eventId: number) => request<{ state: EventState }>(`/events/${eventId}`),
  joinEvent: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/join`),
  leaveEvent: (eventId: number) => del<{ left: boolean }>(`/events/${eventId}/join`),
  setQuestionMaster: (eventId: number, userId: number) =>
    post<{ state: EventState }>(`/events/${eventId}/question-master`, { userId }),
  startEvent: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/start`),
  finishEvent: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/finish`),
  nextQuestion: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/next-question`),
};
