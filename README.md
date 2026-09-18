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

**Quiz nights** — group admins plan an event, members join it, and one of them
is made question master. The admin starts it when everyone is in the room.

**The live screen** — the scoreboard fills the top half and the BUZZ! button the
bottom half, where a thumb already is when the phone is held in one hand. The
board shows five rows — you, and two people either side — as place, name and
score. The first buzz takes the floor and everyone's button turns into that
person's name; tapping it again puts you in the queue behind them. The question
master gets that name across the top half and +1 / 0 / -1 across the bottom.
+1 ends the question and resets everyone; 0 and -1 pass the floor to the next
person who buzzed. Every screen updates over a websocket as it happens.

It is built for a loud room: the phone vibrates when your tap lands and again
when the floor is yours, the button says so the moment a buzz is sent rather
than waiting on the server, and the screen tells you when it has lost its
connection instead of showing a scoreboard that is quietly out of date. Add it
to your home screen and it opens without an address bar.

## Running it

You need [Node.js](https://nodejs.org) 22 or newer — the current LTS is fine.
Nothing here compiles native code, so no build tools are needed on any platform.

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
| `server/` | Node + Express API, SQLite via Node's built-in `node:sqlite`, Socket.IO for realtime |
| `client/` | React + Vite, TypeScript, mobile-first CSS, no UI framework |

The database is a single SQLite file (`server/data/quizbuzz.sqlite` by default).
It is created and migrated on startup, so there is no separate setup step.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | API port |
| `DATABASE_FILE` | `server/data/quizbuzz.sqlite` | SQLite file |
| `JWT_SECRET` | generated in dev | **Required in production**, 16+ characters |
| `NODE_ENV` | unset | Set to `production` when deployed |

Without a valid `JWT_SECRET`, a production server exits on startup rather than
starting up healthy and failing on the first person who tries to sign in.

## Putting it online

The app is one always-on Node process with a SQLite file next to it, so it needs
a host that gives it **Node 22 or newer**, **a persistent disk**, **websockets**,
and **exactly one instance** — the buzz queue and the database both live inside
that single process, so a second instance would be a second, different quiz.

[Fly.io](https://fly.io) fits all four. `Dockerfile` and `fly.toml` here are set
up for it: one 256MB machine in London that never sleeps, with a 1GB volume
mounted at `/data` holding the database.

```bash
fly auth signup                       # or: fly auth login
fly launch --copy-config --no-deploy  # keeps the fly.toml in this repo
fly volumes create quizbuzz_data --size 1
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
fly deploy
```

`fly launch` will pick a unique name if `quizbuzz` is taken, and the app is then
live at `https://<name>.fly.dev` — that is the link to give people in the pub.

Any host meeting those four requirements works the same way. The one thing to
watch for is a free tier that sleeps after a few minutes idle: the first person
to open the link then waits out a cold start, which is a poor way to begin a
quiz night.

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
| `GET /api/groups/:id/events` | The group's quiz nights. |
| `POST /api/groups/:id/events` | Admin: plan a quiz night. |
| `GET /api/events/:id` | The whole live picture: queue, scores, who is who. |
| `POST /api/events/:id/join` | Join a quiz. `DELETE` to drop out. |
| `POST /api/events/:id/question-master` | Admin: hand someone the QM screen. |
| `POST /api/events/:id/start` | Go live and open the first question. |
| `POST /api/events/:id/finish` | Call it a night. |
| `POST /api/events/:id/buzz` | Buzz in. The app uses the socket instead. |
| `POST /api/events/:id/judge` | QM: `+1`, `0` or `-1` for whoever is answering. |
| `POST /api/events/:id/next-question` | QM: give up on this one, move everyone on. |

Every route except register and login needs `Authorization: Bearer <token>`.
