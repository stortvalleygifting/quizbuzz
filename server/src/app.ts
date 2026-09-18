import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { eventsRouter } from './routes/events.js';
import { HttpError } from './lib/errors.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/groups', groupsRouter);
  // Events hang off both /api/groups/:id/events and /api/events/:id.
  app.use('/api', eventsRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));

  // In production the built client is served from the same origin as the API,
  // so phones only need one URL.
  const clientDist = resolve(process.cwd(), '../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      return res.status(409).json({ error: 'That already exists.', code: 'conflict' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong on our end.', code: 'internal' });
  });

  return app;
}
