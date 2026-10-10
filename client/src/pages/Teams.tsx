import { useState } from 'react';
import { api, type BoardEntry, type EventState, type TeamEntry } from '../lib/api';
import { JUDGED, vibrate } from '../lib/haptics';
import { useHold } from './ScorePopups';

type Run = (fn: () => Promise<unknown>) => Promise<void>;

const MAX_TEAMS = 8;

/** A team's colour as a small dot. */
export function TeamDot({ colour }: { colour: string }) {
  return <span className="team-dot" style={{ background: colour }} />;
}

/** A pop-up asking for a team name, for making a team or renaming one. */
export function TeamNameModal({
  title,
  initial = '',
  confirmLabel,
  onSave,
  onClose,
}: {
  title: string;
  initial?: string;
  confirmLabel: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onSave(name.trim());
        }}
      >
        <h2>{title}</h2>
        <input
          autoFocus
          value={name}
          maxLength={24}
          placeholder="Team name"
          onChange={(e) => setName(e.target.value)}
          aria-label="Team name"
        />
        <div className="modal-actions spaced">
          <button type="button" className="block" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="block primary" disabled={!ok}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The question master's pop-up for shuffling everyone into random teams. */
function RandomTeamsModal({ players, onSave, onClose }: { players: number; onSave: (n: number) => void; onClose: () => void }) {
  const most = Math.min(MAX_TEAMS, players);
  const [count, setCount] = useState(Math.min(2, most));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Random teams</h2>
        <div className="sub">Everyone playing is shuffled into even teams. Any teams already made are replaced.</div>
        <div className="adjust">
          <button className="adjust-btn" disabled={count <= 2} onClick={() => setCount((c) => c - 1)} aria-label="One team fewer">
            −
          </button>
          <div className="adjust-value">
            <div className="tally-value">{count}</div>
            <div className="sub">teams</div>
          </div>
          <button className="adjust-btn" disabled={count >= most} onClick={() => setCount((c) => c + 1)} aria-label="One team more">
            +
          </button>
        </div>
        <div className="modal-actions">
          <button className="block" onClick={onClose}>
            Cancel
          </button>
          <button className="block primary" disabled={most < 2} onClick={() => onSave(count)}>
            Shuffle
          </button>
        </div>
      </div>
    </div>
  );
}

