import { transaction, type DB } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { getMembership } from './groups.js';

export interface EventRow {
  id: number;
  group_id: number;
  name: string;
  scheduled_for: string | null;
  status: 'scheduled' | 'live' | 'finished';
  question_master_id: number | null;
  current_question_id: number | null;
  created_by: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface QuestionRow {
  id: number;
  event_id: number;
  seq: number;
  state: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
}

export type BuzzOutcome = 'waiting' | 'answering' | 'correct' | 'pass' | 'wrong' | 'skipped';

export interface BuzzRow {
  id: number;
  question_id: number;
  user_id: number;
  seq: number;
  buzzed_at: string;
  outcome: BuzzOutcome;
}

// -------------------------------------------------------------- lookups --

export function getEvent(db: DB, eventId: number): EventRow {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
  if (!row) throw notFound('That event no longer exists.');
  return row;
}

/** The caller must be an approved member of the event's group. */
export function requireEventMember(db: DB, event: EventRow, userId: number) {
  const m = getMembership(db, event.group_id, userId);
  if (!m || m.status !== 'approved') throw forbidden('You need to be in this group to see its events.');
  return m;
}

/** The caller must be an admin of the event's group. */
export function requireEventAdmin(db: DB, event: EventRow, userId: number) {
  const m = requireEventMember(db, event, userId);
  if (m.role !== 'admin') throw forbidden('Only group admins can do that.');
  return m;
}

/** The caller must be the question master. */
export function requireQuestionMaster(event: EventRow, userId: number): void {
  if (event.question_master_id !== userId) throw forbidden('Only the question master can do that.');
}

export function isParticipant(db: DB, eventId: number, userId: number): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ?').get(eventId, userId),
  );
}

/** Anyone in the group may watch; the state shown just depends on who they are. */
export function canWatch(db: DB, event: EventRow, userId: number): boolean {
  const m = getMembership(db, event.group_id, userId);
  return m?.status === 'approved';
}

// ------------------------------------------------------------- questions --

export function getOpenQuestion(db: DB, event: EventRow): QuestionRow | undefined {
  if (!event.current_question_id) return undefined;
  return db.prepare('SELECT * FROM questions WHERE id = ?').get(event.current_question_id) as
    | QuestionRow
    | undefined;
}

/**
 * Closes whatever question is open and opens the next one, so everybody's
 * button goes back to BUZZ! and the queue starts empty again.
 */
export function openNextQuestion(db: DB, eventId: number): QuestionRow {
  const event = getEvent(db, eventId);
  if (event.current_question_id) {
    db.prepare(`UPDATE questions SET state = 'closed', closed_at = datetime('now') WHERE id = ? AND state = 'open'`).run(
      event.current_question_id,
    );
  }
  const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM questions WHERE event_id = ?').get(
    eventId,
  ) as { next: number };
  const info = db.prepare(`INSERT INTO questions (event_id, seq) VALUES (?, ?)`).run(eventId, next);
  const questionId = Number(info.lastInsertRowid);
  db.prepare('UPDATE events SET current_question_id = ? WHERE id = ?').run(questionId, eventId);
  return db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as unknown as QuestionRow;
}

// ----------------------------------------------------------------- buzzes --

export function getQueue(db: DB, questionId: number): (BuzzRow & { username: string })[] {
  return db
    .prepare(
      `SELECT b.*, u.username FROM buzzes b JOIN users u ON u.id = b.user_id
        WHERE b.question_id = ? ORDER BY b.seq`,
    )
    .all(questionId) as unknown as (BuzzRow & { username: string })[];
}

/** Whoever is currently holding the floor — the name everyone's button shows. */
export function getAnswering(db: DB, questionId: number): (BuzzRow & { username: string }) | undefined {
  return db
    .prepare(
      `SELECT b.*, u.username FROM buzzes b JOIN users u ON u.id = b.user_id
        WHERE b.question_id = ? AND b.outcome = 'answering' ORDER BY b.seq LIMIT 1`,
    )
    .get(questionId) as (BuzzRow & { username: string }) | undefined;
}

