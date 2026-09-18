import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

let socket: Socket | null = null;

/**
 * One shared connection for the whole app. It reconnects on its own, and the
 * server re-sends the state whenever anything changes, so a dropped phone
 * catches up as soon as it is back.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
