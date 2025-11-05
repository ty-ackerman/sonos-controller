import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

const groupsPayload = {
  groups: [{ id: 'GID:123', name: 'All Rooms' }],
  players: [{ id: 'RINCON_A', groupId: 'GID:123' }]
};

function mockGroupFetches(times = 3) {
  const scope = nock('https://api.ws.sonos.com');
  for (let i = 0; i < times; i += 1) {
    scope.get('/control/api/v1/households/HID/groups').reply(200, groupsPayload);
  }
  return scope;
}

describe('Transport controls', () => {
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
    ({ app, cleanup } = await setupTestApp({
      appState: { primaryGroupId: 'GID:123', lastHouseholdId: 'HID' }
    }));
  });

  afterEach(async () => {
    nock.cleanAll();
    await cleanup();
  });

  test('toggle play/pause hits playback endpoint', async () => {
    mockGroupFetches();

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', {
        playerIds: ['RINCON_A']
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/togglePlayPause')
      .reply(200, {});

    const res = await request(app)
      .post('/api/playback/toggle')
      .send({ householdId: 'HID' });

    expect(res.status).toBeLessThan(500);
    expect(nock.isDone()).toBe(true);
  });

  test('next track control hits Sonos API', async () => {
    mockGroupFetches();

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', {
        playerIds: ['RINCON_A']
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/skipToNextTrack')
      .reply(200, {});

    const res = await request(app)
      .post('/api/playback/next')
      .send({ householdId: 'HID' });

    expect(res.status).toBeLessThan(500);
    expect(nock.isDone()).toBe(true);
  });

  test('previous track control hits Sonos API', async () => {
    mockGroupFetches();

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', {
        playerIds: ['RINCON_A']
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/skipToPreviousTrack')
      .reply(200, {});

    const res = await request(app)
      .post('/api/playback/previous')
      .send({ householdId: 'HID' });

    expect(res.status).toBeLessThan(500);
    expect(nock.isDone()).toBe(true);
  });
});
