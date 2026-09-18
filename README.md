# QuizBuzz

A mobile-first web app for live pub quizzes: players buzz in from their phones,
the question master marks the answers, and everyone's score updates live.

Open it in a phone browser — there is no app to install.

## What is built so far

**Accounts** — self-registration with a username and a password, nothing else.
Passwords are bcrypt-hashed; sessions are a bearer token kept in the browser.

**Groups** — create a group (the creator is its first admin), search every group
by name, apply to join, and wait for an admin to approve you. Admins approve or
decline applications, make other members admin, step admins back down, and
remove members. Anyone can leave, and a group can never be left without an
admin.

**Still to come** — events, the question master, the BUZZ screen and live
scoring. The database already has tables for all of it (see
`server/src/lib/schema.ts`), and the realtime socket is wired up and
authenticating, so that work slots in on top of this.

## Running it

```bash
npm install
npm run dev          # API on :3001, app on :5173 with live reload
```

Open http://localhost:5173 on your computer, or
`http://<your-computer's-LAN-ip>:5173` on a phone on the same wifi.

For something closer to production, where one URL serves both the app and the
API:

```bash
npm run build
npm start            # everything on http://localhost:3001
```

### Checks

```bash
npm test             # API tests
npm run typecheck    # TypeScript, both halves
```

## How it is put together

| | |
|---|---|
| `server/` | Node + Express API, SQLite via better-sqlite3, Socket.IO for realtime |
| `client/` | React + Vite, TypeScript, mobile-first CSS, no UI framework |

The database is a single SQLite file (`server/data/quizbuzz.sqlite` by default).
It is created and migrated on startup, so there is no separate setup step.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API port |
| `DATABASE_FILE` | `server/data/quizbuzz.sqlite` | SQLite file |
| `JWT_SECRET` | generated in dev | **Required in production**, 16+ characters |

### API

| | |
|---|---|
| `POST /api/auth/register` | Create an account. Returns a token. |
| `POST /api/auth/login` | Sign in. Returns a token. |
| `GET /api/auth/me` | Who am I. |
| `POST /api/groups` | Create a group; you become its admin. |
| `GET /api/groups/mine` | Groups I am in, and applications I am waiting on. |
| `GET /api/groups/search?q=` | Find groups to apply to. |
| `GET /api/groups/:id` | Group detail. Members see the roster, admins also see requests. |
| `POST /api/groups/:id/apply` | Apply to join. |
| `DELETE /api/groups/:id/apply` | Withdraw an application. |
| `POST /api/groups/:id/members/:userId/approve` | Admin: let someone in. |
| `POST /api/groups/:id/members/:userId/role` | Admin: make admin, or step one down. |
| `DELETE /api/groups/:id/members/:userId` | Admin: remove or decline. Anyone: leave. |

Every route except register and login needs `Authorization: Bearer <token>`.
