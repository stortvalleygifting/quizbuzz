import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { openDatabase, setDb } from '../lib/db.js';
import { createApp } from '../app.js';

let app: Express;

beforeEach(() => {
  setDb(openDatabase(':memory:'));
  app = createApp();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(username: string) {
  const res = await request(app).post('/api/auth/register').send({ username, password: 'hunter2hunter2' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as number, username };
}

interface Player {
  token: string;
  id: number;
  username: string;
}

/**
 * A group with an admin and some members, all joined to a live event with the
 * admin as question master — the state most of these tests start from.
 */
async function liveEvent(memberNames: string[]) {
  const owner = await register('owner');
  const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
    .group.id as number;

  const players: Player[] = [];
  for (const name of memberNames) {
    const p = await register(name);
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(p.token));
    await request(app).post(`/api/groups/${groupId}/members/${p.id}/approve`).set(auth(owner.token));
    players.push(p);
  }

  const eventId = (
    await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
  ).body.event.id as number;

  for (const p of players) await request(app).post(`/api/events/${eventId}/join`).set(auth(p.token));
  await request(app)
    .post(`/api/events/${eventId}/question-master`)
    .set(auth(owner.token))
    .send({ userId: owner.id });
  const started = await request(app).post(`/api/events/${eventId}/start`).set(auth(owner.token));
  expect(started.status).toBe(200);

  return { owner, groupId, eventId, players };
}

const state = async (eventId: number, token: string) =>
  (await request(app).get(`/api/events/${eventId}`).set(auth(token))).body.state;

const buzz = (eventId: number, token: string) =>
  request(app).post(`/api/events/${eventId}/buzz`).set(auth(token));

const judge = (eventId: number, token: string, delta: number) =>
  request(app).post(`/api/events/${eventId}/judge`).set(auth(token)).send({ delta });

describe('events', () => {
  it('lets a group admin create an event and joins them to it', async () => {
    const owner = await register('owner');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
      .group.id;

    const created = await request(app)
      .post(`/api/groups/${groupId}/events`)
      .set(auth(owner.token))
      .send({ name: 'Quiz night', scheduledFor: 'Thursday 8pm' });

    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject({ name: 'Quiz night', status: 'scheduled', joined: true });
  });

  it('will not let a plain member create an event', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
      .group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));

    const attempt = await request(app)
      .post(`/api/groups/${groupId}/events`)
      .set(auth(member.token))
      .send({ name: 'Quiz night' });
    expect(attempt.status).toBe(403);
  });

  it('hides a group’s events from outsiders', async () => {
    const { eventId } = await liveEvent(['ann']);
    const outsider = await register('outsider');
    const peek = await request(app).get(`/api/events/${eventId}`).set(auth(outsider.token));
    expect(peek.status).toBe(403);
  });

  it('lets members join and leave an event', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
      .group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));
    const eventId = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
    ).body.event.id;

    const joined = await request(app).post(`/api/events/${eventId}/join`).set(auth(member.token));
    expect(joined.status).toBe(200);
    expect(joined.body.state.me.isParticipant).toBe(true);
    expect(joined.body.state.participants).toHaveLength(2);

    const left = await request(app).delete(`/api/events/${eventId}/join`).set(auth(member.token));
    expect(left.status).toBe(200);
    expect((await state(eventId, member.token)).participants).toHaveLength(1);
  });

  it('only makes a participant the question master, and only on an admin’s say-so', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
      .group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));
    const eventId = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
    ).body.event.id;

    const notJoined = await request(app)
      .post(`/api/events/${eventId}/question-master`)
      .set(auth(owner.token))
      .send({ userId: member.id });
    expect(notJoined.status).toBe(409);

    await request(app).post(`/api/events/${eventId}/join`).set(auth(member.token));
    const byMember = await request(app)
      .post(`/api/events/${eventId}/question-master`)
      .set(auth(member.token))
      .send({ userId: member.id });
    expect(byMember.status).toBe(403);

    const byAdmin = await request(app)
      .post(`/api/events/${eventId}/question-master`)
      .set(auth(owner.token))
      .send({ userId: member.id });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.state.event.questionMasterName).toBe('member');
  });

  it('will not start without a question master', async () => {
    const owner = await register('owner');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
      .group.id;
    const eventId = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
    ).body.event.id;

    const start = await request(app).post(`/api/events/${eventId}/start`).set(auth(owner.token));
    expect(start.status).toBe(400);
    expect(start.body.code).toBe('no_question_master');
  });
});

