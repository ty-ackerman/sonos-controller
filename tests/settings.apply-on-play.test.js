import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Default speaker volumes applied during playback', () => {
  let app;
  let cleanup;

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

  test('applies stored volumes before queue replacement flow', async () => {
    await request(app)
      .put('/api/settings/volumes')
      .send({ RINCON_A: 10, RINCON_B: 25 });

    const initialSnapshot = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:Separate', name: 'Kitchen' },
        { id: 'RINCON_B', groupId: 'GID:123', name: 'Bedroom' }
      ]
    };

    const finalSnapshot = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:123', name: 'Kitchen' },
        { id: 'RINCON_B', groupId: 'GID:123', name: 'Bedroom' }
      ]
    };

    const scope = nock('https://api.ws.sonos.com')
      .get('/control/api/v1/households')
      .reply(200, { households: [{ id: 'HID' }] })
      .get('/control/api/v1/households/HID/groups')
      .reply(200, initialSnapshot)
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', {
        playerIds: ['RINCON_A', 'RINCON_B']
      })
      .reply(200, {})
      .get('/control/api/v1/households/HID/groups')
      .reply(200, finalSnapshot)
      .get('/control/api/v1/households/HID/groups')
      .reply(200, finalSnapshot)
      .post('/control/api/v1/players/RINCON_A/playerVolume', { volume: 10 })
      .reply(200, {})
      .post('/control/api/v1/players/RINCON_B/playerVolume', { volume: 25 })
      .reply(200, {})
      .post('/control/api/v1/groups/GID%3A123/playback/metadata', {
        container: { id: 'spotify:playlist:123', type: 'playlist' }
      })
      .reply(200, {})
      .post('/control/api/v1/groups/GID%3A123/playback/shuffle', { enabled: true })
      .reply(200, {})
      .post('/control/api/v1/groups/GID%3A123/playback/repeat', { mode: 'on' })
      .reply(200, {})
      .post('/control/api/v1/groups/GID%3A123/playback/crossfade', { enabled: true })
      .reply(200, {})
      .post('/control/api/v1/groups/GID%3A123/playback/play')
      .reply(200, {});

    const response = await request(app)
      .post('/api/groups/GID:123/spotify-playlist')
      .send({
        uri: 'spotify:playlist:123',
        shuffle: true,
        repeat: true,
        crossfade: true,
        householdId: 'HID'
      });

    expect(response.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });
});

