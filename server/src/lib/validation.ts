import { z } from 'zod';
import { badRequest } from './errors.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters.')
  .max(24, 'Username must be 24 characters or fewer.')
  .regex(/^[A-Za-z0-9._-]+$/, 'Username can use letters, numbers, dots, dashes and underscores.');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be 128 characters or fewer.');

export const groupNameSchema = z
  .string()
  .trim()
  .min(3, 'Group name must be at least 3 characters.')
  .max(60, 'Group name must be 60 characters or fewer.');

export const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const createGroupSchema = z.object({
  name: groupNameSchema,
  description: z.string().trim().max(280, 'Description must be 280 characters or fewer.').default(''),
});

/**
 * Signing in only checks that something was typed. The real rules are applied
 * when a password is set, and a temporary password from a system admin is
 * shorter than those rules allow.
 */
export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.').max(64, 'That username is too long.'),
  password: z.string().min(1, 'Enter your password.').max(128, 'That password is too long.'),
});

/** Parses a body, turning the first validation failure into a 400. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(result.error.issues[0]?.message ?? 'That request looked wrong.', 'validation');
  }
  return result.data;
}

/** Parses a numeric route parameter. */
export function parseId(raw: string | undefined, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`That ${what} doesn't look right.`);
  return n;
}
