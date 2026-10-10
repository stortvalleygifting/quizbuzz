import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type BoardEntry, type EventState, type GameRules } from '../lib/api';
import { useConfirm } from '../lib/confirm';
import { useEventState } from '../lib/useEventState';
import { JUDGED, YOUR_TURN, vibrate } from '../lib/haptics';
import { AdjustScore, QuizRivalry, useHold } from './ScorePopups';
import { RulesEditor, rulesSummary, signed } from './GameRules';
import { PickTeamModal, TeamBoard, TeamDot, TeamsPanel } from './Teams';

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/** How long after someone scrolls the board it stays where they left it. */
const HANDS_OFF_MS = 6000;

/**
 * Everybody who is playing, in order.
 *
 * On the live screen the board shows five rows at a time and scrolls for the
 * rest. It starts with you in the middle, the you-and-two-either-side view Rob
 * first asked for, and follows you as your place changes, unless you have just
 * scrolled it yourself to look at somebody else.
 */
function Scoreboard({
  state,
  full = false,
  onTap,
  onHold,
}: {
  state: EventState;
  full?: boolean;
  onTap?: (e: BoardEntry) => void;
  onHold?: (e: BoardEntry) => void;
}) {
  const rows = state.leaderboard;
  const boardRef = useRef<HTMLDivElement>(null);
  const meRef = useRef<HTMLDivElement>(null);
  const touchedAt = useRef(0);
  const myPlace = rows.find((e) => e.userId === state.me.userId)?.place;

  useEffect(() => {
    const board = boardRef.current;
    const row = meRef.current;
    if (full || !board || !row) return;
    if (Date.now() - touchedAt.current < HANDS_OFF_MS) return;
    // Set scrollTop rather than scrollIntoView, which would also nudge the page.
    board.scrollTop = row.offsetTop - (board.clientHeight - row.offsetHeight) / 2;
  }, [full, myPlace, rows.length]);

  if (rows.length === 0) return <div className="empty">Nobody is playing yet.</div>;

  const queued = new Set(state.queue.filter((b) => b.outcome === 'waiting').map((b) => b.userId));
  const handsOff = () => {
    touchedAt.current = Date.now();
  };

  return (
    <div className={`board${!full && rows.length > 5 ? ' scrolls' : ''}`} ref={boardRef} onTouchMove={handsOff} onWheel={handsOff}>
      {rows.map((e) => {
        const isMe = e.userId === state.me.userId;
        const answering = state.answering?.userId === e.userId;
        return (
          <BoardRow
            key={e.userId}
            entry={e}
            rowRef={isMe ? meRef : undefined}
            className={`board-row${isMe ? ' me' : ''}${answering ? ' answering' : ''}`}
            onTap={onTap && !isMe ? () => onTap(e) : undefined}
            onHold={onHold ? () => onHold(e) : undefined}
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
          </BoardRow>
        );
      })}
    </div>
  );
}

/**
 * One leaderboard row. Players tap someone else's name to see how they are
 * doing against them in this quiz; the question master presses and holds a
 * name to put that person's score right.
 */
function BoardRow({
  entry,
  rowRef,
  className,
  onTap,
  onHold,
  children,
}: {
  entry: BoardEntry;
  rowRef?: Ref<HTMLDivElement>;
  className: string;
  onTap?: () => void;
  onHold?: () => void;
  children: ReactNode;
}) {
  const hold = useHold(() => {
    vibrate(JUDGED);
    onHold?.();
  });
  return (
    <div
      className={`${className}${onTap || onHold ? ' pickable' : ''}`}
      ref={rowRef}
      data-user={entry.userId}
      onClick={onTap}
      {...(onHold ? hold : {})}
    >
      {children}
    </div>
  );
}

/**
 * The bottom half of the question master's button: right, pass and wrong, each
 * showing what it is worth for whoever is answering (+1 / 0 / −1 on Classic).
 */
function JudgeControls({ onJudge, right, wrong }: { onJudge: (delta: 1 | 0 | -1) => void; right: number; wrong: number }) {
  return (
    <div className="judge">
      <button className="judge-btn plus" onClick={() => onJudge(1)} aria-label={`Right, ${signed(right)}`}>
        {signed(right)}
        <span className="judge-word">right</span>
      </button>
      <button className="judge-btn zero" onClick={() => onJudge(0)} aria-label="Pass, no score">
        0<span className="judge-word">pass</span>
      </button>
      <button className="judge-btn minus" onClick={() => onJudge(-1)} aria-label={`Wrong, ${signed(wrong)}`}>
        {signed(wrong)}
        <span className="judge-word">wrong</span>
      </button>
    </div>
  );
}

const ANSWER_POSITION = ['1st answer', '2nd answer'];

