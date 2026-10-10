import { Router } from 'express';
import { z } from 'zod';
import { getDb, transaction } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parseBody, parseId } from '../lib/validation.js';
import { getGroup, getMembership, requireAdmin, requireMember } from '../lib/groups.js';
import {
  adjustScore,
  assertCanBeQuestionMaster,
  buildState,
  canWatch,
  getQuizHeadToHead,
  getHeadToHead,
  getEvent,
  isParticipant,
  judgeAnswer,
  openNextQuestion,
  recordBuzz,
  requireEventAdmin,
  requireEventMember,
  requireQuestionMaster,
  type EventRow,
  type Judgement,
} from '../lib/events.js';
import { broadcastEvent } from '../lib/realtime.js';
import { getRules, setRules } from '../lib/rules.js';
import { createTeam, isTeamQuiz, joinTeam, leaveTeam, movePlayer, randomTeams, renameTeam } from '../lib/teams.js';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

const createEventSchema = z.object({
  name: z.string().trim().min(3, 'Event name must be at least 3 characters.').max(80, 'Event name must be 80 characters or fewer.'),
  scheduledFor: z.string().trim().max(40).optional(),
});

const serializeEvent = (e: EventRow, extra: { participantCount: number; joined: boolean; questionMasterName: string | null }) => ({
  id: e.id,
  groupId: e.group_id,
  name: e.name,
  status: e.status,
  scheduledFor: e.scheduled_for,
  questionMasterId: e.question_master_id,
  questionMasterName: extra.questionMasterName,
  createdBy: e.created_by,
  createdAt: e.created_at,
  participantCount: extra.participantCount,
  joined: extra.joined,
});

/** Takes someone off their team in this quiz, tidying the team away if it is now empty. */
function dropFromTeam(eventId: number, userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM event_team_members WHERE event_id = ? AND user_id = ?').run(eventId, userId);
  db.prepare(
    `DELETE FROM event_teams WHERE event_id = ?
       AND id NOT IN (SELECT team_id FROM event_team_members WHERE event_id = ?)`,
  ).run(eventId, eventId);
}

function summarize(eventId: number, viewerId: number) {
  const db = getDb();
  const e = getEvent(db, eventId);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ?').get(eventId) as {
    n: number;
  };
  const master = e.question_master_id
    ? (db.prepare('SELECT username FROM users WHERE id = ?').get(e.question_master_id) as { username: string } | undefined)
    : undefined;
  return serializeEvent(e, {
    participantCount: n,
    joined: isParticipant(db, eventId, viewerId),
    questionMasterName: master?.username ?? null,
  });
}

/** Everything the group has on, newest first. */
eventsRouter.get(
  '/groups/:groupId/events',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);
    requireMember(db, groupId, me);

    const rows = db
      .prepare(
        `SELECT id FROM events WHERE group_id = ?
          ORDER BY status = 'live' DESC, status = 'scheduled' DESC, created_at DESC`,
      )
      .all(groupId) as { id: number }[];
    res.json({ events: rows.map((r) => summarize(r.id, me)) });
  }),
);

/** How you and another member of the group have fared against each other. */
eventsRouter.get(
  '/groups/:groupId/head-to-head/:userId',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const themId = parseId(req.params.userId, 'member');
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);
    requireMember(db, groupId, me);
    if (themId === me) throw badRequest('That is you.', 'self');
    if (getMembership(db, groupId, themId)?.status !== 'approved') {
      throw notFound('That person is not in this group.');
    }

    res.json({ headToHead: getHeadToHead(db, groupId, me, themId) });
  }),
);

/** Admin: put a new quiz night on the calendar. The creator joins it too. */
eventsRouter.post(
  '/groups/:groupId/events',
  asyncHandler(async (req, res) => {
    const groupId = parseId(req.params.groupId, 'group');
    const { name, scheduledFor } = parseBody(createEventSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    getGroup(db, groupId);
    requireAdmin(db, groupId, me);

    const eventId = transaction(db, () => {
      const info = db
        .prepare('INSERT INTO events (group_id, name, scheduled_for, created_by) VALUES (?, ?, ?, ?)')
        .run(groupId, name, scheduledFor ?? null, me);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)').run(id, me);
      return id;
    });

    res.status(201).json({ event: summarize(eventId, me) });
  }),
);

/** The whole live picture: who is playing, the queue, and the scores. */
eventsRouter.get(
  '/events/:eventId',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    res.json({ state: buildState(getDb(), eventId, req.user!.uid) });
  }),
);

