import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type EventSummary, type GroupDetail as Detail } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function GroupDetail() {
  const { groupId } = useParams();
  const id = Number(groupId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [addingEvent, setAddingEvent] = useState(false);
  const [eventName, setEventName] = useState('');
  const [eventWhen, setEventWhen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const d = await api.group(id);
    setDetail(d);
    // Only members can see the fixture list.
    if (d.group.myStatus === 'approved') setEvents((await api.groupEvents(id)).events);
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  async function act(fn: () => Promise<unknown>, afterwards?: () => void) {
    setError('');
    setBusy(true);
    try {
      await fn();
      if (afterwards) afterwards();
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/">
            <button className="small">Back</button>
          </Link>
          <h1 />
        </div>
        {error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>}
      </div>
    );
  }

  async function createEvent(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api.createEvent(id, eventName, eventWhen.trim() || undefined);
      setEventName('');
      setEventWhen('');
      setAddingEvent(false);
    });
  }

  const { group, members, requests } = detail;
  const isAdmin = group.myRole === 'admin';
  const isMember = group.myStatus === 'approved';

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/">
          <button className="small">Back</button>
        </Link>
        <h1>{group.name}</h1>
        {isAdmin && <span className="pill admin">Admin</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {group.description && <div className="card sub">{group.description}</div>}

      {!isMember && (
        <div className="card">
          <p className="sub" style={{ marginTop: 0 }}>
            {group.myStatus === 'pending'
              ? 'Your application is with the admins.'
              : 'You are not in this group yet.'}
          </p>
          {group.myStatus === 'pending' ? (
            <button className="block" disabled={busy} onClick={() => act(() => api.withdraw(id))}>
              Withdraw application
            </button>
          ) : (
            <button className="primary block" disabled={busy} onClick={() => act(() => api.apply(id))}>
              Ask to join
            </button>
          )}
        </div>
      )}

      {isAdmin && requests.length > 0 && (
        <>
          <h2>Requests to join</h2>
          <div className="card list">
            {requests.map((r) => (
              <div className="row" key={r.id}>
                <div className="grow">
                  <div className="name">{r.username}</div>
                </div>
                <button className="small primary" disabled={busy} onClick={() => act(() => api.approve(id, r.id))}>
                  Approve
                </button>
                <button
                  className="small danger"
                  disabled={busy}
                  onClick={() => act(() => api.removeMember(id, r.id))}
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {isMember && (
        <>
          <h2>Quiz nights</h2>
          {events.length === 0 && !addingEvent && (
            <div className="card empty">Nothing planned yet.</div>
          )}
          {events.length > 0 && (
            <div className="card list">
              {events.map((ev) => (
                <Link key={ev.id} className="group-link" to={`/events/${ev.id}`}>
                  <div className="row">
                    <div className="grow">
                      <div className="name">{ev.name}</div>
                      <div className="sub">
                        {ev.scheduledFor ? `${ev.scheduledFor} · ` : ''}
                        {ev.participantCount} playing
                        {ev.questionMasterName ? ` · QM ${ev.questionMasterName}` : ''}
                      </div>
                    </div>
                    {ev.status === 'live' && <span className="pill live">Live</span>}
                    {ev.status === 'finished' && <span className="pill">Done</span>}
                    {ev.status === 'scheduled' && ev.joined && <span className="pill pending">Joined</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}

          {isAdmin &&
            (addingEvent ? (
              <form className="card" onSubmit={createEvent}>
                <label htmlFor="event-name">What is it called?</label>
                <input
                  id="event-name"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  placeholder="Thursday night quiz"
                  required
                />
                <label htmlFor="event-when">When? (optional)</label>
                <input
                  id="event-when"
                  value={eventWhen}
                  onChange={(e) => setEventWhen(e.target.value)}
                  placeholder="Thursday 8pm"
                />
                <div className="row">
                  <button className="primary grow" type="submit" disabled={busy}>
                    Create
                  </button>
                  <button type="button" onClick={() => setAddingEvent(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="primary block" onClick={() => setAddingEvent(true)}>
                Plan a quiz night
              </button>
            ))}

          <h2>Members</h2>
          <div className="card list">
            {members.map((m) => {
              const isMe = m.id === user?.id;
              return (
                <div className="row" key={m.id}>
                  <div className="grow">
                    <div className="name">
                      {isMe ? (
                        <>
                          {m.username}
                          <span className="sub"> (you)</span>
                        </>
                      ) : (
                        // Tapping someone's name opens your record against them.
                        <Link to={`/groups/${id}/vs/${m.id}`}>{m.username}</Link>
                      )}
                    </div>
                  </div>
                  {m.role === 'admin' && <span className="pill admin">Admin</span>}
                  {isAdmin && !isMe && m.role === 'member' && (
                    <button className="small" disabled={busy} onClick={() => act(() => api.setRole(id, m.id, 'admin'))}>
                      Make admin
                    </button>
                  )}
                  {isAdmin && !isMe && m.role === 'admin' && (
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => act(() => api.setRole(id, m.id, 'member'))}
                    >
                      Step down
                    </button>
                  )}
                  {isAdmin && !isMe && (
                    <button
                      className="small danger"
                      disabled={busy}
                      onClick={() => act(() => api.removeMember(id, m.id))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <button
            className="danger block"
            disabled={busy}
            onClick={() => act(() => api.removeMember(id, user!.id), () => navigate('/'))}
          >
            Leave group
          </button>
        </>
      )}
    </div>
  );
}
