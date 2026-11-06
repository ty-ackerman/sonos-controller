// Tests for the restart cap in stallRecovery.js.
// No real Supabase or Sonos is touched: Supabase is mocked with nock and Sonos is a fake client.
import nock from 'nock';

process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_KEY = 'test-key';
delete process.env.NTFY_TOPIC; // alerts just get logged, nothing is sent

const { restartCapStatus, summarizePlaybackError, recoverWithRetries } = await import('../stallRecovery.js');

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const DEVICE = 'global-automation-college';
const GROUP = { id: 'RINCON_TEST:1', name: 'Test group', playerIds: [] };
const HOUSEHOLD = { id: 'HH' };

describe('restartCapStatus (pure)', () => {
  test('no history: allowed', () => {
    expect(restartCapStatus({ recoveries: [] })).toMatchObject({ capped: false, coolingDown: false });
    expect(restartCapStatus(null)).toMatchObject({ capped: false, coolingDown: false });
  });

  test('2 restarts in the window: still allowed', () => {
    const s = restartCapStatus({ recoveries: [minutesAgo(1), minutesAgo(3)] });
    expect(s.capped).toBe(false);
    expect(s.recent).toHaveLength(2);
  });

  test('3 restarts in the window: capped', () => {
    expect(restartCapStatus({ recoveries: [minutesAgo(1), minutesAgo(3), minutesAgo(5)] }).capped).toBe(true);
  });

  test('restarts older than 10 minutes do not count', () => {
    const s = restartCapStatus({ recoveries: [minutesAgo(11), minutesAgo(20), minutesAgo(30)] });
    expect(s.capped).toBe(false);
    expect(s.recent).toHaveLength(0);
  });

  test('cooldown lasts 30 minutes after giving up, then lifts', () => {
    expect(restartCapStatus({ recoveries: [], gave_up_at: minutesAgo(5) }).coolingDown).toBe(true);
    expect(restartCapStatus({ recoveries: [], gave_up_at: minutesAgo(29) }).coolingDown).toBe(true);
    expect(restartCapStatus({ recoveries: [], gave_up_at: minutesAgo(31) }).coolingDown).toBe(false);
  });
});

describe('summarizePlaybackError', () => {
  test('keeps the Sonos error code and reason', () => {
    const s = summarizePlaybackError({ errorCode: 'ERROR_PLAYBACK_FAILED', reason: 'Spotify said no', itemId: 'abc' });
    expect(s).toMatchObject({ code: 'ERROR_PLAYBACK_FAILED', reason: 'Spotify said no', itemId: 'abc' });
    expect(typeof s.at).toBe('string');
  });

  test('copes with a missing or odd body', () => {
    expect(summarizePlaybackError(undefined)).toMatchObject({ code: null, reason: null });
    expect(summarizePlaybackError('nope')).toMatchObject({ code: null, reason: null });
  });
});

// ---- recoverWithRetries, end to end with fakes ---------------------------------------------------

// A fake Sonos that accepts every command but never actually plays: the College failure.
function makeStuckSonos() {
  const calls = [];
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
  return {
    calls,
    async call(endpoint, options = {}) {
      calls.push(`${options.method || 'GET'} ${endpoint}`);
      if (endpoint.endsWith('/playbackMetadata')) return json({ container: { name: 'My Playlist', id: { objectId: 'spotify:playlist:1' } } });
      if (endpoint.endsWith('/favorites') && !options.method) return json({ items: [{ id: 'FAV1', name: 'My Playlist', resource: { id: { objectId: 'spotify:playlist:1' } } }] });
      if (endpoint.endsWith('/playback')) return json({ playbackState: 'PLAYBACK_STATE_IDLE', positionMillis: 0 });
      return json({}); // favorites POST, play, playMode: accepted
    }
  };
}

const reloadCount = (sonos) => sonos.calls.filter((c) => c.startsWith('POST') && c.endsWith('/favorites')).length;

describe('recoverWithRetries cap', () => {
  let writes;
  let healthRow;

  beforeEach(() => {
    nock.disableNetConnect();
    writes = [];
    nock('http://supabase.test')
      .persist()
      .get(/\/rest\/v1\/playback_health/)
      .reply(200, () => healthRow)
      .post(/\/rest\/v1\/playback_health/)
      .reply(201, (uri, body) => {
        writes.push(typeof body === 'string' ? JSON.parse(body) : body);
        return '';
      });
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('already at the cap: gives up at once, no Sonos command, one write of gave_up_at', async () => {
    healthRow = { last_active_at: null, recoveries: [minutesAgo(1), minutesAgo(2), minutesAgo(3)], last_volumes: null, gave_up_at: null, last_error: null };
    const sonos = makeStuckSonos();
    const result = await recoverWithRetries(sonos, DEVICE, HOUSEHOLD, GROUP, healthRow);
    expect(result).toBeNull();
    expect(sonos.calls).toHaveLength(0);
    expect(writes.some((w) => w.gave_up_at)).toBe(true);
  });

  test('cooling down after giving up: does nothing and does not alert again', async () => {
    healthRow = { last_active_at: null, recoveries: [], last_volumes: null, gave_up_at: minutesAgo(5), last_error: null };
    const sonos = makeStuckSonos();
    const result = await recoverWithRetries(sonos, DEVICE, HOUSEHOLD, GROUP, healthRow);
    expect(result).toBeNull();
    expect(sonos.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('a speaker that never plays is restarted exactly 3 times, then it gives up', async () => {
    healthRow = { last_active_at: null, recoveries: [], last_volumes: null, gave_up_at: null, last_error: null };
    const sonos = makeStuckSonos();
    await recoverWithRetries(sonos, DEVICE, HOUSEHOLD, GROUP, healthRow);
    expect(reloadCount(sonos)).toBe(3);
    const lastRecoveries = [...writes].reverse().find((w) => Array.isArray(w.recoveries))?.recoveries;
    expect(lastRecoveries).toHaveLength(3); // each restart is really counted (it used to overwrite itself)
    expect(writes.some((w) => w.gave_up_at)).toBe(true);
  }, 60000);
});
