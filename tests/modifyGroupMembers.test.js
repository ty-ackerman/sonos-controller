import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Group membership modifications', () => {
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

  test('adds player to a group using modifyGroupMembers', async () => {
    const scope = nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/modifyGroupMembers', {
        playerIdsToAdd: ['RINCON_A'],
        playerIdsToRemove: []
      })
      .reply(200, {});

    const res = await request(app)
      .post('/api/groups/GID:123/addPlayer')
      .send({ playerId: 'RINCON_A' });

    expect(res.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });

  test('removes player from a group using modifyGroupMembers', async () => {
    const scope = nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/modifyGroupMembers', {
        playerIdsToAdd: [],
        playerIdsToRemove: ['RINCON_A']
      })
      .reply(200, {});

    const res = await request(app)
      .post('/api/groups/GID:123/removePlayer')
      .send({ playerId: 'RINCON_A' });

    expect(res.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });
});
