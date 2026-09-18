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
is named question master. A finished quiz can be re-opened by the question
master or an admin, with the scores and the questions already asked intact.

**The buzzer** — once a quiz is live the screen splits: a BUZZ! button on top,
and below it the scoreboard showing you and two people either side, by place,
name and score. Everyone's button changes to whoever buzzed first, and stays
tappable so people behind them take their place in the queue. The question
master sees that name with +1 / 0 / -1 underneath: +1 scores and clears the
queue for the next question, while 0 and -1 hand the floor to the next person
who buzzed. Every change is pushed to every screen over Socket.IO.

**Head to head** — tapping another member's name in a group shows your record
against them: quizzes won, drawn and lost, and who reached the buzzer first on
the questions you both buzzed on.

**Still to come** — polishing the half-screen layout on real phones, and
putting it somewhere it can be played from outside the house.

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
| `GET /api/groups/:id/head-to-head/:userId` | Your record against another member. |
| `GET /api/groups/:id/events` | The group's quiz nights. |
| `POST /api/groups/:id/events` | Admin: plan a quiz night. |
| `GET /api/events/:id` | The whole live picture: players, queue, scores. |
| `POST /api/events/:id/join` | Join a quiz. |
| `DELETE /api/events/:id/join` | Drop out. |
| `POST /api/events/:id/question-master` | Admin: name the question master. |
| `POST /api/events/:id/start` | Go live and open the first question. |
| `POST /api/events/:id/finish` | End the quiz. |
| `POST /api/events/:id/reopen` | Bring a finished quiz back, scores intact. |
| `POST /api/events/:id/buzz` | Buzz in. |
| `POST /api/events/:id/judge` | Question master: `{ delta: 1 \| 0 \| -1 }`. |
| `POST /api/events/:id/next-question` | Question master: abandon this question. |

Every route except register and login needs `Authorization: Bearer <token>`.

During a live quiz the app uses the socket rather than these last few routes, so
a buzz is not waiting on an HTTP round trip. The socket takes `event:watch`,
`event:buzz` and `event:judge`, and pushes `event:state` to every screen
watching whenever anything changes.
