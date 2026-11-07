import type { DB } from './db.js';
import { conflict } from './errors.js';

/**
 * SQL for the name someone goes by in a group: their nickname there if they
 * have one, otherwise their username. `user` is the alias of a users row in
 * the query and `groupId` any SQL expression that gives the group's id.
 */
export function displayNameSql(user: string, groupId: string): string {
  return `COALESCE((SELECT gn.nickname FROM group_nicknames gn
                     WHERE gn.group_id = ${groupId} AND gn.user_id = ${user}.id), ${user}.username)`;
}

/** The name one person goes by in one group. */
export function displayName(db: DB, groupId: number, userId: number): string | null {
  const row = db
    .prepare(`SELECT ${displayNameSql('u', '?')} AS name FROM users u WHERE u.id = ?`)
    .get(groupId, userId) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Sets (or, with null, clears) someone's nickname in a group. A nickname has
 * to be unique among the group's current members, counting their usernames
 * too, so two people never show up under the same name.
 */
export function setNickname(db: DB, groupId: number, userId: number, nickname: string | null, setBy: number): void {
  if (nickname === null) {
    db.prepare('DELETE FROM group_nicknames WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return;
  }
  const clash = db
    .prepare(
      `SELECT 1 FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = @group AND gm.status = 'approved' AND gm.user_id <> @user
          AND (u.username = @name COLLATE NOCASE
               OR EXISTS (SELECT 1 FROM group_nicknames gn
                           WHERE gn.group_id = @group AND gn.user_id = u.id AND gn.nickname = @name COLLATE NOCASE))`,
    )
    .get({ group: groupId, user: userId, name: nickname });
  if (clash) throw conflict('Someone in this group already goes by that name.', 'nickname_taken');
  // A former member's leftover nickname shouldn't block a current one.
  db.prepare('DELETE FROM group_nicknames WHERE group_id = ? AND user_id <> ? AND nickname = ? COLLATE NOCASE').run(
    groupId,
    userId,
    nickname,
  );
  db.prepare(
    `INSERT INTO group_nicknames (group_id, user_id, nickname, set_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET nickname = excluded.nickname, set_by = excluded.set_by, updated_at = datetime('now')`,
  ).run(groupId, userId, nickname, setBy);
}
