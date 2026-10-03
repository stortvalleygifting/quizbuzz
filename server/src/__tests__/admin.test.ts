import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { openDatabase, setDb } from '../lib/db.js';
import { createApp } from '../app.js';

let app: Express;

beforeEach(() => {
  setDb(openDatabase(':memory:'));
  app = createApp();
  process.env.SITE_ADMINS = 'Rob, someone-else';
});

afterEach(() => {
  delete process.env.SITE_ADMINS;
});

async function register(username: string, password = 'hunter2hunter2') {
  const res = await request(app).post('/api/auth/register').send({ username, password });
  return { token: res.body.token as string, id: res.body.user.id as number, username };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A group run by `owner`, which Rob has never joined. */
async function someoneElsesGroup() {
  const owner = await register('owner');
  const ann = await register('ann');
  const groupId = (await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })).body
    .group.id as number;
  await request(app).post(`/api/groups/${groupId}/apply`).set(auth(ann.token));
  return { owner, ann, groupId };
}

describe('system admin', () => {
  it('is whoever SITE_ADMINS names, ignoring case, and nobody else', async () => {
    const rob = await register('rob');
    const ann = await register('ann');
    expect((await request(app).get('/api/auth/me').set(auth(rob.token))).body.user.isSiteAdmin).toBe(true);
    expect((await request(app).get('/api/auth/me').set(auth(ann.token))).body.user.isSiteAdmin).toBe(false);

    expect((await request(app).get('/api/admin/groups').set(auth(ann.token))).status).toBe(403);
    expect((await request(app).post(`/api/admin/users/${rob.id}/reset-password`).set(auth(ann.token))).status).toBe(
      403,
    );
  });

  it('sees every group and can run one it never joined', async () => {
    const rob = await register('rob');
    const { ann, groupId } = await someoneElsesGroup();

    const all = await request(app).get('/api/admin/groups').set(auth(rob.token));
    expect(all.body.groups).toEqual([
      { id: groupId, name: 'Tuesday Quiz', memberCount: 1, pendingCount: 1, admins: ['owner'] },
    ]);

    const detail = await request(app).get(`/api/groups/${groupId}`).set(auth(rob.token));
    expect(detail.body.viewingAsSiteAdmin).toBe(true);
    expect(detail.body.requests.map((r: { username: string }) => r.username)).toEqual(['ann']);

    const approved = await request(app).post(`/api/groups/${groupId}/members/${ann.id}/approve`).set(auth(rob.token));
    expect(approved.status).toBe(200);

    // Joining a group for real isn't something it does on the admin's behalf.
    const mine = await request(app).get('/api/groups/mine').set(auth(rob.token));
    expect(mine.body.groups).toEqual([]);
  });

  it('can watch and finish a quiz in any group', async () => {
    const rob = await register('rob');
    const { owner, groupId } = await someoneElsesGroup();
    const eventId = (
      await request(app).post(`/api/groups/${groupId}/events`).set(auth(owner.token)).send({ name: 'Quiz night' })
    ).body.event.id as number;

    const state = await request(app).get(`/api/events/${eventId}`).set(auth(rob.token));
    expect(state.status).toBe(200);
    expect(state.body.state.me.isAdmin).toBe(true);
    expect((await request(app).post(`/api/events/${eventId}/finish`).set(auth(rob.token))).status).toBe(200);
  });

  it('resets a forgotten password to a temporary one, which can then be changed', async () => {
    const rob = await register('rob');
    const ann = await register('ann', 'forgotten-it-1');

    const found = await request(app).get('/api/admin/users?q=an').set(auth(rob.token));
    expect(found.body.users.map((u: { username: string }) => u.username)).toEqual(['ann']);

    const reset = await request(app).post(`/api/admin/users/${ann.id}/reset-password`).set(auth(rob.token));
    expect(reset.status).toBe(200);
    const temp = reset.body.temporaryPassword as string;
    expect(temp).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

    expect((await request(app).post('/api/auth/login').send({ username: 'ann', password: 'forgotten-it-1' })).status).toBe(
      401,
    );
    const signedIn = await request(app).post('/api/auth/login').send({ username: 'ann', password: temp });
    expect(signedIn.status).toBe(200);

    const wrong = await request(app)
      .post('/api/auth/password')
      .set(auth(signedIn.body.token))
      .send({ currentPassword: 'nope', newPassword: 'brand-new-one' });
    expect(wrong.body.code).toBe('wrong_password');
    const changed = await request(app)
      .post('/api/auth/password')
      .set(auth(signedIn.body.token))
      .send({ currentPassword: temp, newPassword: 'brand-new-one' });
    expect(changed.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ username: 'ann', password: 'brand-new-one' })).status).toBe(
      200,
    );
  });
});
