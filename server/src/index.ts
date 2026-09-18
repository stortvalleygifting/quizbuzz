import { createServer } from 'node:http';
import { createApp } from './app.js';
import { assertAuthConfigured } from './lib/auth.js';
import { getDb } from './lib/db.js';
import { createSocketServer } from './lib/realtime.js';

const PORT = Number(process.env.PORT ?? 3001);

assertAuthConfigured(); // fail now, not on the first sign-in
getDb(); // open + migrate before we accept traffic

const httpServer = createServer(createApp());

/** The realtime channel carrying the buzz queue and live scores. */
export const io = createSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`quizbuzz server listening on http://localhost:${PORT}`);
});