/** The question master's pop-up for moving one player to another team. */
function MovePlayerModal({
  state,
  player,
  onMove,
  onClose,
}: {
  state: EventState;
  player: { userId: number; username: string };
  onMove: (teamId: number | null) => void;
  onClose: () => void;
}) {
  const current = state.teams.find((t) => t.members.some((m) => m.userId === player.userId))?.id ?? null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Move {player.username}</h2>
        <div className="card list">
          {state.teams.map((t) => (
            <button key={t.id} className="team-pick" disabled={t.id === current} onClick={() => onMove(t.id)}>
              <TeamDot colour={t.colour} />
              <span className="grow">{t.name}</span>
              {t.id === current && <span className="sub">now</span>}
            </button>
          ))}
          {state.event.status === 'scheduled' && current !== null && (
            <button className="team-pick" onClick={() => onMove(null)}>
              <span className="grow">No team</span>
            </button>
          )}
        </div>
        <div className="modal-actions spaced">
          <button className="block" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The lobby of a team quiz: the teams so far, a way to make or join one, and
 * for the question master random teams and moving people about. Also used in
 * a pop-up mid-quiz, for someone who joins late and has no team yet.
 */
export function TeamsPanel({ state, eventId, run }: { state: EventState; eventId: number; run: Run }) {
  const { me, event } = state;
  const [modal, setModal] = useState<
    | { kind: 'create' }
    | { kind: 'rename'; team: TeamEntry }
    | { kind: 'random' }
    | { kind: 'move'; player: { userId: number; username: string } }
    | null
  >(null);
  const close = () => setModal(null);

  const isRunner = me.isQuestionMaster || me.isAdmin;
  const canPick = me.isParticipant && !me.isQuestionMaster && (event.status === 'scheduled' || me.teamId === null);
  const onTeam = new Set(state.teams.flatMap((t) => t.members.map((m) => m.userId)));
  const noTeam = state.participants.filter((p) => p.id !== event.questionMasterId && !onTeam.has(p.id));
  const players = state.participants.filter((p) => p.id !== event.questionMasterId).length;
  const myTeam = state.teams.find((t) => t.id === me.teamId);
  const moveable = (userId: number, username: string) =>
    isRunner ? { onClick: () => setModal({ kind: 'move', player: { userId, username } }), className: 'member pickable' } : { className: 'member' };

  return (
    <>
      <h2>Teams ({state.teams.length})</h2>
      {state.teams.length === 0 && (
        <div className="card empty">
          No teams yet.{canPick ? ' Make one, and the others can join it.' : ''}
        </div>
      )}
      {state.teams.map((t) => (
        <div className={`card team-card${t.id === me.teamId ? ' mine' : ''}`} key={t.id} style={{ borderColor: t.colour }}>
          <div className="row">
            <TeamDot colour={t.colour} />
            <div className="grow name">{t.name}</div>
            {t.id === me.teamId || isRunner ? (
              <button className="small" onClick={() => setModal({ kind: 'rename', team: t })}>
                Rename
              </button>
            ) : null}
            {canPick && t.id !== me.teamId && (
              <button className="small primary" onClick={() => run(() => api.joinTeam(eventId, t.id))}>
                Join
              </button>
            )}
            {t.id === me.teamId && event.status === 'scheduled' && (
              <button className="small" onClick={() => run(() => api.leaveTeam(eventId))}>
                Leave
              </button>
            )}
          </div>
          <div className="members">
            {t.members.map((m) => (
              <span key={m.userId} {...moveable(m.userId, m.username)}>
                {m.username}
                {m.userId === me.userId && ' (you)'}
              </span>
            ))}
          </div>
        </div>
      ))}

      {noTeam.length > 0 && (
        <div className="card">
          <div className="sub">No team yet{isRunner ? ' (tap a name to place them)' : ''}</div>
          <div className="members">
            {noTeam.map((p) => (
              <span key={p.id} {...moveable(p.id, p.username)}>
                {p.username}
                {p.id === me.userId && ' (you)'}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="team-actions">
        {canPick && !myTeam && state.teams.length < MAX_TEAMS && (
          <button className="primary block" onClick={() => setModal({ kind: 'create' })}>
            Create a team
          </button>
        )}
        {canPick && myTeam && event.status === 'scheduled' && state.teams.length < MAX_TEAMS && (
          <button className="block" onClick={() => setModal({ kind: 'create' })}>
            Start a new team instead
          </button>
        )}
        {isRunner && event.status === 'scheduled' && (
          <button className="block" disabled={players < 2} onClick={() => setModal({ kind: 'random' })}>
            Random teams
          </button>
        )}
      </div>

      {modal?.kind === 'create' && (
        <TeamNameModal
          title="Create a team"
          confirmLabel="Create"
          onClose={close}
          onSave={(name) => {
            close();
            run(() => api.createTeam(eventId, name));
          }}
        />
      )}
      {modal?.kind === 'rename' && (
        <TeamNameModal
          title="Rename team"
          initial={modal.team.name}
          confirmLabel="Save"
          onClose={close}
          onSave={(name) => {
            close();
            run(() => api.renameTeam(eventId, modal.team.id, name));
          }}
        />
      )}
      {modal?.kind === 'random' && (
        <RandomTeamsModal
          players={players}
          onClose={close}
          onSave={(count) => {
            close();
            run(() => api.randomTeams(eventId, count));
          }}
        />
      )}
      {modal?.kind === 'move' && (
        <MovePlayerModal
          state={state}
          player={modal.player}
          onClose={close}
          onMove={(teamId) => {
            close();
            run(() => api.moveToTeam(eventId, modal.player.userId, teamId));
          }}
        />
      )}
    </>
  );
}

/** One player's line under their team; the question master holds it to put their score right. */
function MemberRow({ member, onHold, isMe }: { member: TeamEntry['members'][number]; onHold?: () => void; isMe: boolean }) {
  const hold = useHold(() => {
    vibrate(JUDGED);
    onHold?.();
  });
  return (
    <div className={`member-row${isMe ? ' me' : ''}${onHold ? ' pickable' : ''}`} {...(onHold ? hold : {})}>
      <span className="who">{member.username}</span>
      <span className="score">{member.score}</span>
    </div>
  );
}

/**
 * The leaderboard of a team quiz: one row per team with its total. Tap a team
 * to see its players and what each has scored. The question master presses
 * and holds a player there to adjust their score, as on the individual board.
 */
export function TeamBoard({
  state,
  full = false,
  onHoldMember,
}: {
  state: EventState;
  full?: boolean;
  onHoldMember?: (entry: BoardEntry) => void;
}) {
  const [open, setOpen] = useState<number | null>(full ? null : state.me.teamId);
  if (state.teams.length === 0) return <div className="empty">No teams yet.</div>;
  const answeringTeam = state.answering?.team?.id;
  const queued = new Set(state.queue.filter((b) => b.outcome === 'waiting').map((b) => b.team?.id));

  return (
    <div className={`board${full ? '' : ' scrolls'}`}>
      {state.teams.map((t) => (
        <div key={t.id} className="team-block">
          <div
            className={`board-row team-row pickable${t.id === state.me.teamId ? ' me' : ''}${
              t.id === answeringTeam ? ' answering' : ''
            }`}
            style={{ borderLeftColor: t.colour }}
            onClick={() => setOpen((o) => (o === t.id ? null : t.id))}
          >
            <span className="place">{t.place}</span>
            <span className="who">{t.name}</span>
            {t.id === answeringTeam ? (
              <span className="flag now">answering</span>
            ) : (
              queued.has(t.id) && <span className="flag queued">buzzed</span>
            )}
            <span className="score">{t.score}</span>
          </div>
          {open === t.id &&
            t.members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                isMe={m.userId === state.me.userId}
                onHold={
                  onHoldMember
                    ? () => onHoldMember({ place: t.place, userId: m.userId, username: m.username, score: m.score })
                    : undefined
                }
              />
            ))}
        </div>
      ))}
    </div>
  );
}

/** Mid-quiz, for someone who has joined late in a team quiz and has no team. */
export function PickTeamModal({
  state,
  eventId,
  run,
  onClose,
}: {
  state: EventState;
  eventId: number;
  run: Run;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rules" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <TeamsPanel state={state} eventId={eventId} run={(fn) => run(fn).then(onClose)} />
        <div className="modal-actions spaced">
          <button className="block" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
