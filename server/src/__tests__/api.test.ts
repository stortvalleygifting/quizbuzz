import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { openDatabase, setDb } from '../lib/db.js';
import { createApp } from '../app.js';

let app: Express;

beforeEach(() => {
  setDb(openDatabase(':memory:'));
  app = createApp();
});

async function register(username: string, password = 'hunter2hunter2') {
  const res = await request(app).post('/api/auth/register').send({ username, password });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.user.id as number, username };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('accounts', () => {
  it('lets anyone register and then sign in', async () => {
    const { token } = await register('quizzer');

    const me = await request(app).get('/api/auth/me').set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('quizzer');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'quizzer', password: 'hunter2hunter2' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('treats usernames as case-insensitive and refuses duplicates', async () => {
    await register('Quizzer');
    const dupe = await request(app)
      .post('/api/auth/register')
      .send({ username: 'quizzer', password: 'hunter2hunter2' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('username_taken');
  });

  it('rejects weak passwords and bad usernames', async () => {
    const short = await request(app).post('/api/auth/register').send({ username: 'ok', password: 'x' });
    expect(short.status).toBe(400);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    await register('quizzer');
    const wrongPass = await request(app)
      .post('/api/auth/login')
      .send({ username: 'quizzer', password: 'wrongwrongwrong' });
    const noUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'wrongwrongwrong' });
    expect(wrongPass.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPass.body.error).toBe(noUser.body.error);
  });

  it('refuses requests without a token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/groups/mine')).status).toBe(401);
  });

  it('never returns the password hash', async () => {
    const { token } = await register('quizzer');
    const me = await request(app).get('/api/auth/me').set(auth(token));
    expect(JSON.stringify(me.body)).not.toMatch(/hash|\$2[aby]\$/);
  });
});

