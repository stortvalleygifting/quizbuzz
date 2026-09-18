import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.js';
import { getDb } from './lib/db.js';
import { verifyToken } from './lib/auth.js';

const PORT = Number(process.env.PORT ?? 3001);

getDb(); // open + migrate before we accept traffic

const httpServer = createServer(createApp());

/**
 * The realtime channel. Thread 2 hangs the buzz queue and live scores off this;
 * for now it just authenticates connections so the plumbing is proven.
 */
export const io = new SocketServer(httpServer, {
  cors: { origin: true, credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  try {
    socket.data.user = verifyToken(token);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.emit('ready', { user: socket.data.user });
});

httpServer.listen(PORT, () => {
  console.log(`quizbuzz server listening on http://localhost:${PORT}`);
});
