// Stall recovery (Test location only for now).
//
// Pattern we recover from: a group was PLAYING/BUFFERING a moment ago, then drops to
// PLAYBACK_STATE_IDLE at position 0 (Sonos gave up after several unplayable Spotify tracks).
// A deliberate pause shows up as PAUSED, so it is never touched.
//
// Recovery: turn shuffle on, press play, put the group volume back to what it was.
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
const CONFIRM_WAIT_MS = 8 * 1000; // re-check before acting so a slow start is not "fixed"
const VERIFY_WAIT_MS = 4 * 1000;
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

async function readVolume(client, groupId) {
  const res = await client.call(`/groups/${encodeURIComponent(groupId)}/groupVolume`);
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return Number.isFinite(Number(json.volume)) ? Number(json.volume) : null;
}

async function loadHealth(deviceId, groupId) {
  const { data, error } = await supabase
    .from('playback_health')
    .select('last_active_at, recoveries')
    .eq('device_id', deviceId)
    .eq('group_id', groupId)
    .maybeSingle();
  if (error) {
    log(`could not read playback_health: ${error.message}`);
    return null;
  }
  return data || { last_active_at: null, recoveries: [] };
}

async function saveHealth(deviceId, groupId, fields) {
  const { error } = await supabase.from('playback_health').upsert(
    { device_id: deviceId, group_id: groupId, updated_at: new Date().toISOString(), ...fields },
    { onConflict: 'device_id,group_id' }
  );
  if (error) log(`could not write playback_health: ${error.message}`);
}

async function recoverGroup(client, deviceId, group, health) {
  const label = `${deviceId.replace('global-automation-', '')} "${group.name}" ${group.id}`;
  const volumeBefore = await readVolume(client, group.id);

  // Shuffle on (keep the other play modes as they were), then play.
  const before = await readPlayback(client, group.id);
  const playModes = { ...(before.ok ? before.playModes : {}), shuffle: true };
  const modeRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/playMode`, {
    method: 'POST',
    body: JSON.stringify({ playModes })
  });
  log(`${label} shuffle on -> http ${modeRes.status} ${modeRes.ok ? '' : (await modeRes.text().catch(() => '')).slice(0, 160)}`);

  const playRes = await client.call(`/groups/${encodeURIComponent(group.id)}/playback/play`, { method: 'POST' });
  log(`${label} play -> http ${playRes.status} ${playRes.ok ? '' : (await playRes.text().catch(() => '')).slice(0, 160)}`);

  await sleep(VERIFY_WAIT_MS);

  // Put the volume back if starting playback moved it.
  const volumeAfter = await readVolume(client, group.id);
  if (volumeBefore !== null && volumeAfter !== null && volumeAfter !== volumeBefore) {
    const volRes = await client.call(`/groups/${encodeURIComponent(group.id)}/groupVolume`, {
      method: 'POST',
      body: JSON.stringify({ volume: volumeBefore })
    });
    log(`${label} volume ${volumeAfter} -> ${volumeBefore} restored, http ${volRes.status}`);
  }

  const after = await readPlayback(client, group.id);
  log(
    `${label} result: ${after.ok ? after.raw.replace('PLAYBACK_STATE_', '') : `unreadable ${after.status}`} ` +
    `item=${after.ok ? after.itemId : '?'} pos=${after.ok ? after.positionMillis : '?'} volume=${volumeBefore}->${volumeAfter}`
  );

  const now = Date.now();
  const recent = (health.recoveries || []).filter((t) => now - new Date(t).getTime() < RECOVERY_WINDOW_MS);
  recent.push(new Date(now).toISOString());
  await saveHealth(deviceId, group.id, { recoveries: recent });
}

async function checkGroup(client, deviceId, group) {
  const label = `${deviceId.replace('global-automation-', '')} "${group.name}"`;
  const state = await readPlayback(client, group.id);
  if (!state.ok) {
    log(`${label} status unreadable: ${state.status} ${state.body}`);
    return;
  }

  const nowIso = new Date().toISOString();

  if (state.raw.includes('PLAYING') || state.raw.includes('BUFFERING')) {
    await saveHealth(deviceId, group.id, { last_active_at: nowIso });
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
    log(`${label} changed during confirm wait (${confirm.ok ? confirm.raw : `unreadable ${confirm.status}`}); not acting.`);
    return;
  }

  const now = Date.now();
  const recent = (health.recoveries || []).filter((t) => now - new Date(t).getTime() < RECOVERY_WINDOW_MS);
  if (recent.length >= MAX_RECOVERIES) {
    log(`${label} stalled again but already recovered ${recent.length}x in the last 10 min; leaving it alone.`);
    return;
  }

  log(`${label} confirmed stalled. Recovering (shuffle on, play, keep volume).`);
  await recoverGroup(client, deviceId, group, health);
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
        await checkGroup(client, deviceId, group);
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
