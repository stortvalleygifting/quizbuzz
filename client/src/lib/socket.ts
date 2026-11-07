import { io, type Socket } from 'socket.io-client';
import { api, ApiError, getToken, setToken } from './api';

let socket: Socket | null = null;

/** How long a woken phone waits for the server to answer before it redials. */
const ALIVE_TIMEOUT_MS = 2500;
/** How long to wait before retrying after the server turned the connection down. */
const REFUSED_RETRY_MS = 5000;

/**
 * One shared connection for the whole app. It reconnects on its own, and the
 * server re-sends the state whenever anything changes, so a dropped phone
 * catches up as soon as it is back.
 */
export function getSocket(): Socket {
  if (!socket) {
    const s = io({
      // Read the token on every attempt rather than once, so a reconnect after
      // signing in again doesn't present a stale one.
      auth: (cb) => cb({ token: getToken() }),
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    // Every connect hands back a fresh token, so a phone left on the quiz
    // screen keeps renewing its sign-in rather than letting it run out.
    s.on('ready', (r: { token?: string }) => {
      if (socket === s && r?.token && getToken()) setToken(r.token);
    });

    // Socket.IO gives up for good when the server's sign-in check refuses the
    // connection. Retrying with the same token used to loop on "Reconnecting…"
    // forever once that token had expired, until the player signed out and in
    // again. So ask the server whether the sign-in is still good: if it is
    // not, that request sends the app back to the sign-in screen; if it is,
    // it hands back a fresh token to retry with.
    s.on('connect_error', () => {
      if (s.active || !getToken()) return;
      api
        .me()
        .then((r) => {
          if (r.token) setToken(r.token);
          return true;
        })
        // A 401 has already signed the app out. Anything else (no signal)
        // is worth another try in a moment.
        .catch((e) => !(e instanceof ApiError && e.status === 401))
        .then((retry) => {
          if (!retry) return;
          setTimeout(() => {
            if (socket === s && !s.connected && !s.active && getToken()) s.connect();
          }, REFUSED_RETRY_MS);
        });
    });

    socket = s;
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}

/**
 * A phone that has been locked or in a pocket often comes back with a socket
 * that still says it is connected but is dead underneath, and anything sent
 * down it (a buzz) is lost until the heartbeat notices. So when the app comes
 * back into view, or the network returns, ask the server to answer straight
 * away and redial if it doesn't.
 */
function checkAlive(): void {
  const s = socket;
  if (!s || !getToken()) return;
  if (!s.connected) {
    if (!s.active) s.connect();
    return;
  }
  s.timeout(ALIVE_TIMEOUT_MS).emit('client:alive', (err: Error | null) => {
    if (err && socket === s) {
      s.disconnect();
      s.connect();
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAlive();
  });
  window.addEventListener('online', checkAlive);
  window.addEventListener('pageshow', checkAlive);
}
