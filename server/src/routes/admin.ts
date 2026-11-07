import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { getDb, transaction } from '../lib/db.js';
import { hashPassword, requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { isoFromSqliteUtc } from '../lib/dates.js';
import { notFound } from '../lib/errors.js';
import { parseId } from '../lib/validation.js';
import { requireSiteAdmin } from '../lib/siteAdmin.js';

/** The system admin's view of the whole app: every group, every account. */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireSiteAdmin);

/** Every group, with who runs it and how many are waiting to get in. */
adminRouter.get('/groups', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT g.id, g.name,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'approved') AS member_count,
              (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'pending') AS pending_count,
              (SELECT GROUP_CONCAT(u.username, ', ') FROM group_members m JOIN users u ON u.id = m.user_id
                WHERE m.group_id = g.id AND m.status = 'approved' AND m.role = 'admin') AS admins
         FROM groups g
        ORDER BY g.name COLLATE NOCASE`,
    )
    .all() as unknown as { id: number; name: string; member_count: number; pending_count: number; admins: string | null }[];
  res.json({
    groups: rows.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.member_count,
      pendingCount: g.pending_count,
      admins: g.admins ? g.admins.split(', ') : [],
    })),
  });
});

/** Accounts whose username contains `q` (all of them, newest first, if no `q`). */
adminRouter.get('/users', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = getDb()
    .prepare(
      `SELECT id, username, created_at FROM users
        WHERE @q = '' OR username LIKE '%' || @q || '%'
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
    )
    .all({ q }) as unknown as { id: number; username: string; created_at: string }[];
  res.json({
    users: rows.map((u) => ({ id: u.id, username: u.username, signedUpAt: isoFromSqliteUtc(u.created_at) })),
  });
});

/**
 * Four lowercase letters, short enough to read out across a pub table. It is
 * only good for one sign-in: the app makes them choose their own password
 * straight away.
 */
const TEMP_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const temporaryPassword = (): string =>
  Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');

/**
 * Give someone a new temporary password, for when they have forgotten theirs.
 * It is shown once, to the admin, to pass on; they must choose a new one the
 * next time they sign in.
 */
adminRouter.post(
  '/users/:userId/reset-password',
  asyncHandler(async (req, res) => {
    const userId = parseId(req.params.userId, 'account');
    const db = getDb();
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
    if (!user) throw notFound('That account does not exist.');
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      db.prepare(
        `INSERT INTO password_change_required (user_id, set_by) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET set_by = excluded.set_by, set_at = datetime('now')`,
      ).run(userId, req.user!.uid);
    });
    console.log(`password reset: ${user.username} by ${req.user!.username}`);
    res.json({ username: user.username, temporaryPassword: password });
  }),
);
