import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { credentialsSchema, parseBody } from '../lib/validation.js';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

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

    const user = { id: Number(info.lastInsertRowid), username };
    res.status(201).json({ token: signToken({ uid: user.id, username }), user });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = parseBody(credentialsSchema, req.body);
    const row = getDb()
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;

    // Same message either way, so the form can't be used to discover usernames.
    const failure = unauthorized('That username and password don’t match.');
    if (!row) throw failure;
    if (!(await verifyPassword(password, row.password_hash))) throw failure;

    const user = { id: row.id, username: row.username };
    res.json({ token: signToken({ uid: user.id, username: user.username }), user });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  const row = getDb()
    .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
    .get(req.user!.uid) as Omit<UserRow, 'password_hash'> | undefined;
  if (!row) throw unauthorized();
  res.json({ user: { id: row.id, username: row.username, createdAt: row.created_at } });
});
