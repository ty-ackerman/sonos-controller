import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Per-room volume control', () => {
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

  test('sets and reads player volume', async () => {
    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/players/RINCON_A/playerVolume', { volume: 35 })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .get('/control/api/v1/players/RINCON_A/playerVolume')
      .reply(200, { volume: 35 });

    const postRes = await request(app)
      .post('/api/players/RINCON_A/volume')
      .send({ level: 35 });

    expect(postRes.status).toBe(200);
    expect(postRes.body.volume).toBe(35);
    expect(nock.isDone()).toBe(true);
  });
});
