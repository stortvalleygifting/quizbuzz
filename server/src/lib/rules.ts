import { transaction, type DB } from './db.js';

/** What happens after a wrong answer or a pass. */
export type SecondBuzz = 'queue' | 'reopen' | 'one_shot';

export type PlayAs = 'individuals' | 'teams';

export interface Points {
  right: number;
  wrong: number;
}

/**
 * How one quiz is played. `points` is by answer position: the first person to
 * answer a question, the second, and everyone after that.
 */
export interface GameRules {
  playAs: PlayAs;
  secondBuzz: SecondBuzz;
  points: [Points, Points, Points];
}

/** Today's rules, and what every quiz without rules of its own plays. */
export const CLASSIC: GameRules = {
  playAs: 'individuals',
  secondBuzz: 'queue',
  points: [
    { right: 1, wrong: -1 },
    { right: 1, wrong: -1 },
    { right: 1, wrong: -1 },
  ],
};

export function getRules(db: DB, eventId: number): GameRules {
  const settings = db.prepare('SELECT play_as, second_buzz FROM event_settings WHERE event_id = ?').get(eventId) as
    | { play_as: PlayAs; second_buzz: SecondBuzz }
    | undefined;
  const rows = db
    .prepare('SELECT position, right_points, wrong_points FROM event_points WHERE event_id = ?')
    .all(eventId) as { position: number; right_points: number; wrong_points: number }[];

  const points = CLASSIC.points.map((p) => ({ ...p })) as GameRules['points'];
  for (const r of rows) points[r.position - 1] = { right: r.right_points, wrong: r.wrong_points };
  return {
    playAs: settings?.play_as ?? CLASSIC.playAs,
    secondBuzz: settings?.second_buzz ?? CLASSIC.secondBuzz,
    points,
  };
}

/**
 * Saves a quiz's rules. They can change mid-quiz (a double-points round, say):
 * each answer is scored by the rules in force when the question master judges
 * it, and answers already scored keep their points.
 */
export function setRules(db: DB, eventId: number, rules: GameRules): void {
  transaction(db, () => {
    db.prepare(
      `INSERT INTO event_settings (event_id, play_as, second_buzz) VALUES (?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET play_as = excluded.play_as, second_buzz = excluded.second_buzz,
                                            updated_at = datetime('now')`,
    ).run(eventId, rules.playAs, rules.secondBuzz);
    // Back to individuals: the teams go, so they can't linger half-built.
    if (rules.playAs === 'individuals') db.prepare('DELETE FROM event_teams WHERE event_id = ?').run(eventId);
    const save = db.prepare(
      `INSERT INTO event_points (event_id, position, right_points, wrong_points) VALUES (?, ?, ?, ?)
       ON CONFLICT (event_id, position) DO UPDATE SET right_points = excluded.right_points, wrong_points = excluded.wrong_points`,
    );
    rules.points.forEach((p, i) => save.run(eventId, i + 1, p.right, p.wrong));
  });
}

/** The points for the nth answer on a question (1-based); 3rd and later share a row. */
export const pointsFor = (rules: GameRules, position: number): Points =>
  rules.points[Math.min(Math.max(position, 1), 3) - 1];