/**
 * Records a buzz. The first buzz on a question takes the floor; later ones
 * queue up behind it in the order they arrived. The whole read-then-insert
 * runs in one transaction, so the sequence number settles the race honestly.
 */
export function recordBuzz(db: DB, eventId: number, userId: number): { accepted: boolean } {
  return transaction(db, () => {
    const event = getEvent(db, eventId);
    if (event.status !== 'live') throw badRequest('This event has not started yet.', 'not_live');
    if (event.question_master_id === userId) throw forbidden('The question master does not buzz in.');
    if (!isParticipant(db, eventId, userId)) throw forbidden('Join the event before you buzz in.');

    const question = getOpenQuestion(db, event);
    if (!question || question.state !== 'open') throw badRequest('No question is open right now.', 'no_question');

    const already = db
      .prepare('SELECT 1 FROM buzzes WHERE question_id = ? AND user_id = ?')
      .get(question.id, userId);
    if (already) return { accepted: false };

    const { next } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM buzzes WHERE question_id = ?')
      .get(question.id) as { next: number };

    db.prepare('INSERT INTO buzzes (question_id, user_id, seq, outcome) VALUES (?, ?, ?, ?)').run(
      question.id,
      userId,
      next,
      next === 1 ? 'answering' : 'waiting',
    );
    return { accepted: true };
  });
}

// ---------------------------------------------------------------- scoring --

export type Judgement = 1 | 0 | -1;

/**
 * The question master's +1 / 0 / -1.
 *
 * +1 ends the question: the queue is cleared and everyone resets for the next
 * one. 0 and -1 hand the floor to the next person who buzzed, until the queue
 * runs out — then the question ends the same way.
 */
export function judgeAnswer(
  db: DB,
  eventId: number,
  masterId: number,
  delta: Judgement,
): { scored: number; nextQuestion: boolean } {
  return transaction(db, () => {
    const event = getEvent(db, eventId);
    requireQuestionMaster(event, masterId);
    if (event.status !== 'live') throw badRequest('This event has not started yet.', 'not_live');

    const question = getOpenQuestion(db, event);
    if (!question || question.state !== 'open') throw badRequest('No question is open right now.', 'no_question');

    const current = getAnswering(db, question.id);
    if (!current) throw badRequest('Nobody has buzzed in yet.', 'nobody_answering');

    const outcome: BuzzOutcome = delta === 1 ? 'correct' : delta === 0 ? 'pass' : 'wrong';
    db.prepare('UPDATE buzzes SET outcome = ? WHERE id = ?').run(outcome, current.id);

    if (delta !== 0) {
      db.prepare(
        `INSERT INTO score_events (event_id, user_id, question_id, delta, awarded_by) VALUES (?, ?, ?, ?, ?)`,
      ).run(eventId, current.user_id, question.id, delta, masterId);
      db.prepare('UPDATE event_participants SET score = score + ? WHERE event_id = ? AND user_id = ?').run(
        delta,
        eventId,
        current.user_id,
      );
    }

    // A right answer ends the question; so does running out of people to ask.
    const next =
      delta === 1
        ? undefined
        : (db
            .prepare(
              `SELECT * FROM buzzes WHERE question_id = ? AND outcome = 'waiting' ORDER BY seq LIMIT 1`,
            )
            .get(question.id) as BuzzRow | undefined);

    if (next) {
      db.prepare(`UPDATE buzzes SET outcome = 'answering' WHERE id = ?`).run(next.id);
      return { scored: current.user_id, nextQuestion: false };
    }

    db.prepare(`UPDATE buzzes SET outcome = 'skipped' WHERE question_id = ? AND outcome = 'waiting'`).run(question.id);
    openNextQuestion(db, eventId);
    return { scored: current.user_id, nextQuestion: true };
  });
}

// ------------------------------------------------------------ leaderboard --

export interface BoardEntry {
  place: number;
  userId: number;
  username: string;
  score: number;
}