describe('buzzing in', () => {
  it('shows everyone the first buzzer and keeps the rest in order', async () => {
    const { eventId, players } = await liveEvent(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;

    expect((await buzz(eventId, bob.token)).status).toBe(200);
    await buzz(eventId, cat.token);
    await buzz(eventId, ann.token);

    // Everyone's button shows whoever got there first.
    for (const p of players) {
      expect((await state(eventId, p.token)).answering.username).toBe('bob');
    }

    const queue = (await state(eventId, ann.token)).queue;
    expect(queue.map((b: { username: string }) => b.username)).toEqual(['bob', 'cat', 'ann']);
    expect(queue.map((b: { outcome: string }) => b.outcome)).toEqual(['answering', 'waiting', 'waiting']);
  });

  it('ignores a second buzz from the same person', async () => {
    const { eventId, players } = await liveEvent(['ann', 'bob']);
    await buzz(eventId, players[0].token);
    await buzz(eventId, players[0].token);
    expect((await state(eventId, players[0].token)).queue).toHaveLength(1);
  });

  it('refuses buzzes from the question master, non-participants and before kick-off', async () => {
    const { eventId, owner, groupId, players } = await liveEvent(['ann']);
    const qmBuzz = await buzz(eventId, owner.token);
    expect(qmBuzz.status).toBe(403);

    const watcher = await register('watcher');
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(watcher.token));
    await request(app).post(`/api/groups/${groupId}/members/${watcher.id}/approve`).set(auth(owner.token));
    const notPlaying = await buzz(eventId, watcher.token);
    expect(notPlaying.status).toBe(403);

    const later = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Next week' })
    ).body.event.id;
    await request(app).post(`/api/events/${later}/join`).set(auth(players[0].token));
    const tooEarly = await buzz(later, players[0].token);
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.code).toBe('not_live');
  });
});

describe('scoring', () => {
  it('gives +1, clears the queue and resets everyone for the next question', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    await buzz(eventId, ann.token);
    await buzz(eventId, bob.token);

    const scored = await judge(eventId, owner.token, 1);
    expect(scored.status).toBe(200);

    const after = await state(eventId, bob.token);
    expect(after.answering).toBeNull();
    expect(after.queue).toHaveLength(0);
    expect(after.me.hasBuzzed).toBe(false);
    expect(after.leaderboard.find((e: { username: string }) => e.username === 'ann').score).toBe(1);
    expect(after.leaderboard.find((e: { username: string }) => e.username === 'bob').score).toBe(0);

    // Everyone can buzz again on the new question.
    expect((await buzz(eventId, bob.token)).status).toBe(200);
    expect((await state(eventId, bob.token)).answering.username).toBe('bob');
  });

  it('moves to the next buzzer on 0 and on -1, scoring only the -1', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;

    await buzz(eventId, ann.token);
    await buzz(eventId, bob.token);
    await buzz(eventId, cat.token);

    await judge(eventId, owner.token, 0);
    let now = await state(eventId, ann.token);
    expect(now.answering.username).toBe('bob');
    expect(now.leaderboard.find((e: { username: string }) => e.username === 'ann').score).toBe(0);

    await judge(eventId, owner.token, -1);
    now = await state(eventId, ann.token);
    expect(now.answering.username).toBe('cat');
    expect(now.leaderboard.find((e: { username: string }) => e.username === 'bob').score).toBe(-1);
  });

  it('ends the question once everyone who buzzed has had their turn', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    await buzz(eventId, players[0].token);
    await buzz(eventId, players[1].token);

    await judge(eventId, owner.token, 0);
    await judge(eventId, owner.token, -1);

    const after = await state(eventId, players[0].token);
    expect(after.answering).toBeNull();
    expect(after.queue).toHaveLength(0);
    expect(after.question).not.toBeNull();
    expect((await buzz(eventId, players[0].token)).status).toBe(200);
  });

  it('only lets the question master score, and only when someone is answering', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);

    const nobody = await judge(eventId, owner.token, 1);
    expect(nobody.status).toBe(400);
    expect(nobody.body.code).toBe('nobody_answering');

    await buzz(eventId, players[0].token);
    const byPlayer = await judge(eventId, players[1].token, 1);
    expect(byPlayer.status).toBe(403);

    const bad = await request(app)
      .post(`/api/events/${eventId}/judge`)
      .set(auth(owner.token))
      .send({ delta: 5 });
    expect(bad.status).toBe(400);
  });

  it('lets the question master abandon a question', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    await buzz(eventId, players[0].token);

    const skipped = await request(app).post(`/api/events/${eventId}/next-question`).set(auth(owner.token));
    expect(skipped.status).toBe(200);

    const after = await state(eventId, players[0].token);
    expect(after.answering).toBeNull();
    expect(after.queue).toHaveLength(0);
    expect(after.leaderboard.every((e: { score: number }) => e.score === 0)).toBe(true);
  });
});

