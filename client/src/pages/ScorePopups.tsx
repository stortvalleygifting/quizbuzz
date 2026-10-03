import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { api, type BoardEntry, type QuizHeadToHead } from '../lib/api';
import { Tally } from './HeadToHead';

/** How long a press has to last to count as press-and-hold. */
const HOLD_MS = 550;
/** How far a finger can drift before it counts as scrolling, not holding. */
const SLOP_PX = 10;

/**
 * Press-and-hold for a leaderboard row. The board scrolls, so a finger that
 * moves is scrolling and cancels the hold, and the browser's own long-press
 * menu is kept out of the way.
 */
export function useHold(onHold: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: PointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        start.current = null;
        onHold();
      }, HOLD_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}

/** The question master's pop-up for putting one person's score right. */
export function AdjustScore({
  entry,
  onSave,
  onClose,
}: {
  entry: BoardEntry;
  onSave: (delta: number) => void;
  onClose: () => void;
}) {
  const [delta, setDelta] = useState(0);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Adjust {entry.username}'s score</h2>
        <div className="adjust">
          <button className="adjust-btn" onClick={() => setDelta((d) => d - 1)} aria-label="One less">
            −
          </button>
          <div className="adjust-value">
            <div className="tally-value">{entry.score + delta}</div>
            <div className="sub">
              {delta === 0 ? 'no change' : `was ${entry.score}, ${delta > 0 ? '+' : ''}${delta}`}
            </div>
          </div>
          <button className="adjust-btn" onClick={() => setDelta((d) => d + 1)} aria-label="One more">
            +
          </button>
        </div>
        <div className="modal-actions">
          <button className="block" onClick={onClose}>
            Cancel
          </button>
          <button className="block primary" disabled={delta === 0} onClick={() => onSave(delta)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * You against one other player, in this quiz only: the scores and who got to
 * the buzzer first. During a live quiz it covers only the leaderboard, so the
 * BUZZ button underneath stays usable while it is open.
 */
export function QuizRivalry({
  eventId,
  entry,
  inBoard,
  onClose,
}: {
  eventId: number;
  entry: BoardEntry;
  inBoard: boolean;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<QuizHeadToHead | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .quizHeadToHead(eventId, entry.userId)
      .then((r) => setRecord(r.headToHead))
      .catch((e) => setError(e.message));
  }, [eventId, entry.userId]);

  return (
    <div className={inBoard ? 'sheet-backdrop' : 'modal-backdrop'} onClick={onClose}>
      <div className="modal" role="dialog" aria-modal={!inBoard} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">You v {entry.username}</h2>
          <button className="small" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <div className="error thin">{error}</div>
        ) : !record ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className="tallies">
              <Tally value={record.yourScore} label="you" tone={record.yourScore > record.theirScore ? 'good' : undefined} />
              <Tally
                value={record.theirScore}
                label={record.opponent.username}
                tone={record.theirScore > record.yourScore ? 'bad' : undefined}
              />
            </div>
            <div className="sub center">
              {record.buzzer.contested === 0
                ? 'You have not both buzzed on the same question yet.'
                : `Buzzer: you first ${record.buzzer.youFirst}, them first ${record.buzzer.themFirst}, out of ${
                    record.buzzer.contested
                  } ${record.buzzer.contested === 1 ? 'question' : 'questions'} you both buzzed on.`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
