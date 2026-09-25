import { app, request } from './helpers';

describe('Auth', () => {
  describe('POST /auth/register', () => {
    it('registers a new customer and returns tokens', async () => {
      const res = await request(app).post('/auth/register').send({
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'Password123!',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('CUSTOMER');
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
    });

    it('rejects duplicate email registration', async () => {
      const payload = { name: 'Jane', email: 'dup@example.com', password: 'Password123!' };
      await request(app).post('/auth/register').send(payload);
      const res = await request(app).post('/auth/register').send(payload);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('ignores a client-supplied role and always creates a CUSTOMER', async () => {
      const res = await request(app).post('/auth/register').send({
        name: 'Wannabe Admin',
        email: 'wannabe@example.com',
        password: 'Password123!',
        role: 'ADMIN',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('CUSTOMER');
    });

    it('rejects weak/invalid input with 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ name: 'A', email: 'not-an-email', password: '123' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('POST /auth/login', () => {
    it('logs in with correct credentials', async () => {
      await request(app)
        .post('/auth/register')
        .send({ name: 'Login Test', email: 'login@example.com', password: 'Password123!' });
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'login@example.com', password: 'Password123!' });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('rejects wrong password without revealing whether the email exists', async () => {
      await request(app)
        .post('/auth/register')
        .send({ name: 'X', email: 'wrongpw@example.com', password: 'Password123!' });
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'wrongpw@example.com', password: 'WrongPassword!' });
      expect(res.status).toBe(401);

      const res2 = await request(app)
        .post('/auth/login')
        .send({ email: 'doesnotexist@example.com', password: 'WrongPassword!' });
      expect(res2.status).toBe(401);
      expect(res2.body.error.message).toBe(res.body.error.message);
    });
  });

  describe('GET /auth/me', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns the authenticated user with a valid token', async () => {
      const reg = await request(app)
        .post('/auth/register')
        .send({ name: 'Me Test', email: 'me@example.com', password: 'Password123!' });
      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${reg.body.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('me@example.com');
    });
  });
});
