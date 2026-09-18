import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import type { Express } from 'express';
import { openDatabase, setDb } from '../lib/db.js';
import { createApp } from '../app.js';
import { createSocketServer, detachRealtime } from '../lib/realtime.js';

let app: Express;
let httpServer: HttpServer;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  setDb(openDatabase(':memory:'));
  app = createApp();
  httpServer = createServer(app);
  sockets = createSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await sockets.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  detachRealtime();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function register(username: string) {
  const res = await request(app).post('/api/auth/register').send({ username, password: 'hunter2hunter2' });
  return { token: res.body.token as string, id: res.body.user.id as number, username };
}

/** Connects, waits for the handshake, and starts watching the event. */
function watcher(token: string, eventId: number): Promise<ClientSocket> {
  const socket = connect(url, { auth: { token }, transports: ['websocket'] });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect_error', reject);
    socket.once('ready', () => {
      socket.emit('event:watch', { eventId });
      socket.once('event:state', () => resolve(socket));
    });
  });
}

/** Resolves with the next state this socket is pushed. */
const nextState = (socket: ClientSocket) =>
  new Promise<any>((resolve) => socket.once('event:state', resolve));

async function liveEvent(names: string[]) {
  const owner = await register('owner');
  const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
    .group.id as number;

  const players = [];
  for (const name of names) {
    const p = await register(name);
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(p.token));
    await request(app).post(`/api/groups/${groupId}/members/${p.id}/approve`).set(auth(owner.token));
    players.push(p);
  }

  const eventId = (
    await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
  ).body.event.id as number;
  for (const p of players) await request(app).post(`/api/events/${eventId}/join`).set(auth(p.token));
  await request(app).post(`/api/events/${eventId}/question-master`).set(auth(owner.token)).send({ userId: owner.id });
  await request(app).post(`/api/events/${eventId}/start`).set(auth(owner.token));

  return { owner, eventId, players };
}

describe('the live channel', () => {
  it('turns a token away at the door', async () => {
    const socket = connect(url, { auth: { token: 'nonsense' }, transports: ['websocket'] });
    clients.push(socket);
    const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
  });

  it('pushes a buzz to every screen at once', async () => {
    const { owner, eventId, players } = await liveEvent(['ann', 'bob']);
    const [ann, bob] = players;

    const annSocket = await watcher(ann.token, eventId);
    const bobSocket = await watcher(bob.token, eventId);
    const qmSocket = await watcher(owner.token, eventId);

    const waiting = [nextState(annSocket), nextState(bobSocket), nextState(qmSocket)];
    bobSocket.emit('event:buzz', { eventId });
    const [annSees, bobSees, qmSees] = await Promise.all(waiting);

    for (const s of [annSees, bobSees, qmSees]) expect(s.answering.username).toBe('bob');
    expect(bobSees.me.hasBuzzed).toBe(true);
    expect(annSees.me.hasBuzzed).toBe(false);
  });

  it('pushes a score to everyone and resets them for the next question', async () => {
    const { owner, eventId, players } = await liveEvent(['ann', 'bob']);
    const [ann] = players;

    const annSocket = await watcher(ann.token, eventId);
    const qmSocket = await watcher(owner.token, eventId);

    const buzzed = nextState(annSocket);
    annSocket.emit('event:buzz', { eventId });
    await buzzed;

    const scored = [nextState(annSocket), nextState(qmSocket)];
    qmSocket.emit('event:judge', { eventId, delta: 1 });
    const [annSees] = await Promise.all(scored);

    expect(annSees.answering).toBeNull();
    expect(annSees.me.hasBuzzed).toBe(false);
    expect(annSees.leaderboard.find((e: { username: string }) => e.username === 'ann').score).toBe(1);
  });

  it('keeps the order when several people buzz at once', async () => {
    const { eventId, players } = await liveEvent(['ann', 'bob', 'cat']);
    const watchers = await Promise.all(players.map((p) => watcher(p.token, eventId)));

    // Fire all three down the wire without waiting, then let them settle.
    watchers.forEach((s) => s.emit('event:buzz', { eventId }));
    await new Promise((r) => setTimeout(r, 250));

    const final = await new Promise<any>((resolve) => {
      watchers[0].once('event:state', resolve);
      watchers[0].emit('event:watch', { eventId });
    });

    expect(final.queue).toHaveLength(3);
    expect(final.queue.map((b: { seq: number }) => b.seq)).toEqual([1, 2, 3]);
    expect(final.queue.filter((b: { outcome: string }) => b.outcome === 'answering')).toHaveLength(1);
    expect(final.queue[0].outcome).toBe('answering');
    expect(final.answering.username).toBe(final.queue[0].username);
  });

  it('refuses to let a player score and tells them why', async () => {
    const { eventId, players } = await liveEvent(['ann', 'bob']);
    const annSocket = await watcher(players[0].token, eventId);

    const failure = new Promise<{ error: string }>((resolve) => annSocket.once('event:error', resolve));
    annSocket.emit('event:judge', { eventId, delta: 1 });
    expect((await failure).error).toMatch(/question master/i);
  });

  it('will not let someone outside the group listen in', async () => {
    const { eventId } = await liveEvent(['ann']);
    const outsider = await register('outsider');
    const socket = connect(url, { auth: { token: outsider.token }, transports: ['websocket'] });
    clients.push(socket);

    const failure = await new Promise<{ code: string }>((resolve) => {
      socket.once('ready', () => {
        socket.once('event:error', resolve);
        socket.emit('event:watch', { eventId });
      });
    });
    expect(failure.code).toBe('forbidden');
  });
});
