// Stall recovery (Test location only for now).
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

import { loadTokens, saveTokens } from '../../tokenStore.js';
import { supabase } from '../../supabase.js';
import dotenv from 'dotenv';

dotenv.config();

const SONOS_AUTH_BASE = 'https://api.sonos.com';
const SONOS_CONTROL_BASE = 'https://api.ws.sonos.com/control/api/v1';
const SONOS_CLIENT_ID = process.env.SONOS_CLIENT_ID;
const SONOS_CLIENT_SECRET = process.env.SONOS_CLIENT_SECRET;

// Only these locations get recovery. College and Leslieville are intentionally not listed.
const RECOVERY_DEVICE_IDS = ['global-automation-test'];

const RECENTLY_ACTIVE_MS = 150 * 1000; // group must have been playing within this window
const CONFIRM_WAIT_MS = 5 * 1000; // wait after spotting the pattern, then check it is still true
const SETTLE_WAIT_MS = 4 * 1000; // let playback start before restoring volumes / verifying
const MAX_RECOVERIES = 2; // per group...
const RECOVERY_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[TRACE-RECOVERY] ${msg}`);

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

  // Volumes from just before the failure (saved while it was still playing); else whatever they are now.
  let target = health.last_volumes?.players || null;
  const targetSource = target ? 'saved while playing' : 'read now';
  if (!target) target = await readPlayerVolumes(client, playerIds);
  log(`${label} volumes to keep (${targetSource}): ${JSON.stringify(target)}`);

  const before = await readPlayback(client, group.id);
  const playModes = { ...(before.ok ? before.playModes : {}), shuffle: true };

  // 1. Reload the same playlist from the start.
  const found = await findLoadedFavorite(client, household.id, group.id);
  if (found.favorite) {
    const loadRes = await client.call(`/groups/${encodeURIComponent(group.id)}/favorites`, {
      method: 'POST',
      body: JSON.stringify({
        favoriteId: found.favorite.id,
        queueAction: 'REPLACE',
        action: 'REPLACE',
        playOnCompletion: false
      })
    });
    log(`${label} reload playlist "${found.favorite.name}" -> http ${loadRes.status} ${loadRes.ok ? '' : (await loadRes.text().catch(() => '')).slice(0, 160)}`);
  } else {
    log(`${label} could not reload playlist (${found.error}); continuing with shuffle + play on the current queue`);
  }

  // 2. Shuffle on.
  const modeRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/playMode`, {
    method: 'POST',
    body: JSON.stringify({ playModes })
  });
  log(`${label} shuffle on -> http ${modeRes.status} ${modeRes.ok ? '' : (await modeRes.text().catch(() => '')).slice(0, 160)}`);

  // 3. Play.
  const playRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/play`, { method: 'POST' });
  log(`${label} play -> http ${playRes.status} ${playRes.ok ? '' : (await playRes.text().catch(() => '')).slice(0, 160)}`);

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

  log(`${label} looks stalled: ${state.raw} item=${state.itemId} pos=${state.positionMillis}, last active ${Math.round((Date.now() - lastActive) / 1000)}s ago. Waiting ${CONFIRM_WAIT_MS / 1000}s to confirm.`);
  await sleep(CONFIRM_WAIT_MS);

  const confirm = await readPlayback(client, group.id);
  if (!confirm.ok || !confirm.raw.includes('IDLE') || (confirm.positionMillis ?? 0) !== 0) {
    log(`${label} changed during the wait (${confirm.ok ? confirm.raw : `unreadable ${confirm.status}`}); not acting.`);
    return;
  }

  const now = Date.now();
  const recent = (health.recoveries || []).filter((t) => now - new Date(t).getTime() < RECOVERY_WINDOW_MS);
  if (recent.length >= MAX_RECOVERIES) {
    log(`${label} stalled again but already recovered ${recent.length}x in the last 10 min; leaving it alone.`);
    return;
  }

  log(`${label} confirmed stalled. Recovering (reload playlist, shuffle, play, keep volumes).`);
  await recoverGroup(client, deviceId, household, group, health);
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
        await checkGroup(client, deviceId, household, group);
      } catch (error) {
        log(`${deviceId} "${group.name}" check failed: ${error.message}`);
      }
    }
  }
}

export default async () => {
  for (const deviceId of RECOVERY_DEVICE_IDS) {
    try {
      await checkDevice(deviceId);
    } catch (error) {
      console.error(`[TRACE-RECOVERY] error for ${deviceId}:`, error.message);
    }
  }
  return new Response('OK');
};

export const config = {
  schedule: '@every 1m'
};
