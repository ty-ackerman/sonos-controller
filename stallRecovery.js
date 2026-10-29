// Stall recovery core (Test location only for now). Shared by:
//   - netlify/functions/playback-recovery.js             (scheduled, every minute: the backstop)
//   - netlify/functions/playback-recovery-background.js  (started by the status poll the moment a stall is seen)
//   - server.js status poll                              (calls watchForStall)
//
// Pattern we recover from: a group was PLAYING/BUFFERING a moment ago, then drops to
// PLAYBACK_STATE_IDLE at position 0 (Sonos gave up after several unplayable Spotify tracks).
// A deliberate pause shows up as PAUSED, so it is never touched.
//
// Recovery, 5 seconds after the pattern is confirmed:
//   1. Reload the playlist that was playing (same Spotify playlist, back to the start).
//   2. Turn shuffle on (other play modes are left as they were).
//   3. Press play.
//   4. Put every speaker back to the volume it had while the music was still playing.
// Every step logs with the prefix [TRACE-RECOVERY].

import { loadTokens, saveTokens } from './tokenStore.js';
import { supabase } from './supabase.js';
import dotenv from 'dotenv';

dotenv.config();

const SONOS_AUTH_BASE = 'https://api.sonos.com';
const SONOS_CONTROL_BASE = 'https://api.ws.sonos.com/control/api/v1';
const SONOS_CLIENT_ID = process.env.SONOS_CLIENT_ID;
const SONOS_CLIENT_SECRET = process.env.SONOS_CLIENT_SECRET;

// Locations that get recovery (all of them). The group id in a Sonos event is matched against each
// location's groups to find which one it belongs to.
export const RECOVERY_DEVICE_IDS = [
  'global-automation-test',
  'global-automation-college',
  'global-automation-leslieville'
];

const RECENTLY_ACTIVE_MS = 150 * 1000; // group must have been playing within this window
const CONFIRM_WAIT_MS = 2 * 1000; // wait after spotting the pattern, then check it is still true
const SETTLE_WAIT_MS = 4 * 1000; // let playback start before restoring volumes / verifying
const LOCK_MS = 90 * 1000; // one recovery per group at a time
// There is deliberately no limit on how often a group is recovered. Recoveries are still recorded
// for the last 10 minutes (RECOVERY_WINDOW_MS) so they show up in playback_health for debugging.
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[TRACE-RECOVERY] ${msg}`);

// ---- Phone alerts (ntfy) -------------------------------------------------------------------
// Set NTFY_TOPIC in the Netlify environment to turn alerts on (optional NTFY_SERVER, default
// https://ntfy.sh). Install the ntfy app and subscribe to that topic. Never throws.
const lastAlert = new Map();
async function notify(title, message, { priority = 'default', tags = 'warning', throttleKey = null, throttleMs = 0 } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  if (throttleKey) {
    const now = Date.now();
    if (now - (lastAlert.get(throttleKey) || 0) < throttleMs) return;
    lastAlert.set(throttleKey, now);
  }
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    // Headers must be plain ASCII, so keep titles simple.
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags },
      body: message,
      signal: controller.signal
    });
    if (!res.ok) log(`ntfy alert failed: http ${res.status}`);
  } catch (error) {
    log(`ntfy alert failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const prettyPlace = (deviceId) => {
  const name = deviceId.replace('global-automation-', '');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

function storeTokens(tokenResponse, existingTokens) {
  const expiresIn = Number(tokenResponse.expires_in ?? 0);
  const bufferMs = 60 * 1000;
  return {
    access_token: tokenResponse.access_token ?? null,
    refresh_token: tokenResponse.refresh_token ?? existingTokens.refresh_token ?? null,
    expires_at: Date.now() + Math.max(expiresIn * 1000 - bufferMs, bufferMs)
  };
}

async function refreshAccessToken(tokens, deviceId) {
  const response = await fetch(`${SONOS_AUTH_BASE}/login/v3/oauth/access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SONOS_CLIENT_ID}:${SONOS_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed for ${deviceId}: ${response.status}`);
  }
  const updated = storeTokens(await response.json(), tokens);
  await saveTokens(updated, deviceId);
  return updated;
}

