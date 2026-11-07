import { Router } from 'express';
import { getDb, transaction } from '../lib/db.js';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { isoFromSqliteUtc } from '../lib/dates.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { credentialsSchema, loginSchema, parseBody, passwordSchema } from '../lib/validation.js';
import { isSiteAdmin } from '../lib/siteAdmin.js';
import { z } from 'zod';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

/** The account as every endpoint hands it to the client. */
interface PublicUser {
  id: number;
  username: string;
  signedUpAt: string;
  /** Can see and manage every group, and reset passwords. */
  isSiteAdmin: boolean;
  /** Signed in with a temporary password, so must choose a new one first. */
  mustChangePassword: boolean;
}

const mustChangePassword = (userId: number): boolean =>
  Boolean(getDb().prepare('SELECT 1 FROM password_change_required WHERE user_id = ?').get(userId));

const toPublicUser = (row: Omit<UserRow, 'password_hash'>): PublicUser => ({
  id: row.id,
  username: row.username,
  signedUpAt: isoFromSqliteUtc(row.created_at),
  isSiteAdmin: isSiteAdmin(row.username),
  mustChangePassword: mustChangePassword(row.id),
});

export const authRouter = Router();

/** Self-registration. Anyone can create an account with a username and password. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, password } = parseBody(credentialsSchema, req.body);
    const db = getDb();

    const taken = db
      .prepare('SELECT 1 FROM users WHERE username = ?')
      .get(username) as unknown;
    if (taken) throw conflict('That username is already taken.', 'username_taken');

    const password_hash = await hashPassword(password);
    const info = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, password_hash);

    const id = Number(info.lastInsertRowid);
    // Read the signup date back rather than stamping our own, so the one the
    // client sees is the one the database will still report in a year's time.
    const created = db
      .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
      .get(id) as unknown as Omit<UserRow, 'password_hash'>;

    const user = toPublicUser(created);
    res.status(201).json({ token: signToken({ uid: id, username }), user });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = parseBody(loginSchema, req.body);
    const row = getDb()
      .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?')
      .get(username) as unknown as UserRow | undefined;

    // Rob asked for these to be told apart: a pub crowd mistypes usernames far
    // more often than anyone goes looking for whose account exists.
    if (!row) throw unauthorized(`Can’t find a user called “${username}”.`, 'unknown_user');
    if (!(await verifyPassword(password, row.password_hash))) {
      throw unauthorized('That password isn’t right.', 'wrong_password');
    }

    const user = toPublicUser(row);
    res.json({ token: signToken({ uid: user.id, username: user.username }), user });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  const row = getDb()
    .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
    .get(req.user!.uid) as unknown as Omit<UserRow, 'password_hash'> | undefined;
  if (!row) throw unauthorized();
  res.json({ user: toPublicUser(row) });
});

/**
 * Change your own password. Mostly for replacing the temporary one a system
 * admin set when you forgot yours, which the app insists on before anything
 * else; doing so clears the "must change" mark.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: passwordSchema,
});
authRouter.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.uid) as unknown as
      | { password_hash: string }
      | undefined;
    if (!row) throw unauthorized();
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw badRequest('Your current password is not right.', 'wrong_password');
    }
    if (newPassword === currentPassword) {
      throw badRequest('Pick a password that’s different from your current one.', 'same_password');
    }
    const hash = await hashPassword(newPassword);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user!.uid);
      db.prepare('DELETE FROM password_change_required WHERE user_id = ?').run(req.user!.uid);
    });
    res.json({ changed: true });
  }),
);
