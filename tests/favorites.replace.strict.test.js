import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Favorite launch with queue clearing and autogroup', () => {
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

  test('autogroups players, clears queue, then replaces favorite', async () => {
    const initialSnapshot = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:Other' },
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
      .get('/control/api/v1/groups/GID%3A123/playback/queue/items?quantity=200&offset=0')
      .reply(200, {
        items: [{ id: 'QID_1' }, { id: 'QID_2' }]
      });

    const removal = nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/queue/items/remove', {
        itemIds: ['QID_1', 'QID_2']
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/favorites', {
        favoriteId: 'FAV',
        queueAction: 'REPLACE',
        action: 'REPLACE',
        playOnCompletion: false
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/playMode', {
        playModes: { shuffle: true, repeat: true, crossfade: true }
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/play')
      .reply(200, {});

    const response = await request(app)
      .post('/api/groups/GID:123/favorites/play')
      .send({
        favoriteId: 'FAV',
        shuffle: true,
        repeat: true,
        crossfade: true,
        householdId: 'HID'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', favoriteId: 'FAV' });
    expect(setMembersPayload).toEqual({ playerIds: ['RINCON_A', 'RINCON_B'] });
    expect(removal.isDone()).toBe(true);
    expect(nock.isDone()).toBe(true);
  });
});