/** Join an event you are playing in. */
eventsRouter.post(
  '/events/:eventId/join',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    requireEventMember(db, event, me);
    if (event.status === 'finished') throw badRequest('That event has finished.', 'finished');

    db.prepare('INSERT OR IGNORE INTO event_participants (event_id, user_id) VALUES (?, ?)').run(eventId, me);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Drop out of an event. */
eventsRouter.delete(
  '/events/:eventId/join',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    requireEventMember(db, event, me);
    if (event.question_master_id === me) {
      throw badRequest('You are the question master. Hand that over before you leave.', 'is_question_master');
    }

    transaction(db, () => {
      db.prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?').run(eventId, me);
      dropFromTeam(eventId, me);
    });
    await broadcastEvent(eventId);
    res.json({ left: true });
  }),
);

/** Admin: hand someone the question master's screen. */
const questionMasterSchema = z.object({ userId: z.number().int().positive() });
eventsRouter.post(
  '/events/:eventId/question-master',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { userId } = parseBody(questionMasterSchema, req.body);
    const db = getDb();
    const event = getEvent(db, eventId);
    requireEventAdmin(db, event, req.user!.uid);
    assertCanBeQuestionMaster(db, event, userId);

    transaction(db, () => {
      db.prepare('UPDATE events SET question_master_id = ? WHERE id = ?').run(userId, eventId);
      // The question master runs the quiz rather than playing in a team.
      dropFromTeam(eventId, userId);
    });
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, req.user!.uid) });
  }),
);

