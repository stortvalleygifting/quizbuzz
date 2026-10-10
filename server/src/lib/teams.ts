import { transaction, type DB } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { getEvent, isParticipant, requireEventAdmin, type EventRow } from './events.js';
import { getRules } from './rules.js';

/** Team colours, handed out in this order; random teams are named after them. */
export const TEAM_COLOURS = [
  { name: 'Red', hex: '#ff5c6c' },
  { name: 'Blue', hex: '#4da3ff' },
  { name: 'Green', hex: '#2fc58f' },
  { name: 'Yellow', hex: '#ffd166' },
  { name: 'Purple', hex: '#a78bfa' },
  { name: 'Orange', hex: '#ff9f43' },
  { name: 'Pink', hex: '#f78fb3' },
  { name: 'Teal', hex: '#3dd6d0' },
];
export const MAX_TEAMS = TEAM_COLOURS.length;

export interface TeamRow {
  id: number;
  event_id: number;
  name: string;
  colour: string;
  created_by: number | null;
}

export interface TeamEntry {
  place: number;
  id: number;
  name: string;
  colour: string;
  score: number;
  members: { userId: number; username: string; score: number }[];
}

export const isTeamQuiz = (db: DB, eventId: number): boolean => getRules(db, eventId).playAs === 'teams';

/** The team a player is on in this quiz, if any. */
export function teamOf(db: DB, eventId: number, userId: number): TeamRow | undefined {
  return db
    .prepare(
      `SELECT t.* FROM event_team_members m JOIN event_teams t ON t.id = m.team_id
        WHERE m.event_id = ? AND m.user_id = ?`,
    )
    .get(eventId, userId) as TeamRow | undefined;
}

function getTeam(db: DB, eventId: number, teamId: number): TeamRow {
  const team = db.prepare('SELECT * FROM event_teams WHERE id = ? AND event_id = ?').get(teamId, eventId) as
    | TeamRow
    | undefined;
  if (!team) throw notFound('That team no longer exists.');
  return team;
}

/** Every team, best first, with its players. Equal scores share a place. */
export function getTeamBoard(db: DB, event: EventRow): TeamEntry[] {
  const teams = db.prepare('SELECT * FROM event_teams WHERE event_id = ? ORDER BY id').all(event.id) as unknown as TeamRow[];
  const members = db
    .prepare(
      `SELECT m.team_id, u.id AS user_id, u.username, p.score
         FROM event_team_members m
         JOIN users u ON u.id = m.user_id
         JOIN event_participants p ON p.event_id = m.event_id AND p.user_id = m.user_id
        WHERE m.event_id = ?
        ORDER BY p.score DESC, u.username COLLATE NOCASE`,
    )
    .all(event.id) as { team_id: number; user_id: number; username: string; score: number }[];

  const entries = teams.map((t) => {
    const mine = members.filter((m) => m.team_id === t.id);
    return {
      place: 0,
      id: t.id,
      name: t.name,
      colour: t.colour,
      score: mine.reduce((sum, m) => sum + m.score, 0),
      members: mine.map((m) => ({ userId: m.user_id, username: m.username, score: m.score })),
    };
  });
  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let place = 0;
  let last: number | null = null;
  entries.forEach((e, i) => {
    if (last === null || e.score !== last) {
      place = i + 1;
      last = e.score;
    }
    e.place = place;
  });
  return entries;
}

// ------------------------------------------------------------- guards --

function requireTeamQuiz(db: DB, event: EventRow): void {
  if (!isTeamQuiz(db, event.id)) {
    throw badRequest('The question master has not switched this quiz to teams.', 'not_teams');
  }
  if (event.status === 'finished') throw badRequest('That quiz has finished.', 'finished');
}

/** The question master, or a group admin. */
function requireRunner(db: DB, event: EventRow, userId: number): void {
  if (event.question_master_id !== userId) requireEventAdmin(db, event, userId);
}

/**
 * A player picking a team for themselves. Before the quiz starts they can
 * swap as often as they like; once it is live only someone with no team yet
 * (a late joiner) can pick one, so points can't hop between teams.
 */
function requirePlayerCanPick(db: DB, event: EventRow, userId: number): void {
  if (!isParticipant(db, event.id, userId)) throw forbidden('Join the quiz before you pick a team.');
  if (event.question_master_id === userId) throw forbidden('The question master is not on a team.');
  if (event.status === 'live' && teamOf(db, event.id, userId)) {
    throw conflict('Teams are fixed once the quiz has started.', 'teams_locked');
  }
}

const cleanName = (raw: string): string => raw.trim().replace(/\s+/g, ' ');

function assertNameFree(db: DB, eventId: number, name: string, exceptTeamId = 0): void {
  const taken = db
    .prepare('SELECT 1 FROM event_teams WHERE event_id = ? AND name = ? AND id <> ?')
    .get(eventId, name, exceptTeamId);
  if (taken) throw conflict('There is already a team with that name.', 'name_taken');
}

function nextColour(db: DB, eventId: number): string {
  const used = new Set(
    (db.prepare('SELECT colour FROM event_teams WHERE event_id = ?').all(eventId) as { colour: string }[]).map(
      (r) => r.colour,
    ),
  );
  return (TEAM_COLOURS.find((c) => !used.has(c.hex)) ?? TEAM_COLOURS[0]).hex;
}

