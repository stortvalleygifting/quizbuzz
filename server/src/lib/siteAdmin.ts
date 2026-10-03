import type { NextFunction, Request, Response } from 'express';
import { forbidden } from './errors.js';

/**
 * System admins are named in the SITE_ADMINS setting, a comma-separated list
 * of usernames (on Fly: `fly secrets set SITE_ADMINS=rob`), rather than
 * flagged in the database. That keeps the role off the live database
 * entirely, so adding it needed no migration, and nobody can grant it to
 * themselves through the app.
 */
function siteAdminNames(): Set<string> {
  return new Set(
    (process.env.SITE_ADMINS ?? '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Usernames are unique ignoring case, so the comparison ignores it too. */
export function isSiteAdmin(username: string | undefined): boolean {
  return Boolean(username) && siteAdminNames().has(username!.toLowerCase());
}

/** Rejects the request unless the signed-in user is a system admin. */
export function requireSiteAdmin(req: Request, _res: Response, next: NextFunction): void {
  next(isSiteAdmin(req.user?.username) ? undefined : forbidden('Only a system admin can do that.'));
}
