import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Spotify playlist launch without household hint', () => {
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

  test('finds household automatically and autogroups players', async () => {
    const initialSnapshot = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:Separate' },
        { id: 'RINCON_B', groupId: 'GID:123' }
      ]
    };

    const finalSnapshot = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:123' },
        { id: 'RINCON_B', groupId: 'GID:123' }
      ]
    };

    nock('https://api.ws.sonos.com')
      .get('/control/api/v1/households')
      .reply(200, { households: [{ id: 'HID' }] });

  nock('https://api.ws.sonos.com')
    .get('/control/api/v1/households/HID/groups')
    .reply(200, initialSnapshot)
    .get('/control/api/v1/households/HID/groups')
    .reply(200, finalSnapshot)
    .get('/control/api/v1/households/HID/groups')
    .reply(200, finalSnapshot);

    let setMembersPayload;
    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', (body) => {
        setMembersPayload = body;
        return true;
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/metadata', {
        container: { id: 'spotify:playlist:321', type: 'playlist' }
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/play')
      .reply(200, {});

    const response = await request(app)
      .post('/api/groups/GID:123/spotify-playlist')
      .send({
        uri: 'spotify:playlist:321'
      });

    expect(response.status).toBe(200);
    expect(setMembersPayload).toEqual({ playerIds: ['RINCON_A', 'RINCON_B'] });
    expect(nock.isDone()).toBe(true);
  });
});