/**
 * Everyone playing, best first. Equal scores share a place, so the next person
 * down takes the place their row number implies (1, 2, 2, 4).
 *
 * The question master is left out: they can't buzz or be scored, and a row for
 * them would push a real player out of the five the board has room for.
 */
export function getLeaderboard(db: DB, eventId: number): BoardEntry[] {
  const rows = db
    .prepare(
      `SELECT p.user_id, p.score, u.username
         FROM event_participants p
         JOIN users u ON u.id = p.user_id
         JOIN events e ON e.id = p.event_id
        WHERE p.event_id = ?
          AND (e.question_master_id IS NULL OR e.question_master_id <> p.user_id)
        ORDER BY p.score DESC, u.username COLLATE NOCASE`,
    )
    .all(eventId) as { user_id: number; score: number; username: string }[];

  let place = 0;
  let lastScore: number | null = null;
  return rows.map((r, i) => {
    if (lastScore === null || r.score !== lastScore) {
      place = i + 1;
      lastScore = r.score;
    }
    return { place, userId: r.user_id, username: r.username, score: r.score };
  });
}

// ---------------------------------------------------------- state payload --

export interface EventState {
  event: {
    id: number;
    groupId: number;
    groupName: string;
    name: string;
    status: EventRow['status'];
    questionMasterId: number | null;
    questionMasterName: string | null;
    scheduledFor: string | null;
    createdBy: number;
  };
  me: {
    userId: number;
    isAdmin: boolean;
    isQuestionMaster: boolean;
    isParticipant: boolean;
    hasBuzzed: boolean;
  };
  question: { id: number; seq: number } | null;
  /** Whoever the BUZZ! button should be showing right now, if anyone. */
  answering: { userId: number; username: string } | null;
  queue: { userId: number; username: string; seq: number; outcome: BuzzOutcome }[];
  leaderboard: BoardEntry[];
  participants: { id: number; username: string; score: number }[];
}

/** The single payload every screen renders from, over REST and over sockets alike. */
export function buildState(db: DB, eventId: number, viewerId: number): EventState {
  const event = getEvent(db, eventId);
  const membership = getMembership(db, event.group_id, viewerId);
  if (membership?.status !== 'approved') throw forbidden('You need to be in this group to see its events.');

  const group = db.prepare('SELECT name FROM groups WHERE id = ?').get(event.group_id) as { name: string };
  const master = event.question_master_id
    ? (db.prepare('SELECT username FROM users WHERE id = ?').get(event.question_master_id) as
        | { username: string }
        | undefined)
    : undefined;

  const question = getOpenQuestion(db, event);
  const queue = question && question.state === 'open' ? getQueue(db, question.id) : [];
  const answering = queue.find((b) => b.outcome === 'answering');

  const participants = db
    .prepare(
      `SELECT u.id, u.username, p.score FROM event_participants p JOIN users u ON u.id = p.user_id
        WHERE p.event_id = ? ORDER BY u.username COLLATE NOCASE`,
    )
    .all(eventId) as { id: number; username: string; score: number }[];

  return {
    event: {
      id: event.id,
      groupId: event.group_id,
      groupName: group.name,
      name: event.name,
      status: event.status,
      questionMasterId: event.question_master_id,
      questionMasterName: master?.username ?? null,
      scheduledFor: event.scheduled_for,
      createdBy: event.created_by,
    },
    me: {
      userId: viewerId,
      isAdmin: membership.role === 'admin',
      isQuestionMaster: event.question_master_id === viewerId,
      isParticipant: participants.some((p) => p.id === viewerId),
      hasBuzzed: queue.some((b) => b.user_id === viewerId),
    },
    question: question && question.state === 'open' ? { id: question.id, seq: question.seq } : null,
    answering: answering ? { userId: answering.user_id, username: answering.username } : null,
    queue: queue.map((b) => ({ userId: b.user_id, username: b.username, seq: b.seq, outcome: b.outcome })),
    leaderboard: getLeaderboard(db, eventId),
    participants,
  };
}

