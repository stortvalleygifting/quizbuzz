import { useEffect, useRef } from 'react';
import { getSocket } from './socket';

/**
 * Calls `reload` when the server says your groups have changed: an admin let
 * you in or turned you down, or someone asked to join a group you run. Also
 * after a reconnect, in case the news arrived while the phone was offline.
 *
 * Pass `groupId` to hear only about that group.
 */
export function useGroupsChanged(reload: () => unknown, groupId?: number): void {
  const latest = useRef(reload);
  latest.current = reload;

  useEffect(() => {
    const socket = getSocket();
    let seenConnect = socket.connected;
    const onChanged = (e: { groupId?: number }) => {
      if (groupId === undefined || e?.groupId === groupId) latest.current();
    };
    const onConnect = () => {
      // The first connect is the page loading, which has just fetched anyway.
      if (seenConnect) latest.current();
      seenConnect = true;
    };
    socket.on('groups:changed', onChanged);
    socket.on('connect', onConnect);
    if (!socket.connected) socket.connect();
    return () => {
      socket.off('groups:changed', onChanged);
      socket.off('connect', onConnect);
    };
  }, [groupId]);
}
