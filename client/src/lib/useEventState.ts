import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EventState } from './api';
import { getSocket } from './socket';
import { TAP, vibrate } from './haptics';

/** How long the button admits to having sent a buzz before it gives up waiting. */
const PENDING_TIMEOUT_MS = 3000;

/**
 * Keeps one event's state live.
 *
 * The socket is the source of truth once it is up; the initial fetch just
 * means the screen has something to draw before the first push lands.
 *
 * Two things here exist purely for playing on a phone on pub wifi. `connected`
 * lets the screen admit when it is out of touch rather than showing a stale
 * scoreboard as though it were current, and `buzzPending` gives the button
 * something to say in the few hundred milliseconds between the tap and the
 * server's answer — without it people tap again and again, convinced it missed.
 */
export function useEventState(eventId: number) {
  const [state, setState] = useState<EventState | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [buzzPending, setBuzzPending] = useState(false);
  const latest = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>();

  const settle = useCallback(() => {
    clearTimeout(pendingTimer.current);
    setBuzzPending(false);
  }, []);

  useEffect(() => {
    let live = true;
    const socket = getSocket();

    const onState = (s: EventState) => {
      if (!live || s.event.id !== eventId) return;
      setState(s);
      // Any push that arrives after a buzz already accounts for it.
      settle();
    };
    const onError = (e: { error: string }) => {
      if (!live) return;
      setError(e.error);
      settle();
    };
    const watch = () => socket.emit('event:watch', { eventId });
    const onConnect = () => {
      if (!live) return;
      setConnected(true);
      watch();
    };
    const onDisconnect = () => {
      if (!live) return;
      setConnected(false);
      settle();
    };

    socket.on('event:state', onState);
    socket.on('event:error', onError);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();
    else socket.connect();

    const stamp = ++latest.current;
    api
      .event(eventId)
      .then((r) => {
        // Don't let a slow fetch overwrite a push that already arrived.
        if (live && stamp === latest.current) setState((current) => current ?? r.state);
      })
      .catch((e) => live && setError(e.message));

    return () => {
      live = false;
      clearTimeout(pendingTimer.current);
      socket.emit('event:leave', { eventId });
      socket.off('event:state', onState);
      socket.off('event:error', onError);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [eventId, settle]);

  const buzz = useCallback(() => {
    setError('');
    vibrate(TAP);
    setBuzzPending(true);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => setBuzzPending(false), PENDING_TIMEOUT_MS);
    getSocket().emit('event:buzz', { eventId });
  }, [eventId]);

  const judge = useCallback(
    (delta: 1 | 0 | -1) => {
      setError('');
      getSocket().emit('event:judge', { eventId, delta });
    },
    [eventId],
  );

  /** For the REST-backed buttons (join, start, and so on). */
  const run = useCallback(async (fn: () => Promise<{ state: EventState } | unknown>) => {
    setError('');
    try {
      const r = (await fn()) as { state?: EventState };
      if (r?.state) setState(r.state);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }, []);

  return { state, error, setError, connected, buzzPending, buzz, judge, run };
}