/** Guards a would-be question master: they have to be playing in the event. */
export function assertCanBeQuestionMaster(db: DB, event: EventRow, userId: number): void {
  const m = getMembership(db, event.group_id, userId);
  if (m?.status !== 'approved') throw badRequest('That person is not in this group.', 'not_a_member');
  if (!isParticipant(db, event.id, userId)) {
    throw conflict('That person has not joined the event yet.', 'not_joined');
  }
}

// ----------------------------------------------------------- head to head --

export interface HeadToHead {
  opponent: { id: number; username: string };
  /** Finished quizzes in this group that both of you actually played. */
  quizzes: { played: number; won: number; lost: number; drawn: number };
  /** Questions where you both buzzed, and who got there first. */
  buzzer: { contested: number; youFirst: number; themFirst: number };
  meetings: {
    eventId: number;
    name: string;
    yourScore: number;
    theirScore: number;
    result: 'won' | 'lost' | 'drawn';
    endedAt: string | null;
  }[];
}

/**
 * How two members of a group have fared against each other.
 *
 * A quiz only counts once it has finished and both of you were playing it.
 * Whoever ran a quiz is left out of its result, since the question master has
 * no score of their own to compare.
 */
export function getHeadToHead(db: DB, groupId: number, meId: number, themId: number): HeadToHead {
  const them = db.prepare('SELECT id, username FROM users WHERE id = ?').get(themId) as
    | { id: number; username: string }
    | undefined;
  if (!them) throw notFound('That person no longer has an account.');

  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.ended_at, mine.score AS my_score, theirs.score AS their_score
         FROM events e
         JOIN event_participants mine   ON mine.event_id   = e.id AND mine.user_id   = @me
         JOIN event_participants theirs ON theirs.event_id = e.id AND theirs.user_id = @them
        WHERE e.group_id = @group
          AND e.status = 'finished'
          AND e.question_master_id IS NOT @me
          AND e.question_master_id IS NOT @them
        ORDER BY e.ended_at DESC, e.id DESC`,
    )
    .all({ group: groupId, me: meId, them: themId }) as unknown as {
    id: number;
    name: string;
    ended_at: string | null;
    my_score: number;
    their_score: number;
  }[];

  const meetings = rows.map((r) => ({
    eventId: r.id,
    name: r.name,
    yourScore: r.my_score,
    theirScore: r.their_score,
    result: (r.my_score > r.their_score ? 'won' : r.my_score < r.their_score ? 'lost' : 'drawn') as
      | 'won'
      | 'lost'
      | 'drawn',
    endedAt: r.ended_at,
  }));

  // Every question you both buzzed on, whatever became of the quiz: the lower
  // sequence number got there first.
  const race = db
    .prepare(
      `SELECT
         SUM(CASE WHEN mine.seq < theirs.seq THEN 1 ELSE 0 END) AS you_first,
         SUM(CASE WHEN mine.seq > theirs.seq THEN 1 ELSE 0 END) AS them_first,
         COUNT(*) AS contested
       FROM questions q
       JOIN events e ON e.id = q.event_id
       JOIN buzzes mine   ON mine.question_id   = q.id AND mine.user_id   = @me
       JOIN buzzes theirs ON theirs.question_id = q.id AND theirs.user_id = @them
      WHERE e.group_id = @group`,
    )
    .get({ group: groupId, me: meId, them: themId }) as unknown as {
    you_first: number | null;
    them_first: number | null;
    contested: number;
  };

  return {
    opponent: { id: them.id, username: them.username },
    quizzes: {
      played: meetings.length,
      won: meetings.filter((m) => m.result === 'won').length,
      lost: meetings.filter((m) => m.result === 'lost').length,
      drawn: meetings.filter((m) => m.result === 'drawn').length,
    },
    buzzer: {
      contested: race.contested ?? 0,
      youFirst: race.you_first ?? 0,
      themFirst: race.them_first ?? 0,
    },
    meetings,
  };
}