export default function Event() {
  const { eventId } = useParams();
  const id = Number(eventId);
  const navigate = useNavigate();
  const { state, error, connected, buzzPending, buzz, judge, run } = useEventState(id);
  const confirm = useConfirm();
  // A name tapped (a player looking at a rival) or held (the question master
  // fixing a score) on the leaderboard.
  const [picked, setPicked] = useState<{ entry: BoardEntry; kind: 'rivalry' | 'adjust' } | null>(null);
  const [editingRules, setEditingRules] = useState(false);
  const [pickingTeam, setPickingTeam] = useState(false);

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
  const teamQuiz = state.rules.playAs === 'teams';
  const myTeam = state.teams.find((t) => t.id === me.teamId);
  const boardActions = {
    // Head-to-head only once the quiz is over, so nobody is distracted mid-game,
    // and never for team quizzes, which don't count towards it.
    onTap:
      event.status === 'finished' && me.isParticipant && !me.isQuestionMaster && !teamQuiz
        ? (entry: BoardEntry) => setPicked({ entry, kind: 'rivalry' })
        : undefined,
    onHold: me.isQuestionMaster ? (entry: BoardEntry) => setPicked({ entry, kind: 'adjust' }) : undefined,
  };
  const popup = () =>
    picked?.kind === 'rivalry' ? (
      <QuizRivalry eventId={id} entry={picked.entry} onClose={() => setPicked(null)} />
    ) : picked?.kind === 'adjust' ? (
      <AdjustScore
        entry={picked.entry}
        onClose={() => setPicked(null)}
        onSave={(delta) => {
          setPicked(null);
          run(() => api.adjustScore(id, picked.entry.userId, delta));
        }}
      />
    ) : null;
  const canSetRules = (me.isAdmin || me.isQuestionMaster) && event.status !== 'finished';
  const rulesPopup = () =>
    editingRules && (
      <RulesEditor
        rules={state.rules}
        live={event.status === 'live'}
        onClose={() => setEditingRules(false)}
        onSave={(rules: GameRules) => {
          setEditingRules(false);
          run(() => api.setRules(id, rules));
        }}
      />
    );
  const board = (full = false) =>
    teamQuiz ? (
      <TeamBoard state={state} full={full} onHoldMember={boardActions.onHold} />
    ) : (
      <Scoreboard state={state} full={full} {...boardActions} />
    );
  const waiting = queue.filter((b) => b.outcome === 'waiting');
  // Your place among the people still to be heard, so 1st means you are next
  // up — the same order the "Next up" line lists. 0 if you are not waiting:
  // either you never buzzed, or the question master has already been to you.
  const myPlaceInQueue =
    waiting.findIndex((b) => (teamQuiz && me.teamId !== null ? b.team?.id === me.teamId : b.userId === me.userId)) + 1;
  // In a team quiz, someone on your team has already buzzed on this question.
  const teamIn = teamQuiz && me.teamId !== null && queue.some((b) => b.team?.id === me.teamId);
  const ourTurn = teamQuiz && me.teamId !== null && answering?.team?.id === me.teamId;
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
          <div className="rules-line">
            <span className="sub">Rules: {rulesSummary(state.rules)}</span>
            {canSetRules && (
              <button className="small" onClick={() => setEditingRules(true)}>
                Change
              </button>
            )}
          </div>
        </div>
        {rulesPopup()}

        {finished && (
          <>
            <h2>Final scores</h2>
            <div className="card">{board(true)}</div>
            {(me.isQuestionMaster || me.isAdmin) && (
              <button className="primary block" onClick={() => run(() => api.reopenEvent(id))}>
                Re-open this quiz
              </button>
            )}
            {popup()}
          </>
        )}

        {!finished &&
          (me.isParticipant ? (
            <button
              className="block"
              onClick={async () => {
                if (await confirm({ title: 'Leave this quiz?', message: 'You can join again before it starts.', confirmLabel: 'Leave', danger: true }))
                  run(() => api.leaveEvent(id)).then(() => navigate(`/groups/${event.groupId}`));
              }}
            >
              Leave this quiz
            </button>
          ) : (
            <button className="primary block" onClick={() => run(() => api.joinEvent(id))}>
              Join this quiz
            </button>
          ))}

        {!finished && teamQuiz && <TeamsPanel state={state} eventId={id} run={run} />}

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
  const finish = async () => {
    if (
      await confirm({
        title: 'Finish this quiz?',
        message: 'Everyone sees the final scores. It can be re-opened afterwards.',
        confirmLabel: 'Finish',
        danger: true,
      })
    )
      run(() => api.finishEvent(id));
  };
  // What a right or wrong answer is worth for whoever has the floor.
  const pointsNow = state.rules.points[Math.min(answering?.position ?? 1, 3) - 1];
  // With the queue, a buzz behind whoever is answering takes a place in line;
  // under the other rules the buzzer waits until they have been judged.
  const queueing = state.rules.secondBuzz === 'queue';
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
          {myTeam && (
            <span className="my-team">
              <TeamDot colour={myTeam.colour} />
              {myTeam.name}
            </span>
          )}
          <span className="qno">Q{state.question?.seq ?? '–'}</span>
        </div>

        {!connected && <div className="netbar">Reconnecting… your buzz may not count yet.</div>}
        {error && <div className="error thin">{error}</div>}

        {board()}

        {me.isQuestionMaster ? (
          <div className="qm-tools">
            <span className="sub grow">
              {waiting.length > 0
                ? `${waiting.length} still waiting to answer`
                : answering
                  ? 'Score the answer below.'
                  : 'Nobody has buzzed.'}
            </span>
            <button className="small" onClick={() => setEditingRules(true)}>
              Rules
            </button>
            <button className="small" onClick={() => run(() => api.nextQuestion(id))}>
              Skip
            </button>
            <button className="small danger" onClick={finish}>
              Finish
            </button>
          </div>
        ) : (
          <>
            {waiting.length > 0 && (
              <div className="queue">
                Next up: {waiting.map((b) => (teamQuiz && b.team ? `${b.team.name} (${b.username})` : b.username)).join(' · ')}
              </div>
            )}
            {/* Group admins can call time too, say if the question master's
                phone has died. */}
            {me.isAdmin && (
              <div className="qm-tools">
                <span className="sub grow">You are a group admin.</span>
                <button className="small danger" onClick={finish}>
                  Finish quiz
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="buzz-half">
        {me.isQuestionMaster ? (
          answering ? (
            <div className="qm-panel">
              <div className="qm-name">
                {answering.username}
                {answering.team && (
                  <span className="qm-team">
                    <TeamDot colour={answering.team.colour} />
                    {answering.team.name}
                  </span>
                )}
                <span className="qm-position">
                  {ANSWER_POSITION[answering.position - 1] ?? `${ordinal(answering.position)} answer`}
                </span>
              </div>
              <JudgeControls
                onJudge={onJudge}
                right={pointsNow.right}
                wrong={pointsNow.wrong}
              />
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
        ) : teamQuiz && !myTeam ? (
          <button className="buzz join" onClick={() => setPickingTeam(true)}>
            <span className="buzz-word">PICK A TEAM</span>
            <span className="buzz-sub">Join a team to buzz in.</span>
          </button>
        ) : answering && answering.team && teamQuiz ? (
          // A team quiz: the button shows the team that has the floor, and a
          // teammate's buzz after your team's first one doesn't count.
          <button
            className={`buzzed team${ourTurn ? ' mine' : inQueue ? ' queued' : ''}`}
            style={ourTurn || inQueue ? undefined : { borderColor: answering.team.colour }}
            disabled={teamIn || !queueing}
            onClick={buzz}
          >
            <div className="buzz-name">{answering.team.name}</div>
            {/* Your own team: who is answering matters as much as which team. */}
            {ourTurn && <div className="buzz-name">{answering.username}</div>}
            <div className="buzz-sub">
              {mine
                ? 'Your answer — go!'
                : ourTurn
                  ? 'is answering for your team'
                  : inQueue
                    ? `${answering.username} is answering · your team is ${ordinal(myPlaceInQueue)} in the queue`
                    : teamIn || !queueing
                      ? `${answering.username} is answering`
                      : `${answering.username} is answering · tap to queue for your team`}
            </div>
          </button>
        ) : answering ? (
          // The button shows whoever got in first, but with the queue it still
          // takes your buzz so you can take your place behind them.
          <button
            className={`buzzed${mine ? ' mine' : inQueue ? ' queued' : ''}`}
            disabled={me.hasBuzzed || !queueing}
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
                    : !queueing
                      ? state.rules.secondBuzz === 'reopen'
                        ? 'is answering · the buzzer re-opens if they miss'
                        : 'is answering'
                      : 'is answering · tap to join the queue'}
            </div>
          </button>
        ) : me.hasBuzzed || teamIn ? (
          // Re-open: you (or your team) have had your go at this one, and the
          // rest still can.
          <button className="buzz" disabled>
            <span className="buzz-word">WAIT</span>
            <span className="buzz-sub">{teamQuiz ? 'Your team has had its go at this question' : "You've had your go at this question"}</span>
          </button>
        ) : (
          <button className={`buzz${buzzPending ? ' pending' : ''}`} onClick={buzz}>
            <span className="buzz-word">BUZZ!</span>
            {buzzPending && <span className="buzz-sub">sent…</span>}
          </button>
        )}
      </div>
      {picked?.kind === 'adjust' && popup()}
      {rulesPopup()}
      {pickingTeam && <PickTeamModal state={state} eventId={id} run={run} onClose={() => setPickingTeam(false)} />}
    </div>
  );
}
