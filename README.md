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
is made question master, and the admin starts it when everyone is in the room.
A finished quiz can be re-opened by the question master or an admin, with the
scores and the questions already asked intact.

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

**Head to head** — tapping another member's name in a group shows your record
against them: quizzes won, drawn and lost, and who reached the buzzer first on
the questions you both buzzed on.

**Still to come** — actually putting it on the internet. The Docker and fly.io
setup below is written and ready to run, but nothing is hosted yet.

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

[Fly.io](https://fly.io) fits all four, and `Dockerfile` and `fly.toml` here are
set up for it: one 256MB machine that never sleeps, with a 1GB volume mounted at
`/data` holding the database. It costs roughly **$2 a month** — about $1.94 for
the machine and 15 cents for the volume.

First install flyctl, following
[Fly's install page](https://fly.io/docs/flyctl/install/) — on Windows that is
one PowerShell line, on macOS and Linux one shell line. Then, from the root of
this repo:

```bash
fly auth signup           # or `fly auth login` if you already have an account
fly launch --no-deploy    # say yes to copying the existing configuration
```

`fly launch` asks for an app name. Fly names are global, so `quizbuzz` is
probably taken — pick something like `quizbuzz-stortvalley`. It writes the name
you choose into `fly.toml`.

Next, the signing secret. Generating it needs no extra tools, since you already
have Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy what that prints and hand it to Fly, then deploy:

```bash
fly secrets set JWT_SECRET=paste-the-value-here
fly deploy
```

The first deploy creates the volume and takes a few minutes. After it,
`fly open` opens the app, and its address — `https://<your-app-name>.fly.dev` —
is the link to give people in the pub. `fly logs` shows what the server is
doing, and `fly status` whether the machine is up.

Two things worth knowing. Everyone needs their own account, so tell people to
tap **Create an account** the first time. And if a deploy ever fails saying the
volume does not exist, create it by hand with
`fly volumes create quizbuzz_data --size 1` and deploy again.

Any host meeting those four requirements works the same way. The one thing to
watch for is a free tier that sleeps after a few minutes idle: the first person
to open the link then waits out a cold start, which is a poor way to begin a
quiz night.

