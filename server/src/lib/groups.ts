import type { DB } from './db.js';
import { forbidden, notFound } from './errors.js';
import { isSiteAdmin } from './siteAdmin.js';

export interface MembershipRow {
  group_id: number;
  user_id: number;
  role: 'admin' | 'member';
  status: 'pending' | 'approved';
  requested_at: string;
  joined_at: string | null;
}

export interface GroupRow {
  id: number;
  name: string;
  description: string;
  created_by: number;
  created_at: string;
}

export function getGroup(db: DB, groupId: number): GroupRow {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as unknown as GroupRow | undefined;
  if (!row) throw notFound('That group no longer exists.');
  return row;
}

export function getMembership(db: DB, groupId: number, userId: number): MembershipRow | undefined {
  return db
    .prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId) as unknown as MembershipRow | undefined;
}

/**
 * Your membership as far as permissions go: a system admin counts as an
 * approved admin of every group, whether or not they have joined it. Use
 * getMembership for what is actually recorded, such as whether you have applied.
 */
export function effectiveMembership(db: DB, groupId: number, userId: number): MembershipRow | undefined {
  const m = getMembership(db, groupId, userId);
  if (!isSiteAdmin(usernameOf(db, userId))) return m;
  return {
    group_id: groupId,
    user_id: userId,
    requested_at: m?.requested_at ?? '',
    joined_at: m?.joined_at ?? null,
    ...m,
    role: 'admin',
    status: 'approved',
  };
}

function usernameOf(db: DB, userId: number): string | undefined {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return row?.username;
}

/** The caller must be an approved member of the group. */
export function requireMember(db: DB, groupId: number, userId: number): MembershipRow {
  const m = effectiveMembership(db, groupId, userId);
  if (!m || m.status !== 'approved') throw forbidden('You need to be a member of this group.');
  return m;
}

/** The caller must be an approved admin of the group. */
export function requireAdmin(db: DB, groupId: number, userId: number): MembershipRow {
  const m = requireMember(db, groupId, userId);
  if (m.role !== 'admin') throw forbidden('Only group admins can do that.');
  return m;
}

export function countAdmins(db: DB, groupId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM group_members
        WHERE group_id = ? AND status = 'approved' AND role = 'admin'`,
    )
    .get(groupId) as unknown as { n: number };
  return row.n;
}

export const serializeGroup = (g: GroupRow) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  createdBy: g.created_by,
  createdAt: g.created_at,
});
