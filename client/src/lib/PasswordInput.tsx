import { useState } from 'react';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
  autoFocus?: boolean;
}

/** A password box with a Show / Hide button, so people can check what they typed. */
export default function PasswordInput({ id, value, onChange, autoComplete, minLength, autoFocus }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        minLength={minLength}
        autoFocus={autoFocus}
        required
      />
      <button
        type="button"
        className="reveal"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