describe('the scoreboard', () => {
  it('ranks by score, shares a place on a tie and leaves the question master out', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;

    // ann 2, bob 1, cat 1 — bob and cat share second.
    for (const winner of [ann, ann, bob, cat]) {
      await buzz(eventId, winner.token);
      await judge(eventId, owner.token, 1);
    }

    const board = (await state(eventId, ann.token)).leaderboard;
    expect(board.map((e: { username: string; place: number; score: number }) => [e.username, e.place, e.score])).toEqual([
      ['ann', 1, 2],
      ['bob', 2, 1],
      ['cat', 2, 1],
    ]);
  });

  it('re-opens a finished quiz with the scores intact', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    const [ann] = players;

    await buzz(eventId, ann.token);
    await judge(eventId, owner.token, 1);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    const reopened = await request(app).post(`/api/events/${eventId}/reopen`).set(auth(owner.token));
    expect(reopened.status).toBe(200);
    expect(reopened.body.state.event.status).toBe('live');
    expect(reopened.body.state.question).not.toBeNull();
    expect(reopened.body.state.leaderboard.find((e: { username: string }) => e.username === 'ann').score).toBe(1);

    // Play carries on from where it stopped, and the question numbering with it.
    expect((await buzz(eventId, ann.token)).status).toBe(200);
    await judge(eventId, owner.token, 1);
    expect((await state(eventId, ann.token)).leaderboard.find((e: { username: string }) => e.username === 'ann').score).toBe(2);
  });

  it('lets a group admin re-open it too, but nobody else', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    // Hand the question master's screen to ann, so owner is admin-but-not-QM.
    await request(app)
      .post(`/api/events/${eventId}/question-master`)
      .set(auth(owner.token))
      .send({ userId: players[0].id });
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(players[0].token));

    const byPlayer = await request(app).post(`/api/events/${eventId}/reopen`).set(auth(players[1].token));
    expect(byPlayer.status).toBe(403);

    const byAdmin = await request(app).post(`/api/events/${eventId}/reopen`).set(auth(owner.token));
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.state.event.status).toBe('live');
  });

  it('shrugs off re-opening a quiz that is already running, and refuses one never started', async () => {
    const { eventId, owner } = await liveEvent(['ann']);

    const alreadyLive = await request(app).post(`/api/events/${eventId}/reopen`).set(auth(owner.token));
    expect(alreadyLive.status).toBe(200);
    expect(alreadyLive.body.state.event.status).toBe('live');

    const scheduled = (
      await request(app)
        .post(`/api/groups/${alreadyLive.body.state.event.groupId}/events`)
        .set(auth(owner.token))
        .send({ name: 'Next week' })
    ).body.event.id;
    const notStarted = await request(app).post(`/api/events/${scheduled}/reopen`).set(auth(owner.token));
    expect(notStarted.status).toBe(400);
    expect(notStarted.body.code).toBe('not_finished');
  });

  it('lets people join a re-opened quiz again', async () => {
    const { eventId, owner, groupId } = await liveEvent(['ann']);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    const latecomer = await register('latecomer');
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(latecomer.token));
    await request(app).post(`/api/groups/${groupId}/members/${latecomer.id}/approve`).set(auth(owner.token));

    const tooLate = await request(app).post(`/api/events/${eventId}/join`).set(auth(latecomer.token));
    expect(tooLate.status).toBe(400);

    await request(app).post(`/api/events/${eventId}/reopen`).set(auth(owner.token));
    const joined = await request(app).post(`/api/events/${eventId}/join`).set(auth(latecomer.token));
    expect(joined.status).toBe(200);
    expect(joined.body.state.me.isParticipant).toBe(true);
  });

  it('finishes an event and stops the buzzers', async () => {
    const { eventId, owner, players } = await liveEvent(['ann']);
    const finished = await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));
    expect(finished.status).toBe(200);
    expect(finished.body.state.event.status).toBe('finished');
    expect(finished.body.state.question).toBeNull();

    const late = await buzz(eventId, players[0].token);
    expect(late.status).toBe(400);
  });
});
