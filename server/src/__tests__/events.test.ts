import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { getDb, openDatabase, setDb } from '../lib/db.js';
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

  it('lets a group admin who is not the question master finish the quiz', async () => {
    const { eventId, groupId, owner, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;
    await request(app).post(`/api/groups/${groupId}/members/${ann.id}/role`).set(auth(owner.token)).send({ role: 'admin' });

    expect((await state(eventId, ann.token)).me.isAdmin).toBe(true);
    expect((await request(app).post(`/api/events/${eventId}/finish`).set(auth(bob.token))).status).toBe(403);

    const finished = await request(app).post(`/api/events/${eventId}/finish`).set(auth(ann.token));
    expect(finished.status).toBe(200);
    expect(finished.body.state.event.status).toBe('finished');
  });
});

describe('head to head', () => {
  /** Runs one question: `first` buzzes, then `second`, and the master judges. */
  async function question(
    eventId: number,
    master: Player,
    first: Player,
    second: Player | null,
    delta: number,
  ) {
    await buzz(eventId, first.token);
    if (second) await buzz(eventId, second.token);
    await judge(eventId, master.token, delta);
  }

  it('counts quizzes won, lost and drawn, and who got to the buzzer first', async () => {
    const { eventId, owner, groupId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    // Quiz one: both buzz on every question, ann first each time, ann wins 2-0.
    await question(eventId, owner, ann, bob, 1);
    await question(eventId, owner, ann, bob, 1);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    // Quiz two: bob gets to the buzzer first twice and wins it.
    const second = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Week two' })
    ).body.event.id;
    for (const p of players) await request(app).post(`/api/events/${second}/join`).set(auth(p.token));
    await request(app).post(`/api/events/${second}/question-master`).set(auth(owner.token)).send({ userId: owner.id });
    await request(app).post(`/api/events/${second}/start`).set(auth(owner.token));
    await question(second, owner, bob, ann, 1);
    await question(second, owner, bob, ann, 1);
    await request(app).post(`/api/events/${second}/finish`).set(auth(owner.token));

    const annView = await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(annView.status).toBe(200);
    expect(annView.body.headToHead.opponent.username).toBe('bob');
    expect(annView.body.headToHead.quizzes).toEqual({ played: 2, won: 1, lost: 1, drawn: 0 });
    expect(annView.body.headToHead.buzzer).toEqual({ contested: 4, youFirst: 2, themFirst: 2 });

    // Bob's view is the mirror image.
    const bobView = await request(app).get(`/api/groups/${groupId}/head-to-head/${ann.id}`).set(auth(bob.token));
    expect(bobView.body.headToHead.quizzes).toEqual({ played: 2, won: 1, lost: 1, drawn: 0 });
    expect(bobView.body.headToHead.buzzer).toEqual({ contested: 4, youFirst: 2, themFirst: 2 });
    expect(bobView.body.headToHead.meetings.map((m: { result: string }) => m.result).sort()).toEqual(['lost', 'won']);
  });

  it('counts a level quiz as a draw', async () => {
    const { eventId, owner, groupId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    await question(eventId, owner, ann, null, 1);
    await question(eventId, owner, bob, null, 1);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    const view = await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(view.body.headToHead.quizzes).toEqual({ played: 1, won: 0, lost: 0, drawn: 1 });
    // They never buzzed on the same question, so there was no race.
    expect(view.body.headToHead.buzzer.contested).toBe(0);
  });

  it('leaves out quizzes that are still going, and ones either of you ran', async () => {
    const { eventId, owner, groupId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    // A quiz in progress does not count yet.
    await question(eventId, owner, ann, bob, 1);
    const during = await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(during.body.headToHead.quizzes.played).toBe(0);
    // The buzzer race counts all the same, finished or not.
    expect(during.body.headToHead.buzzer).toEqual({ contested: 1, youFirst: 1, themFirst: 0 });

    // A quiz ann ran herself does not count either, even once finished.
    const hers = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: "Ann's night" })
    ).body.event.id;
    for (const p of players) await request(app).post(`/api/events/${hers}/join`).set(auth(p.token));
    await request(app).post(`/api/events/${hers}/question-master`).set(auth(owner.token)).send({ userId: ann.id });
    await request(app).post(`/api/events/${hers}/start`).set(auth(ann.token));
    await request(app).post(`/api/events/${hers}/finish`).set(auth(ann.token));

    const after = await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(after.body.headToHead.quizzes.played).toBe(0);
  });

  it('keeps each group’s record to itself', async () => {
    const { eventId, owner, groupId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;
    await question(eventId, owner, ann, bob, 1);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    // The same two people in a different group start from nothing.
    const other = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Other pub' })).body.group
      .id;
    for (const p of players) {
      await request(app).post(`/api/groups/${other}/apply`).set(auth(p.token));
      await request(app).post(`/api/groups/${other}/members/${p.id}/approve`).set(auth(owner.token));
    }

    const here = await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(here.body.headToHead.quizzes.played).toBe(1);
    const there = await request(app).get(`/api/groups/${other}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(there.body.headToHead.quizzes.played).toBe(0);
    expect(there.body.headToHead.buzzer.contested).toBe(0);
  });

  it('refuses outsiders, strangers and yourself', async () => {
    const { groupId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    const outsider = await register('outsider');
    const byOutsider = await request(app)
      .get(`/api/groups/${groupId}/head-to-head/${bob.id}`)
      .set(auth(outsider.token));
    expect(byOutsider.status).toBe(403);

    const aboutOutsider = await request(app)
      .get(`/api/groups/${groupId}/head-to-head/${outsider.id}`)
      .set(auth(ann.token));
    expect(aboutOutsider.status).toBe(404);

    const myself = await request(app).get(`/api/groups/${groupId}/head-to-head/${ann.id}`).set(auth(ann.token));
    expect(myself.status).toBe(400);
    expect(myself.body.code).toBe('self');
  });
});

describe('one quiz head to head', () => {
  it('compares two players in a single quiz', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    // Ann first and right; Bob first and wrong then Ann right; Bob alone and right.
    await buzz(eventId, ann.token);
    await buzz(eventId, bob.token);
    await judge(eventId, owner.token, 1);
    await buzz(eventId, bob.token);
    await buzz(eventId, ann.token);
    await judge(eventId, owner.token, -1);
    await judge(eventId, owner.token, 1);
    await buzz(eventId, bob.token);
    await judge(eventId, owner.token, 1);

    // Not while the quiz is still going.
    const early = await request(app).get(`/api/events/${eventId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(early.body.code).toBe('not_finished');
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    const r = await request(app).get(`/api/events/${eventId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(r.status).toBe(200);
    expect(r.body.headToHead).toEqual({
      opponent: { id: bob.id, username: 'bob' },
      yourScore: 2,
      theirScore: 0,
      buzzer: { contested: 2, youFirst: 1, themFirst: 1 },
    });

    const self = await request(app).get(`/api/events/${eventId}/head-to-head/${ann.id}`).set(auth(ann.token));
    expect(self.body.code).toBe('self');
    const outsider = await register('outsider');
    const byOutsider = await request(app)
      .get(`/api/events/${eventId}/head-to-head/${bob.id}`)
      .set(auth(outsider.token));
    expect(byOutsider.status).toBe(403);
  });
});

describe('adjusting a score by hand', () => {
  const adjust = (eventId: number, token: string, userId: number, delta: number) =>
    request(app).post(`/api/events/${eventId}/adjust`).set(auth(token)).send({ userId, delta });

  it('lets the question master change a score, and records why', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    const r = await adjust(eventId, owner.token, ann.id, 3);
    expect(r.status).toBe(200);
    expect(r.body.state.leaderboard.find((e: { userId: number }) => e.userId === ann.id).score).toBe(3);
    expect((await adjust(eventId, owner.token, ann.id, -1)).status).toBe(200);
    expect((await state(eventId, ann.token)).leaderboard[0]).toMatchObject({ userId: ann.id, score: 2 });

    const history = getDb()
      .prepare('SELECT delta, question_id FROM score_events WHERE event_id = ? AND user_id = ? ORDER BY id')
      .all(eventId, ann.id);
    expect(history).toEqual([
      { delta: 3, question_id: null },
      { delta: -1, question_id: null },
    ]);

    // Nobody else may, and the master can't score themselves or do nothing.
    expect((await adjust(eventId, bob.token, bob.id, 5)).status).toBe(403);
    expect((await adjust(eventId, owner.token, owner.id, 5)).status).toBe(404);
    expect((await adjust(eventId, owner.token, ann.id, 0)).status).toBe(400);
  });

  it('can still put a score right after the quiz has finished', async () => {
    const { eventId, owner, players } = await liveEvent(['ann']);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));
    expect((await adjust(eventId, owner.token, players[0].id, 1)).status).toBe(200);
  });
});

describe('game rules', () => {
  const setRules = (eventId: number, token: string, rules: unknown) =>
    request(app).post(`/api/events/${eventId}/rules`).set(auth(token)).send(rules);
  const scoreOf = (s: { leaderboard: { username: string; score: number }[] }, name: string) =>
    s.leaderboard.find((e) => e.username === name)!.score;
  const flat = (right: number, wrong: number) => [
    { right, wrong },
    { right, wrong },
    { right, wrong },
  ];

  it('starts every quiz on Classic: the queue, +1 and -1', async () => {
    const { eventId, players } = await liveEvent(['ann']);
    const s = await state(eventId, players[0].token);
    expect(s.rules).toEqual({ playAs: 'individuals', secondBuzz: 'queue', points: flat(1, -1) });
    expect(s.teams).toEqual([]);
  });

  it('scores by answer position: 1st, 2nd, then 3rd and later', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob', 'cat', 'dan']);
    const [ann, bob, cat, dan] = players;
    const saved = await setRules(eventId, owner.token, {
      secondBuzz: 'queue',
      points: [
        { right: 3, wrong: -2 },
        { right: 2, wrong: -1 },
        { right: 1, wrong: 0 },
      ],
    });
    expect(saved.status).toBe(200);

    for (const p of [ann, bob, cat, dan]) await buzz(eventId, p.token);
    expect((await state(eventId, owner.token)).answering.position).toBe(1);
    await judge(eventId, owner.token, -1); // ann, 1st: -2
    await judge(eventId, owner.token, 0); // bob, 2nd: a pass scores nothing
    expect((await state(eventId, owner.token)).answering.position).toBe(3);
    await judge(eventId, owner.token, -1); // cat, 3rd: 0
    await judge(eventId, owner.token, 1); // dan, 4th: +1

    const s = await state(eventId, ann.token);
    expect([scoreOf(s, 'ann'), scoreOf(s, 'bob'), scoreOf(s, 'cat'), scoreOf(s, 'dan')]).toEqual([-2, 0, 0, 1]);

    // Only real score changes are logged, so the history still adds up.
    const logged = getDb().prepare('SELECT delta FROM score_events WHERE event_id = ? ORDER BY id').all(eventId);
    expect(logged.map((r) => r.delta)).toEqual([-2, 1]);
  });

  it('lets the points change mid-quiz without touching answers already scored', async () => {
    const { eventId, owner, players } = await liveEvent(['ann']);
    await buzz(eventId, players[0].token);
    await judge(eventId, owner.token, 1);

    await setRules(eventId, owner.token, { secondBuzz: 'queue', points: flat(2, 0) });
    await buzz(eventId, players[0].token);
    await judge(eventId, owner.token, 1);

    expect(scoreOf(await state(eventId, owner.token), 'ann')).toBe(3);
  });

  it('re-open: no queue, and a miss frees the buzzer for everyone who has not answered', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;
    await setRules(eventId, owner.token, { secondBuzz: 'reopen', points: flat(1, -1) });

    await buzz(eventId, ann.token);
    await buzz(eventId, bob.token); // turned away: ann has the floor
    let s = await state(eventId, bob.token);
    expect(s.queue.map((b: { username: string }) => b.username)).toEqual(['ann']);
    expect(s.me.hasBuzzed).toBe(false);

    await judge(eventId, owner.token, -1);
    s = await state(eventId, ann.token);
    expect(s.answering).toBeNull();
    expect(s.question.seq).toBe(1); // still the same question

    await buzz(eventId, ann.token); // already had a go
    await buzz(eventId, cat.token);
    s = await state(eventId, ann.token);
    expect(s.answering.username).toBe('cat');
    expect(s.answering.position).toBe(2);

    await judge(eventId, owner.token, 0);
    await buzz(eventId, bob.token);
    await judge(eventId, owner.token, -1);

    // Everyone playing has had a go, so the next question opens.
    s = await state(eventId, ann.token);
    expect(s.question.seq).toBe(2);
    expect(s.queue).toHaveLength(0);
  });

  it('one shot: a miss ends the question', async () => {
    const { eventId, owner, players } = await liveEvent(['ann', 'bob']);
    await setRules(eventId, owner.token, { secondBuzz: 'one_shot', points: flat(1, -1) });

    await buzz(eventId, players[0].token);
    await buzz(eventId, players[1].token);
    await judge(eventId, owner.token, -1);

    const s = await state(eventId, players[1].token);
    expect(s.question.seq).toBe(2);
    expect(scoreOf(s, 'ann')).toBe(-1);
    expect(scoreOf(s, 'bob')).toBe(0);
  });

  it('only lets an admin or the question master set the rules, and checks them', async () => {
    const { eventId, owner, players } = await liveEvent(['ann']);
    const ok = { secondBuzz: 'queue', points: flat(1, 0) };

    expect((await setRules(eventId, players[0].token, ok)).status).toBe(403);
    expect((await setRules(eventId, owner.token, { ...ok, secondBuzz: 'whenever' })).status).toBe(400);
    expect((await setRules(eventId, owner.token, { ...ok, points: flat(500, 0) })).status).toBe(400);
    expect((await setRules(eventId, owner.token, { ...ok, points: [{ right: 1, wrong: 0 }] })).status).toBe(400);

    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));
    expect((await setRules(eventId, owner.token, ok)).status).toBe(400);
  });
});

describe('teams', () => {
  const rules = (playAs: string, secondBuzz = 'queue') => ({
    playAs,
    secondBuzz,
    points: [
      { right: 1, wrong: -1 },
      { right: 1, wrong: -1 },
      { right: 1, wrong: -1 },
    ],
  });
  const setRules = (eventId: number, token: string, body: unknown) =>
    request(app).post(`/api/events/${eventId}/rules`).set(auth(token)).send(body);
  const createTeam = (eventId: number, token: string, name: string) =>
    request(app).post(`/api/events/${eventId}/teams`).set(auth(token)).send({ name });
  const joinTeam = (eventId: number, token: string, teamId: number) =>
    request(app).post(`/api/events/${eventId}/teams/${teamId}/join`).set(auth(token));

  /** A group with players, an event in team mode that has not started, and the owner as question master. */
  async function teamLobby(names: string[]) {
    const owner = await register('owner');
    const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' }))
      .body.group.id as number;
    const players: Player[] = [];
    for (const name of names) {
      const p = await register(name);
      await request(app).post(`/api/groups/${groupId}/apply`).set(auth(p.token));
      await request(app).post(`/api/groups/${groupId}/members/${p.id}/approve`).set(auth(owner.token));
      players.push(p);
    }
    const eventId = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Team night' })
    ).body.event.id as number;
    for (const p of players) await request(app).post(`/api/events/${eventId}/join`).set(auth(p.token));
    await request(app).post(`/api/events/${eventId}/question-master`).set(auth(owner.token)).send({ userId: owner.id });
    expect((await setRules(eventId, owner.token, rules('teams'))).status).toBe(200);
    return { owner, groupId, eventId, players };
  }
  const start = (eventId: number, token: string) => request(app).post(`/api/events/${eventId}/start`).set(auth(token));

  it('only allows teams once the question master has switched the quiz to teams', async () => {
    const { eventId, players } = await liveEvent(['ann']);
    const refused = await createTeam(eventId, players[0].token, 'Quizzly Bears');
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('not_teams');
  });

  it('only lets an admin or the question master switch to teams, and only before the start', async () => {
    const { eventId, owner, players } = await liveEvent(['ann']);
    expect((await setRules(eventId, players[0].token, rules('teams'))).status).toBe(403);
    expect((await setRules(eventId, owner.token, rules('teams'))).status).toBe(409);
    // Points can still change mid-quiz without saying how it is played.
    const { playAs: _, ...noMode } = rules('teams');
    expect((await setRules(eventId, owner.token, noMode)).status).toBe(200);
  });

  it('lets players create, name, join and leave teams', async () => {
    const { eventId, players } = await teamLobby(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;

    const made = await createTeam(eventId, ann.token, '  Quizzly   Bears ');
    expect(made.status).toBe(201);
    const team = made.body.state.teams[0];
    expect(team.name).toBe('Quizzly Bears');
    expect(team.members.map((m: { username: string }) => m.username)).toEqual(['ann']);
    expect(made.body.state.me.teamId).toBe(team.id);

    expect((await createTeam(eventId, bob.token, 'quizzly bears')).body.code).toBe('name_taken');
    await joinTeam(eventId, bob.token, team.id);
    await createTeam(eventId, cat.token, 'Brainiacs');

    // Ann leaves; the team carries on with Bob.
    await request(app).delete(`/api/events/${eventId}/team`).set(auth(ann.token));
    let s = await state(eventId, ann.token);
    expect(s.me.teamId).toBeNull();
    expect(s.teams.find((t: { name: string }) => t.name === 'Quizzly Bears').members).toHaveLength(1);

    // Bob moves to Cat's team, so his old one, now empty, goes.
    await joinTeam(eventId, bob.token, s.teams.find((t: { name: string }) => t.name === 'Brainiacs').id);
    s = await state(eventId, ann.token);
    expect(s.teams.map((t: { name: string }) => t.name)).toEqual(['Brainiacs']);
  });

  it('shuffles everyone into even random teams for the question master', async () => {
    const { eventId, owner, players } = await teamLobby(['ann', 'bob', 'cat', 'dan', 'eve']);
    expect((await request(app).post(`/api/events/${eventId}/teams/random`).set(auth(players[0].token)).send({ count: 2 })).status).toBe(403);

    const shuffled = await request(app).post(`/api/events/${eventId}/teams/random`).set(auth(owner.token)).send({ count: 2 });
    expect(shuffled.status).toBe(200);
    const teams = shuffled.body.state.teams as { name: string; members: unknown[] }[];
    expect(teams.map((t) => t.name).sort()).toEqual(['Blue', 'Red']);
    expect(teams.map((t) => t.members.length).sort()).toEqual([2, 3]);
    // The question master is not on a team.
    expect(shuffled.body.state.me.teamId).toBeNull();
  });

  it('counts only the first buzz from each team, and scores the team', async () => {
    const { eventId, owner, players } = await teamLobby(['ann', 'bob', 'cat', 'dan']);
    const [ann, bob, cat, dan] = players;
    const reds = (await createTeam(eventId, ann.token, 'Reds')).body.state.teams[0].id;
    await joinTeam(eventId, bob.token, reds);
    const blues = (await createTeam(eventId, cat.token, 'Blues')).body.state.teams.find((t: { name: string }) => t.name === 'Blues').id;
    await joinTeam(eventId, dan.token, blues);
    await start(eventId, owner.token);

    await buzz(eventId, bob.token);
    await buzz(eventId, ann.token); // a teammate: ignored
    await buzz(eventId, dan.token);
    let s = await state(eventId, owner.token);
    expect(s.queue.map((b: { username: string }) => b.username)).toEqual(['bob', 'dan']);
    expect(s.answering.team.name).toBe('Reds');

    await judge(eventId, owner.token, -1);
    await judge(eventId, owner.token, 1);
    s = await state(eventId, ann.token);
    expect(s.teams.map((t: { name: string; score: number }) => [t.name, t.score])).toEqual([
      ['Blues', 1],
      ['Reds', -1],
    ]);
  });

  it('keeps players without a team off the buzzer, and locks teams once the quiz starts', async () => {
    const { eventId, owner, players } = await teamLobby(['ann', 'bob', 'cat']);
    const [ann, bob, cat] = players;
    const team = (await createTeam(eventId, ann.token, 'Reds')).body.state.teams[0].id;
    await createTeam(eventId, bob.token, 'Blues');
    await start(eventId, owner.token);

    expect((await buzz(eventId, cat.token)).body.code).toBe('no_team');
    expect((await joinTeam(eventId, bob.token, team)).body.code).toBe('teams_locked');
    // A late pick is fine.
    expect((await joinTeam(eventId, cat.token, team)).status).toBe(200);
    // The question master can still move someone.
    const moved = await request(app)
      .post(`/api/events/${eventId}/teams/move`)
      .set(auth(owner.token))
      .send({ userId: bob.id, teamId: team });
    expect(moved.status).toBe(200);
    expect(moved.body.state.teams).toHaveLength(1);
  });

  it('re-open in teams ends the question once every team has had a go', async () => {
    const { eventId, owner, players } = await teamLobby(['ann', 'bob']);
    await setRules(eventId, owner.token, rules('teams', 'reopen'));
    await createTeam(eventId, players[0].token, 'Reds');
    await createTeam(eventId, players[1].token, 'Blues');
    await start(eventId, owner.token);

    await buzz(eventId, players[0].token);
    await judge(eventId, owner.token, -1);
    expect((await state(eventId, owner.token)).question.seq).toBe(1);
    await buzz(eventId, players[1].token);
    await judge(eventId, owner.token, -1);
    expect((await state(eventId, owner.token)).question.seq).toBe(2);
  });

  it('leaves team quizzes out of head-to-head', async () => {
    const { eventId, owner, groupId, players } = await teamLobby(['ann', 'bob']);
    const [ann, bob] = players;
    await createTeam(eventId, ann.token, 'Reds');
    await createTeam(eventId, bob.token, 'Blues');
    await start(eventId, owner.token);
    await buzz(eventId, ann.token);
    await buzz(eventId, bob.token);
    await judge(eventId, owner.token, 1);
    await request(app).post(`/api/events/${eventId}/finish`).set(auth(owner.token));

    const h2h = (await request(app).get(`/api/groups/${groupId}/head-to-head/${bob.id}`).set(auth(ann.token))).body
      .headToHead;
    expect(h2h.quizzes.played).toBe(0);
    expect(h2h.buzzer.contested).toBe(0);
    const quiz = await request(app).get(`/api/events/${eventId}/head-to-head/${bob.id}`).set(auth(ann.token));
    expect(quiz.body.code).toBe('team_quiz');
  });

  it('drops the teams when the quiz goes back to individuals', async () => {
    const { eventId, owner, players } = await teamLobby(['ann']);
    await createTeam(eventId, players[0].token, 'Reds');
    const back = await setRules(eventId, owner.token, rules('individuals'));
    expect(back.body.state.teams).toEqual([]);
    expect(back.body.state.me.teamId).toBeNull();
  });
});
