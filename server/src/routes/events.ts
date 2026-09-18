import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/async.js';
import { badRequest, conflict } from '../lib/errors.js';
import { parseBody, parseId } from '../lib/validation.js';
import { getGroup, requireAdmin, requireMember } from '../lib/groups.js';
import {
  assertCanBeQuestionMaster,
  buildState,
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

    const eventId = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO events (group_id, name, scheduled_for, created_by) VALUES (?, ?, ?, ?)')
        .run(groupId, name, scheduledFor ?? null, me);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)').run(id, me);
      return id;
    })();

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

    db.prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?').run(eventId, me);
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

    db.prepare('UPDATE events SET question_master_id = ? WHERE id = ?').run(userId, eventId);
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

    db.transaction(() => {
      if (event.current_question_id) {
        db.prepare(`UPDATE questions SET state = 'closed', closed_at = datetime('now') WHERE id = ?`).run(
          event.current_question_id,
        );
      }
      db.prepare(
        `UPDATE events SET status = 'finished', ended_at = datetime('now'), current_question_id = NULL WHERE id = ?`,
      ).run(eventId);
    })();

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

/** Question master: +1, 0 or -1 for whoever is answering. */
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

    db.transaction(() => {
      if (event.current_question_id) {
        db.prepare(`UPDATE buzzes SET outcome = 'skipped' WHERE question_id = ? AND outcome IN ('waiting','answering')`).run(
          event.current_question_id,
        );
      }
      openNextQuestion(db, eventId);
    })();

    await broadcastEvent(eventId);
    res.json({ state: buildState(db, eventId, me) });
  }),
);
