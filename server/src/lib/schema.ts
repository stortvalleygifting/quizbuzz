/**
 * Full database schema.
 *
 * Thread 1 builds accounts + groups. The event / question-master / buzz-queue /
 * scoring tables are defined here too, so the shape is settled before thread 2
 * wires up the live buzzer.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts --
-- created_at is the signup date, set once when the account is registered and
-- never rewritten. It is what a free-first-month offer would be honoured
-- against, so nothing should backdate or clear it.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------ groups --
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A row exists as soon as someone applies. status flips to 'approved' when an
-- admin lets them in; rejecting or removing deletes the row.
CREATE TABLE IF NOT EXISTS group_members (
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at    TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id, status);

-- ------------------------------------------------------------------ events --
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id            INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  scheduled_for       TEXT,
  status              TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','live','finished')),
  question_master_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  started_at          TEXT,
  ended_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id, status);

-- Who is playing, and their running score (denormalised from score_events so
-- the leaderboard is a single cheap read).
CREATE TABLE IF NOT EXISTS event_participants (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  score     INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_participants_board
  ON event_participants(event_id, score DESC);

-- ------------------------------------------------- questions & buzz queue --
CREATE TABLE IF NOT EXISTS questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  state     TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  UNIQUE (event_id, seq)
);

-- One row per person per question. seq is the buzz order: 1 is the person whose
-- name everyone sees, then the queue behind them.
CREATE TABLE IF NOT EXISTS buzzes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  buzzed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  outcome     TEXT NOT NULL DEFAULT 'waiting'
              CHECK (outcome IN ('waiting','answering','correct','pass','wrong','skipped')),
  UNIQUE (question_id, user_id),
  UNIQUE (question_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_buzzes_queue ON buzzes(question_id, seq);

-- Every +1 / 0 / -1 the question master presses, kept as an audit trail so a
-- score can be explained or undone.
CREATE TABLE IF NOT EXISTS score_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  delta       INTEGER NOT NULL,
  awarded_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_score_events_event ON score_events(event_id, created_at);

-- -------------------------------------------------------------- game rules --
-- How one quiz is played. A quiz with no row here plays Classic: individuals,
-- the buzz queue, and +1 / -1 for every answer, which is how every quiz before
-- game rules was played. These are tables of their own rather than columns on
-- events because this schema is only ever created if missing: a new column
-- would never reach the live database, but a new table does.
CREATE TABLE IF NOT EXISTS event_settings (
  event_id    INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  -- Teams arrive in a later update; the column is here now so they need no
  -- change to this table.
  play_as     TEXT NOT NULL DEFAULT 'individuals' CHECK (play_as IN ('individuals','teams')),
  -- What happens after a wrong answer or a pass: 'queue' hands the floor to
  -- the next person who buzzed, 'reopen' frees the buzzer for everyone who has
  -- not answered yet, 'one_shot' ends the question.
  second_buzz TEXT NOT NULL DEFAULT 'queue' CHECK (second_buzz IN ('queue','reopen','one_shot')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Points by answer position on a question: 1 is the first person to answer,
-- 2 the second, and 3 covers everyone after that.
CREATE TABLE IF NOT EXISTS event_points (
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  right_points INTEGER NOT NULL,
  wrong_points INTEGER NOT NULL,
  PRIMARY KEY (event_id, position)
);
`;
