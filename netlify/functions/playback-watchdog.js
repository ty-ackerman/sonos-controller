import { loadTokens, saveTokens } from '../../tokenStore.js';
import dotenv from 'dotenv';

dotenv.config();

const SONOS_AUTH_BASE = 'https://api.sonos.com';
const SONOS_CONTROL_BASE = 'https://api.ws.sonos.com/control/api/v1';
const SONOS_CLIENT_ID = process.env.SONOS_CLIENT_ID;
const SONOS_CLIENT_SECRET = process.env.SONOS_CLIENT_SECRET;

const DEVICE_IDS = [
  'global-automation-college',
  'global-automation-leslieville'
];

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
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  const response = await fetch(`${SONOS_AUTH_BASE}/login/v3/oauth/access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SONOS_CLIENT_ID}:${SONOS_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed for ${deviceId}: ${response.status}`);
  }

  const payload = await response.json();
  const updated = storeTokens(payload, tokens);
  await saveTokens(updated, deviceId);
  return updated;
}

async function sonosApi(endpoint, tokens, deviceId, options = {}) {
  if (tokens.expires_at && Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshAccessToken(tokens, deviceId);
  }

  let response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${tokens.access_token}`,
      ...(options.headers || {}),
      ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
    }
  });

  if (response.status === 401 && tokens.refresh_token) {
    tokens = await refreshAccessToken(tokens, deviceId);
    response = await fetch(`${SONOS_CONTROL_BASE}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokens.access_token}`,
        ...(options.headers || {}),
        ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
      }
    });
  }

  return { response, tokens };
}

async function checkAndResumePlayback(deviceId) {
  let tokens = await loadTokens(deviceId);
  if (!tokens?.access_token) {
    console.log(`[PlaybackWatchdog] No tokens for ${deviceId}, skipping`);
    return;
  }

  const { response: householdsRes, tokens: t1 } = await sonosApi('/households', tokens, deviceId);
  tokens = t1;
  if (!householdsRes.ok) {
    console.log(`[PlaybackWatchdog] Failed to get households for ${deviceId}: ${householdsRes.status}`);
    return;
  }

  const { households = [] } = await householdsRes.json();

  for (const household of households) {
    const { response: groupsRes, tokens: t2 } = await sonosApi(
      `/households/${encodeURIComponent(household.id)}/groups`, tokens, deviceId
    );
    tokens = t2;
    if (!groupsRes.ok) continue;

    const { groups = [] } = await groupsRes.json();

    for (const group of groups) {
      const { response: statusRes, tokens: t3 } = await sonosApi(
        `/groups/${encodeURIComponent(group.id)}/playback/playbackStatus`, tokens, deviceId
      );
      tokens = t3;

      if (!statusRes.ok) {
        const { response: fallbackRes, tokens: t3b } = await sonosApi(
          `/groups/${encodeURIComponent(group.id)}/playback/playbackState`, tokens, deviceId
        );
        tokens = t3b;
        if (!fallbackRes.ok) continue;
        var status = await fallbackRes.json();
      } else {
        var status = await statusRes.json();
      }

      const rawState = String(status.playbackState || status.state || '');

      if (rawState.includes('PLAYING') || rawState.includes('BUFFERING')) {
        continue;
      }

      if (rawState.includes('PAUSED')) {
        continue;
      }

      const { response: metaRes, tokens: t4 } = await sonosApi(
        `/groups/${encodeURIComponent(group.id)}/playbackMetadata`, tokens, deviceId
      );
      tokens = t4;
      const metadata = metaRes.ok ? await metaRes.json() : {};
      const hasContent = !!(metadata.currentItem || metadata.container);

      if (!hasContent) {
        continue;
      }

      console.log(`[PlaybackWatchdog] Group "${group.name}" is ${rawState} with content still loaded — auto-resuming`);

      const { response: playRes } = await sonosApi(
        `/groups/${encodeURIComponent(group.id)}/playback/play`, tokens, deviceId, { method: 'POST' }
      );

      if (playRes.ok) {
        console.log(`[PlaybackWatchdog] Successfully resumed "${group.name}"`);
      } else {
        const errText = await playRes.text().catch(() => '');
        console.log(`[PlaybackWatchdog] Failed to resume "${group.name}": ${playRes.status} ${errText}`);
      }
    }
  }
}

export default async () => {
  console.log('[PlaybackWatchdog] Running scheduled check...');

  for (const deviceId of DEVICE_IDS) {
    try {
      await checkAndResumePlayback(deviceId);
    } catch (error) {
      console.error(`[PlaybackWatchdog] Error checking ${deviceId}:`, error.message);
    }
  }

  return new Response('OK');
};

export const config = {
  schedule: "@every 1m"
};
