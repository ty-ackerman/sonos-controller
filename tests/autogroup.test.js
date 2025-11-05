import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Autogroup behavior', () => {
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

  test('autogroups all players before transport toggle', async () => {
    const initialGroupResponse = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:Other' },
        { id: 'RINCON_B', groupId: 'GID:Other' }
      ]
    };

    const finalGroupResponse = {
      groups: [{ id: 'GID:123', name: 'All Rooms' }],
      players: [
        { id: 'RINCON_A', groupId: 'GID:123' },
        { id: 'RINCON_B', groupId: 'GID:123' }
      ]
    };

    nock('https://api.ws.sonos.com')
      .get('/control/api/v1/households/HID/groups')
      .reply(200, initialGroupResponse)
      .get('/control/api/v1/households/HID/groups')
      .reply(200, initialGroupResponse)
      .get('/control/api/v1/households/HID/groups')
      .reply(200, finalGroupResponse);

    let setMembersPayload;
    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/groups/setGroupMembers', (body) => {
        setMembersPayload = body;
        return true;
      })
      .reply(200, {});

    nock('https://api.ws.sonos.com')
      .post('/control/api/v1/groups/GID%3A123/playback/togglePlayPause')
      .reply(200, {});

    const res = await request(app)
      .post('/api/playback/toggle')
      .send({ householdId: 'HID' });

    expect(res.status).toBeLessThan(500);
    expect(setMembersPayload).toEqual({
      playerIds: ['RINCON_A', 'RINCON_B']
    });
    expect(nock.isDone()).toBe(true);
  });
});
