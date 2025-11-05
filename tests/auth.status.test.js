import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Auth status', () => {
  let cleanup;
  let app;

  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    nock.cleanAll();
    ({ app, cleanup } = await setupTestApp());
  });

  afterEach(async () => {
    nock.cleanAll();
    await cleanup();
  });

  test('reports logged in when tokens valid', async () => {
    nock('https://api.ws.sonos.com')
      .get('/control/api/v1/households')
      .reply(200, { households: [{ id: 'HID' }] });

    const res = await request(app).get('/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  test('reports logged out after signout', async () => {
    nock('https://api.ws.sonos.com')
      .get('/control/api/v1/households')
      .reply(200, { households: [{ id: 'HID' }] });

    await request(app).get('/auth/status');
    expect(nock.isDone()).toBe(true);

    await request(app).post('/auth/signout').send();

    const res = await request(app).get('/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(false);
  });
});