describe('groups', () => {
  it('makes the creator an admin', async () => {
    const owner = await register('owner');
    const res = await request(app)
      .post('/api/groups')
      .set(auth(owner.token))
      .send({ name: 'Tuesday Quiz', description: 'The pub one' });

    expect(res.status).toBe(201);
    expect(res.body.group).toMatchObject({ name: 'Tuesday Quiz', myRole: 'admin', myStatus: 'approved', memberCount: 1 });
  });

  it('refuses a duplicate group name', async () => {
    const owner = await register('owner');
    await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' });
    const dupe = await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'tuesday quiz' });
    expect(dupe.status).toBe(409);
  });

  it('finds groups by name and shows my standing with each', async () => {
    const owner = await register('owner');
    const joiner = await register('joiner');
    const created = await request(app)
      .post('/api/groups')
      .set(auth(owner.token))
      .send({ name: 'Tuesday Quiz' });
    const groupId = created.body.group.id;

    const search = await request(app).get('/api/groups/search?q=tues').set(auth(joiner.token));
    expect(search.status).toBe(200);
    expect(search.body.groups).toHaveLength(1);
    expect(search.body.groups[0].myStatus).toBeNull();

    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(joiner.token));
    const after = await request(app).get('/api/groups/search?q=tues').set(auth(joiner.token));
    expect(after.body.groups[0].myStatus).toBe('pending');
  });

  it('walks an application from apply to approved', async () => {
    const owner = await register('owner');
    const joiner = await register('joiner');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;

    const applied = await request(app).post(`/api/groups/${groupId}/apply`).set(auth(joiner.token));
    expect(applied.status).toBe(201);

    // Applicants are not members yet.
    const beforeApproval = await request(app).get(`/api/groups/${groupId}`).set(auth(joiner.token));
    expect(beforeApproval.body.members).toHaveLength(0);

    const adminView = await request(app).get(`/api/groups/${groupId}`).set(auth(owner.token));
    expect(adminView.body.requests).toHaveLength(1);
    expect(adminView.body.requests[0].username).toBe('joiner');

    const approved = await request(app)
      .post(`/api/groups/${groupId}/members/${joiner.id}/approve`)
      .set(auth(owner.token));
    expect(approved.status).toBe(200);

    const mine = await request(app).get('/api/groups/mine').set(auth(joiner.token));
    expect(mine.body.groups).toHaveLength(1);
    expect(mine.body.pending).toHaveLength(0);
  });

  it('only lets admins approve, promote and remove', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const outsider = await register('outsider');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;

    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));

    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(outsider.token));

    const memberTriesApprove = await request(app)
      .post(`/api/groups/${groupId}/members/${outsider.id}/approve`)
      .set(auth(member.token));
    expect(memberTriesApprove.status).toBe(403);

    const memberTriesPromote = await request(app)
      .post(`/api/groups/${groupId}/members/${member.id}/role`)
      .set(auth(member.token))
      .send({ role: 'admin' });
    expect(memberTriesPromote.status).toBe(403);

    const outsiderTriesRoster = await request(app).get(`/api/groups/${groupId}`).set(auth(outsider.token));
    expect(outsiderTriesRoster.status).toBe(200);
    expect(outsiderTriesRoster.body.members).toHaveLength(0);
    expect(outsiderTriesRoster.body.requests).toHaveLength(0);
  });

  it('promotes a member to admin and lets them act', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));

    const promoted = await request(app)
      .post(`/api/groups/${groupId}/members/${member.id}/role`)
      .set(auth(owner.token))
      .send({ role: 'admin' });
    expect(promoted.status).toBe(200);

    const removeOwner = await request(app)
      .delete(`/api/groups/${groupId}/members/${owner.id}`)
      .set(auth(member.token));
    expect(removeOwner.status).toBe(200);
  });

  it('will not leave a group without an admin', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));

    const demoteSelf = await request(app)
      .post(`/api/groups/${groupId}/members/${owner.id}/role`)
      .set(auth(owner.token))
      .send({ role: 'member' });
    expect(demoteSelf.status).toBe(400);
    expect(demoteSelf.body.code).toBe('last_admin');

    const leave = await request(app).delete(`/api/groups/${groupId}/members/${owner.id}`).set(auth(owner.token));
    expect(leave.status).toBe(400);
    expect(leave.body.code).toBe('last_admin');
  });

  it('lets a member leave and an admin reject an application', async () => {
    const owner = await register('owner');
    const member = await register('member');
    const applicant = await register('applicant');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(member.token));
    await request(app).post(`/api/groups/${groupId}/members/${member.id}/approve`).set(auth(owner.token));
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(applicant.token));

    const left = await request(app).delete(`/api/groups/${groupId}/members/${member.id}`).set(auth(member.token));
    expect(left.status).toBe(200);

    const rejected = await request(app)
      .delete(`/api/groups/${groupId}/members/${applicant.id}`)
      .set(auth(owner.token));
    expect(rejected.status).toBe(200);

    const view = await request(app).get(`/api/groups/${groupId}`).set(auth(owner.token));
    expect(view.body.members).toHaveLength(1);
    expect(view.body.requests).toHaveLength(0);
  });

  it('is idempotent when applying twice and 404s on unknown groups', async () => {
    const joiner = await register('joiner');
    const owner = await register('owner');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;

    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(joiner.token));
    const again = await request(app).post(`/api/groups/${groupId}/apply`).set(auth(joiner.token));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('pending');

    const missing = await request(app).post('/api/groups/9999/apply').set(auth(joiner.token));
    expect(missing.status).toBe(404);
  });

  it('lets an applicant withdraw', async () => {
    const owner = await register('owner');
    const joiner = await register('joiner');
    const groupId = (
      await request(app).post('/api/groups').set(auth(owner.token)).send({ name: 'Tuesday Quiz' })
    ).body.group.id;
    await request(app).post(`/api/groups/${groupId}/apply`).set(auth(joiner.token));

    const withdrawn = await request(app).delete(`/api/groups/${groupId}/apply`).set(auth(joiner.token));
    expect(withdrawn.status).toBe(200);

    const mine = await request(app).get('/api/groups/mine').set(auth(joiner.token));
    expect(mine.body.pending).toHaveLength(0);
  });
});
