import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from './errors.js';

const TOKEN_TTL = '30d';
const BCRYPT_ROUNDS = 10;

export interface TokenPayload {
  uid: number;
  username: string;
}

function loadSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set (16+ characters) in production.');
  }
  // Dev convenience: keep a generated secret on disk so restarts don't sign
  // everyone out mid-testing.
  const file = resolve(process.cwd(), 'data/.jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const generated = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

let cachedSecret: string | null = null;
const secret = (): string => (cachedSecret ??= loadSecret());

/**
 * Forces the signing secret to be resolved now rather than on the first login.
 *
 * Called at startup so a production deploy with no JWT_SECRET dies immediately
 * and visibly, instead of passing its health check and then failing on the
 * first person who tries to sign in — halfway through a quiz night.
 */
export const assertAuthConfigured = (): void => void secret();

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export const signToken = (payload: TokenPayload): string =>
  jwt.sign(payload, secret(), { expiresIn: TOKEN_TTL });

export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, secret()) as jwt.JwtPayload;
    if (typeof decoded.uid !== 'number' || typeof decoded.username !== 'string') {
      throw new Error('malformed token');
    }
    return { uid: decoded.uid, username: decoded.username };
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/** Rejects the request unless it carries a valid bearer token. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    req.user = verifyToken(header.slice('Bearer '.length).trim());
    next();
  } catch (err) {
    next(err);
  }
}
