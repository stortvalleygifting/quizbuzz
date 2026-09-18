import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type BoardEntry, type EventState } from '../lib/api';
import { useEventState } from '../lib/useEventState';

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/**
 * The five rows Rob asked for: you, and two people either side. Near the top or
 * the bottom of the board the window slides so it always shows five if it can.
 */
function windowAround(board: BoardEntry[], userId: number): BoardEntry[] {
  if (board.length <= 5) return board;
  const i = board.findIndex((e) => e.userId === userId);
  if (i < 0) return board.slice(0, 5);
  const start = Math.min(Math.max(i - 2, 0), board.length - 5);
  return board.slice(start, start + 5);
}

function Scoreboard({ state }: { state: EventState }) {
  const rows = state.me.isQuestionMaster
    ? state.leaderboard.slice(0, 5)
    : windowAround(state.leaderboard, state.me.userId);

  if (rows.length === 0) return <div className="empty">Nobody is playing yet.</div>;

  return (
    <div className="board">
      {rows.map((e) => (
        <div className={`board-row${e.userId === state.me.userId ? ' me' : ''}`} key={e.userId}>
          <span className="place">{e.place}</span>
          <span className="who">{e.username}</span>
          <span className="score">{e.score}</span>
        </div>
      ))}
    </div>
  );
}

/** The bottom half of the question master's button: +1, 0 and -1. */
function JudgeControls({ onJudge }: { onJudge: (delta: 1 | 0 | -1) => void }) {
  return (
    <div className="judge">
      <button className="judge-btn plus" onClick={() => onJudge(1)}>
        +1
      </button>
      <button className="judge-btn zero" onClick={() => onJudge(0)}>
        0
      </button>
      <button className="judge-btn minus" onClick={() => onJudge(-1)}>
        −1
      </button>
    </div>
  );
}

export default function Event() {
  const { eventId } = useParams();
  const id = Number(eventId);
  const navigate = useNavigate();
  const { state, error, buzz, judge, run } = useEventState(id);

  if (!state) {
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

  const { event, me, answering, queue } = state;
  const waiting = queue.filter((b) => b.outcome === 'waiting');
  const myPlaceInQueue = queue.findIndex((b) => b.userId === me.userId) + 1;

  // ------------------------------------------------ before the quiz starts --
  if (event.status !== 'live') {
    const finished = event.status === 'finished';
    return (
      <div className="app">
        <div className="topbar">
          <Link to={`/groups/${event.groupId}`}>
            <button className="small">Back</button>
          </Link>
          <h1>{event.name}</h1>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="card">
          <div className="sub">
            {finished
              ? 'This quiz has finished.'
              : event.scheduledFor
                ? `Starting ${event.scheduledFor}.`
                : 'Not started yet.'}
          </div>
          <div className="sub">
            {event.questionMasterName
              ? `Question master: ${event.questionMasterName}`
              : 'No question master yet.'}
          </div>
        </div>

        {finished && (
          <>
            <h2>Final scores</h2>
            <div className="card">
              <Scoreboard state={state} />
            </div>
            {(me.isQuestionMaster || me.isAdmin) && (
              <button className="primary block" onClick={() => run(() => api.reopenEvent(id))}>
                Re-open this quiz
              </button>
            )}
          </>
        )}

        {!finished &&
          (me.isParticipant ? (
            <button className="block" onClick={() => run(() => api.leaveEvent(id)).then(() => navigate(`/groups/${event.groupId}`))}>
              Leave this quiz
            </button>
          ) : (
            <button className="primary block" onClick={() => run(() => api.joinEvent(id))}>
              Join this quiz
            </button>
          ))}

        {!finished && (
          <>
            <h2>Playing ({state.participants.length})</h2>
            <div className="card list">
              {state.participants.map((p) => (
                <div className="row" key={p.id}>
                  <div className="grow">
                    <div className="name">
                      {p.username}
                      {p.id === me.userId && <span className="sub"> (you)</span>}
                    </div>
                  </div>
                  {p.id === event.questionMasterId ? (
                    <span className="pill admin">Question master</span>
                  ) : (
                    me.isAdmin && (
                      <button className="small" onClick={() => run(() => api.setQuestionMaster(id, p.id))}>
                        Make QM
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {!finished && me.isAdmin && (
          <button
            className="primary block"
            disabled={!event.questionMasterId}
            onClick={() => run(() => api.startEvent(id))}
          >
            {event.questionMasterId ? 'Start the quiz' : 'Pick a question master first'}
          </button>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------ live quiz --
  return (
    <div className="event-live">
      <div className="event-head">
        <Link to={`/groups/${event.groupId}`} className="back">
          ‹
        </Link>
        <span className="grow">{event.name}</span>
        <span className="sub">Q{state.question?.seq ?? '–'}</span>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="buzz-half">
        {me.isQuestionMaster ? (
          answering ? (
            <div className="qm-panel">
              <div className="qm-name">{answering.username}</div>
              <JudgeControls onJudge={judge} />
            </div>
          ) : (
            <div className="buzz-idle">
              <div className="buzz-idle-text">Waiting for a buzz…</div>
              <button className="small" onClick={() => run(() => api.nextQuestion(id))}>
                Skip this question
              </button>
            </div>
          )
        ) : answering ? (
          // The button shows whoever got in first, but it still takes your buzz
          // so you can take your place in the queue behind them.
          <button
            className={`buzzed${answering.userId === me.userId ? ' mine' : ''}`}
            disabled={!me.isParticipant || me.hasBuzzed}
            onClick={buzz}
          >
            <div className="buzz-name">{answering.username}</div>
            <div className="buzz-sub">
              {answering.userId === me.userId
                ? 'You buzzed first'
                : me.hasBuzzed
                  ? `is answering · you are ${ordinal(myPlaceInQueue)} in the queue`
                  : 'is answering · tap to join the queue'}
            </div>
          </button>
        ) : (
          <button className="buzz" disabled={!me.isParticipant} onClick={buzz}>
            BUZZ!
          </button>
        )}
      </div>

      <div className="board-half">
        <Scoreboard state={state} />
        {waiting.length > 0 && (
          <div className="queue">
            Next up: {waiting.map((b) => b.username).join(', ')}
          </div>
        )}
        {me.isQuestionMaster && (
          <button className="small danger finish" onClick={() => run(() => api.finishEvent(id))}>
            Finish the quiz
          </button>
        )}
      </div>
    </div>
  );
}
