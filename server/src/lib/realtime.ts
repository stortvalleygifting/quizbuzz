import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { getDb } from './db.js';
import { verifyToken } from './auth.js';
import { HttpError } from './errors.js';
import { buildState, canWatch, getEvent, judgeAnswer, recordBuzz, type Judgement } from './events.js';

export const eventRoom = (eventId: number) => `event:${eventId}`;
/** Every open screen one person has, wherever they are in the app. */
export const userRoom = (userId: number) => `user:${userId}`;

let io: SocketServer | null = null;

/**
 * Builds the realtime server: bearer-token auth on the handshake, then the
 * buzz and scoring handlers.
 */
export function createSocketServer(httpServer: HttpServer): SocketServer {
  const server = new SocketServer(httpServer, {
    cors: { origin: true, credentials: true },
    // Notice a dead phone within about 20 seconds rather than the default 45,
    // so it is dropped and redials sooner. Each ping is a few bytes.
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  server.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  attachRealtime(server);
  return server;
}

/** Wires the handlers onto an existing socket server. */
export function attachRealtime(server: SocketServer): void {
  io = server;
  server.on('connection', (socket) => {
    // One line per dropped phone, so `fly logs` after a quiz night shows who
    // lost their connection, when, and why: "ping timeout" is the phone or the
    // wifi going quiet, "transport close" the connection being cut, and
    // "server shutting down" a restart.
    const who = socket.data.user?.username ?? '?';
    socket.on('disconnect', (reason) => console.log(`socket dropped: ${who} (${reason})`));
    const uid = socket.data.user?.uid as number | undefined;
    if (uid) socket.join(userRoom(uid));
    socket.emit('ready', { user: socket.data.user });
    registerHandlers(socket);
  });
}

/** Test helper: forget the server between runs. */
export function detachRealtime(): void {
  io = null;
}

/**
 * Pushes the current state to everyone watching an event.
 *
 * Each screen gets its own copy because what you may do — buzz, score, start
 * the event — depends on who you are, so the payload is built per viewer.
 */
export async function broadcastEvent(eventId: number): Promise<void> {
  if (!io) return;
  const db = getDb();
  const sockets = await io.in(eventRoom(eventId)).fetchSockets();
  for (const socket of sockets) {
    const viewerId = socket.data.user?.uid as number | undefined;
    if (!viewerId) continue;
    try {
      socket.emit('event:state', buildState(db, eventId, viewerId));
    } catch {
      // They lost access (removed from the group, say) — drop them quietly.
      socket.leave(eventRoom(eventId));
    }
  }
}

/**
 * Tells these people their groups have changed (an application approved or
 * turned down, someone asking to join a group they run), so the screen they
 * have open reloads instead of going stale until they refresh it.
 */
export function notifyGroupsChanged(userIds: number[], groupId: number): void {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map(userRoom)).emit('groups:changed', { groupId });
}

/** Turns a thrown HttpError into something the client can show. */
function fail(socket: Socket, err: unknown): void {
  const message = err instanceof HttpError ? err.message : 'Something went wrong.';
  const code = err instanceof HttpError ? err.code : 'error';
  socket.emit('event:error', { error: message, code });
}

function registerHandlers(socket: Socket): void {
  const uid = () => socket.data.user?.uid as number;

  socket.on('event:watch', async (raw: unknown) => {
    const eventId = Number((raw as { eventId?: unknown })?.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) return;
    try {
      const db = getDb();
      const event = getEvent(db, eventId);
      if (!canWatch(db, event, uid())) throw new HttpError(403, 'You need to be in this group.', 'forbidden');
      socket.join(eventRoom(eventId));
      socket.emit('event:state', buildState(db, eventId, uid()));
    } catch (err) {
      fail(socket, err);
    }
  });

  // A phone that has just woken up asks this to find out whether its
  // connection is still alive; an answer is all it needs.
  socket.on('client:alive', (ack: unknown) => {
    if (typeof ack === 'function') ack();
  });

  socket.on('event:leave', (raw: unknown) => {
    const eventId = Number((raw as { eventId?: unknown })?.eventId);
    if (Number.isInteger(eventId)) socket.leave(eventRoom(eventId));
  });

  // The hot path: a buzz goes straight down the socket so the ordering is
  // decided as close to the tap as we can get it.
  socket.on('event:buzz', async (raw: unknown) => {
    const eventId = Number((raw as { eventId?: unknown })?.eventId);
    if (!Number.isInteger(eventId)) return;
    try {
      recordBuzz(getDb(), eventId, uid());
      await broadcastEvent(eventId);
    } catch (err) {
      fail(socket, err);
    }
  });

  socket.on('event:judge', async (raw: unknown) => {
    const body = raw as { eventId?: unknown; delta?: unknown };
    const eventId = Number(body?.eventId);
    const delta = Number(body?.delta);
    if (!Number.isInteger(eventId) || ![1, 0, -1].includes(delta)) return;
    try {
      judgeAnswer(getDb(), eventId, uid(), delta as Judgement);
      await broadcastEvent(eventId);
    } catch (err) {
      fail(socket, err);
    }
  });
}