/** Teams nobody is on any more are tidied away. */
function dropEmptyTeams(db: DB, eventId: number): void {
  db.prepare(
    `DELETE FROM event_teams WHERE event_id = ?
       AND id NOT IN (SELECT team_id FROM event_team_members WHERE event_id = ?)`,
  ).run(eventId, eventId);
}

function placeOnTeam(db: DB, eventId: number, teamId: number, userId: number): void {
  db.prepare(
    `INSERT INTO event_team_members (event_id, team_id, user_id) VALUES (?, ?, ?)
     ON CONFLICT (event_id, user_id) DO UPDATE SET team_id = excluded.team_id`,
  ).run(eventId, teamId, userId);
  dropEmptyTeams(db, eventId);
}

// ------------------------------------------------------------ actions --

/** A player starts a team, names it, and is on it straight away. */
export function createTeam(db: DB, eventId: number, userId: number, rawName: string): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    requirePlayerCanPick(db, event, userId);
    const name = cleanName(rawName);
    assertNameFree(db, eventId, name);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM event_teams WHERE event_id = ?').get(eventId) as { n: number };
    if (n >= MAX_TEAMS) throw conflict(`A quiz can have up to ${MAX_TEAMS} teams.`, 'too_many_teams');

    const info = db
      .prepare('INSERT INTO event_teams (event_id, name, colour, created_by) VALUES (?, ?, ?, ?)')
      .run(eventId, name, nextColour(db, eventId), userId);
    placeOnTeam(db, eventId, Number(info.lastInsertRowid), userId);
  });
}

/** A player joins someone else's team. */
export function joinTeam(db: DB, eventId: number, userId: number, teamId: number): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    requirePlayerCanPick(db, event, userId);
    getTeam(db, eventId, teamId);
    placeOnTeam(db, eventId, teamId, userId);
  });
}

/** A player steps off their team before the quiz starts. */
export function leaveTeam(db: DB, eventId: number, userId: number): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    if (event.status !== 'scheduled') throw conflict('Teams are fixed once the quiz has started.', 'teams_locked');
    db.prepare('DELETE FROM event_team_members WHERE event_id = ? AND user_id = ?').run(eventId, userId);
    dropEmptyTeams(db, eventId);
  });
}

/** Anyone on the team, the question master or an admin can rename it. */
export function renameTeam(db: DB, eventId: number, userId: number, teamId: number, rawName: string): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    getTeam(db, eventId, teamId);
    if (teamOf(db, eventId, userId)?.id !== teamId) requireRunner(db, event, userId);
    const name = cleanName(rawName);
    assertNameFree(db, eventId, name, teamId);
    db.prepare('UPDATE event_teams SET name = ? WHERE id = ?').run(name, teamId);
  });
}

/**
 * The question master or an admin puts a player on a team, or takes them off
 * one (teamId null). Allowed mid-quiz to fix mistakes; the player's points go
 * with them.
 */
export function movePlayer(db: DB, eventId: number, runnerId: number, userId: number, teamId: number | null): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    requireRunner(db, event, runnerId);
    if (!isParticipant(db, eventId, userId) || userId === event.question_master_id) {
      throw notFound('That person is not playing in this quiz.');
    }
    if (teamId === null) {
      db.prepare('DELETE FROM event_team_members WHERE event_id = ? AND user_id = ?').run(eventId, userId);
      dropEmptyTeams(db, eventId);
    } else {
      getTeam(db, eventId, teamId);
      placeOnTeam(db, eventId, teamId, userId);
    }
  });
}

/**
 * The question master's shortcut: throw away the teams there are and shuffle
 * everyone playing into `count` even teams named after their colours.
 */
export function randomTeams(db: DB, eventId: number, runnerId: number, count: number): void {
  transaction(db, () => {
    const event = getEvent(db, eventId);
    requireTeamQuiz(db, event);
    requireRunner(db, event, runnerId);
    if (event.status !== 'scheduled') throw conflict('Teams are fixed once the quiz has started.', 'teams_locked');

    const players = (
      db
        .prepare('SELECT user_id FROM event_participants WHERE event_id = ? AND user_id IS NOT ?')
        .all(eventId, event.question_master_id) as { user_id: number }[]
    ).map((r) => r.user_id);
    if (count < 2 || count > MAX_TEAMS) throw badRequest(`Pick between 2 and ${MAX_TEAMS} teams.`, 'team_count');
    if (players.length < count) throw badRequest('There are not enough players for that many teams.', 'team_count');

    // Fisher-Yates, then deal the players round the teams like cards.
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    db.prepare('DELETE FROM event_teams WHERE event_id = ?').run(eventId);
    const insert = db.prepare('INSERT INTO event_teams (event_id, name, colour, created_by) VALUES (?, ?, ?, ?)');
    const teamIds = TEAM_COLOURS.slice(0, count).map((c) =>
      Number(insert.run(eventId, c.name, c.hex, runnerId).lastInsertRowid),
    );
    const join = db.prepare('INSERT INTO event_team_members (event_id, team_id, user_id) VALUES (?, ?, ?)');
    players.forEach((p, i) => join.run(eventId, teamIds[i % count], p));
  });
}
