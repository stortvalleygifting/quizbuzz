import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type HeadToHead as Record } from '../lib/api';

/** Big number with a caption, three across. */
function Tally({ value, label, tone }: { value: number; label: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`tally${tone ? ` ${tone}` : ''}`}>
      <div className="tally-value">{value}</div>
      <div className="tally-label">{label}</div>
    </div>
  );
}

export default function HeadToHead() {
  const { groupId, userId } = useParams();
  const gid = Number(groupId);
  const uid = Number(userId);
  const [record, setRecord] = useState<Record | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .headToHead(gid, uid)
      .then((r) => setRecord(r.headToHead))
      .catch((e) => setError(e.message));
  }, [gid, uid]);

  if (!record) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to={`/groups/${gid}`}>
            <button className="small">Back</button>
          </Link>
          <h1 />
        </div>
        {error ? <div className="error">{error}</div> : <div className="empty">Loading…</div>}
      </div>
    );
  }

  const { opponent, quizzes, buzzer, meetings } = record;

  return (
    <div className="app">
      <div className="topbar">
        <Link to={`/groups/${gid}`}>
          <button className="small">Back</button>
        </Link>
        <h1>You v {opponent.username}</h1>
      </div>

      <h2>Quizzes</h2>
      {quizzes.played === 0 ? (
        <div className="card empty">You have not finished a quiz together yet.</div>
      ) : (
        <div className="card tallies">
          <Tally value={quizzes.won} label="won" tone="good" />
          <Tally value={quizzes.drawn} label="drawn" />
          <Tally value={quizzes.lost} label="lost" tone="bad" />
        </div>
      )}

      <h2>Race to the buzzer</h2>
      {buzzer.contested === 0 ? (
        <div className="card empty">You have never both buzzed on the same question.</div>
      ) : (
        <div className="card">
          <div className="tallies">
            <Tally value={buzzer.youFirst} label="you first" tone="good" />
            <Tally value={buzzer.themFirst} label="them first" tone="bad" />
          </div>
          <div className="sub center">
            out of {buzzer.contested} {buzzer.contested === 1 ? 'question' : 'questions'} you both buzzed on
          </div>
        </div>
      )}

      {meetings.length > 0 && (
        <>
          <h2>Every meeting</h2>
          <div className="card list">
            {meetings.map((m) => (
              <div className="row" key={m.eventId}>
                <div className="grow">
                  <div className="name">{m.name}</div>
                  <div className="sub">
                    {m.yourScore} – {m.theirScore}
                  </div>
                </div>
                <span className={`pill ${m.result === 'won' ? 'won' : m.result === 'lost' ? 'lost' : ''}`}>
                  {m.result}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
