import jwt from 'jsonwebtoken';
import { api, createUser } from '../helpers.js';
import env from '../../src/config/env.js';
import email from '../../src/services/email.service.js';
import User from '../../src/models/User.js';

const signup = (body = {}) =>
  api()
    .post('/api/v1/auth/register')
    .send({ name: 'Ada Lovelace', email: 'ada@test.dev', password: 'password123', ...body });

describe('auth', () => {
  it('signs up an attendee by default and never stores the plain password', async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ email: 'ada@test.dev', role: 'attendee' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.accessToken).toBeDefined();
    const stored = await User.findOne({ email: 'ada@test.dev' }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('refuses to create admins through sign-up', async () => {
    const res = await signup({ role: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('role');
  });

  it('rejects a duplicate email with 409', async () => {
    await signup();
    const res = await signup({ email: 'ADA@test.dev' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('returns field details on validation failure', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field).sort();
    expect(fields).toEqual(['email', 'name', 'password']);
  });

  it('logs in with the right password only', async () => {
    await signup();
    const good = await api().post('/api/v1/auth/login').send({ email: 'ada@test.dev', password: 'password123' });
    expect(good.status).toBe(200);
    const bad = await api().post('/api/v1/auth/login').send({ email: 'ada@test.dev', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const missing = await api().post('/api/v1/auth/login').send({ email: 'ghost@test.dev', password: 'password123' });
    expect(missing.status).toBe(401);
  });

  it('rotates refresh tokens and revokes everything when an old one is reused', async () => {
    const { body } = await signup();
    const first = body.data.refreshToken;
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refreshToken;
    expect(second).not.toBe(first);

    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(reuse.status).toBe(401);
    // The reuse revoked the newer token too.
    const after = await api().post('/api/v1/auth/refresh').send({ refreshToken: second });
    expect(after.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { body } = await signup();
    await api().post('/api/v1/auth/logout').send({ refreshToken: body.data.refreshToken }).expect(200);
    const res = await api().post('/api/v1/auth/refresh').send({ refreshToken: body.data.refreshToken });
    expect(res.status).toBe(401);
  });

  it('resets a password with the emailed token, once', async () => {
    await signup();
    const res = await api().post('/api/v1/auth/forgot-password').send({ email: 'ada@test.dev' });
    expect(res.status).toBe(200);
    await email.flush();
    const mail = email.testOutbox.find((m) => m.subject === 'Reset your password');
    const token = decodeURIComponent(mail.html.match(/token=([^"&]+)/)[1]);

    await api().post('/api/v1/auth/reset-password').send({ token, password: 'new-password-1' }).expect(200);
    await api().post('/api/v1/auth/login').send({ email: 'ada@test.dev', password: 'new-password-1' }).expect(200);
    const again = await api().post('/api/v1/auth/reset-password').send({ token, password: 'another-pass-2' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('forgot-password answers 200 for unknown emails too', async () => {
    const res = await api().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.dev' });
    expect(res.status).toBe(200);
    await email.flush();
    expect(email.testOutbox).toHaveLength(0);
  });

  describe('guards', () => {
    it('401 without a token, TOKEN_EXPIRED for an expired one', async () => {
      expect((await api().get('/api/v1/me')).status).toBe(401);
      const { user } = await createUser();
      const expired = jwt.sign({ sub: String(user._id), role: 'attendee' }, env.JWT_ACCESS_SECRET, { expiresIn: -10 });
      const res = await api().get('/api/v1/me').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects tokens signed with another secret', async () => {
      const forged = jwt.sign({ sub: '507f1f77bcf86cd799439011', role: 'admin' }, 'not-the-real-secret-123');
      const res = await api().get('/api/v1/admin/users').set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('403 for the wrong role', async () => {
      const attendee = await createUser('attendee');
      const res = await api().get('/api/v1/admin/users').set(attendee.auth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('lets admins list users with pagination meta', async () => {
      const admin = await createUser('admin');
      await createUser('organizer');
      const res = await api().get('/api/v1/admin/users?role=organizer&limit=5').set(admin.auth);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 5, total: 1 });
    });
  });

  it('strips Mongo operators from request bodies', async () => {
    await signup();
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: { $gt: '' }, password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('returns the standard envelope for unknown routes and the health check', async () => {
    const missing = await api().get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
    const health = await api().get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body.data.db).toBe('up');
  });
});