// Small client that keeps the (possibly refreshed) tokens between calls.
function makeSonosClient(initialTokens, deviceId) {
  let tokens = initialTokens;

  async function call(endpoint, options = {}) {
    if (tokens.expires_at && Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
      tokens = await refreshAccessToken(tokens, deviceId);
    }
    const doFetch = () =>
      fetch(`${SONOS_CONTROL_BASE}${endpoint}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.access_token}`,
          ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
        }
      });
    let response = await doFetch();
    if (response.status === 401 && tokens.refresh_token) {
      tokens = await refreshAccessToken(tokens, deviceId);
      response = await doFetch();
    }
    return response;
  }

  return { call };
}

async function readPlayback(client, groupId) {
  const res = await client.call(`/groups/${encodeURIComponent(groupId)}/playback`);
  if (!res.ok) {
    return { ok: false, status: res.status, body: (await res.text().catch(() => '')).slice(0, 160) };
  }
  const json = await res.json().catch(() => ({}));
  return {
    ok: true,
    raw: String(json.playbackState || ''),
    positionMillis: json.positionMillis ?? null,
    itemId: json.itemId ?? null,
    playModes: json.playModes || {}
  };
}

// Volume of every speaker in the group, e.g. { RINCON_x: 16 }. Returns null if any read fails,
// so we never save or restore a half-known picture.
async function readPlayerVolumes(client, playerIds) {
  const volumes = {};
  for (const playerId of playerIds || []) {
    const res = await client.call(`/players/${encodeURIComponent(playerId)}/playerVolume`);
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    const value = Number(json.volume);
    if (!Number.isFinite(value)) return null;
    volumes[playerId] = value;
  }
  return Object.keys(volumes).length ? volumes : null;
}

async function loadHealth(deviceId, groupId) {
  const { data, error } = await supabase
    .from('playback_health')
    .select('last_active_at, recoveries, last_volumes')
    .eq('device_id', deviceId)
    .eq('group_id', groupId)
    .maybeSingle();
  if (error) {
    log(`could not read playback_health: ${error.message}`);
    return null;
  }
  return data || { last_active_at: null, recoveries: [], last_volumes: null };
}

