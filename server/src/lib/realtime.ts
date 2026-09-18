import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { getDb } from './db.js';
import { verifyToken } from './auth.js';
import { HttpError } from './errors.js';
import { buildState, canWatch, getEvent, judgeAnswer, recordBuzz, type Judgement } from './events.js';

export const eventRoom = (eventId: number) => `event:${eventId}`;

let io: SocketServer | null = null;

/**
 * Builds the realtime server: bearer-token auth on the handshake, then the
 * buzz and scoring handlers.
 */
export function createSocketServer(httpServer: HttpServer): SocketServer {
  const server = new SocketServer(httpServer, { cors: { origin: true, credentials: true } });

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
