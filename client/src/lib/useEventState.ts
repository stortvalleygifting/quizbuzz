import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EventState } from './api';
import { getSocket } from './socket';

/**
 * Keeps one event's state live.
 *
 * The socket is the source of truth once it is up; the initial fetch just
 * means the screen has something to draw before the first push lands.
 */
export function useEventState(eventId: number) {
  const [state, setState] = useState<EventState | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    let live = true;
    const socket = getSocket();

    const onState = (s: EventState) => {
      if (live && s.event.id === eventId) setState(s);
    };
    const onError = (e: { error: string }) => {
      if (live) setError(e.error);
    };
    const watch = () => socket.emit('event:watch', { eventId });

    socket.on('event:state', onState);
    socket.on('event:error', onError);
    socket.on('connect', watch);
    if (socket.connected) watch();
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
      socket.emit('event:leave', { eventId });
      socket.off('event:state', onState);
      socket.off('event:error', onError);
      socket.off('connect', watch);
    };
  }, [eventId]);

  const buzz = useCallback(() => {
    setError('');
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

  return { state, error, setError, buzz, judge, run };
}
