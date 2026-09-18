import { Router } from 'express';
import { getDb, transaction } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createGroupSchema, parseBody, parseId } from '../lib/validation.js';
import {
  countAdmins,
  getGroup,
  getMembership,
  requireAdmin,
  requireMember,
  serializeGroup,
  type GroupRow,
} from '../lib/groups.js';
import { z } from 'zod';
import type { SQLInputValue } from 'node:sqlite';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

interface GroupSummaryRow extends GroupRow {
  member_count: number;
  my_status: 'pending' | 'approved' | null;
  my_role: 'admin' | 'member' | null;
}

const summarize = (r: GroupSummaryRow) => ({
  ...serializeGroup(r),
  memberCount: r.member_count,
  myStatus: r.my_status,
  myRole: r.my_status === 'approved' ? r.my_role : null,
});

const SUMMARY_SELECT = `
  SELECT g.*,
         (SELECT COUNT(*) FROM group_members gm
           WHERE gm.group_id = g.id AND gm.status = 'approved') AS member_count,
         mine.status AS my_status,
         mine.role   AS my_role
    FROM groups g
    LEFT JOIN group_members mine ON mine.group_id = g.id AND mine.user_id = @me`;

/** Create a group. The creator is an approved admin straight away. */
groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, description } = parseBody(createGroupSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();

    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) {
      throw conflict('A group with that name already exists.', 'group_name_taken');
    }

    const groupId = transaction(db, () => {
      const info = db
        .prepare('INSERT INTO groups (name, description, created_by) VALUES (?, ?, ?)')
        .run(name, description, me);
      const id = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO group_members (group_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'admin', 'approved', datetime('now'))`,
      ).run(id, me);
      return id;
    });

    const row = db.prepare(`${SUMMARY_SELECT} WHERE g.id = @id`).get({ me, id: groupId }) as unknown as GroupSummaryRow;
    res.status(201).json({ group: summarize(row) });
  }),
);

/** Groups I belong to, plus applications I'm waiting on. */
groupsRouter.get('/mine', (req, res) => {
  const me = req.user!.uid;
  const rows = getDb()
    .prepare(
      `${SUMMARY_SELECT}
        WHERE mine.user_id = @me
        ORDER BY mine.status = 'approved' DESC, g.name COLLATE NOCASE`,
    )
    .all({ me }) as unknown as GroupSummaryRow[];
  const all = rows.map(summarize);
  res.json({
    groups: all.filter((g) => g.myStatus === 'approved'),
    pending: all.filter((g) => g.myStatus === 'pending'),
  });
});

/** Search every group by name, so people can find one to apply to. */
groupsRouter.get('/search', (req, res) => {
  const me = req.user!.uid;
  const q = String(req.query.q ?? '').trim();
  const params: Record<string, SQLInputValue> = { me, limit: 30 };
  let where = '';
  if (q) {
    where = 'WHERE g.name LIKE @like OR g.description LIKE @like';
    params.like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  }
  const rows = getDb()
    .prepare(
      `${SUMMARY_SELECT} ${where}
        ORDER BY member_count DESC, g.name COLLATE NOCASE
        LIMIT @limit`,
    )
    .all(params) as unknown as GroupSummaryRow[];
  res.json({ groups: rows.map(summarize) });
});

/** Group detail. Members see the roster; everyone else sees the public card. */
groupsRouter.get(
  '/:groupId',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);

    const row = db.prepare(`${SUMMARY_SELECT} WHERE g.id = @id`).get({ me, id: groupId }) as unknown as GroupSummaryRow;
    const membership = getMembership(db, groupId, me);
    const isMember = membership?.status === 'approved';
    const isAdmin = isMember && membership.role === 'admin';

    const members = isMember
      ? (db
          .prepare(
            `SELECT u.id, u.username, gm.role, gm.joined_at
               FROM group_members gm JOIN users u ON u.id = gm.user_id
              WHERE gm.group_id = ? AND gm.status = 'approved'
              ORDER BY gm.role = 'admin' DESC, u.username COLLATE NOCASE`,
          )
          .all(groupId) as unknown as { id: number; username: string; role: string; joined_at: string }[])
      : [];

    const requests = isAdmin
      ? (db
          .prepare(
            `SELECT u.id, u.username, gm.requested_at
               FROM group_members gm JOIN users u ON u.id = gm.user_id
              WHERE gm.group_id = ? AND gm.status = 'pending'
              ORDER BY gm.requested_at`,
          )
          .all(groupId) as unknown as { id: number; username: string; requested_at: string }[])
      : [];

    res.json({
      group: summarize(row),
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        role: m.role,
        joinedAt: m.joined_at,
      })),
      requests: requests.map((r) => ({
        id: r.id,
        username: r.username,
        requestedAt: r.requested_at,
      })),
    });
  }),
);

/** Apply to join a group. */
groupsRouter.post(
  '/:groupId/apply',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);

    const existing = getMembership(db, groupId, me);
    if (existing?.status === 'approved') throw conflict('You are already in this group.', 'already_member');
    if (existing?.status === 'pending') {
      return res.json({ status: 'pending' });
    }

    db.prepare(`INSERT INTO group_members (group_id, user_id, role, status) VALUES (?, ?, 'member', 'pending')`).run(
      groupId,
      me,
    );
    res.status(201).json({ status: 'pending' });
  }),
);

/** Withdraw an application I haven't had approved yet. */
groupsRouter.delete(
  '/:groupId/apply',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const me = req.user!.uid;
    const db = getDb();
    const existing = getMembership(db, groupId, me);
    if (!existing || existing.status !== 'pending') throw notFound('You have no application to withdraw.');
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, me);
    res.json({ status: null });
  }),
);

/** Admin: approve someone's application. */
groupsRouter.post(
  '/:groupId/members/:userId/approve',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const userId = parseId(req.params.userId, 'member');
    const db = getDb();
    getGroup(db, groupId);
    requireAdmin(db, groupId, req.user!.uid);

    const target = getMembership(db, groupId, userId);
    if (!target) throw notFound('That person has not applied to this group.');
    if (target.status === 'approved') return res.json({ status: 'approved' });

    db.prepare(
      `UPDATE group_members SET status = 'approved', joined_at = datetime('now')
        WHERE group_id = ? AND user_id = ?`,
    ).run(groupId, userId);
    res.json({ status: 'approved' });
  }),
);

/** Admin: change a member's role. Also used to step someone down. */
const roleSchema = z.object({ role: z.enum(['admin', 'member']) });
groupsRouter.post(
  '/:groupId/members/:userId/role',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const userId = parseId(req.params.userId, 'member');
    const { role } = parseBody(roleSchema, req.body);
    const db = getDb();
    getGroup(db, groupId);
    requireAdmin(db, groupId, req.user!.uid);

    const target = requireMemberOr404(db, groupId, userId);
    if (target.role === role) return res.json({ role });

    if (role === 'member' && countAdmins(db, groupId) <= 1) {
      throw badRequest('A group needs at least one admin. Make someone else an admin first.', 'last_admin');
    }

    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, groupId, userId);
    res.json({ role });
  }),
);

/**
 * Remove a member, reject an application, or leave the group yourself.
 * Admins can remove anyone; anyone can remove themselves.
 */
groupsRouter.delete(
  '/:groupId/members/:userId',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const userId = parseId(req.params.userId, 'member');
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);

    const leavingMyself = userId === me;
    if (leavingMyself) requireMember(db, groupId, me);
    else requireAdmin(db, groupId, me);

    const target = getMembership(db, groupId, userId);
    if (!target) throw notFound('That person is not in this group.');

    if (target.status === 'approved' && target.role === 'admin' && countAdmins(db, groupId) <= 1) {
      throw badRequest(
        leavingMyself
          ? 'You are the only admin. Make someone else an admin before you leave.'
          : 'That is the only admin. Make someone else an admin first.',
        'last_admin',
      );
    }

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    res.json({ removed: true });
  }),
);

function requireMemberOr404(db: ReturnType<typeof getDb>, groupId: number, userId: number) {
  const m = getMembership(db, groupId, userId);
  if (!m || m.status !== 'approved') throw notFound('That person is not a member of this group.');
  return m;
}
