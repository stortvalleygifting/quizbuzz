import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type BoardEntry, type EventState } from '../lib/api';
import { useEventState } from '../lib/useEventState';
import { JUDGED, YOUR_TURN, vibrate } from '../lib/haptics';

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

/**
 * `full` is the board at the end of the night: everybody who played, rather
 * than the five-row window the live screen keeps around you.
 */
function Scoreboard({ state, full = false }: { state: EventState; full?: boolean }) {
  const rows = full
    ? state.leaderboard
    : state.me.isQuestionMaster
      ? state.leaderboard.slice(0, 5)
      : windowAround(state.leaderboard, state.me.userId);

  if (rows.length === 0) return <div className="empty">Nobody is playing yet.</div>;

  const queued = new Set(state.queue.filter((b) => b.outcome === 'waiting').map((b) => b.userId));

  return (
    <div className="board">
      {rows.map((e) => {
        const isMe = e.userId === state.me.userId;
        const answering = state.answering?.userId === e.userId;
        return (
          <div
            className={`board-row${isMe ? ' me' : ''}${answering ? ' answering' : ''}`}
            key={e.userId}
          >
            <span className="place">{e.place}</span>
            <span className="who">{e.username}</span>
            {/* The question master judges from this board, so it says who is on
                the floor and who is still holding a buzz. */}
            {answering ? (
              <span className="flag now">answering</span>
            ) : (
              queued.has(e.userId) && <span className="flag queued">buzzed</span>
            )}
            <span className="score">{e.score}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The bottom half of the question master's button: +1, 0 and -1. */
function JudgeControls({ onJudge }: { onJudge: (delta: 1 | 0 | -1) => void }) {
  return (
    <div className="judge">
      <button className="judge-btn plus" onClick={() => onJudge(1)} aria-label="Correct, plus one">
        +1
      </button>
      <button className="judge-btn zero" onClick={() => onJudge(0)} aria-label="No score, pass on">
        0
      </button>
      <button className="judge-btn minus" onClick={() => onJudge(-1)} aria-label="Wrong, minus one">
        −1
      </button>
    </div>
  );
}

export default function Event() {
  const { eventId } = useParams();
  const id = Number(eventId);
  const navigate = useNavigate();
  const { state, error, connected, buzzPending, buzz, judge, run } = useEventState(id);

  // The moment the floor passes to you, in a room too loud to hear anything.
  const wasMine = useRef(false);
  const mine = state?.answering?.userId === state?.me.userId && Boolean(state?.answering);
  useEffect(() => {
    if (mine && !wasMine.current) vibrate(YOUR_TURN);
    wasMine.current = mine;
  }, [mine]);

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
  // Your place among the people still to be heard, so 1st means you are next
  // up — the same order the "Next up" line lists. 0 if you are not waiting:
  // either you never buzzed, or the question master has already been to you.
  const myPlaceInQueue = waiting.findIndex((b) => b.userId === me.userId) + 1;
  const inQueue = myPlaceInQueue > 0;

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
              <Scoreboard state={state} full />
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
  // The scoreboard sits above and the buzzer takes the bottom half of the
  // screen, where a thumb already is when the phone is held in one hand.
  const onJudge = (delta: 1 | 0 | -1) => {
    vibrate(JUDGED);
    judge(delta);
  };

  return (
    <div className="event-live">
      <div className="board-half">
        <div className="event-head">
          <Link to={`/groups/${event.groupId}`} className="back" aria-label="Back to the group">
            ‹
          </Link>
          <span className="grow">{event.name}</span>
          <span className="qno">Q{state.question?.seq ?? '–'}</span>
        </div>

        {!connected && <div className="netbar">Reconnecting… your buzz may not count yet.</div>}
        {error && <div className="error thin">{error}</div>}

        <Scoreboard state={state} />

        {me.isQuestionMaster ? (
          <div className="qm-tools">
            <span className="sub grow">
              {waiting.length > 0
                ? `${waiting.length} still waiting to answer`
                : answering
                  ? 'Score the answer below.'
                  : 'Nobody has buzzed.'}
            </span>
            <button className="small" onClick={() => run(() => api.nextQuestion(id))}>
              Skip
            </button>
            <button className="small danger" onClick={() => run(() => api.finishEvent(id))}>
              Finish
            </button>
          </div>
        ) : (
          waiting.length > 0 && (
            <div className="queue">Next up: {waiting.map((b) => b.username).join(' · ')}</div>
          )
        )}
      </div>

      <div className="buzz-half">
        {me.isQuestionMaster ? (
          answering ? (
            <div className="qm-panel">
              <div className="qm-name">{answering.username}</div>
              <JudgeControls onJudge={onJudge} />
            </div>
          ) : (
            <div className="buzz-idle">
              <div className="buzz-idle-text">Waiting for a buzz…</div>
            </div>
          )
        ) : !me.isParticipant ? (
          <button className="buzz join" onClick={() => run(() => api.joinEvent(id))}>
            <span className="buzz-word">JOIN IN</span>
            <span className="buzz-sub">You are watching. Tap to play.</span>
          </button>
        ) : answering ? (
          // The button shows whoever got in first, but it still takes your buzz
          // so you can take your place in the queue behind them.
          <button
            className={`buzzed${mine ? ' mine' : inQueue ? ' queued' : ''}`}
            disabled={me.hasBuzzed}
            onClick={buzz}
          >
            <div className="buzz-name">{answering.username}</div>
            <div className="buzz-sub">
              {mine
                ? 'Your answer — go!'
                : inQueue
                  ? `is answering · you are ${ordinal(myPlaceInQueue)} in the queue`
                  : me.hasBuzzed
                    ? 'is answering'
                    : 'is answering · tap to join the queue'}
            </div>
          </button>
        ) : (
          <button className={`buzz${buzzPending ? ' pending' : ''}`} onClick={buzz}>
            <span className="buzz-word">BUZZ!</span>
            {buzzPending && <span className="buzz-sub">sent…</span>}
          </button>
        )}
      </div>
    </div>
  );
}
