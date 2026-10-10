export interface User {
  id: number;
  username: string;
  /** When the account was registered, UTC ISO 8601. */
  signedUpAt: string;
  /** Can see and manage every group, and reset passwords. */
  isSiteAdmin?: boolean;
}

export interface AdminGroup {
  id: number;
  name: string;
  memberCount: number;
  pendingCount: number;
  admins: string[];
}

export interface AdminUser {
  id: number;
  username: string;
  signedUpAt: string;
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
  /** A system admin looking after a group they are not an admin of. */
  viewingAsSiteAdmin?: boolean;
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

/** What happens after a wrong answer or a pass. */
export type SecondBuzz = 'queue' | 'reopen' | 'one_shot';

export interface Points {
  right: number;
  wrong: number;
}

/** How one quiz is played. Points are for the 1st answer, the 2nd, then 3rd and later. */
export interface GameRules {
  playAs: 'individuals' | 'teams';
  secondBuzz: SecondBuzz;
  points: [Points, Points, Points];
}

/** Which team someone is on, as the buzzer and queue show it. */
export interface TeamTag {
  id: number;
  name: string;
  colour: string;
}

/** One team's line on the board, with its players. */
export interface TeamEntry extends TeamTag {
  place: number;
  score: number;
  members: { userId: number; username: string; score: number }[];
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
    teamId: number | null;
  };
  question: { id: number; seq: number } | null;
  /** position: 1 for the first answer on this question, 2 for the second… */
  answering: { userId: number; username: string; position: number; team: TeamTag | null } | null;
  rules: GameRules;
  queue: { userId: number; username: string; seq: number; outcome: BuzzOutcome; team: TeamTag | null }[];
  /** A team quiz's standings, best first; empty when playing as individuals. */
  teams: TeamEntry[];
  leaderboard: BoardEntry[];
  participants: { id: number; username: string; score: number }[];
}

/** You against one other player, in a single quiz. */
export interface QuizHeadToHead {
  opponent: { id: number; username: string };
  yourScore: number;
  theirScore: number;
  buzzer: { contested: number; youFirst: number; themFirst: number };
}

export interface HeadToHead {
  opponent: { id: number; username: string };
  quizzes: { played: number; won: number; lost: number; drawn: number };
  buzzer: { contested: number; youFirst: number; themFirst: number };
  meetings: {
    eventId: number;
    name: string;
    yourScore: number;
    theirScore: number;
    result: 'won' | 'lost' | 'drawn';
    endedAt: string | null;
  }[];
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
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ changed: true }>('/auth/password', { currentPassword, newPassword }),

  adminGroups: () => request<{ groups: AdminGroup[] }>('/admin/groups'),
  adminUsers: (q: string) => request<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}`),
  resetPassword: (userId: number) =>
    post<{ username: string; temporaryPassword: string }>(`/admin/users/${userId}/reset-password`),

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
  reopenEvent: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/reopen`),

  headToHead: (groupId: number, userId: number) =>
    request<{ headToHead: HeadToHead }>(`/groups/${groupId}/head-to-head/${userId}`),
  nextQuestion: (eventId: number) => post<{ state: EventState }>(`/events/${eventId}/next-question`),
  quizHeadToHead: (eventId: number, userId: number) =>
    request<{ headToHead: QuizHeadToHead }>(`/events/${eventId}/head-to-head/${userId}`),
  adjustScore: (eventId: number, userId: number, delta: number) =>
    post<{ state: EventState }>(`/events/${eventId}/adjust`, { userId, delta }),
  setRules: (eventId: number, rules: GameRules) => post<{ state: EventState }>(`/events/${eventId}/rules`, rules),
  createTeam: (eventId: number, name: string) => post<{ state: EventState }>(`/events/${eventId}/teams`, { name }),
  joinTeam: (eventId: number, teamId: number) => post<{ state: EventState }>(`/events/${eventId}/teams/${teamId}/join`),
  leaveTeam: (eventId: number) => del<{ state: EventState }>(`/events/${eventId}/team`),
  renameTeam: (eventId: number, teamId: number, name: string) =>
    post<{ state: EventState }>(`/events/${eventId}/teams/${teamId}/name`, { name }),
  moveToTeam: (eventId: number, userId: number, teamId: number | null) =>
    post<{ state: EventState }>(`/events/${eventId}/teams/move`, { userId, teamId }),
  randomTeams: (eventId: number, count: number) =>
    post<{ state: EventState }>(`/events/${eventId}/teams/random`, { count }),
};
