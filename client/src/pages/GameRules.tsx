import { useState } from 'react';
import type { GameRules, Points, SecondBuzz } from '../lib/api';

/** +3, 0, −1: the way a score change reads on a button. */
export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

const POSITIONS = ['1st answer', '2nd answer', '3rd and later'];

const SECOND_BUZZ: { value: SecondBuzz; label: string; detail: string }[] = [
  {
    value: 'queue',
    label: 'Queue',
    detail: 'Everyone who buzzed waits in order, and a miss passes to the next in line.',
  },
  {
    value: 'reopen',
    label: 'Re-open',
    detail: 'No queue. A miss frees the buzzer for everyone who has not answered yet.',
  },
  { value: 'one_shot', label: 'One shot', detail: 'Only the first buzzer answers. A miss ends the question.' },
];

const flat = (right: number, wrong: number): GameRules['points'] => [
  { right, wrong },
  { right, wrong },
  { right, wrong },
];

const PRESETS: { name: string; points: GameRules['points'] }[] = [
  { name: 'Classic', points: flat(1, -1) },
  { name: 'No penalties', points: flat(1, 0) },
  {
    name: 'Sliding',
    points: [
      { right: 3, wrong: -1 },
      { right: 2, wrong: 0 },
      { right: 1, wrong: 0 },
    ],
  },
];

const samePoints = (a: GameRules['points'], b: GameRules['points']) =>
  a.every((p, i) => p.right === b[i].right && p.wrong === b[i].wrong);

/** One line for the lobby: "+1 right, −1 wrong · Queue". */
export function rulesSummary(rules: GameRules): string {
  const [first, second, rest] = rules.points;
  const preset = PRESETS.find((p) => samePoints(p.points, rules.points));
  const points =
    samePoints(rules.points, flat(first.right, first.wrong))
      ? `${signed(first.right)} right, ${signed(first.wrong)} wrong`
      : [first, second, rest].map((p, i) => `${['1st', '2nd', '3rd+'][i]} ${signed(p.right)}/${signed(p.wrong)}`).join(', ');
  const buzz = SECOND_BUZZ.find((b) => b.value === rules.secondBuzz)?.label ?? '';
  return `${preset && preset.name !== 'Classic' ? `${preset.name}: ` : ''}${points} · ${buzz}`;
}

function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number) => Math.max(-100, Math.min(100, n));
  return (
    <div className="stepper">
      <button className="small" onClick={() => onChange(clamp(value - 1))} aria-label={`${label}, one less`}>
        −
      </button>
      <span className="stepper-value">{signed(value)}</span>
      <button className="small" onClick={() => onChange(clamp(value + 1))} aria-label={`${label}, one more`}>
        +
      </button>
    </div>
  );
}

/**
 * The admin's or question master's pop-up for how a quiz is played: what a
 * right and a wrong answer are worth by answer position, and what happens
 * after a miss. It can be opened mid-quiz; changes count from the next answer
 * scored.
 */
export function RulesEditor({
  rules,
  live,
  onSave,
  onClose,
}: {
  rules: GameRules;
  live: boolean;
  onSave: (rules: GameRules) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<GameRules>(rules);
  const setPoints = (i: number, change: Partial<Points>) =>
    setDraft((d) => ({
      ...d,
      points: d.points.map((p, j) => (j === i ? { ...p, ...change } : p)) as GameRules['points'],
    }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rules" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Game rules</h2>
        {live && <div className="sub">Changes count from the next answer you score.</div>}

        <h2 className="section">Points</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className={`small${samePoints(p.points, draft.points) ? ' primary' : ''}`}
              onClick={() => setDraft((d) => ({ ...d, points: p.points }))}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="card points-table">
          <div className="points-row head">
            <span />
            <span>Right</span>
            <span>Wrong</span>
          </div>
          {draft.points.map((p, i) => (
            <div className="points-row" key={i}>
              <span className="sub">{POSITIONS[i]}</span>
              <Stepper value={p.right} onChange={(right) => setPoints(i, { right })} label={`${POSITIONS[i]} right`} />
              <Stepper value={p.wrong} onChange={(wrong) => setPoints(i, { wrong })} label={`${POSITIONS[i]} wrong`} />
            </div>
          ))}
        </div>

        <h2 className="section">After a miss</h2>
        <div className="card list">
          {SECOND_BUZZ.map((b) => (
            <label className="row choice" key={b.value}>
              <input
                type="radio"
                name="second-buzz"
                checked={draft.secondBuzz === b.value}
                onChange={() => setDraft((d) => ({ ...d, secondBuzz: b.value }))}
              />
              <div className="grow">
                <div className="name">{b.label}</div>
                <div className="sub">{b.detail}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button className="block" onClick={onClose}>
            Cancel
          </button>
          <button className="block primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