/** Admin or question master: go live, and open the first question. */
eventsRouter.post(
  '/events/:eventId/start',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    if (event.question_master_id !== me) requireEventAdmin(db, event, me);
    if (event.status === 'finished') throw conflict('That event has already finished.', 'finished');
    if (!event.question_master_id) {
      throw badRequest('Pick a question master before you start.', 'no_question_master');
    }

    if (event.status !== 'live') {
      db.prepare(`UPDATE events SET status = 'live', started_at = datetime('now') WHERE id = ?`).run(eventId);
      openNextQuestion(db, eventId);
    }
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Admin or question master: call it a night. */
eventsRouter.post(
  '/events/:eventId/finish',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    if (event.question_master_id !== me) requireEventAdmin(db, event, me);

    transaction(db, () => {
      if (event.current_question_id) {
        db.prepare(`UPDATE questions SET state = 'closed', closed_at = datetime('now') WHERE id = ?`).run(
          event.current_question_id,
        );
      }
      db.prepare(
        `UPDATE events SET status = 'finished', ended_at = datetime('now'), current_question_id = NULL WHERE id = ?`,
      ).run(eventId);
    });

    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/**
 * Question master or admin: bring a finished quiz back to life.
 *
 * Scores, the people playing and the questions already asked all stay as they
 * were, and a fresh question opens so the next buzz counts — a quiz ended by a
 * mistimed tap picks up where it left off.
 */
eventsRouter.post(
  '/events/:eventId/reopen',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    if (event.question_master_id !== me) requireEventAdmin(db, event, me);

    if (event.status === 'live') return res.json({ state: buildState(db, eventId, me) });
    if (event.status !== 'finished') {
      throw badRequest('That quiz has not finished, so there is nothing to re-open.', 'not_finished');
    }
    if (!event.question_master_id) {
      throw badRequest('Pick a question master before you re-open this.', 'no_question_master');
    }

    transaction(db, () => {
      db.prepare(`UPDATE events SET status = 'live', ended_at = NULL WHERE id = ?`).run(eventId);
      openNextQuestion(db, eventId);
    });

    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/**
 * Buzz in. The live app sends this over the socket; this is the same thing over
 * HTTP, so the behaviour can be driven without a socket.
 */
eventsRouter.post(
  '/events/:eventId/buzz',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    recordBuzz(db, eventId, me);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Question master: right (1), pass (0) or wrong (-1) for whoever is answering. */
const judgeSchema = z.object({ delta: z.union([z.literal(1), z.literal(0), z.literal(-1)]) });
eventsRouter.post(
  '/events/:eventId/judge',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { delta } = parseBody(judgeSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    judgeAnswer(db, eventId, me, delta as Judgement);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Question master: change someone's score by hand (press and hold their name). */
const adjustSchema = z.object({
  userId: z.number().int().positive(),
  delta: z
    .number()
    .int()
    .min(-50)
    .max(50)
    .refine((d) => d !== 0, 'Pick a change other than 0.'),
});
eventsRouter.post(
  '/events/:eventId/adjust',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { userId, delta } = parseBody(adjustSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    adjustScore(db, eventId, me, userId, delta);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** You against one other player, in this quiz only (tap their name on the final scores). */
eventsRouter.get(
  '/events/:eventId/head-to-head/:userId',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const themId = parseId(req.params.userId, 'player');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    if (!canWatch(db, event, me)) throw forbidden('You need to be in this group.');
    if (themId === me) throw badRequest('That is you.', 'self');
    if (event.status !== 'finished') {
      throw badRequest('Head-to-head opens once the quiz has finished.', 'not_finished');
    }
    if (isTeamQuiz(db, eventId)) throw badRequest('Team quizzes do not count for head-to-head.', 'team_quiz');
    res.json({ headToHead: getQuizHeadToHead(db, eventId, me, themId) });
  }),
);

/** Question master: give up on this one and move everyone to the next question. */
eventsRouter.post(
  '/events/:eventId/next-question',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    requireQuestionMaster(event, me);
    if (event.status !== 'live') throw badRequest('This event has not started yet.', 'not_live');

    transaction(db, () => {
      if (event.current_question_id) {
        db.prepare(`UPDATE buzzes SET outcome = 'skipped' WHERE question_id = ? AND outcome IN ('waiting','answering')`).run(
          event.current_question_id,
        );
      }
      openNextQuestion(db, eventId);
    });

    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/**
 * Admin or question master: set how this quiz is played. Allowed at any point
 * until it finishes, so the points can change between rounds.
 */
const pointsSchema = z.object({
  right: z.number().int().min(-100, 'Points go from -100 to 100.').max(100, 'Points go from -100 to 100.'),
  wrong: z.number().int().min(-100, 'Points go from -100 to 100.').max(100, 'Points go from -100 to 100.'),
});
const rulesSchema = z.object({
  // Left out by older screens; the quiz then keeps whatever it had.
  playAs: z.enum(['individuals', 'teams']).optional(),
  secondBuzz: z.enum(['queue', 'reopen', 'one_shot']),
  points: z.tuple([pointsSchema, pointsSchema, pointsSchema]),
});
eventsRouter.post(
  '/events/:eventId/rules',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const body = parseBody(rulesSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    const event = getEvent(db, eventId);
    if (event.question_master_id !== me) requireEventAdmin(db, event, me);
    if (event.status === 'finished') throw badRequest('That quiz has finished.', 'finished');

    const playAs = body.playAs ?? getRules(db, eventId).playAs;
    if (playAs !== getRules(db, eventId).playAs && event.status !== 'scheduled') {
      throw conflict('Switch between teams and individuals before the quiz starts.', 'started');
    }
    setRules(db, eventId, { ...body, playAs });
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

// ------------------------------------------------------------------ teams --

const teamNameSchema = z.object({
  name: z.string().trim().min(1, 'Give the team a name.').max(24, 'Team names can be 24 characters at most.'),
});

/** A player starts a team and names it. Only in a quiz switched to teams. */
eventsRouter.post(
  '/events/:eventId/teams',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { name } = parseBody(teamNameSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    createTeam(db, eventId, me, name);
    await broadcastEvent(eventId);
    res.status(201).json({ state: buildState(db, eventId, me) });
  }),
);

/** Join a team someone else has made. */
eventsRouter.post(
  '/events/:eventId/teams/:teamId/join',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const teamId = parseId(req.params.teamId, 'team');
    const me = req.user!.uid;
    const db = getDb();
    joinTeam(db, eventId, me, teamId);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Step off your team, before the quiz starts. */
eventsRouter.delete(
  '/events/:eventId/team',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const me = req.user!.uid;
    const db = getDb();
    leaveTeam(db, eventId, me);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Rename a team: anyone on it, the question master or an admin. */
eventsRouter.post(
  '/events/:eventId/teams/:teamId/name',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const teamId = parseId(req.params.teamId, 'team');
    const { name } = parseBody(teamNameSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    renameTeam(db, eventId, me, teamId, name);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Question master or admin: put a player on a team, or (teamId null) take them off. */
const moveSchema = z.object({ userId: z.number().int().positive(), teamId: z.number().int().positive().nullable() });
eventsRouter.post(
  '/events/:eventId/teams/move',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { userId, teamId } = parseBody(moveSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    movePlayer(db, eventId, me, userId, teamId);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);

/** Question master or admin: shuffle everyone into random teams. */
const randomSchema = z.object({ count: z.number().int() });
eventsRouter.post(
  '/events/:eventId/teams/random',
  asyncHandler(async (req, res) => {
    const eventId = parseId(req.params.eventId, 'event');
    const { count } = parseBody(randomSchema, req.body);
    const me = req.user!.uid;
    const db = getDb();
    randomTeams(db, eventId, me, count);
    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);