// Atomically take the "I am recovering this group" lock. Returns false if someone else holds it.
async function claimLock(deviceId, groupId) {
  const now = new Date();
  const { data, error } = await supabase
    .from('playback_health')
    .update({ recovering_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq('device_id', deviceId)
    .eq('group_id', groupId)
    .or(`recovering_until.is.null,recovering_until.lt.${now.toISOString()}`)
    .select('device_id');
  if (error) {
    log(`could not take recovery lock: ${error.message}`);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function releaseLock(deviceId, groupId) {
  await supabase.from('playback_health').update({ recovering_until: null }).eq('device_id', deviceId).eq('group_id', groupId);
}

async function saveHealth(deviceId, groupId, fields) {
  const { error } = await supabase.from('playback_health').upsert(
    { device_id: deviceId, group_id: groupId, updated_at: new Date().toISOString(), ...fields },
    { onConflict: 'device_id,group_id' }
  );
  if (error) log(`could not write playback_health: ${error.message}`);
}

// Find the saved favorite (playlist) that matches what the group has loaded.
async function findLoadedFavorite(client, householdId, groupId) {
  const metaRes = await client.call(`/groups/${encodeURIComponent(groupId)}/playbackMetadata`);
  if (!metaRes.ok) return { error: `metadata http ${metaRes.status}` };
  const metadata = await metaRes.json().catch(() => ({}));
  const container = metadata.container;
  if (!container) return { error: 'no playlist loaded' };

  const favRes = await client.call(`/households/${encodeURIComponent(householdId)}/favorites`);
  if (!favRes.ok) return { error: `favorites http ${favRes.status}` };
  const favorites = (await favRes.json().catch(() => ({}))).items || [];

  const objectId = container.id?.objectId || null;
  const byId = objectId
    ? favorites.find((f) => String(f.resource?.id?.objectId || '').includes(objectId))
    : null;
  const favorite = byId || favorites.find((f) => container.name && f.name === container.name) || null;

  return favorite
    ? { favorite, containerName: container.name || null }
    : { error: `no favorite matches "${container.name || objectId}"`, containerName: container.name || null };
}

async function recoverGroup(client, deviceId, household, group, health) {
  const label = `${deviceId.replace('global-automation-', '')} "${group.name}"`;
  const playerIds = group.playerIds || [];

  // Volumes exactly as they are right now, at the moment of the failure. We never use a volume saved
  // earlier: it can be a minute old, and restoring it would undo a change someone just made
  // (at 03:19 it lowered 34 back to a stale 26). If this read fails we leave volumes alone.
  // Only saved playlists (Sonos favorites) are recovered. Anything else, such as a playlist staff
  // brought to a class, is left completely alone: reloading or shuffling it would scramble the order.
  const [found, target] = await Promise.all([
    findLoadedFavorite(client, household.id, group.id),
    readPlayerVolumes(client, playerIds)
  ]);
  if (!found.favorite) {
    log(`${label} not a saved playlist (${found.error}); doing nothing.`);
    await notify(
      `Sonos failed at ${prettyPlace(deviceId)} (not fixed)`,
      `"${group.name}" stalled on a playlist that is not saved${found.containerName ? ` ("${found.containerName}")` : ''}. Nothing was changed, so someone needs to press play or skip.`,
      { priority: 'high', tags: 'rotating_light', throttleKey: `skip:${group.id}`, throttleMs: 2 * 60 * 1000 }
    );
    return null;
  }
  const failedAt = Date.now();
  await notify(
    `Sonos failed at ${prettyPlace(deviceId)}`,
    `"${group.name}" stalled on "${found.favorite.name}". Restarting the playlist now.`,
    { tags: 'warning', throttleKey: `start:${group.id}`, throttleMs: 30 * 1000 }
  );
  log(`${label} volumes to keep (live, just before reload): ${JSON.stringify(target)}`);

  const before = await readPlayback(client, group.id);
  const playModes = { ...(before.ok ? before.playModes : {}), shuffle: true };

  // 1. Reload the same playlist from the start.
  let startedInOneCall = false;
  if (found.favorite) {
    // Fast way: one Sonos call reloads the playlist, sets shuffle and starts playing.
    const { _objectType, ...modes } = playModes;
    const loadRes = await client.call(`/groups/${encodeURIComponent(group.id)}/favorites`, {
      method: 'POST',
      body: JSON.stringify({
        favoriteId: found.favorite.id,
        queueAction: 'REPLACE',
        action: 'REPLACE',
        playOnCompletion: true,
        playModes: modes
      })
    });
    startedInOneCall = loadRes.ok;
    log(`${label} reload playlist "${found.favorite.name}" + shuffle + play in one call -> http ${loadRes.status} ${loadRes.ok ? '' : (await loadRes.text().catch(() => '')).slice(0, 160)}`);

    if (!loadRes.ok) {
      // Fall back to the plain reload (no play, no modes), then the separate steps below.
      const plainRes = await client.call(`/groups/${encodeURIComponent(group.id)}/favorites`, {
        method: 'POST',
        body: JSON.stringify({
          favoriteId: found.favorite.id,
          queueAction: 'REPLACE',
          action: 'REPLACE',
          playOnCompletion: false
        })
      });
      log(`${label} fallback reload playlist -> http ${plainRes.status} ${plainRes.ok ? '' : (await plainRes.text().catch(() => '')).slice(0, 160)}`);
    }
  }

  if (startedInOneCall) {
    // Safety net: if it did not start by itself, press play (a short wait, so music is not delayed).
    await sleep(1500);
    const check = await readPlayback(client, group.id);
    if (!check.ok || check.raw.includes('IDLE')) {
      const playRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/play`, { method: 'POST' });
      log(`${label} still idle after the one-call reload; pressed play -> http ${playRes.status}`);
    }
  } else {
    // 2. Shuffle on.
    const modeRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/playMode`, {
      method: 'POST',
      body: JSON.stringify({ playModes })
    });
    log(`${label} shuffle on -> http ${modeRes.status} ${modeRes.ok ? '' : (await modeRes.text().catch(() => '')).slice(0, 160)}`);

    // 3. Play.
    const playRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/play`, { method: 'POST' });
    log(`${label} play -> http ${playRes.status} ${playRes.ok ? '' : (await playRes.text().catch(() => '')).slice(0, 160)}`);
  }

  await sleep(SETTLE_WAIT_MS);

  // 4. Volumes back to what they were.
  const restored = [];
  if (target) {
    const nowVolumes = await readPlayerVolumes(client, playerIds);
    for (const [playerId, wanted] of Object.entries(target)) {
      const current = nowVolumes ? nowVolumes[playerId] : undefined;
      if (current === wanted) continue;
      const volRes = await client.call(`/players/${encodeURIComponent(playerId)}/playerVolume`, {
        method: 'POST',
        body: JSON.stringify({ volume: wanted })
      });
      restored.push(`${playerId}: ${current ?? '?'} -> ${wanted} (http ${volRes.status})`);
    }
  }
  log(`${label} volumes ${restored.length ? `restored: ${restored.join('; ')}` : 'already correct'}`);

  const after = await readPlayback(client, group.id);
  log(
    `${label} result: ${after.ok ? after.raw.replace('PLAYBACK_STATE_', '') : `unreadable ${after.status}`} ` +
    `item=${after.ok ? after.itemId : '?'} pos=${after.ok ? after.positionMillis : '?'}`
  );

  const now = Date.now();
  const recent = (health.recoveries || []).filter((t) => now - new Date(t).getTime() < RECOVERY_WINDOW_MS);
  recent.push(new Date(now).toISOString());
  await saveHealth(deviceId, group.id, { recoveries: recent });

  const seconds = Math.round((Date.now() - failedAt) / 1000);
  const playingAgain = after.ok && (after.raw.includes('PLAYING') || after.raw.includes('BUFFERING'));
  await notify(
    playingAgain ? `Sonos recovered at ${prettyPlace(deviceId)}` : `Sonos still not playing at ${prettyPlace(deviceId)}`,
    playingAgain
      ? `"${group.name}" is playing again (${seconds}s after the reload started).`
      : `"${group.name}" is ${after.ok ? after.raw.replace('PLAYBACK_STATE_', '').toLowerCase() : 'unreadable'} after the reload. Someone needs to check it.`,
    playingAgain
      ? { tags: 'white_check_mark', throttleKey: `ok:${group.id}`, throttleMs: 30 * 1000 }
      : { priority: 'high', tags: 'rotating_light' }
  );
  return after;
}

async function checkGroup(client, deviceId, household, group) {
  const label = `${deviceId.replace('global-automation-', '')} "${group.name}"`;
  const state = await readPlayback(client, group.id);
  if (!state.ok) {
    log(`${label} status unreadable: ${state.status} ${state.body}`);
    return;
  }

  const nowIso = new Date().toISOString();

  if (state.raw.includes('PLAYING') || state.raw.includes('BUFFERING')) {
    // Remember that it was healthy, and what the speaker volumes were while it was.
    const fields = { last_active_at: nowIso };
    const players = await readPlayerVolumes(client, group.playerIds);
    if (players) fields.last_volumes = { players, at: nowIso };
    await saveHealth(deviceId, group.id, fields);
    return;
  }

  if (state.raw.includes('PAUSED')) {
    // Deliberate pause: forget that it was active so we never "recover" it later.
    await saveHealth(deviceId, group.id, { last_active_at: null });
    return;
  }

  // Anything else is IDLE or unknown. Only act on the stall pattern.
  const health = await loadHealth(deviceId, group.id);
  if (!health) return;

  const lastActive = health.last_active_at ? new Date(health.last_active_at).getTime() : 0;
  const wasRecentlyActive = lastActive > 0 && Date.now() - lastActive <= RECENTLY_ACTIVE_MS;
  const atStart = state.positionMillis === 0 || state.positionMillis === null;

  if (!wasRecentlyActive || !atStart) {
    return; // never started, or idle for a long time, or not at the start of a track
  }

  // Only one recovery per group at a time (the status poll and the scheduled check can both notice).
  if (!(await claimLock(deviceId, group.id))) {
    log(`${label} stalled, but another recovery is already handling it.`);
    return;
  }

  try {
    log(`${label} looks stalled: ${state.raw} item=${state.itemId} pos=${state.positionMillis}, last active ${Math.round((Date.now() - lastActive) / 1000)}s ago. Waiting ${CONFIRM_WAIT_MS / 1000}s to confirm.`);
    await sleep(CONFIRM_WAIT_MS);

    const confirm = await readPlayback(client, group.id);
    if (!confirm.ok || !confirm.raw.includes('IDLE') || (confirm.positionMillis ?? 0) !== 0) {
      log(`${label} changed during the wait (${confirm.ok ? confirm.raw : `unreadable ${confirm.status}`}); not acting.`);
      return;
    }

    log(`${label} confirmed stalled. Recovering (reload playlist, shuffle, play, keep volumes).`);
    await recoverGroup(client, deviceId, household, group, health);
  } finally {
    await releaseLock(deviceId, group.id);
  }
}

// ---------------------------------------------------------------------------
// Fast path: called from the status poll (every ~3s while the Test page is open).
// ---------------------------------------------------------------------------

const ACTIVE_WRITE_EVERY_MS = 15 * 1000;
const TRIGGER_EVERY_MS = 30 * 1000;
const lastActiveWrite = new Map(); // per warm server instance; only to avoid writing every poll
const lastTrigger = new Map();

export async function watchForStall({ deviceId, groupId, state, positionMillis, origin }) {
  if (!RECOVERY_DEVICE_IDS.includes(deviceId) || !groupId) return;
  const raw = String(state || '');
  const key = `${deviceId}:${groupId}`;
  const now = Date.now();

  if (raw.includes('PLAYING') || raw.includes('BUFFERING')) {
    if (now - (lastActiveWrite.get(key) || 0) > ACTIVE_WRITE_EVERY_MS) {
      lastActiveWrite.set(key, now);
      await saveHealth(deviceId, groupId, { last_active_at: new Date(now).toISOString() });
    }
    return;
  }

  if (raw.includes('PAUSED')) {
    if (now - (lastActiveWrite.get(key) || 0) > ACTIVE_WRITE_EVERY_MS) {
      lastActiveWrite.set(key, now);
      await saveHealth(deviceId, groupId, { last_active_at: null });
    }
    return;
  }

  // IDLE at the start of a track: possible stall. Ask the background function to take over.
  if (raw.includes('IDLE') && (positionMillis === 0 || positionMillis === null || positionMillis === undefined)) {
    if (now - (lastTrigger.get(key) || 0) < TRIGGER_EVERY_MS) return;
    lastTrigger.set(key, now);

    // Use the address this request came in on (Netlify's URL variables are not reliably set when functions run).
    const siteUrl = origin || process.env.URL || process.env.DEPLOY_PRIME_URL;
    if (!siteUrl || /localhost|127\.0\.0\.1/.test(siteUrl)) {
      log(`stall seen in status poll but no deployed site address to call (origin=${origin || 'none'}); the once-a-minute check will handle it`);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/playback-recovery-background`, {
        method: 'POST',
        signal: controller.signal
      });
      log(`${deviceId.replace('global-automation-', '')} idle at start seen in status poll; started background recovery check -> http ${res.status}`);
    } catch (error) {
      log(`could not start background recovery check: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Fastest path: started by the Sonos event receiver the moment Sonos reports a playbackError.
// No flat waiting: it polls the group every ~0.6s, and as soon as Sonos has given up (IDLE twice in
// a row) it reloads the playlist right away. A pause (PAUSED) is never touched, and a group that
// Sonos got going again by itself is left alone.
// ---------------------------------------------------------------------------

const FAST_POLL_MS = 600;
const FAST_MAX_WAIT_MS = 9 * 1000; // give up waiting for Sonos to give up after this long
const FAST_IDLE_CONFIRMATIONS = 2; // consecutive IDLE reads before acting
const SELF_RECOVERED_MS = 3000; // PLAYING this far into a track = Sonos fixed itself

// The event receiver sets playback_health.error_burst_at when it sees 3+ playbackErrors for a group
// within a few seconds. In every failure so far that cascade ended with Sonos giving up (IDLE) 1-5s
// later, so we do not wait for that.
async function readBurstAt(deviceId, groupId) {
  const { data } = await supabase
    .from('playback_health')
    .select('error_burst_at')
    .eq('device_id', deviceId)
    .eq('group_id', groupId)
    .maybeSingle();
  return data?.error_burst_at ? new Date(data.error_burst_at).getTime() : 0;
}

const errorTimes = new Map(); // per warm instance; the DB flag is what the background function reads
const BURST_COUNT = 3;
const BURST_WINDOW_MS = 3000;
export async function noteError(groupId) {
  if (!groupId) return;
  const now = Date.now();
  const times = (errorTimes.get(groupId) || []).filter((t) => now - t < BURST_WINDOW_MS);
  times.push(now);
  errorTimes.set(groupId, times);
  if (times.length === BURST_COUNT) {
    // Which location owns this group? playback_health rows are keyed by (device, group); the
    // one-minute check creates the row for every group it sees. If none exists yet the early
    // reaction is skipped and the recovery still acts when Sonos goes idle.
    const { data: rows } = await supabase.from('playback_health').select('device_id').eq('group_id', groupId);
    const owners = (rows || []).map((r) => r.device_id).filter((id) => RECOVERY_DEVICE_IDS.includes(id));
    for (const deviceId of owners) {
      await saveHealth(deviceId, groupId, { error_burst_at: new Date(now).toISOString() });
    }
    log(`error burst: ${BURST_COUNT} playbackErrors within ${BURST_WINDOW_MS / 1000}s for ${String(groupId).slice(0, 24)}`);
  }
}

export async function recoverAfterError(groupId, householdId, errorAt) {
  const t0 = Date.now();
  const burstSince = (Number(errorAt) || t0) - 2000;
  for (const deviceId of RECOVERY_DEVICE_IDS) {
    const tokens = await loadTokens(deviceId);
    if (!tokens?.access_token) continue;
    const client = makeSonosClient(tokens, deviceId);

    // Find the group (and its household) on this account.
    let household = null;
    let group = null;
    const householdIds = householdId ? [householdId] : [];
    if (!householdIds.length) {
      const hhRes = await client.call('/households');
      if (hhRes.ok) householdIds.push(...((await hhRes.json().catch(() => ({}))).households || []).map((h) => h.id));
    }
    for (const id of householdIds) {
      const groupsRes = await client.call(`/households/${encodeURIComponent(id)}/groups`);
      if (!groupsRes.ok) continue;
      const found = ((await groupsRes.json().catch(() => ({}))).groups || []).find((g) => g.id === groupId);
      if (found) {
        household = { id };
        group = found;
        break;
      }
    }
    if (!group) continue;

    const label = `${deviceId.replace('global-automation-', '')} "${group.name}"`;
    await saveHealth(deviceId, group.id, {}); // make sure the row exists so the lock can be taken

    // The lock is taken only when we are about to recover (below), not while watching, so this
    // watcher can never block the slow-buffer trigger (that is what happened at 03:19).
    let locked = false;
    try {
      log(`${label} playbackError seen (+${Date.now() - t0}ms after start). Watching for Sonos to give up.`);
      let idleReads = 0;
      let cascade = false;
      let last = 'no reads';
      while (Date.now() - t0 < FAST_MAX_WAIT_MS) {
        const s = await readPlayback(client, group.id);
        if (!s.ok) {
          last = `unreadable ${s.status}`;
          idleReads = 0;
        } else {
          last = `${s.raw.replace('PLAYBACK_STATE_', '')} pos=${s.positionMillis}`;
          if (s.raw.includes('PAUSED')) {
            log(`${label} is PAUSED (deliberate pause); leaving it alone.`);
            await saveHealth(deviceId, group.id, { last_active_at: null });
            return;
          }
          if (s.raw.includes('PLAYING') && (s.positionMillis ?? 0) >= SELF_RECOVERED_MS) {
            log(`${label} Sonos got going again by itself (${last}); nothing to do.`);
            return;
          }
          idleReads = s.raw.includes('IDLE') ? idleReads + 1 : 0;
          if (idleReads >= FAST_IDLE_CONFIRMATIONS) break;

          // Not idle yet: has the receiver flagged an error burst (3+ errors in 3s)? Then Sonos is
          // about to give up, so go now instead of waiting for it.
          if (!s.raw.includes('PLAYING') || (s.positionMillis ?? 0) < SELF_RECOVERED_MS) {
            const burstAt = await readBurstAt(deviceId, group.id);
            if (burstAt >= burstSince) {
              cascade = true;
              break;
            }
          }
        }
        await sleep(FAST_POLL_MS);
      }

      if (!cascade && idleReads < FAST_IDLE_CONFIRMATIONS) {
        log(`${label} did not go idle within ${FAST_MAX_WAIT_MS / 1000}s (last: ${last}); the regular checks will pick it up if it stalls.`);
        return;
      }

      if (!(await claimLock(deviceId, group.id))) {
        log(`${label} playbackError recovery not needed: another recovery is already handling it.`);
        return;
      }
      locked = true;
      const health = (await loadHealth(deviceId, group.id)) || { recoveries: [], last_volumes: null };

      log(`${label} ${cascade ? 'error burst' : 'idle after playbackError'} (+${Date.now() - t0}ms). Recovering now (reload playlist, shuffle, play, keep volumes).`);
      const done = await recoverGroup(client, deviceId, household, group, health);
      if (done) log(`${label} recovery finished (+${Date.now() - t0}ms total).`);
    } finally {
      if (locked) await releaseLock(deviceId, group.id); // never release a lock another run holds
    }
    return;
  }
  log(`playbackError for group ${String(groupId).slice(0, 24)} is not on a recovery location; ignoring.`);
}

// Called by the event receiver. Hands the work to the background function and returns quickly,
// because Sonos wants an answer to each event within about a second.
const lastErrorTrigger = new Map();
export async function startRecoveryFromError({ groupId, householdId, origin }) {
  if (!groupId) return;
  const now = Date.now();
  if (now - (lastErrorTrigger.get(groupId) || 0) < 5000) return; // an error burst sends several events
  lastErrorTrigger.set(groupId, now);

  const siteUrl = origin || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!siteUrl || /localhost|127\.0\.0\.1/.test(siteUrl)) {
    log(`playbackError received but no deployed site address to call (origin=${origin || 'none'})`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/playback-recovery-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, householdId, errorAt: now }),
      signal: controller.signal
    });
    log(`playbackError for ${String(groupId).slice(0, 24)}: started background recovery -> http ${res.status}`);
  } catch (error) {
    log(`could not start background recovery from playbackError: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Slow-buffer trigger -------------------------------------------------------------------
// A healthy song buffers for about 1.1s. A failing one sits in BUFFERING for ~20s before Sonos
// reports ERROR_LOST_CONNECTION. If a song is still buffering after BUFFER_LIMIT_MS, recover now.
export const BUFFER_LIMIT_MS = 2000;
const MAX_BUFFER_ATTEMPTS = 4;

export async function recoverIfStillBuffering(groupId, householdId, itemId, bufferedAt) {
  const t0 = Date.now();
  const since = Number(bufferedAt) || t0;
  for (const deviceId of RECOVERY_DEVICE_IDS) {
    const tokens = await loadTokens(deviceId);
    if (!tokens?.access_token) continue;
    const client = makeSonosClient(tokens, deviceId);

    let household = null;
    let group = null;
    const householdIds = householdId ? [householdId] : [];
    if (!householdIds.length) {
      const hhRes = await client.call('/households');
      if (hhRes.ok) householdIds.push(...((await hhRes.json().catch(() => ({}))).households || []).map((h) => h.id));
    }
    for (const id of householdIds) {
      const groupsRes = await client.call(`/households/${encodeURIComponent(id)}/groups`);
      if (!groupsRes.ok) continue;
      const found = ((await groupsRes.json().catch(() => ({}))).groups || []).find((g) => g.id === groupId);
      if (found) {
        household = { id };
        group = found;
        break;
      }
    }
    if (!group) continue;

    const label = `${deviceId.replace('global-automation-', '')} "${group.name}"`;
    const wait = since + BUFFER_LIMIT_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const s = await readPlayback(client, group.id);
    if (!s.ok) {
      log(`${label} slow-buffer check: could not read state (${s.status}); leaving it.`);
      return;
    }
    const stuck = s.raw.includes('BUFFERING') && (!itemId || s.itemId === itemId);
    if (!stuck) {
      log(`${label} slow-buffer check: ${s.raw.replace('PLAYBACK_STATE_', '')} item=${s.itemId} ${Date.now() - since}ms after buffering began; fine.`);
      return;
    }

    await saveHealth(deviceId, group.id, {});
    if (!(await claimLock(deviceId, group.id))) {
      log(`${label} still buffering after ${Date.now() - since}ms, but another recovery is already handling it.`);
      return;
    }
    try {
      const health = (await loadHealth(deviceId, group.id)) || { recoveries: [], last_volumes: null };
      log(`${label} still BUFFERING item=${s.itemId} after ${Date.now() - since}ms (limit ${BUFFER_LIMIT_MS}ms). Recovering now.`);
      // The reloaded playlist's first song can stall too (seen at 03:19). Recovery holds the lock, so
      // no new watcher could act on it. Check the result and go again while it is still buffering
      // well past the limit (recoverGroup waits several seconds before reporting).
      for (let attempt = 1; attempt <= MAX_BUFFER_ATTEMPTS; attempt += 1) {
        const result = await recoverGroup(client, deviceId, household, group, health);
        if (!result) break; // not a saved playlist: recoverGroup did nothing
        const stillStuck = result?.ok && result.raw.includes('BUFFERING') && (result.positionMillis ?? 0) < 1000;
        if (!stillStuck) break;
        log(`${label} still BUFFERING after recovery attempt ${attempt}/${MAX_BUFFER_ATTEMPTS}${attempt < MAX_BUFFER_ATTEMPTS ? '; trying again.' : '; giving up.'}`);
      }
      log(`${label} slow-buffer recovery finished (+${Date.now() - since}ms since buffering began).`);
    } finally {
      await releaseLock(deviceId, group.id);
    }
    return;
  }
}

const lastBufferTrigger = new Map();
export async function startBufferWatch({ groupId, householdId, itemId, queueVersion, origin }) {
  if (!groupId) return;
  const now = Date.now();
  const key = `${groupId}|${itemId}|${queueVersion}`;
  if (now - (lastBufferTrigger.get(key) || 0) < 5000) return; // Sonos often sends two BUFFERING events
  lastBufferTrigger.set(key, now);

  const siteUrl = origin || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!siteUrl || /localhost|127\.0\.0\.1/.test(siteUrl)) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    await fetch(`${siteUrl}/.netlify/functions/playback-recovery-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, householdId, bufferWatch: true, itemId, bufferedAt: now }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name !== 'AbortError') log(`could not start buffer watch: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Sonos silently stops sending events if it drops our subscription (seen at 03:17 on 2026-10-29:
// events stopped while the speaker kept playing, so no recovery could trigger). Subscribing again
// is harmless, so the one-minute check renews it for every group, even with no page open.
let lastSubscribeLog = 0;
async function renewEventSubscription(client, group) {
  const res = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/subscription`, { method: 'POST' });
  const now = Date.now();
  if (!res.ok) {
    log(`event subscription renew failed for "${group.name}": http ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  } else if (now - lastSubscribeLog > 10 * 60 * 1000) {
    lastSubscribeLog = now;
    log(`event subscription renewed for "${group.name}" (http ${res.status}); renewed every minute.`);
  }
}

async function checkDevice(deviceId) {
  const tokens = await loadTokens(deviceId);
  if (!tokens?.access_token) {
    return;
  }
  const client = makeSonosClient(tokens, deviceId);

  const householdsRes = await client.call('/households');
  if (!householdsRes.ok) {
    log(`${deviceId} households failed: ${householdsRes.status}`);
    return;
  }
  const { households = [] } = await householdsRes.json();

  for (const household of households) {
    const groupsRes = await client.call(`/households/${encodeURIComponent(household.id)}/groups`);
    if (!groupsRes.ok) continue;
    const { groups = [] } = await groupsRes.json();
    for (const group of groups) {
      try {
        await renewEventSubscription(client, group);
        await checkGroup(client, deviceId, household, group);
      } catch (error) {
        log(`${deviceId} "${group.name}" check failed: ${error.message}`);
      }
    }
  }
}

export async function runRecoveryCheck() {
  for (const deviceId of RECOVERY_DEVICE_IDS) {
    try {
      await checkDevice(deviceId);
    } catch (error) {
      console.error(`[TRACE-RECOVERY] error for ${deviceId}:`, error.message);
    }
  }
}
